// Streams a gcode file and turns extrusion moves into line segments for the 3D viewer.
// Runs in a Web Worker: a 30 MB file is a few million lines and must not block the page.
//
// Output (transferred, not copied):
//   pos     Float32Array  6 floats per segment: x1 y1 z1 x2 y2 z2 (printer coordinates, mm)
//   layer   Uint16Array   layer index per segment (0-based, in file order, so monotonic)
//   tool    Uint8Array    slicer tool index per segment (T0, T1, ...)
//   type    Uint8Array    feature type index per segment (index into `types`)
//   layers  number
//   types   string[]      ;TYPE: names seen, in order of first appearance
//   colors  string[]      ; filament_colour header, per tool, if present
//   header  { layers?, height?, filamentMm?, time?, thumbnail? (data URL of the largest embedded PNG) }
//   truncated boolean     hit the segment cap
//   bbox    [minx, miny, minz, maxx, maxy, maxz]

export type ParseResult = {
  pos: Float32Array; layer: Uint16Array; tool: Uint8Array; type: Uint8Array
  layers: number; types: string[]; colors: string[]; truncated: boolean
  bbox: [number, number, number, number, number, number]
  header: { layers?: number; height?: number; filamentMm?: number; time?: string; thumbnail?: string; filamentTypes?: string[] }
}
export type WorkerMsg = { kind: 'progress'; read: number; total: number } | { kind: 'done'; result: ParseResult } | { kind: 'error'; message: string }

const MAX_SEG = 6_000_000

class Grow<T extends Float32Array | Uint16Array | Uint8Array> {
  buf: T; n = 0
  constructor(private mk: (n: number) => T, private stride: number, initial = 1 << 16) { this.buf = mk(initial * stride) }
  need(count: number) {
    if ((this.n + count) * this.stride > this.buf.length) {
      let cap = this.buf.length
      while ((this.n + count) * this.stride > cap) cap *= 2
      const nb = this.mk(cap); nb.set(this.buf); this.buf = nb
    }
  }
  done(): T { return this.buf.slice(0, this.n * this.stride) as T }
}

