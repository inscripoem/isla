import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  AVATAR_CANVAS_CONTEXT_OPTIONS,
  FRESHNESS_WINDOW_MS,
  MAX_DIMENSION,
  MAX_FRAME_BYTES,
  createAvatarViewportState,
  decodeAvatarFrame,
  parseAvatarFrame,
  parseAvatarStatus,
  reduceAvatarViewport,
  resolveAvatarRelayUrl,
} from '../../src/console/avatar-viewport'
import type {
  AvatarDecodeResult,
  AvatarFrame,
  AvatarFrameErrorCode,
  AvatarFrameParseResult,
  AvatarStatus,
  AvatarViewportAction,
} from '../../src/console/avatar-viewport'
import { createAvatarFrameClient } from '../../src/console/avatar-frame-client'
import type { AvatarClientEvent, AvatarSocket } from '../../src/console/avatar-frame-client'

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

/** Build a minimal WebP payload: RIFF size WEBP, then a 10-byte VP8X chunk. */
function webpPayload(flags: number): Uint8Array {
  const payload = new Uint8Array(12 + 8 + 10)
  payload[0] = 0x52
  payload[1] = 0x49
  payload[2] = 0x46
  payload[3] = 0x46
  writeUint32LE(payload, 4, payload.length - 8)
  payload[8] = 0x57
  payload[9] = 0x45
  payload[10] = 0x42
  payload[11] = 0x50
  payload[12] = 0x56
  payload[13] = 0x50
  payload[14] = 0x38
  payload[15] = 0x58
  writeUint32LE(payload, 16, 10)
  payload[20] = flags
  return payload
}

function frameBytes(width: number, height: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength)
  bytes[0] = 0x41
  bytes[1] = 0x56
  bytes[2] = 1
  bytes[3] = 1
  bytes[4] = (width >>> 8) & 0xff
  bytes[5] = width & 0xff
  bytes[6] = (height >>> 8) & 0xff
  bytes[7] = height & 0xff
  bytes.set(payload, 8)
  return bytes
}

/** Pad a valid WebP payload with trailing bytes so the full envelope reaches `total`. */
function frameBytesOfLength(width: number, height: number, total: number): Uint8Array {
  const base = webpPayload(0x10)
  const padded = new Uint8Array(total - 8)
  padded.set(base, 0)
  return frameBytes(width, height, padded)
}

function parsedFrame(result: AvatarFrameParseResult): AvatarFrame {
  if (!result.ok) throw new Error(`expected a valid frame, got ${result.code}`)
  return result.frame
}

function expectRejected(result: AvatarFrameParseResult, code: AvatarFrameErrorCode): void {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a rejected frame')
  expect(result.code).toBe(code)
  expect('frame' in result).toBe(false)
}

function status(
  source: AvatarStatus['source'],
  fps: number | null,
  lastFrameAt: number | null,
): AvatarStatus {
  return { protocolVersion: '0.1', kind: 'avatar.status', source, fps, lastFrameAt }
}

async function decodeOnlyValid<T>(
  bytes: Uint8Array,
  createBitmap: (payload: Uint8Array) => Promise<T>,
): Promise<AvatarDecodeResult<T> | null> {
  const parsed = parseAvatarFrame(bytes)
  if (!parsed.ok) return null
  return decodeAvatarFrame(parsed.frame, createBitmap)
}

class FakeAvatarSocket implements AvatarSocket {
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closeCount = 0
  closed = false

  close(): void {
    this.closeCount += 1
    this.closed = true
  }

  open(): void {
    this.onopen?.()
  }

  message(data: unknown): void {
    this.onmessage?.({ data })
  }

  closeEvent(): void {
    this.closed = true
    this.onclose?.()
  }

  errorEvent(): void {
    this.onerror?.()
  }
}

