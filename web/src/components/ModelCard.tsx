import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { api, baseName, fmtHMS, type GFile, type Status } from '../api'
import type { ParseResult, WorkerMsg } from '../gcode.worker'

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

function colorsFor(r: ParseResult, mode: Mode): Float32Array {
  const n = r.pos.length / 6
  const out = new Float32Array(n * 6)
  const c = new THREE.Color()
  const cache = new Map<number, [number, number, number]>()
  for (let i = 0; i < n; i++) {
    const key = mode === 'tool' ? r.tool[i] : 1000 + r.type[i]
    let rgb = cache.get(key)
    if (!rgb) {
      const hex = mode === 'tool'
        ? (r.colors[r.tool[i]] || TOOL_FALLBACK[r.tool[i] % TOOL_FALLBACK.length])
        : (TYPE_COLORS[r.types[r.type[i]]] || '#8d98aa')
      c.set(hex); rgb = [c.r, c.g, c.b]; cache.set(key, rgb)
    }
    out.set(rgb, i * 6); out.set(rgb, i * 6 + 3)
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
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; lines?: THREE.LineSegments; bbox?: number[]; frame: () => void; fit: () => void } | null>(null)

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
    const grid = new THREE.GridHelper(BED, BED / 10, 0x34405a, 0x263042)
    grid.rotation.x = Math.PI / 2
    grid.position.set(BED / 2, BED / 2, 0)
    scene.add(grid)
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(BED, BED)), new THREE.LineBasicMaterial({ color: 0x5b6678 }))
    edge.position.set(BED / 2, BED / 2, 0)
    scene.add(edge)
    let raf = 0, dirty = true
    const frame = () => { dirty = true }
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const moved = controls.update()
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
    three.current = { renderer, scene, camera, controls, frame, fit }
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
    if (result && result.pos.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(result.pos, 3))
      g.setAttribute('color', new THREE.BufferAttribute(colorsFor(result, mode), 3))
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }))
      t.scene.add(lines); t.lines = lines; t.bbox = result.bbox
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
