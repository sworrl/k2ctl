import { useEffect, useState } from 'react'
import { api, type Status } from '../api'

// Chamber climate. The stock K2 has a thermistor and an exhaust/filter fan on a
// temperature threshold (Creality's M141), no heater. When a heater_generic for the
// chamber shows up in Klipper (K2 Plus PTC, or a heater mod) the backend reports it and
// the setpoint control appears; until then that section says so instead of pretending.

const PRESETS: { name: string; threshold: number; hint: string }[] = [
  { name: 'PLA', threshold: 35, hint: 'vent early, keep it cool' },
  { name: 'PETG', threshold: 45, hint: 'a little warmth, no fumes trapped' },
  { name: 'ABS / ASA', threshold: 60, hint: 'hold the heat, fan stays off' },
]

export default function ChamberCard({ status, className = '' }: { status: Status; className?: string }) {
  const c = status.chamber
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [thr, setThr] = useState<number>(c?.fan_target || 35)
  const [heat, setHeat] = useState<number>(c?.heater?.target || 0)
  const [dragT, setDragT] = useState(false)
  const [dragH, setDragH] = useState(false)
  useEffect(() => { if (!dragT && !busy) setThr(c?.fan_target || 35) }, [c?.fan_target, dragT, busy])
  useEffect(() => { if (!dragH && !busy) setHeat(c?.heater?.target || 0) }, [c?.heater?.target, dragH, busy])
  if (!c) return null

  const run = async (label: string, body: { fan_threshold?: number; heat?: number }) => {
    setBusy(true); setMsg(null)
    try { await api.setChamber(body); setMsg(`${label}: sent`) } catch (e) { setMsg(`${label}: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  const h = c.heater
  const maxScale = h?.max || 80
  const pctOf = (v: number) => `${Math.max(0, Math.min(100, (v / maxScale) * 100))}%`
  const above = c.temp >= c.fan_target
  const state = h && h.target > 0
    ? (h.temp < h.target - 1 ? `heating to ${h.target.toFixed(0)}°` : `holding ${h.target.toFixed(0)}°`)
    : c.fan_on ? 'venting' : above ? 'at threshold' : 'passive'

  return (
    <div className={`card chamber ${className}`}>
      <h2>Chamber <span>{state}</span></h2>
      <div className="ch-top">
        <div className="ch-big"><span className="num">{c.temp.toFixed(1)}°</span><small>seen {c.min_seen.toFixed(0)}° to {c.max_seen.toFixed(0)}° since boot</small></div>
        <div className="ch-gauge" aria-hidden>
          <i className="fill" style={{ width: pctOf(c.temp) }} />
          <i className="mark thr" style={{ left: pctOf(c.fan_target) }} title={`exhaust fan above ${c.fan_target.toFixed(0)}°`} />
          {h && h.target > 0 && <i className="mark set" style={{ left: pctOf(h.target) }} title={`heater setpoint ${h.target.toFixed(0)}°`} />}
          <b style={{ left: 0 }}>0°</b><b style={{ right: 0 }}>{maxScale}°</b>
        </div>
      </div>

      <div className="ch-row">
        <div className="ch-label">
          <b>Exhaust fan</b>
          <small>{c.fan_on ? `running at ${Math.round(c.fan_speed * 100)} %` : 'off'}. Kicks in above the threshold, so a higher number keeps more of the bed's heat in.</small>
        </div>
        <div className="ch-ctl">
          <input type="range" min={0} max={80} step={1} value={thr} disabled={busy} style={{ ['--fill' as string]: `${(thr / 80) * 100}%` }}
            aria-label="exhaust fan threshold"
            onChange={e => { setDragT(true); setThr(Number(e.target.value)) }}
            onMouseUp={() => { setDragT(false); void run('threshold', { fan_threshold: thr }) }}
            onTouchEnd={() => { setDragT(false); void run('threshold', { fan_threshold: thr }) }}
            onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { setDragT(false); void run('threshold', { fan_threshold: thr }) } }} />
          <div className="val">{thr}<small>°</small></div>
        </div>
        <div className="ch-presets">
          {PRESETS.map(p => <button key={p.name} className={`btn small ${c.fan_target === p.threshold ? 'on' : ''}`} disabled={busy} title={p.hint} onClick={() => { setThr(p.threshold); void run(p.name, { fan_threshold: p.threshold }) }}>{p.name} {p.threshold}°</button>)}
        </div>
      </div>

      <div className={`ch-row ${h ? '' : 'absent'}`}>
        <div className="ch-label">
          <b>Heater</b>
          {h
            ? <small>{h.name}, {Math.round(h.power * 100)} % power, max {h.max || 80}°. Setpoint 0 turns it off.</small>
            : <small>Not fitted. The stock K2 has no chamber heater; the chamber warms from the bed only. When a <code>heater_generic</code> for the chamber appears in Klipper this control turns on by itself.</small>}
        </div>
        {h && (
          <div className="ch-ctl">
            <input type="range" min={0} max={h.max || 80} step={1} value={heat} disabled={busy} style={{ ['--fill' as string]: pctOf(heat) }}
              aria-label="chamber heater setpoint"
              onChange={e => { setDragH(true); setHeat(Number(e.target.value)) }}
              onMouseUp={() => { setDragH(false); void run('heat', { heat }) }}
              onTouchEnd={() => { setDragH(false); void run('heat', { heat }) }} />
            <div className="val">{heat}<small>°</small></div>
            <button className="btn small danger" disabled={busy || heat === 0} onClick={() => { setHeat(0); void run('heater off', { heat: 0 }) }}>off</button>
          </div>
        )}
      </div>
      {msg && <div className={`msg ${/sent$/.test(msg) ? '' : 'err'}`} style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}