describe('avatar viewport state', () => {
  it('keeps an unconfigured viewport unavailable for every action', () => {
    const state = createAvatarViewportState(false)
    expect(state.phase).toBe('unavailable')
    expect(state.source).toBe('none')

    const actions: AvatarViewportAction[] = [
      { type: 'socket-open' },
      { type: 'status', status: status('synthetic', 30, 1) },
      { type: 'frame', receivedAtMs: 1 },
      { type: 'tick', nowMs: 1_000_000 },
      { type: 'socket-closed' },
      { type: 'socket-error' },
      { type: 'frame-rejected', code: 'bad_webp' },
      { type: 'reconnect' },
    ]

    for (const action of actions) {
      expect(reduceAvatarViewport(state, action)).toBe(state)
    }
  })

  it('moves live frames to stale only after the freshness window', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'socket-open' })
    state = reduceAvatarViewport(state, { type: 'status', status: status('synthetic', 30, 100) })
    expect(state.phase).toBe('connecting')

    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 1000 })
    expect(state.phase).toBe('live')

    state = reduceAvatarViewport(state, { type: 'tick', nowMs: 1000 + FRESHNESS_WINDOW_MS })
    expect(state.phase).toBe('live')

    state = reduceAvatarViewport(state, { type: 'tick', nowMs: 1000 + FRESHNESS_WINDOW_MS + 1 })
    expect(state.phase).toBe('stale')

    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 2600 })
    expect(state.phase).toBe('live')

    state = reduceAvatarViewport(state, { type: 'tick', nowMs: 2600 + FRESHNESS_WINDOW_MS })
    expect(state.phase).toBe('live')

    state = reduceAvatarViewport(state, { type: 'tick', nowMs: 2600 + FRESHNESS_WINDOW_MS + 1 })
    expect(state.phase).toBe('stale')
  })

  it('reports a relay with no source as stale while connecting', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'socket-open' })
    state = reduceAvatarViewport(state, { type: 'status', status: status('none', null, null) })
    expect(state.phase).toBe('stale')
    expect(state.detail).toBe('relay reports no source')
  })

  it('reconnects only from stale or error and clears frame clocks', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'status', status: status('synthetic', 30, 100) })
    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 1000 })
    state = reduceAvatarViewport(state, { type: 'socket-closed' })
    expect(state.phase).toBe('error')
    expect(state.detail).toBe('relay connection closed')

    const afterTick = reduceAvatarViewport(state, { type: 'tick', nowMs: 100000 })
    expect(afterTick).toBe(state)

    const errored = reduceAvatarViewport(createAvatarViewportState(true), { type: 'socket-error' })
    expect(errored.detail).toBe('relay connection error')

    const reconnected = reduceAvatarViewport(state, { type: 'reconnect' })
    expect(reconnected.phase).toBe('connecting')
    expect(reconnected.lastFrameReceivedAtMs).toBeNull()
    expect(reconnected.lastFrameAt).toBeNull()
    expect(reconnected.fps).toBeNull()
    expect(reconnected.detail).toBeNull()

    const live = reduceAvatarViewport(reconnected, { type: 'frame', receivedAtMs: 2000 })
    expect(live.phase).toBe('live')

    const unavailable = createAvatarViewportState(false)
    expect(reduceAvatarViewport(unavailable, { type: 'reconnect' })).toBe(unavailable)
  })

  it('ignores a frame that arrives after the socket has closed', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 1000 })
    expect(state.phase).toBe('live')

    state = reduceAvatarViewport(state, { type: 'socket-closed' })
    expect(state.phase).toBe('error')

    const afterFrame = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 2000 })
    expect(afterFrame).toBe(state)
    expect(afterFrame.phase).toBe('error')
  })

  it('never lets the frame clock move backwards', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 2000 })
    expect(state.lastFrameReceivedAtMs).toBe(2000)

    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 1000 })
    expect(state.lastFrameReceivedAtMs).toBe(2000)
  })

  it('keeps the maximum status lastFrameAt and ignores a null update', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'status', status: status('synthetic', 30, 500) })
    expect(state.lastFrameAt).toBe(500)

    state = reduceAvatarViewport(state, { type: 'status', status: status('synthetic', 30, null) })
    expect(state.lastFrameAt).toBe(500)

    state = reduceAvatarViewport(state, { type: 'status', status: status('synthetic', 30, 100) })
    expect(state.lastFrameAt).toBe(500)
  })

  it('goes stale immediately when a live relay reports no source', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'frame', receivedAtMs: 1000 })
    expect(state.phase).toBe('live')

    state = reduceAvatarViewport(state, { type: 'status', status: status('none', null, null) })
    expect(state.phase).toBe('stale')
    expect(state.detail).toBe('relay reports no source')
  })

  it('ignores a late status while in error', () => {
    let state = createAvatarViewportState(true)
    state = reduceAvatarViewport(state, { type: 'socket-closed' })
    expect(state.phase).toBe('error')

    const afterStatus = reduceAvatarViewport(state, {
      type: 'status',
      status: status('synthetic', 30, 100),
    })
    expect(afterStatus).toBe(state)
  })

  it('records a frame rejection without storing the frame bytes', () => {
    const state = reduceAvatarViewport(
      reduceAvatarViewport(createAvatarViewportState(true), { type: 'frame', receivedAtMs: 10 }),
      { type: 'frame-rejected', code: 'bad_webp' },
    )
    expect(state.phase).toBe('live')
    expect(state.detail).toBe('frame rejected: bad_webp')
    expect('payload' in state).toBe(false)
    expect(JSON.stringify(state).includes('RIFF')).toBe(false)
  })

  it('requests an alpha-preserving canvas context', () => {
    expect(AVATAR_CANVAS_CONTEXT_OPTIONS.alpha).toBe(true)
  })
})

