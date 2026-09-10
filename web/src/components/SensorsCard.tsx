import type { Status } from '../api'
import { Graphic, classify, useHistory, type Kind } from './SensorGraphic'

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : 0
}

type Row = { key: string; name: string; value: string; g: Kind; depth: number }

export default function SensorsCard({ status, className = '' }: { status: Status; className?: string }) {
  const push = useHistory()
  const rows: Row[] = []
  const add = (key: string, name: string, value: string, g: Kind, depth = 0) => rows.push({ key, name, value, g, depth })

  // Temperatures, fans, motion (from the summary part of the status)
  for (const [k, t] of Object.entries(status.temps)) {
    add(`temps/${k}`, k, `${t.actual.toFixed(1)} °C → ${t.target.toFixed(0)} °C`,
      { kind: 'temp', value: t.actual, target: t.target, max: t.max || 300, hist: push(`temps/${k}`, t.actual) })
  }
  for (const [k, v] of Object.entries(status.fans)) add(`fans/${k}`, `${k} fan`, `${v} %`, { kind: 'pct', value: v, fan: true })
  add('speed', 'speed factor', `${status.speed_pct} %`, { kind: 'factor', value: status.speed_pct })
  add('flow', 'flow factor', `${status.flow_pct} %`, { kind: 'factor', value: status.flow_pct })
  {
    const m = /X:\s*(-?[\d.]+)\s*Y:\s*(-?[\d.]+)\s*Z:\s*(-?[\d.]+)/.exec(status.position || '')
    add('pos', 'position', status.position || '-', { kind: 'axis', xyz: m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0] })
  }
  add('light', 'light', status.light ? 'on' : 'off', { kind: 'bool', on: status.light })

  // Filament system
  add('cfs', 'CFS connected', status.cfs.connected ? 'yes' : 'no', { kind: 'bool', on: status.cfs.connected })
  for (const b of status.cfs.boxes ?? []) {
    if (b.type === 0) add(`box/${b.id}`, b.name, `${b.temp.toFixed(0)} °C · ${b.humidity.toFixed(0)} % RH`, { kind: 'box', temp: b.temp, humidity: b.humidity })
    else add(`box/${b.id}`, b.name, '', { kind: 'bool', on: b.slots.length > 0 })
    for (const s of b.slots) {
      const colors = ((s as unknown as { colors?: string[] }).colors ?? []).length ? (s as unknown as { colors: string[] }).colors : [s.color || '#888']
      add(`slot/${b.id}/${s.id}`, s.label, `${s.vendor} ${s.name} (${s.type}) ${s.min_temp}-${s.max_temp} °C · PA ${s.pressure}${s.selected ? ' · FEEDING' : ''}`,
        { kind: 'swatch', colors }, 1)
    }
  }

  // Klipper objects: one row per object plus one per field
  const names = Object.keys(status.sensors).sort()
  for (const n of names) {
    const o = status.sensors[n]
    let g: Kind = { kind: 'text' }
    if (o.temperature !== undefined && !Number.isNaN(Number(o.temperature))) {
      const ln = n.toLowerCase()
      const max = ln.includes('bed') ? 120 : ln.includes('chamber') || ln.includes('box') ? 60 : /mcu|host|cpu/.test(ln) ? 100 : 300
      g = { kind: 'temp', value: num(o.temperature), target: num(o.target), max, hist: push(`obj/${n}`, num(o.temperature)) }
    } else if (o.state !== undefined) {
      g = { kind: 'bool', on: typeof o.state === 'string' ? ['connect', 'ready', 'on'].includes(o.state) : num(o.state) !== 0 }
    } else if (o.speed !== undefined) {
      const sp = num(o.speed); g = { kind: 'pct', value: sp <= 1 ? sp * 100 : sp, fan: true }
    } else if (o.value !== undefined) {
      g = { kind: 'bool', on: num(o.value) !== 0 }
    }
    add(`obj/${n}`, n, '', g)
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const so = v as Record<string, unknown>
        add(`obj/${n}/${k}`, k, '', { kind: 'bool', on: so.state !== 'None' && so.state !== '' && so.state !== undefined }, 1)
        for (const [kk, vv] of Object.entries(so)) add(`obj/${n}/${k}/${kk}`, kk, fmt(vv), classify(kk, vv, so, push, `obj/${n}/${k}/${kk}`), 2)
        continue
      }
      let fg: Kind
      if (k === 'speed' || k === 'power' || k === 'progress') { const p = num(v); fg = { kind: 'pct', value: p <= 1 ? p * 100 : p, fan: k === 'speed' } }
      else if (k === 'target') { const t = num(v); fg = t > 0 ? { kind: 'temp', value: t, target: 0, max: 300, hist: [] } : { kind: 'text' } }
      else fg = classify(k, v, o, push, `obj/${n}/${k}`)
      add(`obj/${n}/${k}`, k, fmt(v), fg, 1)
    }
  }

  // Raw device-socket fields
  const dev = Object.keys(status.device).sort()
  const devRows: Row[] = dev.map(k => ({ key: `dev/${k}`, name: k, value: fmt(status.device[k]), g: classify(k, status.device[k], status.device, push, `dev/${k}`), depth: 0 }))

  const table = (list: Row[], head: string) => (
    <div className="tscroll"><table style={{ marginTop: 8 }}>
      <thead><tr><th>{head}</th><th>Value</th><th style={{ width: 160 }}>Graph</th></tr></thead>
      <tbody>
        {list.map(r => (
          <tr key={r.key} className={`d${r.depth}`}>
            <td style={{ paddingLeft: 8 + r.depth * 16 }}>{r.name}</td>
            <td className="v">{r.value}</td>
            <td className="g"><Graphic g={r.g} id={r.key} /></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  )

  return (
    <div className={`card sensors ${className}`}>
      <details>
        <summary>Verbose sensors ({names.length} Klipper objects, {dev.length} device fields)</summary>
        {table(rows, 'Sensor')}
        {table(devRows, 'Device field')}
      </details>
    </div>
  )
}
