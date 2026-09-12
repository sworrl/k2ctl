import { useEffect, useRef, useState } from 'react'

/** True when the viewer asked for reduced motion; every effect checks this. */
export function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** Tweens a number toward its target so readouts roll instead of jump. */
export function useTween(target: number, ms = 600): number {
  const [v, setV] = useState(target)
  const from = useRef(target), start = useRef(0), raf = useRef(0)
  useEffect(() => {
    if (reducedMotion() || !Number.isFinite(target)) { setV(target); return }
    cancelAnimationFrame(raf.current)
    from.current = v; start.current = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - start.current) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      setV(from.current + (target - from.current) * e)
      if (k < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ms])
  return v
}

/** Returns a class that flashes briefly whenever the value changes. */
export function useFlash(value: unknown): string {
  const [on, setOn] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setOn(true)
    const t = window.setTimeout(() => setOn(false), 700)
    return () => clearTimeout(t)
  }, [value])
  return on ? 'flash' : ''
}
