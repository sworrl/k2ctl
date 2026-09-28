import { useEffect, useMemo, useState } from 'react'
import { api, fmtDuration, type CostSettings, type Job, type JobLedger } from '../api'

type Filter = 'all' | 'completed' | 'cancelled'
type Sort = 'new' | 'cost' | 'weight' | 'time'

function money(v: number, cur: string): string {
  if (!isFinite(v)) return '-'
  return v < 1 && v > 0 ? `${cur}${v.toFixed(3)}` : `${cur}${v.toFixed(2)}`
}
function grams(g: number): string { return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(g < 10 ? 1 : 0)} g` }
function day(t: number): string {
  const d = new Date(t * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const statusPill: Record<string, string> = { in_progress: 'printing', completed: 'complete', cancelled: 'paused', error: 'error', klippy_shutdown: 'error', klippy_disconnect: 'error' }
const statusWord: Record<string, string> = { in_progress: 'printing', completed: 'done', cancelled: 'cancelled', error: 'error', klippy_shutdown: 'shutdown', klippy_disconnect: 'disconnect' }

export default function LibraryCard({ jobState, className = '' }: { jobState: string; className?: string }) {
  const [led, setLed] = useState<JobLedger | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('new')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Job | null>(null)
  const [editing, setEditing] = useState(false)
  const [more, setMore] = useState(24)

  useEffect(() => {
    let dead = false
    const load = () => api.jobs().then(d => { if (!dead) { setLed(d); setErr(null) } }).catch(e => !dead && setErr((e as Error).message))
    load()
    const t = window.setInterval(load, jobState === 'printing' ? 15000 : 60000)
    return () => { dead = true; clearInterval(t) }
  }, [jobState])

  const list = useMemo(() => {
    if (!led) return []
    const needle = q.trim().toLowerCase()
    const l = led.jobs.filter(j => (filter === 'all' || j.status === filter || (filter === 'cancelled' && j.status !== 'completed' && j.status !== 'in_progress'))
      && (!needle || `${j.title} ${j.file} ${j.materials.map(m => `${m.type} ${m.name}`).join(' ')}`.toLowerCase().includes(needle)))
    const by: Record<Sort, (a: Job, b: Job) => number> = {
      new: (a, b) => b.start - a.start, cost: (a, b) => b.cost - a.cost, weight: (a, b) => b.g - a.g, time: (a, b) => b.total_s - a.total_s,
    }
    return [...l].sort(by[sort])
  }, [led, filter, sort, q])

  const cur = led?.settings.currency ?? '$'
  const shown = useMemo(() => {
    const t = { g: 0, kwh: 0, fil: 0, en: 0, cost: 0, n: list.length }
    for (const j of list) { t.g += j.g; t.kwh += j.kwh; t.fil += j.filament_cost; t.en += j.energy_cost; t.cost += j.cost }
    return t
  }, [list])
  const wasted = useMemo(() => (led?.jobs ?? []).filter(j => j.status !== 'completed' && j.status !== 'in_progress').reduce((a, j) => a + j.cost, 0), [led])

  return (
    <div className={`card library ${className}`}>
      <h2>Print library <span>{led ? `${led.totals.jobs} jobs · ${led.totals.hours.toFixed(0)} h on the printer` : err ? err : 'loading'}</span></h2>
      {led && (
        <>
          <div className="lib-totals">
            <div className="lib-big"><small>{filter === 'all' && !q ? 'all prints' : `${shown.n} shown`}</small><b className="tnum">{money(shown.cost, cur)}</b></div>
            <div><small>filament</small><b className="tnum">{money(shown.fil, cur)}</b><em className="tnum">{grams(shown.g)}</em></div>
            <div><small>electricity</small><b className="tnum">{money(shown.en, cur)}</b><em className="tnum">{shown.kwh.toFixed(1)} kWh</em></div>
            <div><small>failed or cancelled</small><b className="tnum">{money(wasted, cur)}</b><em>of all prints</em></div>
            <button className="btn small" onClick={() => setEditing(true)} title="spool prices, electricity price and heater wattages">Prices</button>
          </div>
          <div className="lib-tools">
            <div className="seg">
              {(['all', 'completed', 'cancelled'] as Filter[]).map(f => <button key={f} className={`btn small ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'cancelled' ? 'cancelled / failed' : f}</button>)}
            </div>
            <input className="search" placeholder="Search name or material" value={q} onChange={e => setQ(e.target.value)} />
            <select className="lib-sort" value={sort} onChange={e => setSort(e.target.value as Sort)}>
              <option value="new">Newest</option><option value="cost">Most expensive</option><option value="weight">Heaviest</option><option value="time">Longest</option>
            </select>
          </div>
          <div className="lib-grid">
            {list.slice(0, more).map(j => <Tile key={j.id} j={j} cur={cur} onOpen={() => setOpen(j)} />)}
          </div>
          {list.length > more && <div className="lib-more"><button className="btn small" onClick={() => setMore(more + 24)}>Show {Math.min(24, list.length - more)} more of {list.length - more}</button></div>}
          {list.length === 0 && <div className="msg">No prints match.</div>}
        </>
      )}
      {open && led && <JobDialog j={led.jobs.find(x => x.id === open.id) ?? open} s={led.settings} onClose={() => setOpen(null)} />}
      {editing && led && <PriceDialog s={led.settings} onClose={() => setEditing(false)} onSaved={() => api.jobs().then(setLed)} />}
    </div>
  )
}

