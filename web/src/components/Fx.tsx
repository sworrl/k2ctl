import { useEffect, useRef, useState } from 'react'
import { reducedMotion } from '../motion'

// Page-wide effects: a cursor spotlight, toasts on printer state changes, a confetti
// burst when a print completes, and a hero status word that flips with the state.

export function Spotlight() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (reducedMotion() || matchMedia('(pointer: coarse)').matches) return
    const el = ref.current!
    let x = innerWidth / 2, y = innerHeight / 3, tx = x, ty = y, raf = 0
    // Runs only while the light is still catching up with the pointer.
    const loop = () => {
      x += (tx - x) * .12; y += (ty - y) * .12; el.style.transform = `translate(${x - 300}px, ${y - 300}px)`
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(loop) : 0
    }
    const move = (e: PointerEvent) => { tx = e.clientX; ty = e.clientY; if (!raf) raf = requestAnimationFrame(loop) }
    addEventListener('pointermove', move, { passive: true }); loop()
    return () => { removeEventListener('pointermove', move); cancelAnimationFrame(raf) }
  }, [])
  return <div ref={ref} className="spotlight" aria-hidden />
}

/** Tilts every .card toward the cursor (document-level, one loop). */
export function CardTilt() {
  useEffect(() => {
    if (reducedMotion() || matchMedia('(pointer: coarse)').matches) return
    let cur: HTMLElement | null = null, rx = 0, ry = 0, trx = 0, try_ = 0, raf = 0
    const onMove = (e: PointerEvent) => {
      let el = (e.target as HTMLElement).closest?.('.card') as HTMLElement | null
      // Big cards (model viewer, print library) are too costly to re-raster on every move.
      if (el && el.offsetWidth * el.offsetHeight > 900 * 650) el = null
      if (el !== cur) { if (cur) { cur.style.transform = ''; cur.classList.remove('tilting') } cur = el; rx = ry = 0 }
      if (!el) { trx = try_ = 0; return }
      const r = el.getBoundingClientRect()
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height
      const max = r.width > 900 ? 1.5 : 3.5
      trx = (0.5 - py) * max; try_ = (px - 0.5) * max
      el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`); el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`)
      el.classList.add('tilting')
    }
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (!cur) return
      rx += (trx - rx) * .12; ry += (try_ - ry) * .12
      cur.style.transform = `perspective(1200px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(4px)`
    }
    addEventListener('pointermove', onMove, { passive: true }); loop()
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); if (cur) cur.style.transform = '' }
  }, [])
  return null
}

/** Tilts a card toward the cursor. Attach the returned handlers to the card. */
export function useTilt(max = 5) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion() || matchMedia('(pointer: coarse)').matches) return
    let raf = 0, rx = 0, ry = 0, trx = 0, try_ = 0, gx = 50, gy = 50
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height
      trx = (0.5 - py) * max; try_ = (px - 0.5) * max; gx = px * 100; gy = py * 100
      el.style.setProperty('--gx', `${gx}%`); el.style.setProperty('--gy', `${gy}%`)
    }
    const onLeave = () => { trx = 0; try_ = 0 }
    const loop = () => {
      raf = requestAnimationFrame(loop)
      rx += (trx - rx) * .1; ry += (try_ - ry) * .1
      if (Math.abs(rx) > .01 || Math.abs(ry) > .01) el.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`
      else el.style.transform = ''
    }
    el.addEventListener('pointermove', onMove); el.addEventListener('pointerleave', onLeave); loop()
    return () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerleave', onLeave); cancelAnimationFrame(raf) }
  }, [max])
  return ref
}

type Toast = { id: number; text: string; kind: string }
export function Toasts({ state, file }: { state: string; file: string }) {
  const [list, setList] = useState<Toast[]>([])
  const prev = useRef<string | null>(null)
  useEffect(() => {
    if (prev.current === null) { prev.current = state; return }
    if (prev.current === state) return
    const name = file.split('/').pop() || 'print'
    const text = state === 'printing' ? `Printing ${name}` : state === 'paused' ? 'Print paused' : state === 'complete' ? `${name} finished` : state === 'cancelled' ? 'Print cancelled' : state === 'error' ? 'Printer reported an error' : `Printer ${state}`
    const id = Date.now()
    setList(l => [...l, { id, text, kind: state }])
    prev.current = state
    const t = window.setTimeout(() => setList(l => l.filter(x => x.id !== id)), 6000)
    return () => clearTimeout(t)
  }, [state, file])
  return <div className="toasts">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}><i />{t.text}</div>)}</div>
}

export function Confetti({ fire }: { fire: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!fire || reducedMotion()) return
    const cv = ref.current!, ctx = cv.getContext('2d')!
    const dpr = Math.min(2, devicePixelRatio || 1)
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr
    const cols = ['#ff4d6d', '#ffb000', '#3ddc84', '#2b8cff', '#b56cff', '#22d3ee', '#ffffff']
    const ps = Array.from({ length: 260 }, () => ({ x: cv.width / 2, y: cv.height * .35, vx: (Math.random() - .5) * 26 * dpr, vy: (-14 - Math.random() * 16) * dpr, r: (3 + Math.random() * 5) * dpr, c: cols[Math.floor(Math.random() * cols.length)], a: Math.random() * Math.PI, s: (Math.random() - .5) * .3 }))
    let raf = 0, t0 = performance.now()
    const loop = (t: number) => {
      const k = (t - t0) / 1000
      ctx.clearRect(0, 0, cv.width, cv.height)
      for (const p of ps) { p.vy += 0.5 * dpr; p.x += p.vx; p.y += p.vy; p.vx *= .99; p.a += p.s; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.globalAlpha = Math.max(0, 1 - k / 4); ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore() }
      if (k < 4.5) raf = requestAnimationFrame(loop); else ctx.clearRect(0, 0, cv.width, cv.height)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [fire])
  return <canvas ref={ref} className="confetti" aria-hidden />
}

/** Seconds-accurate countdown that ticks locally between backend updates. */
export function useCountdown(secondsLeft: number, updatedAt: string): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const base = new Date(updatedAt).getTime() || now
  return Math.max(0, secondsLeft - Math.floor((now - base) / 1000))
}
