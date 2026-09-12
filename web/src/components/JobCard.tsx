import { baseName, fmtClock, fmtHMS, type Status } from '../api'

function Ring({ pct }: { pct: number }) {
  const r = 34, c = 2 * Math.PI * r
  const p = Math.min(100, Math.max(0, pct))
  return (
    <svg className="ring" width={84} height={84} viewBox="0 0 84 84" aria-hidden>
      <circle cx={42} cy={42} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={7} />
      <circle cx={42} cy={42} r={r} fill="none" stroke="var(--accent)" strokeWidth={7} strokeLinecap="round"
        strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 42 42)" style={{ transition: 'stroke-dasharray .6s' }} />
      <text x={42} y={47} textAnchor="middle" className="ring-num">{p.toFixed(p >= 99.5 ? 0 : 1)}%</text>
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
