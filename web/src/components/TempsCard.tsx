import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Sample, type Status } from '../api'
import { useTween } from '../motion'

// One histogram per heater: the last WINDOW_S of readings in BUCKET_S columns, the
// target as a dashed line, the live reading as the big number. History comes from the
// backend (/api/temps/history, kept for an hour on the printer) and grows from the live
// status while the page is open.
const WINDOW_S = 600
const BUCKET_S = 15
const N = WINDOW_S / BUCKET_S

type Row = { key: string; label: string; scale: number; cls: string }
const ROWS: Row[] = [
  { key: 'nozzle', label: 'Nozzle', scale: 300, cls: 'nozzle' },
  { key: 'bed', label: 'Bed', scale: 120, cls: 'bed' },
  { key: 'chamber', label: 'Chamber', scale: 60, cls: 'chamber' },
]

function useTempHistory(status: Status): Sample[] {
  const [hist, setHist] = useState<Sample[]>([])
  const lastT = useRef(0)
  useEffect(() => {
    api.tempsHistory().then(h => {
      setHist(h.samples ?? [])
      lastT.current = h.samples?.length ? h.samples[h.samples.length - 1].t : 0
    }).catch(() => { /* histogram then fills from live data only */ })
  }, [])
  useEffect(() => {
    const t = Math.floor(new Date(status.updated_at).getTime() / 1000)
    if (!t || t - lastT.current < 2) return
    lastT.current = t
    const v: Record<string, [number, number]> = {}
    for (const [k, tt] of Object.entries(status.temps)) v[k] = [tt.actual, tt.target]
    const box = (status.cfs.boxes ?? []).find(b => b.type === 0)
    if (box) v.cfs = [box.temp, box.humidity]
    setHist(h => {
      const cut = t - 3600
      const next = h.length && h[0].t < cut ? h.filter(s => s.t >= cut) : h.slice()
      next.push({ t, v })
      return next
    })
  }, [status.updated_at, status.temps, status.cfs.boxes])
  return hist
}

/** Last WINDOW_S seconds bucketed into N columns: [actual, target] per column or null. */
function buckets(hist: Sample[], key: string, now: number): (readonly [number, number] | null)[] {
  const out: (readonly [number, number] | null)[] = new Array(N).fill(null)
  const start = now - WINDOW_S
  for (const s of hist) {
    if (s.t < start) continue
    const i = Math.min(N - 1, Math.floor((s.t - start) / BUCKET_S))
    const v = s.v[key]
    if (v) out[i] = [v[0], v[1]]
  }
  return out
}

function Readout({ v, digits = 1, suffix = '' }: { v: number; digits?: number; suffix?: string }) {
  const t = useTween(v, 500)
  return <>{t.toFixed(digits)}{suffix}</>
}

