import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { isIPv4 } from 'node:net'
import type { Duplex } from 'node:stream'

import { WebSocketServer, type WebSocket } from 'ws'

import type {
  MouthPlaybackSample,
  MouthPlaybackState,
} from '../browser/envelope-connection'
import { createEnvelopePlayback } from './envelope-playback'
import type { VolumeEnvelopeEvent } from './volume-envelope'

/**
 * Optional local clock bridge for the M1 mouth envelope.
 *
 * The caller owns the HTTP server (for example Vite's), so this bridge adds one
 * exact WebSocket upgrade route and never opens a second port. The page receives
 * only an ephemeral local capability in its URL fragment. Clock frames travel
 * browser-to-server; envelopes and audio never travel to the browser.
 *
 * The peer playback controller owns envelope validation, RMS, output identity,
 * epochs, terminal neutralisation and write pacing. This module owns the local
 * transport, capability/origin admission, one socket generation and a tiny
 * bounded pre-connection supply cache.
 */

const CLOCK_PATH = '/_isla/mouth/clock'
const CLOCK_PROTOCOL = 'isla-mouth-v1'
const FRAGMENT_PREFIX = '#isla-mouth='
const MAX_PAYLOAD_BYTES = 4096
const MAX_PENDING_ENVELOPES = 8
const PENDING_TTL_MS = 15_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const CLOCK_STATES: readonly MouthPlaybackState[] = [
  'playing',
  'waiting',
  'paused',
  'ended',
  'error',
  'stopped',
]

interface PendingEnvelope {
  readonly at: number
  readonly envelope: VolumeEnvelopeEvent
}

interface BridgeSession {
  readonly socket: WebSocket
  readonly controller: ReturnType<typeof createEnvelopePlayback>
  readonly generation: number
  retired: boolean
  closing?: Promise<void>
}

export interface EnvelopeBridge {
  readonly fragment: string
  supply(envelope: VolumeEnvelopeEvent): void
  attach(server: Server): void
  close(): Promise<void>
}

export interface EnvelopeBridgeOptions {
  readonly origin: string
  readonly write: (opening: number, signal: AbortSignal) => void | Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOrigin(origin: string): { readonly origin: string; readonly host: string } {
  const url = new URL(origin)
  const valid =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === '/' &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    LOOPBACK_HOSTS.has(url.hostname)
  if (!valid) throw new TypeError('m1-envelope-bridge: origin must be an HTTP loopback origin')
  return { origin: url.origin, host: url.host }
}

/** True only for IPv4/IPv6 loopback, including IPv4-mapped loopback forms. */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  let value = address.toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (value === '::1') return true
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  if (isIPv4(value)) return value.startsWith('127.')
  const groups = value.split(':')
  if (groups.length !== 2) return false
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  if (!Number.isInteger(high) || !Number.isInteger(low)) return false
  if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) return false
  return ((high << 16) | low) >>> 24 === 127
}

/** Copies an envelope for the short pre-connection cache without trusting it. */
function copyEnvelope(value: VolumeEnvelopeEvent): VolumeEnvelopeEvent | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.audioRef !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.segmentId !== 'string' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    value.stepMs !== 20 ||
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !Array.isArray(value.levels) ||
    !value.levels.every(
      (level) => typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 1,
    )
  ) {
    return undefined
  }
  const { audioRef, sessionId, epoch, turnId, segmentId, durationMs, levels } = value
  return {
    audioRef,
    sessionId,
    epoch,
    turnId,
    segmentId,
    stepMs: 20,
    durationMs,
    levels: Object.freeze([...levels]),
  }
}

