import { useEffect, useRef } from 'react'
import { reducedMotion } from '../motion'

// Spectrum particle field behind the page, the same idea as falcontechnix.com's hero:
// small glowing motes drifting upward with short tails, colored across the k2ctl spectrum,
// denser and faster while a print is running. Canvas, pauses when the tab is hidden, and
// skipped entirely under reduced motion.

const COLORS = ['#ff4d6d', '#ffb000', '#3ddc84', '#2b8cff', '#b56cff', '#22d3ee']

export default function Backdrop({ active = false }: { active?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    const cv = ref.current
    if (!cv || reducedMotion()) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    type P = { x: number; y: number; vx: number; vy: number; r: number; c: string; life: number; max: number }
    let ps: P[] = []
    let w = 0, h = 0, raf = 0, last = performance.now(), running = true
    const dpr = Math.min(1.5, window.devicePixelRatio || 1)
    const resize = () => { w = cv.width = Math.floor(innerWidth * dpr); h = cv.height = Math.floor(innerHeight * dpr); cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px' }
    const spawn = (): P => {
      const max = 6000 + Math.random() * 9000
      return { x: Math.random() * w, y: h + 10 * dpr, vx: (Math.random() - .5) * 6 * dpr, vy: -(12 + Math.random() * 22) * dpr, r: (0.8 + Math.random() * 1.6) * dpr, c: COLORS[Math.floor(Math.random() * COLORS.length)], life: 0, max }
    }
    const frame = (t: number) => {
      if (!running) return
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (t - last) / 1000); last = t
      const want = activeRef.current ? 140 : 70
      while (ps.length < want) { const p = spawn(); p.y = Math.random() * h; p.life = Math.random() * p.max; ps.push(p) }
      if (ps.length > want) ps.length = want
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      const speed = activeRef.current ? 1.6 : 1
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]
        p.life += dt * 1000
        p.x += p.vx * dt * speed; p.y += p.vy * dt * speed
        p.vx += (Math.random() - .5) * 2 * dpr * dt
        if (p.y < -20 * dpr || p.life > p.max) { ps[i] = spawn(); continue }
        const a = Math.sin(Math.PI * Math.min(1, p.life / p.max)) * 0.85
        ctx.strokeStyle = p.c; ctx.globalAlpha = a * 0.35; ctx.lineWidth = p.r
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.25, p.y - p.vy * 0.25); ctx.stroke()
        ctx.fillStyle = p.c; ctx.globalAlpha = a
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = a * 0.25
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
    }
    const vis = () => { if (document.hidden) { running = false; cancelAnimationFrame(raf) } else if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame) } }
    resize(); addEventListener('resize', resize); document.addEventListener('visibilitychange', vis)
    raf = requestAnimationFrame(frame)
    return () => { running = false; cancelAnimationFrame(raf); removeEventListener('resize', resize); document.removeEventListener('visibilitychange', vis) }
  }, [])
  return <canvas ref={ref} className="backdrop" aria-hidden />
}
