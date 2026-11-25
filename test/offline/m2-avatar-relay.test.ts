import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  MAX_FRAME_BYTES,
  parseAvatarFrame,
} from '../../src/console/avatar-viewport'
import {
  MAX_BUFFERED_BYTES,
  MAX_CLIENTS,
  createAvatarRelay,
} from '../../tools/avatar-relay/relay'
import type { AvatarRelay, RelaySocket } from '../../tools/avatar-relay/relay'
import {
  SYNTHETIC_WEBP,
  createNoneSource,
  createSyntheticSource,
  createUnavailableNdiSource,
} from '../../tools/avatar-relay/source'
import type { AvatarSource, AvatarSourceFrame } from '../../tools/avatar-relay/source'
import {
  isAllowedRelayOrigin,
  parseArgs,
  startAvatarRelayServer,
} from '../../tools/avatar-relay/index'

class FakeSocket implements RelaySocket {
  sent: Array<string | Uint8Array> = []
  closed = 0
  readyState = 1
  bufferedAmount = 0
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

  it('rejects clients beyond the cap and leaves the count unchanged', () => {
    const source = createManualSource('synthetic', 15)
    const errors: string[] = []
    const relay = createAvatarRelay({
      source,
      onError: (message) => errors.push(message),
    })
    relay.start()
    for (let index = 0; index < MAX_CLIENTS; index += 1) {
      relay.handleClient(new FakeSocket())
    }
    expect(relay.clientCount()).toBe(MAX_CLIENTS)

    const overflow = new FakeSocket()
    relay.handleClient(overflow)

    expect(relay.clientCount()).toBe(MAX_CLIENTS)
    expect(overflow.closed).toBe(1)
    expect(errors).toEqual([`client rejected: at most ${MAX_CLIENTS} clients`])
  })

  it('drops frames for a client whose send buffer is over the limit', () => {
    const source = createManualSource('synthetic', 15)
    const relay = createAvatarRelay({ source, now: () => 1 })
    relay.start()

    const backed = new FakeSocket()
    backed.bufferedAmount = MAX_BUFFERED_BYTES + 1
    const healthy = new FakeSocket()
    relay.handleClient(backed)
    relay.handleClient(healthy)

    source.emit(VALID_FRAME)

    expect(binary(backed)).toHaveLength(0)
    expect(binary(healthy)).toHaveLength(1)
  })

  it('does not broadcast a late source callback after stop', () => {
    let callback: ((frame: AvatarSourceFrame) => void) | null = null
    const source: AvatarSource = {
      kind: 'synthetic',
      fps: 15,
      start(emit) {
        callback = emit
      },
      stop() {
        // deliberately keeps the callback to simulate a late delivery
      },
    }
    const relay = createAvatarRelay({ source, now: () => 1 })
    relay.start()
    const socket = new FakeSocket()
    relay.handleClient(socket)

    relay.stop()
    const beforeLate = binary(socket).length
    callback!(VALID_FRAME)

    expect(binary(socket)).toHaveLength(beforeLate)
    expect(relay.lastFrameAt()).toBeNull()
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
    expect(parseArgs([])).toEqual({ port: 4320, source: 'none', fps: 15 })
    expect(parseArgs(['--port', '5000', '--source=none', '--fps', '20'])).toEqual({
      port: 5000,
      source: 'none',
      fps: 20,
    })
    expect(parseArgs(['--source', 'synthetic'])).toEqual({
      port: 4320,
      source: 'synthetic',
      fps: 15,
    })
    expect(() => parseArgs(['--port', 'abc'])).toThrow()
    expect(() => parseArgs(['--source', 'bogus'])).toThrow()
  })
})

describe('relay origin policy', () => {
  it('allows an absent or empty origin for local CLI clients', () => {
    expect(isAllowedRelayOrigin(undefined)).toBe(true)
    expect(isAllowedRelayOrigin('')).toBe(true)
  })

  it('allows loopback hostnames and rejects everything else', () => {
    expect(isAllowedRelayOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedRelayOrigin('http://127.0.0.1:4320')).toBe(true)
    expect(isAllowedRelayOrigin('http://[::1]:4320')).toBe(true)
    expect(isAllowedRelayOrigin('http://evil.test')).toBe(false)
    expect(isAllowedRelayOrigin('null')).toBe(false)
    expect(isAllowedRelayOrigin('not a url')).toBe(false)
  })
})

interface WsTrace {
  statusMessages: string[]
  binaryFrames: Uint8Array[]
  binaryOk: boolean
  unexpectedStatus: number | null
}

function openClient(url: string, origin?: string): WebSocket {
  return new WebSocket(url, origin === undefined ? {} : { origin })
}