function Swatches({ j }: { j: Job }) {
  return <span className="lib-sw">{j.materials.map((m, i) => <i key={i} style={{ background: m.color || 'var(--line-2)' }} title={`${m.type} ${m.name ?? ''}`} />)}</span>
}

function Tile({ j, cur, onOpen }: { j: Job; cur: string; onOpen: () => void }) {
  const types = [...new Set(j.materials.map(m => m.type))].join(' + ')
  return (
    <button className={`lib-tile ${j.status}`} onClick={onOpen}>
      <div className="lib-thumb">
        {j.thumb ? <img src={`/api/jobs/${encodeURIComponent(j.id)}/thumb`} alt="" loading="lazy" />
          : <div className="lib-noimg" style={{ background: j.materials[0]?.color || 'var(--panel-3)' }} />}
        <span className={`pill ${statusPill[j.status] ?? 'standby'}`}>{statusWord[j.status] ?? j.status}</span>
        <span className="lib-cost tnum">{money(j.cost, cur)}</span>
      </div>
      <div className="lib-meta">
        <div className="lib-title" title={j.file}>{j.title || j.file}</div>
        <div className="lib-line"><Swatches j={j} />{types} · {grams(j.g)} · {fmtDuration(j.total_s)}</div>
        <div className="lib-line dim" title={`${money(j.filament_cost, cur)} filament, ${money(j.energy_cost, cur)} electricity`}>{day(j.start)} · {j.kwh.toFixed(2)} kWh</div>
      </div>
    </button>
  )
}

