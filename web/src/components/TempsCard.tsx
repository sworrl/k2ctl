import type { Status } from '../api'

const ROWS: [string, string, number][] = [['nozzle', 'Nozzle', 300], ['bed', 'Bed', 120], ['chamber', 'Chamber', 60]]

export default function TempsCard({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <div className={`card ${className}`}>
      <h2>Temperatures</h2>
      {ROWS.map(([key, label, scale]) => {
        const t = status.temps[key]
        if (!t) return null
        const max = t.max || scale
        return (
          <div className="temp-row" key={key}>
            <span className="name">{label}</span>
            <div className="bar temp"><i style={{ width: `${Math.min(100, (t.actual / max) * 100)}%` }} /></div>
            <span className="val">{t.actual.toFixed(1)}°<small>/ {t.target.toFixed(0)}°</small></span>
          </div>
        )
      })}
      <div className="temp-extra">
        {Object.entries(status.fans).map(([k, v]) => <span key={k}>{k === 'part' ? 'Part fan' : k === 'aux' ? 'Aux fan' : k === 'case' ? 'Case fan' : k} <b>{v} %</b></span>)}
        {(status.cfs.boxes ?? []).filter(b => b.type === 0).map(b => <span key={b.id}>{b.name} <b>{b.temp.toFixed(0)}° · {b.humidity.toFixed(0)} % RH</b></span>)}
      </div>
    </div>
  )
}
