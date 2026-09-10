import { useEffect, useRef, useState } from 'react'

export interface Temp { actual: number; target: number; max?: number }
export interface Slot {
  id: number; label: string; vendor: string; type: string; name: string; color: string; colors?: string[]; rfid: string
  min_temp: number; max_temp: number; pressure: number; percent: number; selected: boolean; state: number; editable: boolean
}
export interface Box { id: number; name: string; type: number; state: number; temp: number; humidity: number; serial?: string; slots: Slot[] }
export interface Status {
  printer: { hostname: string; name: string; model: string; state: string; raw_state: number; connected: boolean; klipper?: string; firmware?: string }
  temps: Record<string, Temp>
  job: { file: string; state: string; progress: number; layer: number; total_layers: number; time_left_s: number; elapsed_s: number; started_at?: number }
  cfs: { connected: boolean; enabled: boolean; boxes: Box[]; tool_map?: Record<string, string>; active?: string }
  light: boolean
  fans: Record<string, number>
  fan_on?: Record<string, boolean>
  fan_ctrl: FanCtrl
  speed_pct: number
  flow_pct: number
  position: string
  errors: string[]
  sources: Record<string, boolean>
  sensors: Record<string, Record<string, unknown>>
  device: Record<string, unknown>
  updated_at: string
}
export interface Fan { on: boolean; pct: number }
export interface FanRec { part: number; aux: number; chamber: number; source: string }
export interface FanCtrl { part: Fan; aux: Fan; chamber: Fan; recommended: FanRec }
export type FanKey = 'part' | 'aux' | 'chamber'
export interface Profile {
  id: string; vendor: string; name: string; type: string; min_temp: number; max_temp: number; pressure: number
  rfid?: string; color?: string; colors?: string[]; density?: number; notes?: string; slicer_preset?: string
  cfs?: { ok: boolean; reason?: string }; warnings?: string[]; dry?: { temp_c: number; hours: number }
}

/** Error thrown by request(); carries the HTTP status and the JSON body (e.g. cfs_incompatible). */
export class ApiError extends Error {
  status: number; body: Record<string, unknown>
  constructor(status: number, body: Record<string, unknown>, msg: string) { super(msg); this.status = status; this.body = body }
}

/** Flexible filament cannot be fed by the CFS (Creality: it bends in the tubes). */
export function flexible(type?: string, name?: string): boolean { return /TPU|TPE|FLEX/i.test(`${type ?? ''} ${name ?? ''}`) }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, body, body.error || r.statusText)
  return body as T
}

export const api = {
  status: () => request<Status>('/api/status'),
  profiles: () => request<Profile[]>('/api/profiles'),
  setMaterial: (box: number, slot: number, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/cfs/${box}/${slot}/material`, { method: 'POST', body: JSON.stringify(body) }),
  print: (action: 'pause' | 'resume' | 'cancel') =>
    request<{ ok: boolean }>(`/api/print/${action}`, { method: 'POST', body: JSON.stringify({ confirm: action === 'cancel' }) }),
  light: (on: boolean) => request<{ ok: boolean }>('/api/light', { method: 'POST', body: JSON.stringify({ on }) }),
  fans: () => request<FanCtrl>('/api/fans'),
  /** body: {part|aux|chamber: percent} and/or {part_on|aux_on|chamber_on: bool} */
  setFans: (body: Partial<Record<FanKey, number>> & Partial<Record<`${FanKey}_on`, boolean>>) =>
    request<FanCtrl>('/api/fans', { method: 'POST', body: JSON.stringify(body) }),
  fansRecommended: (profile?: string) =>
    request<{ ok: boolean; applied: FanRec; fans: FanCtrl }>('/api/fans/recommended', { method: 'POST', body: JSON.stringify(profile ? { profile } : {}) }),
  gcode: (script: string) => request<{ ok: boolean }>('/api/gcode', { method: 'POST', body: JSON.stringify({ script }) }),
}

/** Live status over the backend WebSocket, with polling as a fallback. */
export function useStatus(): { status: Status | null; live: boolean; error: string | null } {
  const [status, setStatus] = useState<Status | null>(null)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let retry = 1000
    let pollTimer: number | undefined

    const poll = async () => {
      try {
        setStatus(await api.status())
        setError(null)
      } catch (e) {
        setError((e as Error).message)
      }
    }

    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/api/ws`)
      wsRef.current = ws
      ws.onopen = () => { setLive(true); setError(null); retry = 1000; if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined } }
      ws.onmessage = (ev) => { try { setStatus(JSON.parse(ev.data)) } catch { /* ignore */ } }
      ws.onclose = () => {
        setLive(false)
        if (closed) return
        if (!pollTimer) { void poll(); pollTimer = window.setInterval(poll, 3000) }
        setTimeout(connect, retry)
        retry = Math.min(retry * 2, 15000)
      }
      ws.onerror = () => ws.close()
    }
    void poll()
    connect()
    return () => { closed = true; wsRef.current?.close(); if (pollTimer) clearInterval(pollTimer) }
  }, [])

  return { status, live, error }
}

/** CSS background for a single color or a multi-color (rainbow) spool. */
export function swatchStyle(colors?: string[] | null, single?: string): string {
  const cs = (colors && colors.length ? colors : single ? [single] : []).filter(Boolean)
  if (cs.length === 0) return 'transparent'
  if (cs.length === 1) return cs[0]
  return `linear-gradient(90deg, ${cs.join(', ')})`
}

export function fmtDuration(s: number): string {
  if (!s || s < 0) return '-'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m ${Math.floor(s % 60).toString().padStart(2, '0')}s`
}

export function baseName(p: string): string {
  return p ? p.split('/').pop() || p : ''
}
