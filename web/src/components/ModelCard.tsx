import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { api, baseName, fmtHMS, type GFile, type MotionSample, type Status } from '../api'
import type { ParseResult, WorkerMsg } from '../gcode.worker'
import { reducedMotion } from '../motion'

// 3D preview of a gcode file on the printer: extrusion toolpaths as lines, drag to
// rotate, wheel to zoom, right-drag to pan. Colored by slicer tool (the filament colors
// the slicer wrote into the file) or by feature type. While the shown file is printing,
// the layer slider follows the printer.

const BED = 262, BED_Z = 270
const TYPE_COLORS: Record<string, string> = {
  'Outer wall': '#ff7a3d', 'Inner wall': '#ffd23d', 'Sparse infill': '#8f4bff', 'Internal solid infill': '#c14bff',
  'Top surface': '#ff3d7a', 'Bottom surface': '#ff3d7a', 'Support': '#3dd6ff', 'Support interface': '#3dffb0',
  'Skirt': '#8d98aa', 'Brim': '#8d98aa', 'Bridge': '#3d8fff', 'Overhang wall': '#ff3d3d', 'Gap infill': '#ffffff',
  'Prime tower': '#5b6678', 'Custom': '#5b6678', 'Wipe tower': '#5b6678',
}
const TOOL_FALLBACK = ['#3ddc84', '#2b8cff', '#ffb000', '#ff4d6d', '#b56cff', '#3dd6ff', '#ffffff', '#8d98aa']

type Mode = 'tool' | 'type'

// Live nozzle tracking. Klipper pushes an interpolated position about 4 times a second.
// Guessing ahead along the last heading overshoots on every direction change (infill
// turns many times a second), so instead the marker is drawn a fixed DELAY behind real
// time, interpolated between the two samples that bracket that moment. It is always on
// the true path and glides through corners; the cost is a little over half a second of
// lag, less than the camera has. Klipper eventtimes space the samples; wall clocks only
// place "now".
type Track = {
  samples: MotionSample[]
  shown: THREE.Vector3      // where the marker is drawn
  latestT: number           // eventtime of the newest sample
  latestWall: number        // performance.now() when it arrived
  active: boolean
  trail: number[]           // recent shown positions, newest last, 3 floats each
}
const DELAY = 0.65 // seconds behind real time
const TRAIL = 90

// Per-segment color with fake tube lighting: a line's brightness follows how its
// direction sits against a fixed light, the way slicers shade extrusions, so walls facing
// different ways get different tones and a dense model reads as a shape, not a blob.
// A mild height ramp adds depth, and infill sits a little darker than walls.
const LX = 0.62, LY = 0.30, LZ = 0.72 // normalized light direction
function colorsFor(r: ParseResult, mode: Mode): Float32Array {
  const n = r.pos.length / 6
  const out = new Float32Array(n * 6)
  const c = new THREE.Color()
  const cache = new Map<number, [number, number, number]>()
  const p = r.pos
  const z0 = r.bbox[2], z1 = Math.max(r.bbox[5], z0 + 1)
  for (let i = 0; i < n; i++) {
    const key = mode === 'tool' ? r.tool[i] : 1000 + r.type[i]
    let rgb = cache.get(key)
    if (!rgb) {
      const hex = mode === 'tool'
        ? (r.colors[r.tool[i]] || TOOL_FALLBACK[r.tool[i] % TOOL_FALLBACK.length])
        : (TYPE_COLORS[r.types[r.type[i]]] || '#8d98aa')
      c.set(hex); rgb = [c.r, c.g, c.b]; cache.set(key, rgb)
    }
    const j = i * 6
    let dx = p[j + 3] - p[j], dy = p[j + 4] - p[j + 1], dz = p[j + 5] - p[j + 2]
    const len = Math.hypot(dx, dy, dz) || 1
    dx /= len; dy /= len; dz /= len
    // the tube's shading depends on the direction perpendicular to travel; use the
    // horizontal normal (-dy, dx) against the light for the wall tone
    const facing = Math.abs(-dy * LX + dx * LY) * 0.75 + Math.abs(dz) * 0.25
    let shade = 0.45 + 0.55 * facing
    shade *= 0.82 + 0.18 * ((p[j + 5] - z0) / (z1 - z0))
    const t = r.types[r.type[i]] || ''
    if (mode === 'tool' && (t.includes('infill') || t.includes('Infill'))) shade *= 0.72
    const R = Math.min(1, rgb[0] * shade), G = Math.min(1, rgb[1] * shade), B = Math.min(1, rgb[2] * shade)
    out[j] = R; out[j + 1] = G; out[j + 2] = B; out[j + 3] = R; out[j + 4] = G; out[j + 5] = B
  }
  return out
}

