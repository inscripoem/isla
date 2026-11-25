/**
 * Avatar frame sources for the local relay.
 *
 * This module is Node-only and DOM-free: it never touches the canvas or the
 * browser graph. Sources either produce frames on a timer (synthetic) or report
 * that no frames are available (none, unavailable NDI). A source never invents a
 * frame: the NDI boundary stays untested until capture is implemented.
 */

export interface AvatarSourceFrame {
  readonly payload: Uint8Array
  readonly width: number
  readonly height: number
}

export interface AvatarSource {
  readonly kind: 'none' | 'synthetic' | 'ndi'
  readonly fps: number | null
  start(emit: (frame: AvatarSourceFrame) => void): void
  stop(): void
}

/** A 96x96 lossy WebP with VP8X alpha and an ALPH chunk, generated locally. */
export const SYNTHETIC_FRAME_BASE64 =
  'UklGRtICAABXRUJQVlA4WAoAAAAQAAAAXwAAXwAAQUxQSJcAAAABDzDIERHCUW3bTkNniASkfGkgDSlIYNi5QN476ck0ov+K3LZtlGO6K38i+g81BqCVUs8g1Z5VajySFEMHGv2NCkbCwPFGgJkwcb8hvxYs1UqwVGcpGXdFuORgqe8zWsJ9VkvzHLtFr0OO+Ht5+Vu95v0f/7vH/5p9eNwZ9op9Qw/ZT/aWfWbP2X/OBeaFc8T54tz97IoAAFZQOCAUAgAAcBAAnQEqYABgAD4xGIlDIiGhFVoFKCADBKANQRQTvP53+TPCldzcpP5Pv1v218AB+h24A/T79vOEA/pP9I6wD0AP2l9T7/P/sL8B/7X+wT/Kf7H/6ta56AfQAEDB4PA2rawEVufrm70wzK+fL38dBUj2AiSkrjfSjZrAqS2gUpxcvsZchGMWzRskd6AA/v7uqgD7/9umh/9umG7mPlbTLtliE8uqFZVKACxk2Vqzt7Xna5+fCWmYxaMH8JaZjEf5ngjkBFLu5ao/DBxwWUfGFnWs/KBM5BRWpCsYFMmsqjiBwawVbSm8H9voy+xeKX8b1f8sG/9Y7e7ug7LNTfxmOvBgYuUHkkeZx+lNxErrLA7jJS2Lww7r+QX4wtRVzLywA4ymef5mzoliazkOQMJkjroMYUoOj8vVCFaazcdUFKA+Sd6eCnbQ4RC+3/p6/YW6q/wB2ODBnDsyZezob3HKwmHvOeRL/7fnZe7kgB3nZOaXv+ZEVP7qrxHgoKKcvjgs0zkHV3OgXi/IhmENOqPvvjFa668K9qfsxr4NFGCuElNhIW4U6gTsDYuLcPqba5dP7GO66G9xysJh7znkLf+36Qwtw4xuQJuRRH/DjG5Am5FEg3h4Ws+j0sJ4xH/SbTmIElhO4+dkk/kWNYyHMP63pq5Jd7/7fmj/f38xX3usEGb9hZP4uhcYqi+1/0OwUTuFjqAAAA=='

export const SYNTHETIC_FRAME_WIDTH = 96
export const SYNTHETIC_FRAME_HEIGHT = 96
export const SYNTHETIC_WEBP: Uint8Array = Buffer.from(SYNTHETIC_FRAME_BASE64, 'base64')

/**
 * Emit a fixed payload on a timer. The payload reference is reused for every
 * frame so a consumer cannot mutate one frame's bytes into another's.
 */
export function createSyntheticSource(options?: {
  readonly fps?: number
  readonly payload?: Uint8Array
  readonly width?: number
  readonly height?: number
}): AvatarSource {
  const fps = options?.fps ?? 15
  const payload = options?.payload ?? SYNTHETIC_WEBP
  const width = options?.width ?? SYNTHETIC_FRAME_WIDTH
  const height = options?.height ?? SYNTHETIC_FRAME_HEIGHT
  const periodMs = Math.max(1, Math.round(1000 / fps))

  let timer: ReturnType<typeof setInterval> | null = null
  let emitCallback: ((frame: AvatarSourceFrame) => void) | null = null

  const emitFrame = (): void => {
    if (emitCallback === null) return
    emitCallback({ payload, width, height })
  }

  return {
    kind: 'synthetic',
    fps,
    start(emit) {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      emitCallback = emit
      emitFrame()
      timer = setInterval(emitFrame, periodMs)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      emitCallback = null
    },
  }
}

/** A source that never produces a frame. */
export function createNoneSource(): AvatarSource {
  return {
    kind: 'none',
    fps: null,
    start() {},
    stop() {},
  }
}

/**
 * The NDI boundary. Capture is not implemented in this increment, so the source
 * reports its kind but never emits; the reason is informational only.
 */
export function createUnavailableNdiSource(reason: string): AvatarSource {
  void reason
  return {
    kind: 'ndi',
    fps: null,
    start() {},
    stop() {},
  }
}
