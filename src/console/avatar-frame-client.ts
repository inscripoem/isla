/**
 * Injected-socket framing for the avatar relay.
 *
 * This module never references a global WebSocket: the socket is always supplied
 * by the caller, so the same client is exercised with a fake in offline tests and
 * with the platform socket in the browser. It never reconnects on its own; a
 * close or error is reported once and the viewport decides when to retry.
 */

import { parseAvatarFrame, parseAvatarStatus } from './avatar-viewport'
import type { AvatarFrame, AvatarStatus } from './avatar-viewport'

export interface AvatarSocket {
  binaryType: string
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  close(): void
}

export type AvatarClientEvent =
  | { readonly type: 'open' }
  | { readonly type: 'status'; readonly status: AvatarStatus }
  | { readonly type: 'frame'; readonly frame: AvatarFrame; readonly receivedAtMs: number }
  | { readonly type: 'frame-rejected'; readonly code: string; readonly receivedAtMs: number }
  | { readonly type: 'closed'; readonly detail: string | null }
  | { readonly type: 'error'; readonly detail: string | null }

export interface AvatarFrameClientOptions {
  readonly url: string
  readonly createSocket: (url: string) => AvatarSocket
  readonly onEvent: (event: AvatarClientEvent) => void
  readonly now?: () => number
}

export interface AvatarFrameClient {
  connect(): void
  reconnect(): void
  dispose(): void
}

function detach(socket: AvatarSocket): void {
  socket.onopen = null
  socket.onmessage = null
  socket.onclose = null
  socket.onerror = null
}

export function createAvatarFrameClient(options: AvatarFrameClientOptions): AvatarFrameClient {
  const now = options.now ?? (() => Date.now())
  let socket: AvatarSocket | null = null
  let disposed = false

  const handleMessage = (data: unknown): void => {
    if (typeof data === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        options.onEvent({ type: 'error', detail: 'invalid avatar status' })
        return
      }
      const status = parseAvatarStatus(parsed)
      if (status === null) {
        options.onEvent({ type: 'error', detail: 'invalid avatar status' })
        return
      }
      options.onEvent({ type: 'status', status })
      return
    }

    let bytes: ArrayBuffer | Uint8Array | null = null
    if (data instanceof ArrayBuffer) {
      bytes = data
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    if (bytes === null) {
      options.onEvent({ type: 'frame-rejected', code: 'unsupported_message', receivedAtMs: now() })
      return
    }

    const receivedAtMs = now()
    const result = parseAvatarFrame(bytes)
    if (!result.ok) {
      options.onEvent({ type: 'frame-rejected', code: result.code, receivedAtMs })
      return
    }
    options.onEvent({ type: 'frame', frame: result.frame, receivedAtMs })
  }

  const connect = (): void => {
    if (disposed || socket !== null) return
    const next = options.createSocket(options.url)
    socket = next
    next.binaryType = 'arraybuffer'
    next.onopen = () => {
      if (socket !== next) return
      options.onEvent({ type: 'open' })
    }
    next.onmessage = (event) => {
      if (socket !== next) return
      handleMessage(event.data)
    }
    next.onclose = () => {
      if (socket !== next) return
      socket = null
      options.onEvent({ type: 'closed', detail: 'relay connection closed' })
    }
    next.onerror = () => {
      if (socket !== next) return
      socket = null
      options.onEvent({ type: 'error', detail: 'relay connection error' })
    }
  }

  const reconnect = (): void => {
    if (disposed) return
    const current = socket
    socket = null
    if (current !== null) {
      detach(current)
      current.close()
    }
    connect()
  }

  const dispose = (): void => {
    disposed = true
    const current = socket
    socket = null
    if (current !== null) {
      detach(current)
      current.close()
    }
  }

  return { connect, reconnect, dispose }
}
