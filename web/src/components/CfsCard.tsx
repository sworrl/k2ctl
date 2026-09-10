import { flexible, swatchStyle, type Box, type Slot, type Status } from '../api'

export default function CfsCard({ status, onPick, className = '' }: { status: Status; onPick: (box: Box, slot: Slot) => void; className?: string }) {
  const cfs = status.cfs
  return (
    <div className={`card ${className}`}>
      <h2>Filament <span>{cfs.connected ? 'CFS connected' : 'CFS not connected'}{cfs.active ? ` · feeding ${cfs.active}` : ''}</span></h2>
      <div className="boxes">
        {(cfs.boxes ?? []).map(box => (
          <div key={box.id}>
            <div className="box-head">
              <span className="box-name">{box.type === 0 ? `CFS ${box.name}` : box.name}</span>
              {box.type === 0 && (
                <span className="box-climate">
                  <span title="temperature inside the CFS">{box.temp.toFixed(0)}° <i className="tb"><b style={{ width: `${Math.min(100, (box.temp / 60) * 100)}%` }} /></i></span>
                  <span title="humidity inside the CFS; swap the desiccant when this climbs">{box.humidity.toFixed(0)} % RH <i className={`tb ${box.humidity > 50 ? 'warn' : ''}`}><b style={{ width: `${Math.min(100, box.humidity)}%` }} /></i></span>
                </span>
              )}
              <span>{(box.slots ?? []).length} slot{(box.slots ?? []).length === 1 ? '' : 's'}</span>
            </div>
            <div className="slots">
              {(box.slots ?? []).map(s => (
                <button key={s.id} className={`slot ${s.selected ? 'active' : ''} ${s.state === 0 ? 'empty' : ''}`} onClick={() => onPick(box, s)}
                  style={{ ['--slot-color' as string]: (s.colors?.length ?? 0) > 1 ? swatchStyle(s.colors) : (s.color || 'var(--line-2)'), ['--swatch' as string]: swatchStyle(s.colors, s.color) }}
                  title={`${s.vendor} ${s.name} (${s.type}) ${s.min_temp}-${s.max_temp}°C PA ${s.pressure}${(s.colors?.length ?? 0) > 1 ? ' · rainbow: shifts as used' : ''}`}>
                  <span className="spool" aria-hidden="true"><i /></span>
                  <span className="label">{s.label}{s.selected && <span className="badge">FEEDING</span>}</span>
                  <span className="name">{s.name || 'empty'}</span>
                  <span className="meta">{[s.vendor, s.type].filter(Boolean).join(' · ')}{s.type ? ` · ${s.min_temp}-${s.max_temp}°` : ''}</span>
                  {s.state !== 0 && s.percent > 0 && s.percent < 100 && (
                    <span className="left" title={`${s.percent}% of the spool left (printer estimate)`}><i className="tb"><b style={{ width: `${s.percent}%` }} /></i>{s.percent}% left</span>
                  )}
                  {box.type === 0 && flexible(s.type, s.name) && <span className="hint warn" title="Creality: flexible filament bends in the CFS tubes and jams feeding/unloading">Warning: TPU: use the external spool holder</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        {(cfs.boxes ?? []).length === 0 && <div className="msg">No filament boxes reported yet.</div>}
        {(cfs.boxes ?? []).some(b => (b.slots ?? []).some(s => (s.colors?.length ?? 0) > 1)) &&
          <div className="legend"><i className="swatch rainbow" style={{ background: 'linear-gradient(90deg,#ff4d4d,#ffb400,#3ddc84,#2b8cff,#b56cff)' }} /> gradient swatch = rainbow spool, color shifts as it is used (the printer only knows the middle color)</div>}
      </div>
    </div>
  )
}
