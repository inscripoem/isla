import { describe, expect, it, vi } from 'vitest'
import {
  MAX_FRAME_BYTES,
  parseAvatarFrame,
} from '../../src/console/avatar-viewport'
import { createAvatarRelay } from '../../tools/avatar-relay/relay'
import type { AvatarRelay, RelaySocket } from '../../tools/avatar-relay/relay'
import {
  SYNTHETIC_WEBP,
  createNoneSource,
  createSyntheticSource,
  createUnavailableNdiSource,
} from '../../tools/avatar-relay/source'
import type { AvatarSource, AvatarSourceFrame } from '../../tools/avatar-relay/source'
import { parseArgs } from '../../tools/avatar-relay/index'

class FakeSocket implements RelaySocket {
  sent: Array<string | Uint8Array> = []
  closed = 0
  readyState = 1
  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed += 1
  }
}

function textual(socket: FakeSocket): string[] {
  return socket.sent.filter((entry): entry is string => typeof entry === 'string')
}

function binary(socket: FakeSocket): Uint8Array[] {
  return socket.sent.filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
}

interface ManualSource extends AvatarSource {
  emit(frame: AvatarSourceFrame): void
  readonly startCount: number
  readonly stopCount: number
}

function createManualSource(kind: 'synthetic' | 'none' | 'ndi', fps: number | null): ManualSource {
  let callback: ((frame: AvatarSourceFrame) => void) | null = null
  let startCount = 0
  let stopCount = 0
  return {
    kind,
    fps,
    get startCount() {
      return startCount
    },
    get stopCount() {
      return stopCount
    },
    start(emit) {
      startCount += 1
      callback = emit
    },
    stop() {
      stopCount += 1
      callback = null
    },
    emit(frame) {
      if (callback !== null) callback(frame)
    },
  }
}

const VALID_FRAME: AvatarSourceFrame = { payload: SYNTHETIC_WEBP, width: 96, height: 96 }