function JobDialog({ j, s, onClose }: { j: Job; s: CostSettings; onClose: () => void }) {
  const cur = s.currency
  const avgW = j.total_s > 0 ? (j.kwh * 3.6e6) / j.total_s : 0
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header><h3>{j.title || j.file}</h3><button className="btn" onClick={onClose}>Close</button></header>
        <div className="body lib-detail">
          {j.thumb && <img src={`/api/jobs/${encodeURIComponent(j.id)}/thumb`} alt="" />}
          <div>
            <div className="lib-kv">
              <span>Total</span><b className="tnum">{money(j.cost, cur)}</b>
              <span>Status</span><b>{statusWord[j.status] ?? j.status}</b>
              <span>Started</span><b className="tnum">{day(j.start)}</b>
              <span>On the printer</span><b className="tnum">{fmtDuration(j.total_s)}{j.print_s && Math.abs(j.total_s - j.print_s) > 60 ? ` (${fmtDuration(j.print_s)} printing)` : ''}</b>
              <span>Filament</span><b className="tnum">{(j.filament_mm / 1000).toFixed(2)} m, {grams(j.g)}, {money(j.filament_cost, cur)}</b>
              <span>Electricity</span><b className="tnum">{j.kwh.toFixed(2)} kWh at {money(s.kwh_price, cur)}, {money(j.energy_cost, cur)} (about {avgW.toFixed(0)} W average)</b>
              <span>Power basis</span><b>{j.measured_pct >= 99 ? 'metered' : j.measured_pct > 0 ? `${j.measured_pct.toFixed(0)} % metered, rest estimated` : 'estimated from bed and nozzle temperatures'}</b>
              <span>Temperatures</span><b className="tnum">nozzle {j.nozzle_c.toFixed(0)}°, bed {j.bed_c.toFixed(0)}°</b>
              <span>File</span><b className="lib-file">{j.file}{j.exists ? '' : ' (deleted)'}</b>
            </div>
            <table className="lib-mats">
              <thead><tr><th /><th>Material</th><th>Weight</th><th>Price / kg</th><th>Cost</th></tr></thead>
              <tbody>{j.materials.map((m, i) => (
                <tr key={i}><td><i className="lib-dot" style={{ background: m.color || 'var(--line-2)' }} /></td>
                  <td>{m.type}<small>{m.name}{m.source !== 'gcode' ? ` (type from ${m.source})` : ''}</small></td>
                  <td className="tnum">{grams(m.g)}</td><td className="tnum">{money(m.price_kg, cur)}</td><td className="tnum">{money(m.cost, cur)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function PriceDialog({ s, onClose, onSaved }: { s: CostSettings; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<CostSettings>({ ...s, price_per_kg: { ...s.price_per_kg } })
  const [newType, setNewType] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const numField = (k: keyof CostSettings, label: string, hint: string, step = '0.01') => (
    <label className="lib-field"><span>{label}</span>
      <input type="number" step={step} min="0" value={f[k] as number} onChange={e => setF({ ...f, [k]: parseFloat(e.target.value) || 0 })} />
      <small>{hint}</small></label>
  )
  const save = async () => {
    setBusy(true); setMsg(null)
    try { await api.setCostSettings(f); onSaved(); onClose() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header><h3>Prices and power</h3><button className="btn" onClick={onClose}>Close</button></header>
        <div className="body">
          <div className="lib-form">
            <label className="lib-field"><span>Currency</span><input value={f.currency} maxLength={4} onChange={e => setF({ ...f, currency: e.target.value })} /><small>symbol shown before amounts</small></label>
            {numField('kwh_price', 'Electricity per kWh', 'from your power bill')}
            {numField('default_kg', 'Spool price per kg, fallback', 'for types not in the table below')}
            {numField('hotend_w', 'Hotend heater, W', 'Creality spec: 70 W', '1')}
            {numField('bed_w', 'Bed heater, W at full power', 'estimate; measure at the wall to correct it', '1')}
            {numField('base_w', 'Base load, W', 'board, screen, motors, fans, camera, CFS', '1')}
            {numField('ambient_c', 'Room temperature, °C', 'for estimating jobs k2ctl did not meter', '1')}
          </div>
          <h4 className="lib-h4">Spool price per kg by type</h4>
          <div className="lib-form">
            {Object.entries(f.price_per_kg).sort().map(([t, v]) => (
              <label key={t} className="lib-field"><span>{t}</span>
                <input type="number" step="0.01" min="0" value={v} onChange={e => setF({ ...f, price_per_kg: { ...f.price_per_kg, [t]: parseFloat(e.target.value) || 0 } })} /></label>
            ))}
            <label className="lib-field"><span>Add a type</span>
              <input placeholder="e.g. PLA-CF" value={newType} onChange={e => setNewType(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter' && newType.trim()) { setF({ ...f, price_per_kg: { ...f.price_per_kg, [newType.trim()]: f.default_kg } }); setNewType('') } }} />
              <small>Enter adds it at the fallback price</small></label>
          </div>
          <p className="lib-note">Every past job is repriced when you save. A price of 0 removes a type from the table, and its jobs then use the price in the gcode or the fallback.</p>
          {msg && <div className="msg err">{msg}</div>}
        </div>
        <footer><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save and reprice</button></footer>
      </div>
    </div>
  )
}
