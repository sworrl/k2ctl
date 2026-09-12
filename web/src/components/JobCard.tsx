import { baseName, fmtClock, fmtHMS, type Status } from '../api'
import { useTween } from '../motion'

function Ring({ pct }: { pct: number }) {
  const r = 36, c = 2 * Math.PI * r
  const p = Math.min(100, Math.max(0, useTween(pct, 900)))
  const a = (p / 100) * 2 * Math.PI - Math.PI / 2
  const hx = 46 + r * Math.cos(a), hy = 46 + r * Math.sin(a)
  return (
    <svg className="ring" width={92} height={92} viewBox="0 0 92 92" aria-hidden>
      <defs>
        <linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" /><stop offset=".5" stopColor="#2b8cff" /><stop offset="1" stopColor="#b56cff" />
        </linearGradient>
        <filter id="ringglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" /></filter>
      </defs>
      <circle cx={46} cy={46} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={7} />
      <circle cx={46} cy={46} r={r + 5} fill="none" stroke="var(--line)" strokeWidth={1} strokeDasharray="2 5" className="ring-orbit" />
      <circle cx={46} cy={46} r={r} fill="none" stroke="url(#ringg)" strokeWidth={7} strokeLinecap="round" filter="url(#ringglow)" opacity={.55}
        strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 46 46)" />
      <circle cx={46} cy={46} r={r} fill="none" stroke="url(#ringg)" strokeWidth={7} strokeLinecap="round"
        strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 46 46)" />
      {p > 0.5 && p < 99.5 && <circle cx={hx} cy={hy} r={5} fill="#fff" className="ring-head" />}
      <text x={46} y={51} textAnchor="middle" className="ring-num">{p.toFixed(p >= 99.5 ? 0 : 1)}%</text>
    </svg>
  )
}

export default function JobCard({ status, className = '' }: { status: Status; className?: string }) {
  const j = status.job
  const idle = !j.file || j.state === 'standby'
  const layers = j.total_layers > 0 ? (j.layer / j.total_layers) * 100 : 0
  return (
    <div className={`card job ${className}`}>
      <h2>Job <span className={`pill ${j.state}`}>{j.state}</span></h2>
      {idle ? (
        <div className="job-idle">
          <div>Nothing printing.</div>
          <div className="job-mini"><span>Speed <b>{status.speed_pct} %</b></span><span>Flow <b>{status.flow_pct} %</b></span></div>
        </div>
      ) : (
        <>
          <div className="job-top">
            <Ring pct={j.progress} />
            <div className="job-text">
              <div className="job-file" title={j.file}>{baseName(j.file)}</div>
              <div className="job-eta"><b>{fmtHMS(j.time_left_s)}</b> left, done about <b>{fmtClock(j.time_left_s, true)}</b></div>
              <div className="job-sub">{fmtHMS(j.elapsed_s)} elapsed{j.started_at ? `, started ${fmtClock(j.started_at)}` : ''}</div>
            </div>
          </div>
          <div className="job-layer">
            <span>Layer <b>{j.layer}</b>{j.total_layers ? <> / {j.total_layers}</> : null}</span>
            <div className="bar"><i style={{ width: `${Math.min(100, layers)}%` }} /></div>
          </div>
          <div className="job-mini">
            <span>Speed <b>{status.speed_pct} %</b></span>
            <span>Flow <b>{status.flow_pct} %</b></span>
            <span className="pos">{status.position || '-'}</span>
          </div>
        </>
      )}
    </div>
  )
}
