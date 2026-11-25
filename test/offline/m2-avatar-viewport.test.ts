import { describe, expect, it } from 'vitest'
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

    // A typed-array view is accepted just like a raw ArrayBuffer.
    clock = 902
    first.message(frameBytes(32, 32, webpPayload(0)))
    expect(events.at(-1)?.type).toBe('frame')

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
})
