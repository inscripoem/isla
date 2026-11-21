import { useEffect, useRef } from 'react'
import { PetalField } from './petals'

/**
 * Fixed night-sky background: a static nebula wash, a twinkling star field
 * and a single sakura petal canvas. Depth comes from layered gradients, not
 * from animated blur filters — every layer here is either static CSS or one
 * shared lightweight canvas, so the background never fights the content for
 * frame time.
 *
 * The aurora band drifts gently against the pointer through --isla-mx/
 * --isla-my (transform-only, no filter repaints).
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const FINE_POINTER = '(pointer: fine)'

function writeParallax(event: PointerEvent): void {
  const x = (event.clientX / window.innerWidth) * 2 - 1
  const y = (event.clientY / window.innerHeight) * 2 - 1
  const root = document.documentElement
  root.style.setProperty('--isla-mx', x.toFixed(3))
  root.style.setProperty('--isla-my', y.toFixed(3))
}

export function DepthLayers() {
  const frame = useRef(0)

  useEffect(() => {
    if (window.matchMedia(REDUCED_MOTION).matches || !window.matchMedia(FINE_POINTER).matches) return
    const onMove = (event: PointerEvent): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => writeParallax(event))
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame.current)
    }
  }, [])

  return (
    <div className="isla-depth" aria-hidden="true">
      <div className="isla-depth__wash" />
      <div className="isla-depth__stars" />
      <div className="isla-depth__aurora">
        <div className="isla-depth__ribbon isla-depth__ribbon--sky" />
        <div className="isla-depth__ribbon isla-depth__ribbon--pink" />
      </div>
      <PetalField />
    </div>
  )
}
