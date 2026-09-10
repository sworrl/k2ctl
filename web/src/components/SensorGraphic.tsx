import { useRef } from 'react'

// Small inline-SVG graphics for the verbose sensors view. Each row gets one,
// chosen from the field name and value shape (see classify()).

export type Kind =
  | { kind: 'temp'; value: number; target: number; max: number; hist: number[] }
  | { kind: 'pct'; value: number; fan?: boolean }
  | { kind: 'factor'; value: number }
  | { kind: 'bool'; on: boolean }
  | { kind: 'swatch'; colors: string[] }
  | { kind: 'spark'; hist: number[] }
  | { kind: 'axis'; xyz: [number, number, number] }
  | { kind: 'box'; temp: number; humidity: number }
  | { kind: 'text' }

const W = 150, H = 20

export function heat(r: number): string {
  r = Math.max(0, Math.min(1, r))
  const h = r < 0.33 ? 210 - 90 * (r / 0.33) : r < 0.66 ? 120 - 80 * ((r - 0.33) / 0.33) : 40 - 40 * ((r - 0.66) / 0.34)
  return `hsl(${h} 80% 60%)`
}

function Bar({ x, y, w, h, ratio, color, tick }: { x: number; y: number; w: number; h: number; ratio: number; color: string; tick?: number }) {
  const r = Math.max(0, Math.min(1, ratio))
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={3} fill="rgba(128,128,128,.18)" />
      {r > 0 && <rect x={x} y={y} width={w * r} height={h} rx={3} fill={color} />}
      {tick !== undefined && tick >= 0 && <line x1={x + w * Math.min(1, tick)} x2={x + w * Math.min(1, tick)} y1={y - 2} y2={y + h + 2} stroke="currentColor" strokeWidth={1.5} />}
    </g>
  )
}

function Spark({ x, y, w, h, hist, color }: { x: number; y: number; w: number; h: number; hist: number[]; color: string }) {
  if (hist.length < 2) return <line x1={x} x2={x + w} y1={y + h / 2} y2={y + h / 2} stroke="var(--line)" />
  let mn = Math.min(...hist), mx = Math.max(...hist)
  if (mn === mx) { mn -= 1; mx += 1 }
  const pad = (mx - mn) * 0.1; mn -= pad; mx += pad
  const dx = w / (hist.length - 1)
  const pts = hist.map((v, i) => [x + i * dx, y + h - ((v - mn) / (mx - mn)) * h] as const)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <g>
      <path d={`${d} L${(x + w).toFixed(1)},${y + h} L${x},${y + h} Z`} fill={color} opacity={0.18} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.3} />
      <circle cx={last[0]} cy={last[1]} r={1.8} fill={color} />
    </g>
  )
}

function Fan({ cx, cy, r, pct }: { cx: number; cy: number; r: number; pct: number }) {
  const on = pct > 0
  const col = on ? 'var(--accent)' : 'var(--muted)'
  const blade = `M0,0 C${r * 0.9},${-r * 0.2} ${r * 0.9},${-r * 0.9} ${r * 0.15},${-r * 0.75} Z`
  const a = Math.max(0, Math.min(1, pct / 100)) * 2 * Math.PI
  const ex = cx + (r + 1.5) * Math.sin(a), ey = cy - (r + 1.5) * Math.cos(a)
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 1.5} fill="none" stroke="var(--line)" strokeWidth={2} />
      {on && a > 0 && (
        <path d={`M${cx},${cy - r - 1.5} A${r + 1.5},${r + 1.5} 0 ${a > Math.PI ? 1 : 0} 1 ${ex.toFixed(2)},${ey.toFixed(2)}`} fill="none" stroke={col} strokeWidth={2} />
      )}
      {[0, 120, 240].map(deg => <path key={deg} d={blade} fill={col} transform={`translate(${cx},${cy}) rotate(${deg})`} />)}
      <circle cx={cx} cy={cy} r={r * 0.22} fill={col} />
    </g>
  )
}

function Led({ on }: { on: boolean }) {
  return (
    <g>
      {on && <circle cx={10} cy={H / 2} r={7} fill="var(--ok)" opacity={0.28} />}
      <circle cx={10} cy={H / 2} r={4.5} fill={on ? 'var(--ok)' : 'var(--line)'} stroke={on ? 'var(--ok)' : 'var(--muted)'} />
    </g>
  )
}

function Swatch({ colors, id }: { colors: string[]; id: string }) {
  const gid = `g${id.replace(/[^a-z0-9]/gi, '')}`
  return (
    <g>
      {colors.length > 1 && (
        <defs>
          <linearGradient id={gid} x1="0" x2="1" y1="0" y2="0">
            {colors.map((c, i) => <stop key={i} offset={`${(i / (colors.length - 1)) * 100}%`} stopColor={c} />)}
          </linearGradient>
        </defs>
      )}
      <rect x={1} y={3} width={44} height={H - 6} rx={4} fill={colors.length > 1 ? `url(#${gid})` : colors[0] || 'var(--muted)'} stroke="var(--line)" />
    </g>
  )
}

function Tag() {
  return (
    <g stroke="var(--muted)" fill="rgba(128,128,128,.12)">
      <path d={`M1,${H / 2 - 5} H11 L16,${H / 2} L11,${H / 2 + 5} H1 Z`} />
      <circle cx={5} cy={H / 2} r={1.3} fill="var(--muted)" stroke="none" />
    </g>
  )
}