describe('avatar relay url resolution', () => {
  it('treats null, undefined and blank values as unconfigured', () => {
    expect(resolveAvatarRelayUrl(null)).toEqual({ state: 'unconfigured' })
    expect(resolveAvatarRelayUrl(undefined)).toEqual({ state: 'unconfigured' })
    expect(resolveAvatarRelayUrl('')).toEqual({ state: 'unconfigured' })
    expect(resolveAvatarRelayUrl('   ')).toEqual({ state: 'unconfigured' })
  })

  it('normalizes a scheme-less host and host:port to ws:// with the default path', () => {
    expect(resolveAvatarRelayUrl('localhost:4320/avatar')).toEqual({
      state: 'configured',
      url: 'ws://localhost:4320/avatar',
    })
    expect(resolveAvatarRelayUrl('127.0.0.1:4320')).toEqual({
      state: 'configured',
      url: 'ws://127.0.0.1:4320/avatar',
    })
    expect(resolveAvatarRelayUrl('  localhost:4320  ')).toEqual({
      state: 'configured',
      url: 'ws://localhost:4320/avatar',
    })
  })

  it('keeps explicit ws and wss and maps http and https', () => {
    expect(resolveAvatarRelayUrl('ws://relay.test/avatar')).toEqual({
      state: 'configured',
      url: 'ws://relay.test/avatar',
    })
    expect(resolveAvatarRelayUrl('wss://relay.test/avatar')).toEqual({
      state: 'configured',
      url: 'wss://relay.test/avatar',
    })
    expect(resolveAvatarRelayUrl('http://localhost:4320/avatar')).toEqual({
      state: 'configured',
      url: 'ws://localhost:4320/avatar',
    })
    expect(resolveAvatarRelayUrl('https://relay.test/avatar')).toEqual({
      state: 'configured',
      url: 'wss://relay.test/avatar',
    })
  })

  it('keeps an explicit non-root path and any query string', () => {
    expect(resolveAvatarRelayUrl('http://relay.test/custom/path')).toEqual({
      state: 'configured',
      url: 'ws://relay.test/custom/path',
    })
    expect(resolveAvatarRelayUrl('ws://relay.test/avatar?token=abc')).toEqual({
      state: 'configured',
      url: 'ws://relay.test/avatar?token=abc',
    })
    expect(resolveAvatarRelayUrl('localhost:4320?token=abc')).toEqual({
      state: 'configured',
      url: 'ws://localhost:4320/avatar?token=abc',
    })
  })

  it('rejects unsupported schemes and malformed urls without echoing the value', () => {
    const ftp = resolveAvatarRelayUrl('ftp://x')
    expect(ftp.state).toBe('invalid')
    expect(ftp).toMatchObject({ state: 'invalid' })

    const javascript = resolveAvatarRelayUrl('javascript:alert(1)')
    expect(javascript.state).toBe('invalid')

    const file = resolveAvatarRelayUrl('file:/tmp/relay')
    expect(file.state).toBe('invalid')

    expect(resolveAvatarRelayUrl('ws://').state).toBe('invalid')
    expect(resolveAvatarRelayUrl('not a url').state).toBe('invalid')

    if (ftp.state === 'invalid') {
      expect(ftp.detail.includes('ftp://x')).toBe(false)
    }
    const malformed = resolveAvatarRelayUrl('ws://')
    if (malformed.state === 'invalid') {
      expect(malformed.detail).toBe('relay url is not a valid URL')
    }
    const unsupported = resolveAvatarRelayUrl('ftp://x')
    if (unsupported.state === 'invalid') {
      expect(unsupported.detail).toBe('unsupported relay url scheme: ftp')
    }
    const javascriptSchemeLess = resolveAvatarRelayUrl('javascript:alert(1)')
    if (javascriptSchemeLess.state === 'invalid') {
      expect(javascriptSchemeLess.detail).toBe(
        'relay url must use ws://, wss://, http:// or https://',
      )
    }
  })
})