function collectFrames(socket: WebSocket, expectedFrames: number): Promise<WsTrace> {
  return new Promise((resolve, reject) => {
    const trace: WsTrace = {
      statusMessages: [],
      binaryFrames: [],
      binaryOk: false,
      unexpectedStatus: null,
    }
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('timed out waiting for relay frames'))
    }, 4000)
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const bytes = data as Buffer
        trace.binaryFrames.push(new Uint8Array(bytes))
        if (trace.binaryFrames.length >= expectedFrames && trace.statusMessages.length > 0) {
          clearTimeout(timer)
          resolve(trace)
        }
      } else {
        trace.statusMessages.push(data.toString())
        if (trace.binaryFrames.length >= expectedFrames) {
          clearTimeout(timer)
          resolve(trace)
        }
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function collectStatusOnly(socket: WebSocket): Promise<WsTrace> {
  return new Promise((resolve, reject) => {
    const trace: WsTrace = {
      statusMessages: [],
      binaryFrames: [],
      binaryOk: false,
      unexpectedStatus: null,
    }
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('timed out waiting for relay status'))
    }, 4000)
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        trace.statusMessages.push(data.toString())
        clearTimeout(timer)
        resolve(trace)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function expectRejected(socket: WebSocket, code: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('timed out waiting for rejection'))
    }, 4000)
    const settle = (): void => {
      clearTimeout(timer)
      resolve()
    }
    socket.on('unexpected-response', (_request, response) => {
      expect(response.statusCode).toBe(code)
      settle()
    })
    socket.on('error', () => settle())
    socket.on('open', () => {
      clearTimeout(timer)
      reject(new Error('expected the relay to reject the connection'))
    })
  })
}

describe('avatar relay server integration', () => {
  it('binds loopback on a free port and frees it on close', async () => {
    const server = await startAvatarRelayServer({ port: 0, source: 'synthetic', fps: 20 })
    try {
      expect(server.host).toBe('127.0.0.1')
      expect(server.port).toBeGreaterThan(0)
    } finally {
      await server.close()
    }

    const again = await startAvatarRelayServer({ port: server.port, source: 'none', fps: 15 })
    try {
      expect(again.port).toBe(server.port)
    } finally {
      await again.close()
    }
  })

  it('accepts a localhost origin and streams a status then a valid frame', async () => {
    const server = await startAvatarRelayServer({ port: 0, source: 'synthetic', fps: 20 })
    const socket = openClient(`ws://127.0.0.1:${server.port}/avatar`, 'http://localhost:5173')
    try {
      const trace = await collectFrames(socket, 1)
      expect(trace.statusMessages).not.toHaveLength(0)
      const status = JSON.parse(trace.statusMessages[0]!)
      expect(status.kind).toBe('avatar.status')
      expect(status.source).toBe('synthetic')
      expect(trace.binaryFrames).not.toHaveLength(0)
      const parsed = parseAvatarFrame(trace.binaryFrames[0]!)
      expect(parsed.ok).toBe(true)
    } finally {
      socket.terminate()
      await server.close()
    }
  })

  it('accepts a client with no origin and sends the status', async () => {
    const server = await startAvatarRelayServer({ port: 0, source: 'none', fps: 15 })
    const socket = openClient(`ws://127.0.0.1:${server.port}/avatar`)
    try {
      const trace = await collectStatusOnly(socket)
      expect(trace.statusMessages).not.toHaveLength(0)
      const status = JSON.parse(trace.statusMessages[0]!)
      expect(status.source).toBe('none')
    } finally {
      socket.terminate()
      await server.close()
    }
  })

  it('rejects a non-local origin with HTTP 403', async () => {
    const server = await startAvatarRelayServer({ port: 0, source: 'none', fps: 15 })
    const socket = openClient(`ws://127.0.0.1:${server.port}/avatar`, 'http://evil.test')
    try {
      await expectRejected(socket, 403)
    } finally {
      socket.terminate()
      await server.close()
    }
  })

  it('rejects a wrong path with HTTP 404', async () => {
    const server = await startAvatarRelayServer({ port: 0, source: 'none', fps: 15 })
    const socket = openClient(`ws://127.0.0.1:${server.port}/not-avatar`)
    try {
      await expectRejected(socket, 404)
    } finally {
      socket.terminate()
      await server.close()
    }
  })
})

const CLI_ENTRY = 'tools/avatar-relay/index.ts'
const CHILD_TIMEOUT_MS = 8000

function spawnCli(args: string[]): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timed out waiting for the CLI to exit'))
    }, CHILD_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('timed out waiting for the relay to listen'))
    }, CHILD_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (!settled && stdout.includes('listening on ws://127.0.0.1:')) {
        settled = true
        clearTimeout(timer)
        resolve(stdout)
      }
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`relay exited early with code ${String(code)}`))
    })
  })
}

describe.skipIf(process.platform === 'win32')('avatar relay CLI subprocess', () => {
  it('exits 2 for the unimplemented ndi source', async () => {
    const child = spawnCli(['--source', 'ndi'])
    try {
      const { code, stderr } = await waitForExit(child)
      expect(code).toBe(2)
      expect(stderr.length).toBeGreaterThan(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })

  it('reports the bound address and exits 0 on SIGTERM', async () => {
    const child = spawnCli(['--port', '0'])
    try {
      const output = await waitForListening(child)
      expect(output).toContain('listening on ws://127.0.0.1:')
      const exited = waitForExit(child)
      child.kill('SIGTERM')
      const { code } = await exited
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
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