describe('avatar relay', () => {
  it('reports a none source and never sends a frame before stop', () => {
    vi.useFakeTimers()
    try {
      const relay = createAvatarRelay({ source: createNoneSource() })
      relay.start()
      const socket = new FakeSocket()
      relay.handleClient(socket)

      const first = socket.sent[0]
      expect(typeof first).toBe('string')
      const parsed = JSON.parse(first as string)
      expect(parsed).toEqual({
        protocolVersion: '0.1',
        kind: 'avatar.status',
        source: 'none',
        fps: null,
        lastFrameAt: null,
      })

      vi.advanceTimersByTime(5000)
      expect(binary(socket)).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('broadcasts exactly one valid encoded frame and advances lastFrameAt', () => {
    let clock = 0
    const source = createManualSource('synthetic', 15)
    const relay = createAvatarRelay({ source, now: () => (clock += 10) })
    relay.start()

    const socket = new FakeSocket()
    relay.handleClient(socket)
    source.emit(VALID_FRAME)

    const frames = binary(socket)
    expect(frames).toHaveLength(1)
    const frame = frames[0]!
    const parsed = parseAvatarFrame(frame)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.frame.width).toBe(96)
      expect(parsed.frame.height).toBe(96)
      expect(parsed.frame.hasAlpha).toBe(true)
    }
    expect(relay.lastFrameAt()).toBe(10)
    expect(relay.status().source).toBe('synthetic')
    expect(relay.status().fps).toBe(15)
    expect(relay.status().lastFrameAt).toBe(10)
  })

  it('rejects invalid frames without sending or advancing lastFrameAt', () => {
    const source = createManualSource('synthetic', 15)
    const errors: string[] = []
    const relay = createAvatarRelay({
      source,
      now: () => 500,
      onError: (message) => errors.push(message),
    })
    relay.start()
    const socket = new FakeSocket()
    relay.handleClient(socket)
    const binaryBefore = binary(socket).length

    source.emit({ payload: new Uint8Array([1, 2, 3, 4]), width: 96, height: 96 })
    source.emit({ payload: SYNTHETIC_WEBP, width: 0, height: 96 })
    source.emit({ payload: new Uint8Array(MAX_FRAME_BYTES), width: 96, height: 96 })

    expect(errors).toHaveLength(3)
    expect(binary(socket)).toHaveLength(binaryBefore)
    expect(relay.lastFrameAt()).toBeNull()
  })

  it('fans out to two clients and unsubscribes exactly one', () => {
    const source = createManualSource('synthetic', 15)
    const relay = createAvatarRelay({ source, now: () => 1 })
    relay.start()

    const first = new FakeSocket()
    const second = new FakeSocket()
    const removeFirst = relay.handleClient(first)
    relay.handleClient(second)
    expect(relay.clientCount()).toBe(2)

    removeFirst()
    expect(relay.clientCount()).toBe(1)

    source.emit(VALID_FRAME)
    expect(binary(first)).toHaveLength(0)
    expect(binary(second)).toHaveLength(1)
  })

  it('stop sends a final none status and keeps the last frame time', () => {
    const source = createManualSource('synthetic', 15)
    const relay: AvatarRelay = createAvatarRelay({ source, now: () => 42 })
    relay.start()
    const socket = new FakeSocket()
    relay.handleClient(socket)
    source.emit(VALID_FRAME)
    expect(relay.lastFrameAt()).toBe(42)

    relay.stop()
    expect(source.stopCount).toBe(1)

    const last = textual(socket).at(-1)!
    const parsed = JSON.parse(last)
    expect(parsed.source).toBe('none')
    expect(parsed.fps).toBeNull()
    expect(parsed.lastFrameAt).toBe(42)

    source.emit(VALID_FRAME)
    expect(binary(socket)).toHaveLength(1)
    expect(relay.lastFrameAt()).toBe(42)
  })
})

describe('avatar sources', () => {
  it('emits on the configured synthetic cadence and stops cleanly', () => {
    vi.useFakeTimers()
    try {
      const frames: AvatarSourceFrame[] = []
      const source = createSyntheticSource({ fps: 10 })
      source.start((frame) => frames.push(frame))
      expect(frames).toHaveLength(1)

      vi.advanceTimersByTime(100)
      expect(frames).toHaveLength(2)

      source.stop()
      vi.advanceTimersByTime(500)
      expect(frames).toHaveLength(2)

      expect(source.kind).toBe('synthetic')
      expect(source.fps).toBe(10)
      const parsed = parseAvatarFrame(encodeForTest(frames[0]!))
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.frame.hasAlpha).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never emits from none or unavailable ndi sources', () => {
    const emitted: AvatarSourceFrame[] = []
    const none = createNoneSource()
    const ndi = createUnavailableNdiSource('capture missing')
    none.start((frame) => emitted.push(frame))
    ndi.start((frame) => emitted.push(frame))
    none.stop()
    ndi.stop()

    expect(emitted).toHaveLength(0)
    expect(none.fps).toBeNull()
    expect(ndi.fps).toBeNull()
    expect(ndi.kind).toBe('ndi')
  })

  it('parses relay flags with both space and equals forms', () => {
    expect(parseArgs([])).toEqual({ port: 4320, source: 'synthetic', fps: 15 })
    expect(parseArgs(['--port', '5000', '--source=none', '--fps', '20'])).toEqual({
      port: 5000,
      source: 'none',
      fps: 20,
    })
    expect(() => parseArgs(['--port', 'abc'])).toThrow()
    expect(() => parseArgs(['--source', 'bogus'])).toThrow()
  })
})

function encodeForTest(frame: AvatarSourceFrame): Uint8Array {
  const bytes = new Uint8Array(8 + frame.payload.byteLength)
  bytes[0] = 0x41
  bytes[1] = 0x56
  bytes[2] = 1
  bytes[3] = 1
  bytes[4] = (frame.width >>> 8) & 0xff
  bytes[5] = frame.width & 0xff
  bytes[6] = (frame.height >>> 8) & 0xff
  bytes[7] = frame.height & 0xff
  bytes.set(frame.payload, 8)
  return bytes
}