function Gauge({ value, target, max, cls }: { value: number; target: number; max: number; cls: string }) {
  const v = useTween(value, 600)
  const r = 26, cx = 32, cy = 34
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25 // 270 degree sweep from bottom-left, clockwise
  const ang = (f: number) => a0 + (a1 - a0) * Math.max(0, Math.min(1, f))
  const pt = (f: number, rr = r) => [cx + rr * Math.cos(ang(f)), cy + rr * Math.sin(ang(f))] as const
  const arc = (f0: number, f1: number, rr = r) => {
    const [x0, y0] = pt(f0, rr), [x1, y1] = pt(f1, rr)
    const large = (ang(f1) - ang(f0)) > Math.PI ? 1 : 0
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${rr},${rr} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`
  }
  const f = v / max, ft = target / max
  const [nx, ny] = pt(f, r - 4)
  const [tx, ty] = pt(ft, r + 5)
  const ticks = Array.from({ length: 10 }, (_, i) => i / 9)
  return (
    <svg className={`gauge ${cls}`} width={64} height={64} viewBox="0 0 64 64" aria-hidden>
      <path d={arc(0, 1)} fill="none" stroke="var(--panel-3)" strokeWidth={5} strokeLinecap="round" />
      {ticks.map(t => { const [x0, y0] = pt(t, r - 7), [x1, y1] = pt(t, r - 9.5); return <line key={t} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--grid)" strokeWidth={1} /> })}
      {f > 0.01 && <path d={arc(0, f)} fill="none" stroke="var(--series)" strokeWidth={5} strokeLinecap="round" className="gauge-arc" />}
      {target > 0 && <circle cx={tx} cy={ty} r={2.2} fill="var(--text)" className="gauge-target" />}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#fff" strokeWidth={1.6} strokeLinecap="round" className="gauge-needle" />
      <circle cx={cx} cy={cy} r={3} fill="var(--series)" />
    </svg>
  )
}

function Histogram({ row, hist, now, max, target }: { row: Row; hist: Sample[]; now: number; max: number; target: number }) {
  const cols = useMemo(() => buckets(hist, row.key, now), [hist, row.key, now])
  const [hover, setHover] = useState<number | null>(null)
  const h = hover !== null ? cols[hover] : null
  const ago = hover !== null ? (N - 1 - hover) * BUCKET_S : 0
  return (
    <div className={`histo ${row.cls}`} onMouseLeave={() => setHover(null)}>
      {target > 0 && <i className="tline" style={{ bottom: `${Math.min(100, (target / max) * 100)}%` }} title={`target ${target.toFixed(0)}°`} />}
      {cols.map((c, i) => (
        <b key={i} className={`hb ${c ? '' : 'none'} ${hover === i ? 'hot' : ''} ${i === N - 1 && c ? 'live' : ''}`}
          style={{ height: c ? `${Math.max(3, Math.min(100, (c[0] / max) * 100))}%` : '3%' }}
          onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
      ))}
      {h && hover !== null && (
        <span className="tip" style={{ left: `${((hover + 0.5) / N) * 100}%` }}>
          {h[0].toFixed(1)}°{h[1] > 0 ? ` / ${h[1].toFixed(0)}°` : ''} <small>{ago ? `${ago}s ago` : 'now'}</small>
        </span>
      )}
    </div>
  )
}

export default function TempsCard({ status, className = '' }: { status: Status; className?: string }) {
  const hist = useTempHistory(status)
  const now = Math.floor(Date.now() / 1000)
  const box = (status.cfs.boxes ?? []).find(b => b.type === 0)
  const fanName = (k: string) => k === 'part' ? 'Part fan' : k === 'aux' ? 'Aux fan' : k === 'case' ? 'Case fan' : k
  return (
    <div className={`card temps ${className}`}>
      <h2>Temperatures <span>last 10 min</span></h2>
      {ROWS.map(row => {
        const t = status.temps[row.key]
        if (!t) return null
        const max = t.max || row.scale
        const heating = t.target > 0 && t.actual < t.target - 2
        return (
          <div className="temp-row" key={row.key}>
            <div className="name">
              <span className={`swatch-dot ${row.cls}`} />{row.label}
              <small>{t.target > 0 ? `${heating ? 'heating to' : 'holding'} ${t.target.toFixed(0)}°` : 'off'}</small>
            </div>
            <div className="temp-mid"><Gauge value={t.actual} target={t.target} max={max} cls={row.cls} /><Histogram row={row} hist={hist} now={now} max={max} target={t.target} /></div>
            <div className="val"><span className="num"><Readout v={t.actual} suffix="°" /></span><small>max {max}°</small></div>
          </div>
        )
      })}
      <div className="temp-strip">
        {Object.entries(status.fans).map(([k, v]) => (
          <div className="tile" key={k}>
            <span className="tl">{fanName(k)}</span>
            <span className="tv"><Readout v={v} digits={0} /><small> %</small></span>
            <i className="tb"><b style={{ width: `${Math.min(100, v)}%` }} /></i>
          </div>
        ))}
        {box && (
          <>
            <div className="tile">
              <span className="tl">{box.name} temp</span>
              <span className="tv"><Readout v={box.temp} digits={0} /><small>°</small></span>
              <i className="tb"><b style={{ width: `${Math.min(100, (box.temp / 60) * 100)}%` }} /></i>
            </div>
            <div className="tile">
              <span className="tl">{box.name} humidity</span>
              <span className="tv"><Readout v={box.humidity} digits={0} /><small> % RH</small></span>
              <i className={`tb ${box.humidity > 50 ? 'warn' : ''}`}><b style={{ width: `${Math.min(100, box.humidity)}%` }} /></i>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
