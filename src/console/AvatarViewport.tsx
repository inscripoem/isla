import { useEffect, useRef, useState } from 'react'
import { createAvatarFrameClient } from './avatar-frame-client'
import type { AvatarSocket } from './avatar-frame-client'
import {
  AVATAR_CANVAS_CONTEXT_OPTIONS,
  createAvatarViewportState,
  decodeAvatarFrame,
  reduceAvatarViewport,
  resolveAvatarRelayUrl,
} from './avatar-viewport'
import type { AvatarViewportAction, AvatarViewportState } from './avatar-viewport'

export interface AvatarViewportProps {
  readonly relayUrl: string | null
}

/**
 * A transparent live stage for relay-provided WebP frames.
 *
 * The canvas never draws a background: with no fresh frame it stays empty and
 * only the badge is visible. Image bitmaps are decoded through the injected
 * browser APIs and closed once drawn, so the component never fabricates an
 * avatar and never accumulates decoded frames.
 */
export function AvatarViewport({ relayUrl }: AvatarViewportProps) {
  const relayConfig = resolveAvatarRelayUrl(relayUrl)
  const relayTarget = relayConfig.state === 'configured' ? relayConfig.url : null
  const invalidDetail = relayConfig.state === 'invalid' ? relayConfig.detail : null

  const [state, setState] = useState<AvatarViewportState>(() =>
    createAvatarViewportState(relayTarget !== null, invalidDetail),
  )
  const [stateRelayUrl, setStateRelayUrl] = useState<string | null>(relayUrl)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const clientRef = useRef<ReturnType<typeof createAvatarFrameClient> | null>(null)
  const latestFrameSeq = useRef(0)

  useEffect(() => {
    if (relayTarget === null) return

    let active = true

    const closePreviousBitmap = (): void => {
      const previous = bitmapRef.current
      bitmapRef.current = null
      previous?.close()
    }

    const drawFrame = (bitmap: ImageBitmap, width: number, height: number): void => {
      const canvas = canvasRef.current
      if (canvas === null) return
      const context: CanvasRenderingContext2D | null = canvas.getContext('2d', {
        alpha: AVATAR_CANVAS_CONTEXT_OPTIONS.alpha,
      })
      if (context === null) return
      canvas.width = width
      canvas.height = height
      context.clearRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)
    }

    const dispatch = (action: AvatarViewportAction): void => {
      if (!active) return
      setState((current) => reduceAvatarViewport(current, action))
    }

    const client = createAvatarFrameClient({
      url: relayTarget,
      createSocket: (url) => {
        const socket = new WebSocket(url)
        socket.binaryType = 'arraybuffer'
        return socket as unknown as AvatarSocket
      },
      now: () => Date.now(),
      onEvent: (event) => {
        if (!active) return
        switch (event.type) {
          case 'open':
            dispatch({ type: 'socket-open' })
            return
          case 'status':
            dispatch({ type: 'status', status: event.status })
            return
          case 'frame': {
            const seq = ++latestFrameSeq.current
            void decodeAvatarFrame(event.frame, (payload) => {
              const copy = payload.buffer.slice(
                payload.byteOffset,
                payload.byteOffset + payload.byteLength,
              ) as ArrayBuffer
              return createImageBitmap(new Blob([copy], { type: 'image/webp' }))
            }).then((result) => {
              if (!active || clientRef.current !== client || seq !== latestFrameSeq.current) {
                if (result.ok) result.bitmap.close()
                return
              }
              if (!result.ok) {
                dispatch({ type: 'frame-rejected', code: 'decode_failed' })
                return
              }
              closePreviousBitmap()
              bitmapRef.current = result.bitmap
              drawFrame(result.bitmap, event.frame.width, event.frame.height)
              dispatch({ type: 'frame', receivedAtMs: event.receivedAtMs })
              result.bitmap.close()
              if (bitmapRef.current === result.bitmap) bitmapRef.current = null
            })
            return
          }
          case 'frame-rejected':
            dispatch({ type: 'frame-rejected', code: event.code })
            return
          case 'closed':
            dispatch({ type: 'socket-closed', detail: event.detail })
            return
          case 'error':
            dispatch({ type: 'socket-error', detail: event.detail })
            return
          default:
            return
        }
      },
    })
    clientRef.current = client
    client.connect()
    const interval = window.setInterval(() => {
      dispatch({ type: 'tick', nowMs: Date.now() })
    }, 250)

    return () => {
      active = false
      window.clearInterval(interval)
      client.dispose()
      if (clientRef.current === client) clientRef.current = null
      closePreviousBitmap()
    }
  }, [relayTarget])

  if (stateRelayUrl !== relayUrl) {
    setStateRelayUrl(relayUrl)
    setState(createAvatarViewportState(relayTarget !== null, invalidDetail))
  }

  const fpsLabel = state.fps === null ? 'fps unknown' : `${state.fps} fps`
  const badgeText =
    relayConfig.state === 'unconfigured'
      ? 'Avatar · not configured'
      : relayConfig.state === 'invalid'
        ? 'Avatar · invalid relay url · error'
        : `Avatar · ${state.source} · ${fpsLabel} · ${state.phase}`

  return (
    <div className="avatar-viewport" data-avatar-phase={state.phase}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="avatar-viewport__badge" title={state.detail ?? undefined}>
        {badgeText}
      </span>
      {relayTarget !== null && (state.phase === 'stale' || state.phase === 'error') && (
        <button
          type="button"
          className="avatar-viewport__reconnect"
          onClick={() => {
            setState((current) => reduceAvatarViewport(current, { type: 'reconnect' }))
            clientRef.current?.reconnect()
          }}
        >
          Reconnect
        </button>
      )}
    </div>
  )
}
