import { useEffect, useRef, useState } from 'react'

/**
 * Custom cursor: a precise dot with a soft trailing ring that morphs over
 * interactive targets (link pill, text caret, press shrink). Mounted only
 * for fine pointers without reduced motion; otherwise the native cursor
 * stays. One rAF loop, no per-click DOM churn.
 */

const FINE_POINTER = '(pointer: fine)'
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

const INTERACTIVE = 'a, button, [role="button"], input, select, textarea, label, summary, [data-cursor]'

type CursorMode = 'idle' | 'link' | 'text'

export function CursorLayer() {
  // Derived once at mount: fine pointer without reduced motion. The layer
  // never setStates synchronously inside an effect.
  const [enabled] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(FINE_POINTER).matches &&
      !window.matchMedia(REDUCED_MOTION).matches,
  )
  const [mode, setMode] = useState<CursorMode>('idle')
  const [pressing, setPressing] = useState(false)
  const dotRef = useRef<HTMLDivElement | null>(null)
  const ringRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!enabled) return
    document.body.classList.add('isla-cursor-active')

    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const ring = { x: pointer.x, y: pointer.y }
    let raf = 0

    const paint = (): void => {
      ring.x += (pointer.x - ring.x) * 0.22
      ring.y += (pointer.y - ring.y) * 0.22
      if (dotRef.current !== null) {
        dotRef.current.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`
      }
      if (ringRef.current !== null) {
        ringRef.current.style.transform = `translate3d(${ring.x}px, ${ring.y}px, 0)`
      }
      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)

    const onMove = (event: PointerEvent): void => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      const target = event.target instanceof Element ? event.target : null
      if (target === null) return
      setMode(target.closest('input, textarea') !== null ? 'text' : target.closest(INTERACTIVE) !== null ? 'link' : 'idle')
    }
    const onDown = (): void => setPressing(true)
    const onUp = (): void => setPressing(false)
    const onLeave = (): void => {
      pointer.x = window.innerWidth / 2
      pointer.y = window.innerHeight / 2
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    return () => {
      document.body.classList.remove('isla-cursor-active')
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [enabled])

  if (!enabled) return null
  const stateClass =
    (pressing ? 'isla-cursor--press' : mode === 'link' ? 'isla-cursor--link' : mode === 'text' ? 'isla-cursor--text' : '') ||
    'isla-cursor--idle'

  return (
    <>
      <div ref={ringRef} className={`isla-cursor isla-cursor__ring ${stateClass}`} aria-hidden="true" />
      <div ref={dotRef} className="isla-cursor__dot" aria-hidden="true" />
    </>
  )
}
