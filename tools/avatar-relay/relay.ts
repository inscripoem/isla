/**
 * Local avatar relay core.
 *
 * A small fan-out that turns source frames into wire messages and status text
 * for connected clients. It is Node-only and never imported by the browser
 * entry points; the WebSocket server that owns sockets lives in index.ts. Status
 * and frame validation reuse the browser-safe viewport module so a client can
 * trust that the relay reported what it accepted.
 */

import {
  MAX_DIMENSION,
  MAX_FRAME_BYTES,
  MIN_DIMENSION,
  parseAvatarFrame,
} from '../../src/console/avatar-viewport.ts'
import type { AvatarStatus } from '../../src/console/avatar-viewport.ts'
import type { AvatarSource, AvatarSourceFrame } from './source.ts'

export interface RelaySocket {
  readonly readyState?: number
  send(data: string | Uint8Array): void
  close(): void
}

export interface AvatarRelayOptions {
  readonly source: AvatarSource
  readonly now?: () => number
  readonly onError?: (message: string) => void
}

export interface AvatarRelay {
  handleClient(socket: RelaySocket): () => void
  start(): void
  stop(): void
  status(): AvatarStatus
  lastFrameAt(): number | null
  clientCount(): number
}

const FRAME_HEADER_BYTES = 8
const OPEN = 1

function isDimension(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION
}

export function createAvatarRelay(options: AvatarRelayOptions): AvatarRelay {
  const { source } = options
  const now = options.now ?? (() => Date.now())
  const onError = options.onError ?? (() => {})

  const clients = new Set<RelaySocket>()
  let running = false
  let lastFrameAtMs: number | null = null

  function status(): AvatarStatus {
    return {
      protocolVersion: '0.1',
      kind: 'avatar.status',
      source: running ? source.kind : 'none',
      fps: running ? source.fps : null,
      lastFrameAt: lastFrameAtMs,
    }
  }

  function encodeFrame(frame: AvatarSourceFrame): Uint8Array | null {
    const payload = frame.payload
    if (payload.byteLength + FRAME_HEADER_BYTES > MAX_FRAME_BYTES) return null
    const bytes = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
    bytes[0] = 0x41
    bytes[1] = 0x56
    bytes[2] = 1
    bytes[3] = 1
    bytes[4] = (frame.width >>> 8) & 0xff
    bytes[5] = frame.width & 0xff
    bytes[6] = (frame.height >>> 8) & 0xff
    bytes[7] = frame.height & 0xff
    bytes.set(payload, FRAME_HEADER_BYTES)
    return bytes
  }

  function sendTo(socket: RelaySocket, data: string | Uint8Array): void {
    if (socket.readyState !== undefined && socket.readyState !== OPEN) return
    try {
      socket.send(data)
    } catch {
      clients.delete(socket)
    }
  }

  function emit(frame: AvatarSourceFrame): void {
    if (!isDimension(frame.width) || !isDimension(frame.height)) {
      onError('frame rejected: width and height must be integers within bounds')
      return
    }
    if (!(frame.payload instanceof Uint8Array)) {
      onError('frame rejected: payload must be a Uint8Array')
      return
    }
    if (frame.payload.byteLength + FRAME_HEADER_BYTES > MAX_FRAME_BYTES) {
      onError('frame rejected: payload exceeds the frame size limit')
      return
    }
    const encoded = encodeFrame(frame)
    if (encoded === null) {
      onError('frame rejected: could not encode frame')
      return
    }
    const parsed = parseAvatarFrame(encoded)
    if (!parsed.ok) {
      onError(`frame rejected: ${parsed.code}`)
      return
    }
    lastFrameAtMs = now()
    for (const socket of [...clients]) {
      sendTo(socket, encoded)
    }
  }

  function broadcastStatus(): void {
    const text = JSON.stringify(status())
    for (const socket of [...clients]) {
      sendTo(socket, text)
    }
  }

  return {
    handleClient(socket) {
      clients.add(socket)
      sendTo(socket, JSON.stringify(status()))
      return () => {
        clients.delete(socket)
      }
    },
    start() {
      if (running) return
      running = true
      source.start(emit)
    },
    stop() {
      if (!running) return
      running = false
      source.stop()
      broadcastStatus()
    },
    status,
    lastFrameAt() {
      return lastFrameAtMs
    },
    clientCount() {
      return clients.size
    },
  }
}
