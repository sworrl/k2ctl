import { baseName, fmtDuration, type Status } from '../api'

export default function JobCard({ status, className = '' }: { status: Status; className?: string }) {
  const j = status.job
  const idle = !j.file || j.state === 'standby'
  return (
    <div className={`card ${className}`}>
      <h2>Job <span>{j.state}</span></h2>
      {idle ? <div className="job-idle">Nothing printing. Speed {status.speed_pct} %, flow {status.flow_pct} %.</div> : (
        <>
          <div className="job-file">{baseName(j.file)}</div>
          <div className="job-big"><span className="pct">{j.progress.toFixed(0)}%</span><span className="eta">{fmtDuration(j.time_left_s)} left · {fmtDuration(j.elapsed_s)} done</span></div>
          <div className="bar spectrum"><i style={{ width: `${Math.min(100, Math.max(0, j.progress))}%` }} /></div>
          <dl className="kv">
            <dt>Layer</dt><dd>{j.layer}{j.total_layers ? ` / ${j.total_layers}` : ''}</dd>
            <dt>Speed / flow</dt><dd>{status.speed_pct}% / {status.flow_pct}%</dd>
            <dt>Position</dt><dd>{status.position || '-'}</dd>
          </dl>
        </>
      )}
    </div>
  )
}
