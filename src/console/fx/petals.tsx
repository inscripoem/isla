import { useEffect, useRef } from 'react'

/**
 * Sakura petal field (koharu's petal-field recipe, adapted).
 *
 * A fixed canvas between the background depth stack and the content:
 * pre-rendered petal sprites fall with a sway phase and a fake-3D flip,
 * and pointer movement brushes nearby petals along the pointer velocity
 * so the sky reacts to the mouse. Petals are soft and sparse so console
 * text stays readable.
 *
 * The field mounts only for reduced-motion-free sessions and pauses when
 * the tab is hidden. Nothing here is required to understand a state
 * change: it is decoration.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const PETAL_COUNT = 12
/** Cap canvas resolution: full-screen repaint at DPR 2 is the main cost. */
const MAX_DPR = 1.5
/** Pointer influence radius and the strongest push it may apply. */
const BRUSH_RADIUS = 110
const MAX_PUSH = 4.4
/** px/s^2 decay applied to the brush velocity each second. */
const PUSH_DECAY = 3.2

interface PetalSprite {
  readonly canvas: HTMLCanvasElement
  readonly size: number
}

interface Petal {
  x: number
  y: number
  vy: number
  swayPhase: number
  swaySpeed: number
  swayAmplitude: number
  rotation: number
  spin: number
  scale: number
  sprite: number
  pushX: number
  pushY: number
}

/**
 * Draw one petal sprite into an offscreen canvas: the koharu petal path,
 * filled with a candy gradient and a soft rim. On the night sky the
 * petals carry a faint glow so they stay visible without shouting.
 */
function makePetalSprite(inner: string, outer: string, glow: string): PetalSprite {
  const size = 20
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx === null) return { canvas, size }
  const gradient = ctx.createLinearGradient(2, 2, size - 2, size - 2)
  gradient.addColorStop(0, inner)
  gradient.addColorStop(1, outer)
  ctx.fillStyle = gradient
  ctx.shadowColor = glow
  ctx.shadowBlur = 6
  // The petal: one rounded corner pulled to a point (koharu's path,
  // normalised into a 20x20 box).
  ctx.beginPath()
  ctx.moveTo(10, 24 - 4)
  ctx.bezierCurveTo(4.6, 20.4 - 4, 1.4, 14.2 - 4, 2.2, 8.4 - 4)
  ctx.bezierCurveTo(3, 2.6 - 4, 9, -1.4, 13.6, 0.8)
  ctx.bezierCurveTo(18.6, 3.2, 19, 10, 15.4, 14.6)
  ctx.bezierCurveTo(13.4, 17.2, 11.6, 19.4, 10, 20 - 4)
  ctx.closePath()
  ctx.fill()
  return { canvas, size }
}

function makeSprites(): readonly PetalSprite[] {
  return [
    makePetalSprite('#ffe6ee', '#ff9ebd', 'rgba(255, 158, 189, 0.8)'),
    makePetalSprite('#fff3f7', '#ffb8cc', 'rgba(255, 184, 204, 0.7)'),
    makePetalSprite('#ffd9e5', '#f7879f', 'rgba(247, 135, 159, 0.7)'),
    makePetalSprite('#dbeeff', '#7cb8ee', 'rgba(124, 184, 238, 0.7)'),
    makePetalSprite('#fff6dd', '#ffd46b', 'rgba(255, 212, 107, 0.7)'),
  ]
}

function spawnPetal(petals: readonly PetalSprite[], width: number, fromTop: boolean): Petal {
  const angle = Math.random() * Math.PI * 2
  return {
    x: Math.random() * width,
    y: fromTop ? -24 - Math.random() * 120 : Math.random() * 400,
    vy: 22 + Math.random() * 26,
    swayPhase: angle,
    swaySpeed: 0.6 + Math.random() * 0.9,
    swayAmplitude: 14 + Math.random() * 22,
    rotation: angle,
    spin: (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 1.1),
    scale: 0.55 + Math.random() * 0.6,
    sprite: Math.floor(Math.random() * petals.length),
    pushX: 0,
    pushY: 0,
  }
}

export function PetalField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (window.matchMedia(REDUCED_MOTION).matches) return
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const sprites = makeSprites()
    let width = window.innerWidth
    let height = window.innerHeight
    let raf = 0
    let running = !document.hidden
    let last = performance.now()

    const resize = (): void => {
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const items: Petal[] = Array.from({ length: PETAL_COUNT }, () => spawnPetal(sprites, width, false))

    // Pointer brush: recent velocity, decayed every frame.
    const pointer = { x: -9999, y: -9999, vx: 0, vy: 0 }
    const lastPointer = { x: 0, y: 0, has: false }
    const onMove = (event: PointerEvent): void => {
      if (lastPointer.has) {
        pointer.vx = event.clientX - lastPointer.x
        pointer.vy = event.clientY - lastPointer.y
      }
      lastPointer.x = event.clientX
      lastPointer.y = event.clientY
      lastPointer.has = true
      pointer.x = event.clientX
      pointer.y = event.clientY
    }

    const onVisibility = (): void => {
      running = !document.hidden
      if (running) {
        last = performance.now()
        raf = requestAnimationFrame(step)
      } else {
        cancelAnimationFrame(raf)
      }
    }

    const step = (now: number): void => {
      if (!running) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      pointer.vx *= Math.max(0, 1 - PUSH_DECAY * dt)
      pointer.vy *= Math.max(0, 1 - PUSH_DECAY * dt)

      ctx.clearRect(0, 0, width, height)
      for (const petal of items) {
        petal.swayPhase += petal.swaySpeed * dt
        petal.y += petal.vy * dt
        petal.x += Math.sin(petal.swayPhase) * petal.swayAmplitude * dt + petal.pushX
        petal.y += petal.pushY
        petal.rotation += petal.spin * dt
        petal.pushX *= Math.max(0, 1 - PUSH_DECAY * dt * 2)
        petal.pushY *= Math.max(0, 1 - PUSH_DECAY * dt * 2)

        // Brush: petals near the pointer are pushed along its velocity.
        const dx = petal.x - pointer.x
        const dy = petal.y - pointer.y
        const distance = Math.hypot(dx, dy)
        if (distance < BRUSH_RADIUS && distance > 0.001) {
          const strength = (1 - distance / BRUSH_RADIUS) * MAX_PUSH
          petal.pushX += ((pointer.vx * strength) / 8) * dt * 60
          petal.pushY += ((pointer.vy * strength) / 8) * dt * 60
        }

        // Respawn above the fold once a petal leaves the sky.
        if (petal.y > height + 30 || petal.x < -40 || petal.x > width + 40) {
          Object.assign(petal, spawnPetal(sprites, width, true))
          continue
        }

        const sprite = sprites[petal.sprite]!
        const flip = Math.abs(Math.cos(petal.swayPhase * 0.9)) * 0.7 + 0.3
        ctx.save()
        ctx.translate(petal.x, petal.y)
        ctx.rotate(petal.rotation)
        ctx.scale(petal.scale, petal.scale * flip)
        ctx.globalAlpha = 0.75
        ctx.drawImage(sprite.canvas, -sprite.size / 2, -sprite.size / 2)
        ctx.restore()
      }
      raf = requestAnimationFrame(step)
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', resize)
    raf = requestAnimationFrame(step)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="isla-petal-canvas" aria-hidden="true" />
}
