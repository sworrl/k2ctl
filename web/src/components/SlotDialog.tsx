import { useMemo, useState } from 'react'
import { api, ApiError, swatchStyle, type Box, type Profile, type Slot } from '../api'

export default function SlotDialog({ box, slot, profiles, printing, onClose }:
  { box: Box; slot: Slot; profiles: Profile[]; printing: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Profile | null>(null)
  const [color, setColor] = useState(slot.color || '#ffffff')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)   // CFS refusal reason, offers "Load anyway"

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = profiles.filter(p => !needle || `${p.vendor} ${p.name} ${p.type}`.toLowerCase().includes(needle))
    const g = new Map<string, Profile[]>()
    for (const p of list) g.set(p.vendor, [...(g.get(p.vendor) || []), p])
    return [...g.entries()]
  }, [profiles, q])

  const apply = async (force = false) => {
    if (!sel) return
    setBusy(true); setMsg(null); setRefused(null)
    try {
      const multi = (sel.colors?.length ?? 0) > 1
      const body: Record<string, unknown> = multi ? { profile: sel.id, colors: sel.colors } : { profile: sel.id, color }
      if (force) body.force = true
      await api.setMaterial(box.id, slot.id, body)
      setMsg(`Slot ${slot.label} set to ${sel.vendor} ${sel.name}.`)
      setTimeout(onClose, 900)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body.cfs_incompatible) setRefused(String(e.body.reason || e.message))
      else setMsg((e as Error).message)
    } finally { setBusy(false) }
  }
  const cfsBay = box.type === 0
  const selCfsBad = !!sel && cfsBay && sel.cfs?.ok === false
  const locked = printing && slot.selected
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header>
          <h3>{slot.label} · {slot.vendor} {slot.name || 'empty'}</h3>
          <button className="btn" onClick={onClose}>Close</button>
        </header>
        <div className="body">
          {locked && <div className="msg err" style={{ marginBottom: 8 }}>This slot is feeding the running print; it can be changed after the job.</div>}
          <input className="search" placeholder="Search vendor, name or type…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          {groups.map(([vendor, list]) => (
            <div key={vendor}>
              <div className="vendor">{vendor}</div>
              <div className="plist">
                {list.map(p => (
                  <button key={p.id} className={`pitem ${sel?.id === p.id ? 'sel' : ''}`} onClick={() => setSel(p)} title={p.notes || ''}>
                    <div>{(p.colors?.length ?? 0) > 1 && <i className="swatch mini rainbow" style={{ background: swatchStyle(p.colors) }} />}{p.name}</div>
                    <div className="t">{p.type} · {p.min_temp}-{p.max_temp}° · PA {p.pressure}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {groups.length === 0 && <div className="msg">No profiles match.</div>}
        </div>
        {sel && (sel.warnings?.length || sel.dry || selCfsBad || sel.cfs?.reason) ? (
          <div className="profile-info">
            {selCfsBad && <div className="msg err">Warning: {sel.vendor} {sel.name} is not CFS-compatible: {sel.cfs?.reason}. Put it on the external spool holder instead.</div>}
            {!selCfsBad && sel.cfs?.reason && <div className="msg warn">CFS: {sel.cfs.reason}</div>}
            {sel.dry && <div className="msg">Dry {sel.dry.temp_c} °C for {sel.dry.hours} h before use.</div>}
            {(sel.warnings ?? []).map((w, i) => <div key={i} className="msg warn">• {w}</div>)}
          </div>) : null}
        {refused && (
          <div className="profile-info">
            <div className="msg err">The CFS refused this spool: {refused}</div>
            <div className="msg">Creality's guidance is to print it from the external spool holder. If you really have it in this bay, you can record it anyway.</div>
            <button className="btn danger" disabled={busy} onClick={() => apply(true)}>Load anyway</button>
          </div>)}
        <footer>
          {(sel?.colors?.length ?? 0) > 1
            ? <label className="colorpick">Rainbow <i className="swatch mini rainbow" style={{ background: swatchStyle(sel!.colors) }} /> <span className="msg">shifts as used · printer gets {sel!.colors![Math.floor(sel!.colors!.length / 2)]}</span></label>
            : <label className="colorpick">Color <input type="color" value={color} onChange={e => setColor(e.target.value)} /> <span className="msg">{color}</span></label>}
          {msg && <span className={`msg ${msg.includes('set to') ? '' : 'err'}`}>{msg}</span>}
          <button className="btn primary" disabled={!sel || busy || locked} onClick={() => apply(false)}>{busy ? 'Applying…' : 'Apply to slot'}</button>
        </footer>
      </div>
    </div>
  )
}
