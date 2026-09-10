import { useState } from 'react'
import { api, type Status } from '../api'

export default function ControlsCard({ status, className = '' }: { status: Status; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const st = status.job.state
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setMsg(null)
    try { await fn(); setMsg(`${name}: ok`) } catch (e) { setMsg(`${name}: ${(e as Error).message}`) } finally { setBusy(null) }
  }
  const cancel = () => { if (confirm('Cancel the running print?')) void run('cancel', () => api.print('cancel')) }
  return (
    <div className={`card ${className}`}>
      <h2>Controls</h2>
      <div className="controls">
        {st === 'printing'
          ? <button className="btn" disabled={busy !== null} onClick={() => run('pause', () => api.print('pause'))}>Pause</button>
          : <button className="btn primary" disabled={busy !== null || st !== 'paused'} onClick={() => run('resume', () => api.print('resume'))}>Resume</button>}
        <button className="btn danger" disabled={busy !== null || (st !== 'printing' && st !== 'paused')} onClick={cancel}>Cancel</button>
        <label className={`switch ${status.light ? 'on' : ''}`} title={status.light ? 'Chamber light is on. Click to turn it off' : 'Chamber light is off. Click to turn it on'}>
          <input type="checkbox" checked={!!status.light} disabled={busy !== null} onChange={e => run('light', () => api.light(e.target.checked))} />
          <span className="track"><span className="knob" /></span>
          <span className="switch-label">Chamber light <b>{status.light ? 'ON' : 'OFF'}</b></span>
        </label>
      </div>
      {msg && <div className="msg" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}