export function Graphic({ g, id }: { g: Kind; id: string }) {
  let body
  switch (g.kind) {
    case 'temp': {
      const scale = g.max || 300
      const c = heat(g.value / scale)
      body = <><Bar x={0} y={6} w={62} h={8} ratio={g.value / scale} color={c} tick={g.target > 0 ? g.target / scale : -1} /><Spark x={70} y={1} w={W - 72} h={H - 2} hist={g.hist} color={c} /></>
      break
    }
    case 'pct': {
      const x0 = g.fan ? 26 : 0
      body = <>{g.fan && <Fan cx={10} cy={H / 2} r={7.5} pct={g.value} />}<Bar x={x0} y={6} w={W - x0 - 4} h={8} ratio={g.value / 100} color={g.value > 0 ? 'var(--accent)' : 'var(--muted)'} /></>
      break
    }
    case 'factor':
      body = <Bar x={0} y={6} w={W - 4} h={8} ratio={g.value / 200} color={Math.abs(g.value - 100) < 0.5 ? 'var(--ok)' : 'var(--warn)'} tick={0.5} />
      break
    case 'bool':
      body = <Led on={g.on} />
      break
    case 'swatch':
      body = <Swatch colors={g.colors} id={id} />
      break
    case 'spark':
      body = <Spark x={0} y={1} w={W - 2} h={H - 2} hist={g.hist} color="var(--accent)" />
      break
    case 'axis': {
      const cols = ['var(--bad)', 'var(--ok)', 'var(--accent)']
      body = <>{g.xyz.map((v, i) => (
        <g key={i}>
          <text x={0} y={5 + i * 6.3} fontSize={5.5} fill={cols[i]}>{'XYZ'[i]}</text>
          <Bar x={9} y={1 + i * 6.3} w={W - 12} h={5} ratio={v / AXIS_MAX[i]} color={cols[i]} />
        </g>))}</>
      break
    }
    case 'box':
      body = <><Bar x={0} y={2} w={W - 4} h={6} ratio={g.temp / 60} color={heat(g.temp / 60)} /><Bar x={0} y={H - 8} w={W - 4} h={6} ratio={g.humidity / 100} color={g.humidity > 50 ? 'var(--warn)' : 'var(--accent)'} /></>
      break
    default:
      body = <Tag />
  }
  return <svg className="sg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>{body}</svg>
}

// Creality K2 (F021) travel: X/Y 262 mm, Z 270 mm.
const AXIS_MAX = [262, 262, 270]
const BOOL_KEY = /(^|_)(sw|ai|connect|enable|video|tfCard|powerLoss|detect|detector|support|elapse|selfTest|autoPid|status|light|filament_detected|is_)|Sw$|Detect$|Enable$|Support$|Status$/i
const PCT_KEY = /pct$|percent|progress|humidity|_pct/i
const TEMP_KEY = /temp|temperature/i

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return null
}

/** Keeps a rolling history per key across renders (call inside a component). */
export function useHistory() {
  const ref = useRef<Map<string, number[]>>(new Map())
  return (key: string, v: number, keep = 60): number[] => {
    const h = ref.current.get(key) ?? []
    if (h[h.length - 1] !== v || h.length === 0) h.push(v)
    while (h.length > keep) h.shift()
    ref.current.set(key, h)
    return h
  }
}

/** Pick a graphic for a loose key/value pair; ctx is the enclosing object (for max/target lookups). */
export function classify(key: string, v: unknown, ctx: Record<string, unknown>, push: (k: string, v: number) => number[], hk: string): Kind {
  if (typeof v === 'boolean') return { kind: 'bool', on: v }
  if (v === 'None' || v === '' || v === null || v === undefined) return { kind: 'text' }
  if (Array.isArray(v) && /color/i.test(key)) {
    const cols = v.map(c => (typeof c === 'string' && c.length === 7 && c.startsWith('0') ? '#' + c.slice(1) : String(c))).filter(c => c.startsWith('#'))
    if (cols.length) return { kind: 'swatch', colors: cols }
  }
  const d = num(v)
  if (d === null) return { kind: 'text' }
  if ((d === 0 || d === 1) && BOOL_KEY.test(key)) return { kind: 'bool', on: d === 1 }
  if (PCT_KEY.test(key) && d >= 0 && d <= 100) return { kind: 'pct', value: d, fan: /fan/i.test(key) }
  if (TEMP_KEY.test(key) && !/max/i.test(key) && !key.startsWith('target')) {
    const k = key.toLowerCase()
    let max = 300
    if (k.includes('bed')) max = num(ctx.maxBedTemp) ?? 120
    else if (k.includes('box') || k.includes('chamber')) max = num(ctx.maxBoxTemp) ?? 60
    else if (k.includes('nozzle') || k.includes('extruder')) max = num(ctx.maxNozzleTemp) ?? 300
    else if (k.includes('mcu') || k.includes('cpu')) max = 100
    const target = num(ctx['target' + key[0].toUpperCase() + key.slice(1)]) ?? num(ctx.target) ?? 0
    return { kind: 'temp', value: d, target, max, hist: push(hk, d) }
  }
  return { kind: 'spark', hist: push(hk, d) }
}