/** Decodes only the small JSON clock frame; levels and openings are refused. */
function parseClock(text: string): MouthPlaybackSample | undefined {
  if (text.length === 0 || text.length > MAX_PAYLOAD_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || 'levels' in value || 'opening' in value) return undefined
  if (typeof value.state !== 'string' || !CLOCK_STATES.includes(value.state as MouthPlaybackState)) {
    return undefined
  }
  if (
    typeof value.positionMs !== 'number' ||
    !Number.isFinite(value.positionMs) ||
    value.positionMs < 0
  ) {
    return undefined
  }
  const key = value.key
  if (!isRecord(key)) return undefined
  for (const field of ['audioRef', 'sessionId', 'turnId', 'segmentId', 'outputId'] as const) {
    if (typeof key[field] !== 'string' || key[field].length === 0) return undefined
  }
  if (!Number.isSafeInteger(key.epoch) || (key.epoch as number) < 0) return undefined
  return {
    key: {
      audioRef: key.audioRef as string,
      sessionId: key.sessionId as string,
      epoch: key.epoch as number,
      turnId: key.turnId as string,
      segmentId: key.segmentId as string,
      outputId: key.outputId as string,
    },
    state: value.state as MouthPlaybackState,
    positionMs: value.positionMs,
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch {
    // The transport may already be gone; the outcome is still a rejection.
  }
  socket.destroy()
}

function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Creates one local clock bridge. The fragment is generated for every bridge
 * instance and must be delivered only to the dedicated local browser page.
 */
export function createEnvelopeBridge(options: EnvelopeBridgeOptions): EnvelopeBridge {
  const expected = parseOrigin(options.origin)
  const capability = randomBytes(32).toString('base64url')
  const capabilityBytes = Buffer.from(capability, 'utf8')
  const pending: PendingEnvelope[] = []

  let active: BridgeSession | undefined
  let writing:
    | { readonly generation: number; readonly controller: AbortController }
    | undefined
  let attached: Server | undefined
  let closed = false
  let closing: Promise<void> | undefined
  let generation = 0

  const server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(CLOCK_PROTOCOL) ? CLOCK_PROTOCOL : false
    },
  })
  server.on('error', () => {
    // A failed local bridge must not become a process-wide unhandled error.
  })

  const matchesCapability = (candidate: string): boolean => {
    const bytes = Buffer.from(candidate, 'utf8')
    return bytes.length === capabilityBytes.length && timingSafeEqual(bytes, capabilityBytes)
  }

  const writeFor = (sessionGeneration: number) => {
    return (opening: number, signal: AbortSignal): void | Promise<void> => {
      const current = active
      if (current === undefined || current.generation !== sessionGeneration) return
      // A retiring owner may still emit its neutral write, but no late nonzero
      // value may reopen the mouth or follow the socket into a new generation.
      if (current.retired && opening !== 0) return

      let writingSession = writing
      if (writingSession === undefined || writingSession.generation !== sessionGeneration) {
        // Supersede the last generation that actually wrote only when this
        // generation writes. An idle replacement leaves the retired neutral
        // live, while an animating replacement cancels that pending zero.
        writingSession?.controller.abort()
        writingSession = { generation: sessionGeneration, controller: new AbortController() }
        writing = writingSession
      }
      const writeAbort = writingSession.controller.signal
      if (writeAbort.aborted) return
      try {
        return Promise.resolve(
          options.write(opening, AbortSignal.any([signal, writeAbort])),
        ).catch(() => {
          // A local actuator failure must not break the clock channel.
        })
      } catch {
        return
      }
    }
  }

  const retire = (session: BridgeSession): Promise<void> => {
    if (session.closing !== undefined) return session.closing
    session.retired = true
    pending.length = 0
    session.closing = (async () => {
      try {
        await session.controller.disconnect()
      } catch {
        // Teardown is best-effort; no stale callback may own the next socket.
      }
      if (active === session) active = undefined
    })()
    return session.closing
  }

  const accept = (socket: WebSocket): void => {
    if (closed) {
      socket.terminate()
      return
    }
    const previous = active
    if (previous !== undefined && !previous.retired) {
      socket.close(1008, 'duplicate clock socket')
      return
    }
    if (previous !== undefined && previous.socket.readyState <= 1) {
      // A disconnected generation may still be waiting on its terminal zero.
      // Leave that neutral live until this replacement actually writes.
      previous.socket.terminate()
    }

    const sessionGeneration = (generation += 1)
    const controller = createEnvelopePlayback(writeFor(sessionGeneration))
    const session: BridgeSession = {
      socket,
      controller,
      generation: sessionGeneration,
      retired: false,
    }
    active = session

    const now = Date.now()
    for (const entry of pending.splice(0)) {
      if (now - entry.at > PENDING_TTL_MS) continue
      try {
        controller.supply(entry.envelope)
      } catch {
        // The controller owns malformed or stale envelope handling.
      }
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary || session.retired || active !== session) return
      const value = parseClock(rawText(data))
      if (value === undefined) return
      try {
        controller.observe(value)
      } catch {
        // Observation must never destabilise the local transport.
      }
    })
    socket.on('close', () => {
      void retire(session)
    })
    socket.on('error', () => {
      void retire(session)
    })
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (request.url === undefined) return
    if (request.url !== CLOCK_PATH) {
      // A different upgrade route belongs to another owner; a query on our
      // exact route is a malformed handshake.
      if (request.url.startsWith(`${CLOCK_PATH}?`)) rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (closed) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (request.headers.origin !== expected.origin) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (String(request.headers.host ?? '').toLowerCase() !== expected.host.toLowerCase()) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }

    const header = request.headers['sec-websocket-protocol']
    const protocols = (Array.isArray(header) ? header.join(',') : header ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    if (protocols.length !== 2 || !protocols.includes(CLOCK_PROTOCOL)) {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    const candidate = protocols.find((value) => value !== CLOCK_PROTOCOL)
    if (candidate === undefined || !matchesCapability(candidate)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    if (active !== undefined && !active.retired) {
      rejectUpgrade(socket, 409, 'Conflict')
      return
    }

    try {
      server.handleUpgrade(request, socket, head, accept)
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
    }
  }

  const detach = (): void => {
    if (attached === undefined) return
    attached.off('upgrade', onUpgrade)
    attached = undefined
  }

  return {
    fragment: `${FRAGMENT_PREFIX}${capability}`,

    supply(value) {
      if (closed) return
      const envelope = copyEnvelope(value)
      if (envelope === undefined) return
      if (active !== undefined && !active.retired) {
        try {
          active.controller.supply(envelope)
        } catch {
          // The controller owns envelope identity and epoch decisions.
        }
        return
      }
      const now = Date.now()
      while (pending.length > 0 && now - pending[0].at > PENDING_TTL_MS) pending.shift()
      pending.push({ at: now, envelope })
      while (pending.length > MAX_PENDING_ENVELOPES) pending.shift()
    },

    attach(httpServer) {
      if (closed) throw new Error('m1-envelope-bridge: bridge is closed')
      if (attached !== undefined) throw new Error('m1-envelope-bridge: bridge is already attached')
      attached = httpServer
      httpServer.on('upgrade', onUpgrade)
    },

    close() {
      if (closing !== undefined) return closing
      closed = true
      detach()
      closing = (async () => {
        pending.length = 0
        const current = active
        if (current !== undefined) {
          try {
            await current.controller.close()
          } catch {
            // Closing is idempotent and must still release the socket.
          }
          if (writing?.generation === current.generation) writing.controller.abort()
          if (active === current) active = undefined
          current.retired = true
          try {
            current.socket.terminate()
          } catch {
            // The socket may already be gone.
          }
        }
        writing = undefined
        try {
          server.close()
        } catch {
          // With noServer the local wrapper may already be closed.
        }
      })()
      return closing
    },
  }
}