self.onmessage = async (ev: MessageEvent<{ url: string }>) => {
  try {
    const res = await fetch(ev.data.url)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('Content-Length') || 0)
    const reader = res.body.getReader()
    const dec = new TextDecoder()

    const pos = new Grow(n => new Float32Array(n), 6)
    const lay = new Grow(n => new Uint16Array(n), 1)
    const layZ = new Grow(n => new Uint16Array(n), 1)
    const tool = new Grow(n => new Uint8Array(n), 1)
    const typ = new Grow(n => new Uint8Array(n), 1)
    const types: string[] = []
    const typeIdx = new Map<string, number>()
    let curType = 0
    let customType = false // ;TYPE:Custom = start/end gcode (purge line); kept out of the bounding box
    let colors: string[] = []
    let filamentTypes: string[] = []
    const header: ParseResult['header'] = {}

    let x = 0, y = 0, z = 0, e = 0
    let absXYZ = true, absE = true
    let layer = -1, markerLayers = 0
    let zLayer = -1, lastLayerZ = -Infinity
    let curTool = 0
    let truncated = false
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    let thumb: { w: number; h: number; b64: string[] } | null = null
    let bestThumb: { w: number; b64: string } | null = null
    let read = 0, lastReport = 0, tail = ''

    const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => {
      if (pos.n >= MAX_SEG) { truncated = true; return }
      if (layer < 0 && zLayer < 0) { zLayer = 0; lastLayerZ = z2 }
      pos.need(1); lay.need(1); layZ.need(1); tool.need(1); typ.need(1)
      const b = pos.buf, i = pos.n * 6
      b[i] = x1; b[i + 1] = y1; b[i + 2] = z1; b[i + 3] = x2; b[i + 4] = y2; b[i + 5] = z2
      lay.buf[lay.n] = Math.max(0, layer); layZ.buf[layZ.n] = Math.max(0, zLayer)
      tool.buf[tool.n] = curTool; typ.buf[typ.n] = curType
      pos.n++; lay.n++; layZ.n++; tool.n++; typ.n++
      if (customType) return
      if (x2 < minx) minx = x2; if (x2 > maxx) maxx = x2
      if (y2 < miny) miny = y2; if (y2 > maxy) maxy = y2
      if (z2 < minz) minz = z2; if (z2 > maxz) maxz = z2
    }

    const word = (line: string, c: string): number | null => {
      const i = line.indexOf(c)
      if (i < 0) return null
      let j = i + 1
      while (j < line.length && ' -+.0123456789eE'.includes(line[j]) && !(line[j] === ' ' && j > i + 1)) j++
      const v = parseFloat(line.slice(i + 1, j))
      return Number.isFinite(v) ? v : null
    }

    const handle = (raw: string) => {
      let line = raw
      const ci = line.indexOf(';')
      if (ci >= 0) {
        const c = line.slice(ci + 1).trim()
        line = line.slice(0, ci)
        if (c.length) {
          if (c.startsWith('LAYER_CHANGE') || c.startsWith('CHANGE_LAYER')) { layer++; markerLayers++ }
          else if (c.startsWith('TYPE:')) {
            const t = c.slice(5).trim()
            let i = typeIdx.get(t)
            if (i === undefined) { i = types.length; types.push(t); typeIdx.set(t, i) }
            curType = i
            customType = t === 'Custom'
          }
          else if (c.startsWith('thumbnail begin ')) {
            const m = /thumbnail begin (\d+)x(\d+)/.exec(c)
            if (m) thumb = { w: Number(m[1]), h: Number(m[2]), b64: [] }
          }
          else if (c.startsWith('thumbnail end')) {
            if (thumb && (!bestThumb || thumb.w > bestThumb.w)) bestThumb = { w: thumb.w, b64: thumb.b64.join('') }
            thumb = null
          }
          else if (thumb) thumb.b64.push(c)
          else if (c.startsWith('total layer number:')) header.layers = Number(c.split(':')[1])
          else if (c.startsWith('max_z_height:')) header.height = Number(c.split(':')[1])
          else if (c.startsWith('filament_colour =')) colors = c.split('=')[1].split(';').map(s => s.trim()).filter(Boolean)
          else if (c.startsWith('filament_type =')) filamentTypes = c.split('=')[1].split(';').map(s => s.trim()).filter(Boolean)
          else if (c.startsWith('filament used [mm] =')) header.filamentMm = c.split('=')[1].split(',').map(Number).reduce((a, b) => a + (b || 0), 0)
          else if (c.startsWith('estimated printing time (normal mode) =')) header.time = c.split('=')[1].trim()
        }
      }
      line = line.trim()
      if (!line) return
      const c0 = line[0]
      if (c0 === 'T' && line.length <= 3) { const t = parseInt(line.slice(1), 10); if (Number.isFinite(t)) curTool = Math.max(0, Math.min(255, t)); return }
      if (c0 === 'M') {
        if (line.startsWith('M82')) absE = true
        else if (line.startsWith('M83')) absE = false
        return
      }
      if (c0 !== 'G') return
      const sp = line.indexOf(' ')
      const cmd = sp < 0 ? line : line.slice(0, sp)
      if (cmd === 'G90') { absXYZ = true; return }
      if (cmd === 'G91') { absXYZ = false; return }
      if (cmd === 'G92') {
        const ne = word(line, 'E'); if (ne !== null) e = ne
        const nx = word(line, 'X'); if (nx !== null) x = nx
        const ny = word(line, 'Y'); if (ny !== null) y = ny
        const nz = word(line, 'Z'); if (nz !== null) z = nz
        return
      }
      if (cmd !== 'G0' && cmd !== 'G1' && cmd !== 'G2' && cmd !== 'G3') return
      const nx = word(line, 'X'), ny = word(line, 'Y'), nz = word(line, 'Z'), ne = word(line, 'E')
      const x2 = nx === null ? x : absXYZ ? nx : x + nx
      const y2 = ny === null ? y : absXYZ ? ny : y + ny
      const z2 = nz === null ? z : absXYZ ? nz : z + nz
      let de = 0
      if (ne !== null) { de = absE ? ne - e : ne; e = absE ? ne : e + ne }
      const extruding = de > 0 && (nx !== null || ny !== null || nz !== null)
      if (extruding) {
        if (markerLayers === 0 && z2 > lastLayerZ + 0.001 && zLayer >= 0) { zLayer++; lastLayerZ = z2 }
        if (cmd === 'G2' || cmd === 'G3') {
          const I = word(line, 'I') ?? 0, J = word(line, 'J') ?? 0
          const cx = x + I, cy = y + J
          const r = Math.hypot(I, J)
          let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(y2 - cy, x2 - cx)
          if (cmd === 'G2') { if (a1 >= a0) a1 -= 2 * Math.PI } else { if (a1 <= a0) a1 += 2 * Math.PI }
          const n = Math.max(2, Math.min(64, Math.ceil(Math.abs(a1 - a0) * r / 1.0)))
          let px = x, py = y, pz = z
          for (let k = 1; k <= n; k++) {
            const t = k / n, a = a0 + (a1 - a0) * t
            const qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a), qz = z + (z2 - z) * t
            push(px, py, pz, qx, qy, qz); px = qx; py = qy; pz = qz
          }
        } else if (x2 !== x || y2 !== y || z2 !== z) {
          push(x, y, z, x2, y2, z2)
        }
      }
      x = x2; y = y2; z = z2
    }

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      read += value.byteLength
      const text = tail + dec.decode(value, { stream: true })
      let start = 0
      for (;;) {
        const nl = text.indexOf('\n', start)
        if (nl < 0) break
        handle(text.slice(start, nl))
        start = nl + 1
      }
      tail = text.slice(start)
      if (read - lastReport > 1 << 20) { lastReport = read; (self as unknown as Worker).postMessage({ kind: 'progress', read, total } satisfies WorkerMsg) }
    }
    if (tail) handle(tail)

    const useMarkers = markerLayers > 0
    const layerArr = useMarkers ? lay.done() : layZ.done()
    const layers = pos.n ? layerArr[pos.n - 1] + 1 : 0
    const bt = bestThumb as { w: number; b64: string } | null
    if (bt) header.thumbnail = 'data:image/png;base64,' + bt.b64
    header.filamentTypes = filamentTypes
    const result: ParseResult = {
      pos: pos.done(), layer: layerArr, tool: tool.done(), type: typ.done(), layers, types, colors, truncated,
      bbox: Number.isFinite(minx) ? [minx, miny, minz, maxx, maxy, maxz] : [0, 0, 0, 0, 0, 0], header,
    }
    ;(self as unknown as Worker).postMessage({ kind: 'done', result } satisfies WorkerMsg, [result.pos.buffer, result.layer.buffer, result.tool.buffer, result.type.buffer])
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ kind: 'error', message: (e as Error).message } satisfies WorkerMsg)
  }
}
