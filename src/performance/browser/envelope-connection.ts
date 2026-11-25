/**
 * Optional browser clock channel for the M1 mouth envelope.
 *
 * The page opts in only when its URL fragment carries the ephemeral local
 * capability. The capability selects a local loopback WebSocket; it is not an
 * application or avatar credential and never travels in a path, query or log.
 * This module forwards only the observed media sample (identity, state and
 * actual position). It does not read volume, mute, audio bytes or media
 * properties, and it never patches browser-wide APIs.
 */

import type {
  MouthPlaybackKey,
  MouthPlaybackSample,
  MouthPlaybackState,
} from './types'

export type { MouthPlaybackKey, MouthPlaybackSample, MouthPlaybackState }

type Observer = (sample: MouthPlaybackSample) => void

interface EnvelopeSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: () => void): void
}

interface EnvelopeRealm {
  readonly location?: { hash: string; protocol: string; hostname: string; host: string }
  readonly WebSocket?: new (url: string, protocols: string[]) => EnvelopeSocket
  readonly window?: { addEventListener?: (type: string, listener: () => void) => void }
}

const CLOCK_PATH = '/_isla/mouth/clock'
const CLOCK_PROTOCOL = 'isla-mouth-v1'
const FRAGMENT_PATTERN = /^#isla-mouth=([A-Za-z0-9_-]{43})$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BUFFERED_AMOUNT = 4096

let socket: EnvelopeSocket | undefined
let observer: Observer | undefined
let pending: MouthPlaybackSample | undefined
let generation = 0
let pagehideBound = false

function realm(): EnvelopeRealm {
  return globalThis as EnvelopeRealm
}

function readConfiguration(): { readonly url: string; readonly token: string } | undefined {
  const location = realm().location
  if (location === undefined) return undefined
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return undefined
  if (!LOOPBACK_HOSTS.has(location.hostname)) return undefined
  const match = FRAGMENT_PATTERN.exec(location.hash)
  if (match === null) return undefined
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: `${protocol}//${location.host}${CLOCK_PATH}`, token: match[1] }
}

function retireCurrent(expected?: EnvelopeSocket): void {
  if (expected !== undefined && socket !== expected) return
  const current = socket
  if (current === undefined && observer === undefined) return
  socket = undefined
  observer = undefined
  pending = undefined
  generation += 1
  if (current !== undefined && current.readyState < 2) {
    try {
      current.close()
    } catch {
      // A socket that cannot close has already stopped being useful.
    }
  }
}

function bindPagehide(): void {
  if (pagehideBound) return
  pagehideBound = true
  realm().window?.addEventListener?.('pagehide', () => retireCurrent())
}

function serialize(value: MouthPlaybackSample): string | undefined {
  try {
    // Rebuild the wire object so an accidental host-side field such as volume,
    // mute or media data cannot leave the page.
    const { audioRef, sessionId, epoch, turnId, segmentId, outputId } = value.key
    return JSON.stringify({
      key: { audioRef, sessionId, epoch, turnId, segmentId, outputId },
      state: value.state,
      positionMs: value.positionMs,
    })
  } catch {
    return undefined
  }
}

function deliver(current: EnvelopeSocket, value: MouthPlaybackSample): void {
  if (current.readyState !== 1) {
    // Before OPEN only the latest playing sample is worth retaining. A terminal
    // sample retires any older buffered playback instead of replaying it.
    pending = value.state === 'playing' ? value : undefined
    return
  }
  if (value.state === 'playing' && current.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    pending = value
    return
  }
  // A non-playing sample is tiny and must not wait behind a slow socket.
  const text = serialize(value)
  if (text === undefined) return
  pending = undefined
  try {
    current.send(text)
  } catch {
    retireCurrent(current)
  }
}

/**
 * Returns the realm's current clock callback when the page is a correctly
 * configured local viewer. The first accepted handle creates one socket for
 * this realm; later handles reuse it until a disconnect retires that generation.
 * Ordinary tabs, invalid fragments and server-side rendering receive nothing.
 */
export function getEnvelopeObserver(): Observer | undefined {
  const configuration = readConfiguration()
  if (configuration === undefined) {
    retireCurrent()
    return undefined
  }
  if (socket !== undefined && socket.readyState <= 1 && observer !== undefined) return observer
  if (socket !== undefined) retireCurrent()

  const Constructor = realm().WebSocket
  if (Constructor === undefined) return undefined
  bindPagehide()

  let current: EnvelopeSocket
  try {
    current = new Constructor(configuration.url, [CLOCK_PROTOCOL, configuration.token])
  } catch {
    return undefined
  }

  socket = current
  const currentGeneration = generation + 1
  generation = currentGeneration
  const boundObserver = (value: MouthPlaybackSample): void => {
    if (generation !== currentGeneration || socket !== current) return
    deliver(current, value)
  }
  observer = boundObserver

  current.addEventListener('open', () => {
    if (generation !== currentGeneration || socket !== current) return
    const buffered = pending
    pending = undefined
    if (buffered !== undefined) deliver(current, buffered)
  })
  current.addEventListener('close', () => retireCurrent(current))
  current.addEventListener('error', () => retireCurrent(current))

  return boundObserver
}