describe('avatar viewport initial state', () => {
  it('starts in error with the invalid-url detail when a detail is supplied', () => {
    const state = createAvatarViewportState(true, 'bad url')
    expect(state.phase).toBe('error')
    expect(state.detail).toBe('bad url')
    expect(state.configured).toBe(true)
  })

  it('starts connecting when configured without a detail', () => {
    const state = createAvatarViewportState(true)
    expect(state.phase).toBe('connecting')
    expect(state.detail).toBeNull()
  })
})

describe('avatar frame parsing', () => {
  it('parses a valid WebP frame envelope and its alpha flag', () => {
    const payload = webpPayload(0x10)
    const frame = parsedFrame(parseAvatarFrame(frameBytes(640, 480, payload)))
    expect(frame.format).toBe(1)
    expect(frame.width).toBe(640)
    expect(frame.height).toBe(480)
    expect(frame.hasAlpha).toBe(true)
    expect(Array.from(frame.payload)).toEqual(Array.from(payload))
  })

  it('reports a WebP frame without alpha when the VP8X flag is clear', () => {
    const frame = parsedFrame(parseAvatarFrame(frameBytes(320, 200, webpPayload(0))))
    expect(frame.hasAlpha).toBe(false)
  })

  it('rejects malformed and oversized frame envelopes without exposing bytes', () => {
    const payload = webpPayload(0x10)

    expectRejected(parseAvatarFrame(new Uint8Array(19)), 'too_short')
    expectRejected(parseAvatarFrame(new Uint8Array(MAX_FRAME_BYTES + 1)), 'too_large')

    const badMagic = frameBytes(64, 64, payload)
    badMagic[0] = 0
    expectRejected(parseAvatarFrame(badMagic), 'bad_magic')

    const badVersion = frameBytes(64, 64, payload)
    badVersion[2] = 2
    expectRejected(parseAvatarFrame(badVersion), 'bad_version')

    const badFormat = frameBytes(64, 64, payload)
    badFormat[3] = 2
    expectRejected(parseAvatarFrame(badFormat), 'bad_format')

    expectRejected(parseAvatarFrame(frameBytes(0, 64, payload)), 'bad_dimensions')
    expectRejected(
      parseAvatarFrame(frameBytes(MAX_DIMENSION + 1, 64, payload)),
      'bad_dimensions',
    )

    const noRiff = webpPayload(0x10)
    noRiff[0] = 0
    expectRejected(parseAvatarFrame(frameBytes(64, 64, noRiff)), 'bad_webp')

    const noWebp = webpPayload(0x10)
    noWebp[8] = 0
    expectRejected(parseAvatarFrame(frameBytes(64, 64, noWebp)), 'bad_webp')
  })

  it('rejects an oversized frame but accepts one exactly at the byte limit', () => {
    const exact = frameBytesOfLength(64, 64, MAX_FRAME_BYTES)
    const parsed = parsedFrame(parseAvatarFrame(exact))
    expect(parsed.payload.byteLength).toBe(MAX_FRAME_BYTES - 8)

    expectRejected(parseAvatarFrame(frameBytesOfLength(64, 64, MAX_FRAME_BYTES + 1)), 'too_large')
  })

  it('reports a WebP payload without VP8X as an undetermined alpha', () => {
    const payload = webpPayload(0x10)
    payload[12] = 0x56
    payload[13] = 0x50
    payload[14] = 0x38
    payload[15] = 0x20
    const frame = parsedFrame(parseAvatarFrame(frameBytes(320, 200, payload)))
    expect(frame.hasAlpha).toBeNull()
  })

  it('validates the avatar status text message', () => {
    const valid = {
      protocolVersion: '0.1',
      kind: 'avatar.status',
      source: 'ndi',
      fps: 30,
      lastFrameAt: 1234,
    }
    expect(parseAvatarStatus(valid)).toEqual(valid)
    expect(parseAvatarStatus({ ...valid, fps: null, lastFrameAt: null })).toEqual({
      protocolVersion: '0.1',
      kind: 'avatar.status',
      source: 'ndi',
      fps: null,
      lastFrameAt: null,
    })

    expect(parseAvatarStatus(null)).toBeNull()
    expect(parseAvatarStatus({ ...valid, protocolVersion: '0.2' })).toBeNull()
    expect(parseAvatarStatus({ ...valid, kind: 'avatar.frame' })).toBeNull()
    expect(parseAvatarStatus({ ...valid, source: 'camera' })).toBeNull()
    expect(parseAvatarStatus({ ...valid, fps: -1 })).toBeNull()
    expect(parseAvatarStatus({ ...valid, fps: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseAvatarStatus({ ...valid, lastFrameAt: 'now' })).toBeNull()
  })

  it('decodes a parsed frame and swallows decode failures', async () => {
    const frame = parsedFrame(parseAvatarFrame(frameBytes(64, 64, webpPayload(0x10))))
    const seen: Uint8Array[] = []

    const success = await decodeAvatarFrame(frame, (payload) => {
      seen.push(payload)
      return Promise.resolve({ width: 64 })
    })
    expect(success).toEqual({ ok: true, bitmap: { width: 64 } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(frame.payload)

    const failure = await decodeAvatarFrame(frame, () =>
      Promise.reject(new Error('decoder failed')),
    )
    expect(failure).toEqual({ ok: false, code: 'decode_failed' })

    let calls = 0
    const guarded = await decodeOnlyValid(new Uint8Array(4), (payload) => {
      calls += 1
      return Promise.resolve(payload)
    })
    expect(guarded).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('avatar frame client', () => {
  it('creates one socket and maps open, status, frame and rejection events', () => {
    const sockets: FakeAvatarSocket[] = []
    const events: AvatarClientEvent[] = []
    let clock = 500

    const client = createAvatarFrameClient({
      url: 'ws://relay.test/avatar',
      createSocket: (url) => {
        expect(url).toBe('ws://relay.test/avatar')
        const socket = new FakeAvatarSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: (event) => events.push(event),
      now: () => clock,
    })

    client.connect()
    client.connect()
    expect(sockets).toHaveLength(1)

    const first = sockets[0]!
    expect(first.binaryType).toBe('arraybuffer')

    first.open()
    expect(events.at(-1)).toEqual({ type: 'open' })

    const synthetic = status('synthetic', 24, 42)
    first.message(JSON.stringify(synthetic))
    expect(events.at(-1)).toEqual({ type: 'status', status: synthetic })

    clock = 900
    first.message(frameBytes(64, 48, webpPayload(0x10)).buffer)
    const frameEvent = events.at(-1)
    expect(frameEvent?.type).toBe('frame')
    if (frameEvent?.type === 'frame') {
      expect(frameEvent.receivedAtMs).toBe(900)
      expect(frameEvent.frame.width).toBe(64)
      expect(frameEvent.frame.height).toBe(48)
    }

    clock = 901
    first.message(new Uint8Array(4))
    const rejected = events.at(-1)
    expect(rejected?.type).toBe('frame-rejected')
    if (rejected?.type === 'frame-rejected') {
      expect(rejected.code).toBe('too_short')
      expect(rejected.receivedAtMs).toBe(901)
    }

    // A frame without alpha is rejected as missing_alpha, not emitted.
    clock = 902
    first.message(frameBytes(32, 32, webpPayload(0)))
    const missingAlpha = events.at(-1)
    expect(missingAlpha?.type).toBe('frame-rejected')
    if (missingAlpha?.type === 'frame-rejected') {
      expect(missingAlpha.code).toBe('missing_alpha')
      expect(missingAlpha.receivedAtMs).toBe(902)
    }

    client.reconnect()
    expect(sockets).toHaveLength(2)
    expect(first.closeCount).toBe(1)

    const second = sockets[1]!
    expect(second.binaryType).toBe('arraybuffer')
    second.open()
    expect(events.at(-1)).toEqual({ type: 'open' })

    const beforeClose = sockets.length
    second.closeEvent()
    expect(events.at(-1)).toEqual({ type: 'closed', detail: 'relay connection closed' })
    expect(sockets).toHaveLength(beforeClose)

    client.connect()
    expect(sockets).toHaveLength(3)
    const third = sockets[2]!
    client.dispose()
    expect(third.closeCount).toBe(1)

    const afterDispose = events.length
    third.open()
    third.message(JSON.stringify(synthetic))
    third.closeEvent()
    third.errorEvent()
    expect(events).toHaveLength(afterDispose)

    client.connect()
    client.reconnect()
    expect(sockets).toHaveLength(3)
  })

  it('rejects unsupported message data and invalid status JSON', () => {
    const sockets: FakeAvatarSocket[] = []
    const events: AvatarClientEvent[] = []
    const clock = 10

    const client = createAvatarFrameClient({
      url: 'ws://relay.test/avatar',
      createSocket: () => {
        const socket = new FakeAvatarSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: (event) => events.push(event),
      now: () => clock,
    })

    client.connect()
    const socket = sockets[0]!

    socket.message(42)
    expect(events.at(-1)).toEqual({
      type: 'frame-rejected',
      code: 'unsupported_message',
      receivedAtMs: 10,
    })

    socket.message('{ not json')
    expect(events.at(-1)).toEqual({ type: 'error', detail: 'invalid avatar status' })

    socket.message(
      JSON.stringify({
        protocolVersion: '0.1',
        kind: 'avatar.status',
        source: 'camera',
        fps: 30,
        lastFrameAt: null,
      }),
    )
    expect(events.at(-1)).toEqual({ type: 'error', detail: 'invalid avatar status' })

    client.dispose()
  })

  it('detaches a socket closed before it opens and ignores its late events', () => {
    const sockets: FakeAvatarSocket[] = []
    const events: AvatarClientEvent[] = []

    const client = createAvatarFrameClient({
      url: 'ws://relay.test/avatar',
      createSocket: () => {
        const socket = new FakeAvatarSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: (event) => events.push(event),
    })

    client.connect()
    const first = sockets[0]!
    client.reconnect()
    expect(first.closeCount).toBe(1)
    expect(sockets).toHaveLength(2)

    const before = events.length
    first.open()
    first.message(JSON.stringify(status('synthetic', 30, 1)))
    first.closeEvent()
    first.errorEvent()
    expect(events).toHaveLength(before)
  })

  it('closes each previous socket exactly once across repeated reconnects', () => {
    const sockets: FakeAvatarSocket[] = []
    const events: AvatarClientEvent[] = []

    const client = createAvatarFrameClient({
      url: 'ws://relay.test/avatar',
      createSocket: () => {
        const socket = new FakeAvatarSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: (event) => events.push(event),
    })

    client.connect()
    client.reconnect()
    client.reconnect()
    client.reconnect()
    expect(sockets).toHaveLength(4)
    expect(sockets[0]!.closeCount).toBe(1)
    expect(sockets[1]!.closeCount).toBe(1)
    expect(sockets[2]!.closeCount).toBe(1)
    expect(sockets[3]!.closeCount).toBe(0)

    const opensBefore = events.filter((event) => event.type === 'open').length
    sockets[3]!.open()
    expect(events.filter((event) => event.type === 'open').length).toBe(opensBefore + 1)
  })

  it('reports a socket creation failure without throwing', () => {
    const events: AvatarClientEvent[] = []
    const client = createAvatarFrameClient({
      url: 'ws://relay.test/avatar',
      createSocket: () => {
        throw new Error('boom')
      },
      onEvent: (event) => events.push(event),
    })

    expect(() => client.connect()).not.toThrow()
    expect(events).toEqual([{ type: 'error', detail: 'relay url could not be opened' }])
  })

  it('times out an unopened socket and allows a reconnect afterwards', () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeAvatarSocket[] = []
      const events: AvatarClientEvent[] = []
      const client = createAvatarFrameClient({
        url: 'ws://relay.test/avatar',
        connectTimeoutMs: 1000,
        createSocket: () => {
          const socket = new FakeAvatarSocket()
          sockets.push(socket)
          return socket
        },
        onEvent: (event) => events.push(event),
      })

      client.connect()
      const first = sockets[0]!

      vi.advanceTimersByTime(999)
      expect(events).toEqual([])

      vi.advanceTimersByTime(1)
      expect(events).toEqual([{ type: 'error', detail: 'relay connection timed out' }])
      expect(first.closeCount).toBe(1)

      client.reconnect()
      expect(sockets).toHaveLength(2)
      const second = sockets[1]!
      second.open()
      expect(events.at(-1)).toEqual({ type: 'open' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes and detaches the socket on error', () => {
    const sockets: FakeAvatarSocket[] = []
    const events: AvatarClientEvent[] = []
    const client = createAvatarFrameClient({
      url: 'ws://relay.test/avatar',
      createSocket: () => {
        const socket = new FakeAvatarSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: (event) => events.push(event),
    })

    client.connect()
    const first = sockets[0]!
    first.errorEvent()
    expect(events.at(-1)).toEqual({ type: 'error', detail: 'relay connection error' })
    expect(first.closeCount).toBe(1)

    const before = events.length
    first.open()
    first.message(JSON.stringify(status('synthetic', 30, 1)))
    first.closeEvent()
    first.errorEvent()
    expect(events).toHaveLength(before)
  })
})

type CssDeclarations = ReadonlyMap<string, string>

function parseCssDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const piece of body.split(';')) {
    const colon = piece.indexOf(':')
    if (colon < 0) continue
    const property = piece.slice(0, colon).trim().toLowerCase()
    const value = piece.slice(colon + 1).trim()
    if (property.length > 0 && value.length > 0) declarations.set(property, value)
  }
  return declarations
}

function parseCssRules(files: readonly string[]): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>()
  for (const file of files) {
    const css = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@(?:import|charset)[^;]*;/g, '')
    let cursor = 0
    while (cursor < css.length) {
      const open = css.indexOf('{', cursor)
      if (open < 0) break
      let depth = 1
      let close = open + 1
      while (close < css.length && depth > 0) {
        if (css[close] === '{') depth += 1
        else if (css[close] === '}') depth -= 1
        close += 1
      }
      const prelude = css.slice(cursor, open).trim()
      if (!prelude.startsWith('@')) {
        const declarations = parseCssDeclarations(css.slice(open + 1, close - 1))
        for (const selector of prelude.split(',')) {
          const name = selector.trim()
          if (name.length === 0) continue
          const existing = rules.get(name) ?? new Map<string, string>()
          for (const [property, value] of declarations) existing.set(property, value)
          rules.set(name, existing)
        }
      }
      cursor = close
    }
  }
  return rules
}

function declarationsFor(rules: Map<string, Map<string, string>>, selector: string): CssDeclarations {
  const declarations = rules.get(selector)
  if (declarations === undefined) throw new Error(`missing CSS rule for ${selector}`)
  return declarations
}

function isPositioned(declarations: CssDeclarations): boolean {
  return (declarations.get('position') ?? 'static') !== 'static'
}

function integerDeclaration(declarations: CssDeclarations, property: string): number | null {
  const raw = declarations.get(property)
  if (raw === undefined) return null
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) ? value : null
}

function stackingLevel(declarations: CssDeclarations): number {
  if (!isPositioned(declarations)) return 0
  return integerDeclaration(declarations, 'z-index') ?? 0
}

function createsStackingContext(declarations: CssDeclarations): boolean {
  if ((declarations.get('isolation') ?? '') === 'isolate') return true
  if (isPositioned(declarations) && integerDeclaration(declarations, 'z-index') !== null) return true
  const opacity = declarations.get('opacity')
  if (opacity !== undefined && Number.parseFloat(opacity) < 1) return true
  if ((declarations.get('transform') ?? 'none') !== 'none') return true
  if ((declarations.get('filter') ?? 'none') !== 'none') return true
  if ((declarations.get('backdrop-filter') ?? 'none') !== 'none') return true
  if ((declarations.get('mix-blend-mode') ?? 'normal') !== 'normal') return true
  const fill = declarations.get('animation-fill-mode') ?? ''
  const animation = declarations.get('animation') ?? ''
  return (
    fill.includes('both') ||
    fill.includes('forwards') ||
    fill.includes('backwards') ||
    animation.includes('both')
  )
}

describe('stage paint order (parsed static CSS)', () => {
  const rules = parseCssRules([
    'src/console/design/components.css',
    'src/console/design/layout.css',
    'src/console/console.css',
  ])
  const stage = declarationsFor(rules, '.console__stagebox')
  const avatar = declarationsFor(rules, '.avatar-viewport')

  it('keeps the stage a self-contained stacking context', () => {
    expect(stage.get('position')).toBe('relative')
    expect(stage.get('isolation')).toBe('isolate')
    expect(declarationsFor(rules, '.isla-stage').get('overflow')).toBe('hidden')
    expect(createsStackingContext(stage)).toBe(true)
  })

  it('places the transparent avatar at a negative level inside the stage', () => {
    expect(avatar.get('position')).toBe('absolute')
    expect(avatar.get('pointer-events')).toBe('none')
    expect(avatar.get('background')).toBeUndefined()
    expect(stackingLevel(avatar)).toBeLessThan(0)
    expect(stackingLevel(avatar)).toBeLessThan(stackingLevel(stage))
  })

  it('paints every in-flow stage overlay above the avatar layer', () => {
    for (const selector of ['.isla-stage__hud', '.isla-stage__viz', '.isla-subtitle', '.isla-reaction']) {
      const overlay = declarationsFor(rules, selector)
      expect(isPositioned(overlay)).toBe(false)
      expect(stackingLevel(overlay)).toBeGreaterThan(stackingLevel(avatar))
    }
  })

  it('keeps the laser, danmaku, player and stopped overlay above the avatar layer', () => {
    for (const [selector, level] of [
      ['.isla-stage__danmaku', 1],
      ['.isla-player', 2],
      ['.isla-stage__laser', 3],
      ['.isla-stage__stopped', 4],
    ] as const) {
      const layer = declarationsFor(rules, selector)
      expect(isPositioned(layer)).toBe(true)
      expect(stackingLevel(layer)).toBe(level)
      expect(stackingLevel(layer)).toBeGreaterThan(stackingLevel(avatar))
    }
  })
})
