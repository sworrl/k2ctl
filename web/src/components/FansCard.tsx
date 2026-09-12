import { useEffect, useState } from 'react'
import { api, type FanCtrl, type FanKey, type Status } from '../api'
import { useTween } from '../motion'

const FANS: { key: FanKey; name: string; hint: string }[] = [
  { key: 'part', name: 'Part fan', hint: 'model cooling · M106 P0' },
  { key: 'aux', name: 'Auxiliary fan', hint: 'side cooling · M106 P2' },
  { key: 'chamber', name: 'Chamber fan', hint: 'case / exhaust · M106 P1' },
]

function FanGlyph({ pct, on }: { pct: number; on: boolean }) {
  const spin = on && pct > 0
  return (
    <svg className={`fanglyph ${spin ? 'spin' : ''}`} viewBox="0 0 24 24" width={26} height={26} aria-hidden
      style={{ animationDuration: spin ? `${(2.6 - (pct / 100) * 2.2).toFixed(2)}s` : undefined }}>
      <circle cx={12} cy={12} r={11} fill="none" stroke="var(--line-2)" strokeWidth={1.2} />
      {[0, 120, 240].map(d => <path key={d} d="M12 12 C16 10 17 5 13 3.5 C12.4 6 12 9 12 12 Z" fill={spin ? 'var(--accent)' : 'var(--muted)'} transform={`rotate(${d} 12 12)`} />)}
      <circle cx={12} cy={12} r={2.2} fill={spin ? 'var(--accent)' : 'var(--muted)'} />
    </svg>
  )
}

function Pct({ v }: { v: number }) { const t = useTween(v, 400); return <>{Math.round(t)}</> }

function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className={`switch ${on ? 'on' : ''}`} title={`${label}: ${on ? 'on' : 'off'}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="knob" /></span>
    </label>
  )
}

export default function FansCard({ status, className = '' }: { status: Status; className?: string }) {
  const ctrl: FanCtrl | undefined = status.fan_ctrl
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // Slider values while the user is dragging; cleared once the live state catches up.
  const [drag, setDrag] = useState<Partial<Record<FanKey, number>>>({})

  useEffect(() => { if (!busy) setDrag({}) }, [status.updated_at, busy])

  if (!ctrl) return <div className={`card ${className}`}><h2>Fans</h2><div className="fan-note">Backend too old: no fan_ctrl in status.</div></div>

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setMsg(null)
    try { await fn(); setMsg(null) } catch (e) { setMsg(`${name}: ${(e as Error).message}`) } finally { setBusy(null) }
  }
  const setPct = (k: FanKey, pct: number) => run(k, () => api.setFans({ [k]: pct }))
  const setOn = (k: FanKey, on: boolean) => run(k, () => api.setFans({ [`${k}_on`]: on }))
  const rec = ctrl.recommended
  const idle = status.job.state !== 'printing' && status.job.state !== 'paused'
  const printing = status.job.state === 'printing'

  return (
    <div className={`card ${className}`}>
      <h2>Fans <small style={{ textTransform: 'none', letterSpacing: 0 }}>{printing ? 'live · the print job owns these' : 'live'}</small></h2>
      <div className="fan-rows">
        {FANS.map(({ key, name, hint }) => {
          const f = ctrl[key]
          const shown = drag[key] ?? f.pct
          return (
            <div key={key} className={`fan-row ${f.on ? 'on' : 'off'}`}>
              <div className="fan-name">
                <Toggle on={f.on} disabled={busy !== null} label={name} onChange={(v) => void setOn(key, v)} />
                <FanGlyph pct={shown} on={f.on} />
                <div><b>{name}</b><br /><small>{hint}</small></div>
              </div>
              <input type="range" min={0} max={100} step={5} value={shown} disabled={busy !== null} style={{ ['--fill' as string]: `${shown}%` }}
                aria-label={`${name} percent`}
                onChange={(e) => setDrag((d) => ({ ...d, [key]: Number(e.target.value) }))}
                onMouseUp={(e) => void setPct(key, Number((e.target as HTMLInputElement).value))}
                onTouchEnd={(e) => void setPct(key, Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) void setPct(key, Number((e.target as HTMLInputElement).value)) }} />
              <div className="val"><Pct v={shown} /><small> %</small></div>
            </div>
          )
        })}
      </div>
      <div className="fan-rec">
        <button className="btn" disabled={busy !== null} title={`part ${rec.part}% · aux ${rec.aux}% · chamber ${rec.chamber}%`}
          onClick={() => void run('recommended', () => api.fansRecommended())}>
          Recommended ({rec.source})
        </button>
        <span className="rec-vals">part {rec.part}% · aux {rec.aux}% · chamber {rec.chamber}%</span>
      </div>
      {idle && <div className="fan-note">Printer is idle: these act on the live fans now. When a print starts, the firmware and the sliced filament settings take over the fans again.</div>}
      {msg && <div className="msg err" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}