/** Vertex count to draw so that layers 0..upto (inclusive) are shown. */
function drawCount(r: ParseResult, upto: number): number {
  const n = r.layer.length
  if (upto >= r.layers - 1) return n * 2
  // layers are monotonic in file order: binary search the first segment past `upto`
  let lo = 0, hi = n
  while (lo < hi) { const m = (lo + hi) >> 1; if (r.layer[m] <= upto) lo = m + 1; else hi = m }
  return lo * 2
}

export default function ModelCard({ status, className = '' }: { status: Status; className?: string }) {
  const [files, setFiles] = useState<GFile[]>([])
  const [path, setPath] = useState<string>('')
  const [result, setResult] = useState<ParseResult | null>(null)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [mode, setMode] = useState<Mode>('tool')
  const [layer, setLayer] = useState(0)
  const [follow, setFollow] = useState(true)
  const mount = useRef<HTMLDivElement>(null)
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; lines?: THREE.LineSegments; glow?: THREE.LineSegments; bbox?: number[]; nozzle: THREE.Group; trail: THREE.Line; track: Track; frame: () => void; fit: () => void } | null>(null)

  const jobFile = status.job.file
  const printingThis = !!path && path === jobFile && (status.job.state === 'printing' || status.job.state === 'paused')

  useEffect(() => { api.files().then(setFiles).catch(() => setFiles([])) }, [])
  // default to the running job's file, else the newest file
  useEffect(() => { if (!path) setPath(jobFile || files[0]?.path || '') }, [jobFile, files, path])

  // scene setup once
  useEffect(() => {
    const el = mount.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 4000)
    camera.up.set(0, 0, 1)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = 0.1
    controls.maxPolarAngle = Math.PI / 2 + 0.05
    // bed: 262 x 262 grid in the XY plane, 10 mm cells, origin at the front-left corner
    const grid = new THREE.GridHelper(BED, BED / 10, 0x22d3ee, 0x1a2536)
    ;(grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = .55
    grid.rotation.x = Math.PI / 2
    grid.position.set(BED / 2, BED / 2, 0)
    scene.add(grid)
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED, BED)), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: .8 }))
    edge.position.set(BED / 2, BED / 2, 0)
    scene.add(edge)
    // bed plate: faint glass so the model reads as sitting on something
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(BED, BED), new THREE.MeshBasicMaterial({ color: 0x0b1018, transparent: true, opacity: .55, side: THREE.DoubleSide }))
    plate.position.set(BED / 2, BED / 2, -0.05)
    scene.add(plate)
    // nozzle marker: a bright dot with a pulsing halo and a drop line to the bed
    const nozzle = new THREE.Group()
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    const halo = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 12), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: .35, depthWrite: false }))
    halo.name = 'halo'
    const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: .35 }))
    drop.name = 'drop'
    nozzle.add(core, halo, drop); nozzle.visible = false
    scene.add(nozzle)
    // fading trail behind the nozzle
    const trailGeo = new THREE.BufferGeometry()
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3))
    trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3))
    trailGeo.setDrawRange(0, 0)
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }))
    trail.frustumCulled = false
    scene.add(trail)
    const track: Track = { samples: [], shown: new THREE.Vector3(), latestT: 0, latestWall: 0, active: false, trail: [] }
    let raf = 0, dirty = true, idleSince = performance.now(), t0 = performance.now()
    const frame = () => { dirty = true }
    const motion = !reducedMotion()
    controls.addEventListener('start', () => { idleSince = Infinity })
    controls.addEventListener('end', () => { idleSince = performance.now() })
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      let moved = controls.update()
      if (motion) {
        // slow auto-orbit after 8 s idle; the pulse on the nozzle halo always runs
        if (now - idleSince > 8000) { controls.autoRotate = true; controls.autoRotateSpeed = 0.35; moved = controls.update() || moved }
        else controls.autoRotate = false
        if (nozzle.visible) { const k = 1 + 0.35 * Math.sin((now - t0) / 260); halo.scale.setScalar(k); (halo.material as THREE.MeshBasicMaterial).opacity = .18 + .22 * (2 - k); moved = true }
      }
      // nozzle follow: render DELAY behind real time, interpolated between real samples
      if (track.active && track.samples.length) {
        const ss = track.samples
        const renderT = track.latestT + (now - track.latestWall) / 1000 - DELAY
        let a = ss[0], b = ss[0]
        for (let i = 0; i < ss.length; i++) { if (ss[i].t <= renderT) a = ss[i]; if (ss[i].t >= renderT) { b = ss[i]; break } b = ss[i] }
        const span = b.t - a.t
        const f = span > 1e-6 ? Math.max(0, Math.min(1, (renderT - a.t) / span)) : 1
        track.shown.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f)
        nozzle.position.set(track.shown.x, track.shown.y, track.shown.z + 0.3)
        const dropLine = nozzle.getObjectByName('drop') as THREE.Line | undefined
        if (dropLine) dropLine.scale.set(1, 1, Math.max(0.01, track.shown.z + 0.3))
        nozzle.visible = true
        // trail
        const tr = track.trail
        const lastIdx = tr.length - 3
        if (lastIdx < 0 || Math.hypot(tr[lastIdx] - track.shown.x, tr[lastIdx + 1] - track.shown.y, tr[lastIdx + 2] - track.shown.z) > 0.15) {
          tr.push(track.shown.x, track.shown.y, track.shown.z + 0.25)
          if (tr.length > TRAIL * 3) tr.splice(0, tr.length - TRAIL * 3)
          const pa = trail.geometry.getAttribute('position') as THREE.BufferAttribute
          const ca = trail.geometry.getAttribute('color') as THREE.BufferAttribute
          const n = tr.length / 3
          for (let i = 0; i < n; i++) {
            pa.setXYZ(i, tr[i * 3], tr[i * 3 + 1], tr[i * 3 + 2])
            const f = (i + 1) / n
            ca.setXYZ(i, 0.13 * f, 0.83 * f, 0.93 * f)
          }
          pa.needsUpdate = true; ca.needsUpdate = true
          trail.geometry.setDrawRange(0, n)
        }
        moved = true
      } else if (nozzle.visible) { nozzle.visible = false; trail.geometry.setDrawRange(0, 0); track.trail.length = 0; moved = true }
      ;(loop as unknown as { prev: number }).prev = now
      if (dirty || moved) { renderer.render(scene, camera); dirty = false }
    }
    const fit = () => {
      const t = three.current
      const target = new THREE.Vector3(BED / 2, BED / 2, 20)
      let dist = 420
      const b = t?.bbox
      if (t?.lines && b && b[3] > b[0]) {
        target.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2)
        dist = Math.max(80, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) * 1.5)
      }
      controls.target.copy(target)
      camera.position.set(target.x - dist * 0.55, target.y - dist * 0.7, target.z + dist * 0.55)
      camera.lookAt(target); controls.update(); frame()
    }
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); frame()
    })
    ro.observe(el)
    controls.addEventListener('change', frame)
    three.current = { renderer, scene, camera, controls, nozzle, trail, track, frame, fit }
    fit(); loop()
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose()
      el.removeChild(renderer.domElement); three.current = null
    }
  }, [])

  // load + parse when the file changes
  useEffect(() => {
    if (!path) return
    setResult(null); setError(''); setProgress('loading')
    const w = new Worker(new URL('../gcode.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev: MessageEvent<WorkerMsg>) => {
      const m = ev.data
      if (m.kind === 'progress') setProgress(m.total ? `${Math.round((m.read / m.total) * 100)}%` : `${(m.read / 1048576).toFixed(0)} MB`)
      else if (m.kind === 'done') { setResult(m.result); setProgress(''); setLayer(m.result.layers - 1); setFollow(true) }
      else { setError(m.message); setProgress('') }
    }
    w.onerror = e => { setError(e.message); setProgress('') }
    w.postMessage({ url: `/api/files/gcode?path=${encodeURIComponent(path)}` })
    return () => w.terminate()
  }, [path])

  // build / recolor the line geometry
  useEffect(() => {
    const t = three.current
    if (!t) return
    if (t.lines) { t.scene.remove(t.lines); t.lines.geometry.dispose(); (t.lines.material as THREE.Material).dispose(); t.lines = undefined }
    if (t.glow) { t.scene.remove(t.glow); (t.glow.material as THREE.Material).dispose(); t.glow = undefined }
    if (result && result.pos.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(result.pos, 3))
      g.setAttribute('color', new THREE.BufferAttribute(colorsFor(result, mode), 3))
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }))
      // additive ghost of the same geometry gives a cheap bloom without post-processing;
      // dense models stack the additive passes, so fade it with segment count
      const n = result.pos.length / 6
      const glowOpacity = Math.max(0.03, Math.min(0.25, 0.25 * (150000 / n)))
      const glow = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: glowOpacity, blending: THREE.AdditiveBlending, depthWrite: false }))
      glow.renderOrder = -1
      t.scene.add(glow, lines); t.lines = lines; t.glow = glow; t.bbox = result.bbox
    }
    t.fit()
  }, [result, mode])

  // follow the printer's layer while this file prints
  useEffect(() => {
    if (!result || !printingThis || !follow) return
    const l = Math.max(0, Math.min(result.layers - 1, status.job.layer - 1))
    setLayer(l)
  }, [status.job.layer, printingThis, follow, result])

  useEffect(() => {
    const t = three.current
    if (!t?.lines || !result) return
    t.lines.geometry.setDrawRange(0, drawCount(result, layer)); t.frame()
  }, [layer, result])

  // live nozzle: poll the motion samples 4x a second while this file prints
  useEffect(() => {
    const t = three.current
    if (!t) return
    if (!printingThis) { t.track.active = false; return }
    let stop = false
    const tick = async () => {
      if (stop) return
      try {
        const r = await api.motion()
        const tr = t.track
        const fresh = r.samples.filter(s => s.t > tr.latestT)
        if (fresh.length) {
          tr.samples = tr.samples.concat(fresh).slice(-16)
          const s = fresh[fresh.length - 1]
          if (!tr.active) { tr.shown.set(s.x, s.y, s.z); tr.active = true }
          // the newest sample was true at its eventtime; it reached us a little later,
          // so place its wall time back by that lag
          const lagMs = Math.max(0, Math.min(500, Date.now() - new Date(s.at).getTime()))
          tr.latestT = s.t; tr.latestWall = performance.now() - lagMs
        }
      } catch { /* keep the last estimate */ }
      if (!stop) timer = window.setTimeout(tick, 250)
    }
    let timer = window.setTimeout(tick, 0)
    return () => { stop = true; clearTimeout(timer); t.track.active = false }
  }, [printingThis])

  const legend = useMemo(() => {
    if (!result) return []
    if (mode === 'tool') {
      const seen = new Set<number>(); for (let i = 0; i < result.tool.length; i += 97) seen.add(result.tool[i]); seen.add(result.tool[0] ?? 0)
      return [...seen].sort().map(t => ({ name: `T${t}${result.header.filamentTypes?.[t] ? ` ${result.header.filamentTypes[t]}` : ''}`, color: result.colors[t] || TOOL_FALLBACK[t % TOOL_FALLBACK.length] }))
    }
    return result.types.map(n => ({ name: n, color: TYPE_COLORS[n] || '#8d98aa' }))
  }, [result, mode])

  const h = result?.header
  return (
    <div className={`card model ${className}`}>
      <h2>Model
        <span className="model-tools">
          <select value={path} onChange={e => { setPath(e.target.value); setFollow(false) }} aria-label="gcode file">
            {!files.some(f => f.path === path) && path && <option value={path}>{baseName(path)}</option>}
            {files.map(f => <option key={f.path} value={f.path}>{baseName(f.path)}{f.path === jobFile ? ' (printing)' : ''}</option>)}
          </select>
          <button className={`btn small ${mode === 'tool' ? 'on' : ''}`} onClick={() => setMode('tool')}>by filament</button>
          <button className={`btn small ${mode === 'type' ? 'on' : ''}`} onClick={() => setMode('type')}>by feature</button>
          <button className="btn small" onClick={() => three.current?.fit()}>reset view</button>
        </span>
      </h2>
      <div className="model-body">
        <div className="model-view" ref={mount}>
          {(progress || error) && <div className="model-msg">{error ? `Could not load: ${error}` : `Reading gcode ${progress}`}</div>}
          {!path && <div className="model-msg">No gcode files on the printer yet.</div>}
          {h?.thumbnail && <img className="model-thumb" src={h.thumbnail} alt="" title="slicer preview" />}
        </div>
        <div className="model-side">
          {result && (
            <>
              <div className="model-layer">
                <label>Layer <b>{layer + 1}</b> / {result.layers}{printingThis && <small> {follow ? 'following the print' : 'paused: drag to scrub'}</small>}</label>
                <input type="range" min={0} max={Math.max(0, result.layers - 1)} value={layer} style={{ ['--fill' as string]: `${result.layers > 1 ? (layer / (result.layers - 1)) * 100 : 100}%` }}
                  onChange={e => { setLayer(Number(e.target.value)); setFollow(false) }} aria-label="layers shown" />
                {printingThis && !follow && <button className="btn small" onClick={() => setFollow(true)}>follow print</button>}
              </div>
              <dl className="kv">
                <dt>Height</dt><dd>{(h?.height ?? result.bbox[5]).toFixed(1)} mm</dd>
                <dt>Footprint</dt><dd>{(result.bbox[3] - result.bbox[0]).toFixed(0)} x {(result.bbox[4] - result.bbox[1]).toFixed(0)} mm</dd>
                {h?.filamentMm ? <><dt>Filament</dt><dd>{(h.filamentMm / 1000).toFixed(2)} m</dd></> : null}
                {h?.time ? <><dt>Sliced time</dt><dd>{h.time}</dd></> : null}
                {printingThis && <><dt>Left</dt><dd>{fmtHMS(status.job.time_left_s)}</dd></>}
                <dt>Segments</dt><dd>{(result.pos.length / 6).toLocaleString()}{result.truncated ? ' (cut)' : ''}</dd>
              </dl>
              <div className="model-legend">{legend.map(l => <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>)}</div>
            </>
          )}
          <div className="model-hint">Drag to rotate, wheel to zoom, right-drag to pan. Bed is {BED} x {BED} x {BED_Z} mm.</div>
        </div>
      </div>
    </div>
  )
}
