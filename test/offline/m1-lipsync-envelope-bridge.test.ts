import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net'
import type { Duplex } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { getEnvelopeObserver } from '../../src/performance/browser/envelope-connection'
import { createEnvelopeBridge } from '../../src/performance/lipsync/envelope-bridge'
import type { VolumeEnvelopeEvent } from '../../src/performance/lipsync/volume-envelope'

const FRAGMENT_PREFIX = '#isla-mouth='
const TOKEN = 'A'.repeat(43)
const CLOCK_PATH = '/_isla/mouth/clock'
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')

type ClockState = 'playing' | 'waiting' | 'paused' | 'ended' | 'error' | 'stopped'

interface ClockKey {
  readonly audioRef: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  readonly segmentId: string
  readonly outputId: string
}

interface ClockSample {
  readonly key: ClockKey
  readonly state: ClockState
  readonly positionMs: number
}

function envelope(overrides: Partial<VolumeEnvelopeEvent> = {}): VolumeEnvelopeEvent {
  return {
    audioRef: 'audio-a',
    sessionId: 'session-1',
    epoch: 1,
    turnId: 'turn-1',
    segmentId: 'segment-1',
    stepMs: 20,
    durationMs: 60,
    levels: [0.05, 0.1, 0.2],
    ...overrides,
  }
}

function sample(overrides: Partial<ClockKey> = {}, state: ClockState = 'playing', positionMs = 0): ClockSample {
  return {
    key: {
      audioRef: 'audio-a',
      sessionId: 'session-1',
      epoch: 1,
      turnId: 'turn-1',
      segmentId: 'segment-1',
      outputId: 'output-1',
      ...overrides,
    },
    state,
    positionMs,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not reached')
    await delay(5)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error('operation timed out')
    }),
  ])
}

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // Each test owns its cleanup; a failed teardown must not mask the assertion.
    }
  }
  vi.restoreAllMocks()
})

interface BridgeFixture {
  readonly server: Server
  readonly port: number
  readonly origin: string
  readonly bridge: ReturnType<typeof createEnvelopeBridge>
  readonly writes: number[]
}

type BridgeWriter = (opening: number, signal: AbortSignal) => void | Promise<void>

async function startBridge(
  createWriter?: (writes: number[]) => BridgeWriter,
): Promise<BridgeFixture> {
  const writes: number[] = []
  const server = createServer((_request, response) => {
    response.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  const bridge = createEnvelopeBridge({
    origin,
    write:
      createWriter?.(writes) ??
      ((opening) => {
        writes.push(opening)
      }),
  })
  bridge.attach(server)
  cleanups.push(async () => {
    await bridge.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  })
  return { server, port, origin, bridge, writes }
}

interface HeldZeroFixture extends BridgeFixture {
  readonly zeroStarted: Promise<void>
  readonly zeroSettled: Promise<void>
  readonly zeroSignal: () => AbortSignal | undefined
  releaseZero(): void
}

async function startBridgeWithHeldZero(): Promise<HeldZeroFixture> {
  let releaseZero: () => void = () => {}
  let markZeroStarted: () => void = () => {}
  let markZeroSettled: () => void = () => {}
  const zeroGate = new Promise<void>((resolve) => {
    releaseZero = resolve
  })
  const zeroStarted = new Promise<void>((resolve) => {
    markZeroStarted = resolve
  })
  const zeroSettled = new Promise<void>((resolve) => {
    markZeroSettled = resolve
  })
  let zeroSignal: AbortSignal | undefined
  let held = false

  const fixture = await startBridge((writes) => (opening, signal) => {
    if (opening === 0 && !held) {
      held = true
      zeroSignal = signal
      markZeroStarted()
      return zeroGate.then(() => {
        if (!signal.aborted) writes.push(0)
        markZeroSettled()
      })
    }
    writes.push(opening)
  })
  cleanups.push(() => {
    releaseZero()
  })
  return {
    ...fixture,
    zeroStarted,
    zeroSettled,
    zeroSignal: () => zeroSignal,
    releaseZero,
  }
}

function tokenOf(bridge: BridgeFixture['bridge']): string {
  expect(bridge.fragment.startsWith(FRAGMENT_PREFIX)).toBe(true)
  const token = bridge.fragment.slice(FRAGMENT_PREFIX.length)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return token
}

function upgradeRequest(
  fixture: BridgeFixture,
  token: string,
  socket: Duplex,
): IncomingMessage {
  return {
    url: CLOCK_PATH,
    method: 'GET',
    httpVersion: '1.1',
    headers: {
      host: `127.0.0.1:${fixture.port}`,
      origin: fixture.origin,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': `isla-mouth-v1, ${token}`,
    },
    socket,
  } as unknown as IncomingMessage
}

function trackClient(client: WebSocket): WebSocket {
  cleanups.push(() => {
    client.terminate()
  })
  return client
}

async function openClock(
  port: number,
  protocols: string[],
  origin: string,
  path = CLOCK_PATH,
): Promise<WebSocket> {
  const client = trackClient(
    new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { origin }),
  )
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('unexpected-response', (_request, response) => {
        response.resume()
        reject(new Error(`unexpected handshake status ${response.statusCode ?? 0}`))
      })
      client.once('error', reject)
    }),
  )
  return client
}

async function openClockEventually(
  port: number,
  protocols: string[],
  origin: string,
): Promise<WebSocket> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await openClock(port, protocols, origin)
    } catch {
      await delay(25)
    }
  }
  throw new Error('bridge did not accept a new socket')
}

function handshakeStatus(
  port: number,
  protocols: string[],
  origin?: string,
  path = CLOCK_PATH,
): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      const client = trackClient(
        new WebSocket(
          `ws://127.0.0.1:${port}${path}`,
          protocols,
          origin === undefined ? undefined : { origin },
        ),
      )
      client.once('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0
        response.resume()
        resolve(status)
      })
      client.once('open', () => reject(new Error('handshake was accepted')))
      client.once('error', reject)
    }),
  )
}

function expectUpgradeRefused(port: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const client = trackClient(new WebSocket(`ws://127.0.0.1:${port}${CLOCK_PATH}`))
      client.once('open', () => reject(new Error('upgrade was accepted after cleanup')))
      client.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve()
      })
      client.once('error', () => resolve())
    }),
  )
}

function sendClock(client: WebSocket, value: ClockSample): void {
  client.send(JSON.stringify(value))
}

describe('M1 envelope bridge', () => {
  it('drives the mouth from a supplied envelope and actual clock positions', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    fixture.bridge.supply(envelope())

    const client = await openClock(fixture.port, ['isla-mouth-v1', token], fixture.origin)
    sendClock(client, sample())
    await waitUntil(() => fixture.writes.length === 1)
    expect(fixture.writes[0]).toBeCloseTo(0.25)

    sendClock(client, sample({}, 'playing', 25))
    await waitUntil(() => fixture.writes.length === 2)
    expect(fixture.writes[1]).toBeCloseTo(0.5)

    sendClock(client, sample({}, 'playing', 45))
    await waitUntil(() => fixture.writes.length === 3)
    expect(fixture.writes[2]).toBeCloseTo(1)

    sendClock(client, sample({}, 'ended', 60))
    await waitUntil(() => fixture.writes.at(-1) === 0)

    sendClock(client, sample({}, 'playing', 0))
    await delay(30)
    expect(fixture.writes.at(-1)).toBe(0)
  })

  it('rejects origin, capability, protocol, query and duplicate sockets before effects', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)

    expect(
      await handshakeStatus(fixture.port, ['isla-mouth-v1', token], 'http://example.test'),
    ).toBe(403)
    expect(await handshakeStatus(fixture.port, ['isla-mouth-v1', token])).toBe(403)
    expect(await handshakeStatus(fixture.port, ['isla-mouth-v1', 'B'.repeat(43)], fixture.origin)).toBe(403)
    expect(await handshakeStatus(fixture.port, ['isla-mouth-v1'], fixture.origin)).toBe(400)
    expect(
      await handshakeStatus(fixture.port, ['isla-mouth-v1', token, 'extra'], fixture.origin),
    ).toBe(400)
    expect(
      await handshakeStatus(
        fixture.port,
        ['isla-mouth-v1', token],
        fixture.origin,
        `${CLOCK_PATH}?debug=1`,
      ),
    ).toBe(400)

    await openClock(fixture.port, ['isla-mouth-v1', token], fixture.origin)
    expect(await handshakeStatus(fixture.port, ['isla-mouth-v1', token], fixture.origin)).toBe(409)
    expect(fixture.writes).toHaveLength(0)
  })

  it('rejects a non-loopback peer before controller effects', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    const written: string[] = []
    let destroyed = false
    const socket = {
      remoteAddress: '203.0.113.10',
      write(data: string) {
        written.push(data)
      },
      destroy() {
        destroyed = true
      },
    } as unknown as Duplex
    fixture.server.emit('upgrade', upgradeRequest(fixture, token, socket), socket, Buffer.alloc(0))

    expect(written.join('')).toContain('403 Forbidden')
    expect(destroyed).toBe(true)
    expect(fixture.writes).toHaveLength(0)
  })

  it('accepts loopback and IPv4-mapped loopback peers on the exact route', async () => {
    for (const remoteAddress of ['::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      const fixture = await startBridge()
      const token = tokenOf(fixture.bridge)
      const tcp = createTcpServer()
      await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            tcp.close(() => resolve())
          }),
      )
      const accepted = new Promise<Socket>((resolve) => tcp.once('connection', resolve))
      const peer = connect((tcp.address() as AddressInfo).port, '127.0.0.1')
      peer.on('error', () => {})
      cleanups.push(() => {
        peer.destroy()
      })
      const serverSide = await withTimeout(accepted)
      serverSide.on('error', () => {})
      cleanups.push(() => {
        serverSide.destroy()
      })
      Object.defineProperty(serverSide, 'remoteAddress', {
        configurable: true,
        value: remoteAddress,
      })

      const received: string[] = []
      peer.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')))
      fixture.server.emit(
        'upgrade',
        upgradeRequest(fixture, token, serverSide),
        serverSide,
        Buffer.alloc(0),
      )
      await waitUntil(() => received.join('').includes('101 Switching Protocols'))

      await fixture.bridge.close()
      await waitUntil(() => fixture.writes.at(-1) === 0)
    }
  })

  it('retains only the eight newest envelopes until the first socket', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    const base = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let index = 0; index < 9; index += 1) {
      fixture.bridge.supply(envelope({ audioRef: `audio-${index}` }))
    }
    now.mockRestore()

    const client = await openClock(fixture.port, ['isla-mouth-v1', token], fixture.origin)
    sendClock(client, sample({ audioRef: 'audio-0' }))
    await delay(30)
    expect(fixture.writes).toHaveLength(0)

    sendClock(client, sample({ audioRef: 'audio-8' }))
    await waitUntil(() => fixture.writes.length > 0)
    expect(fixture.writes[0]).toBeCloseTo(0.25)
  })

  it('drops stale and unknown envelopes without animating', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    const base = Date.now()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(base - 16_000)
    fixture.bridge.supply(envelope({ audioRef: 'audio-old' }))
    now.mockReturnValue(base)
    fixture.bridge.supply(envelope({ audioRef: 'audio-fresh' }))
    now.mockRestore()

    const client = await openClock(fixture.port, ['isla-mouth-v1', token], fixture.origin)
    sendClock(client, sample({ audioRef: 'audio-old' }))
    sendClock(client, sample({ audioRef: 'audio-unknown' }))
    await delay(30)
    expect(fixture.writes).toHaveLength(0)

    sendClock(client, sample({ audioRef: 'audio-fresh' }))
    await waitUntil(() => fixture.writes.length > 0)
    expect(fixture.writes[0]).toBeCloseTo(0.25)
  })

  it('ignores malformed frames and client-supplied levels or opening', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    fixture.bridge.supply(envelope())
    const client = await openClock(fixture.port, ['isla-mouth-v1', token], fixture.origin)

    client.send('not json')
    client.send(JSON.stringify({ ...sample(), levels: [1, 1, 1] }))
    client.send(JSON.stringify({ ...sample(), opening: 1 }))
    client.send(JSON.stringify({ ...sample(), positionMs: -1 }))
    client.send(JSON.stringify({ ...sample(), positionMs: Number.NaN }))
    await delay(30)
    expect(fixture.writes).toHaveLength(0)

    sendClock(client, sample())
    await waitUntil(() => fixture.writes.length > 0)
    expect(fixture.writes[0]).toBeCloseTo(0.25)
  })

  it('neutralizes on disconnect and never revives the old output on a new socket', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    const protocols = ['isla-mouth-v1', token]
    const first = await openClock(fixture.port, protocols, fixture.origin)
    fixture.bridge.supply(envelope())
    sendClock(first, sample())
    await waitUntil(() => fixture.writes.length > 0)

    first.close()
    await waitUntil(() => fixture.writes.at(-1) === 0)

    const second = await openClockEventually(fixture.port, protocols, fixture.origin)
    const before = fixture.writes.length
    sendClock(second, sample())
    await delay(30)
    expect(fixture.writes.slice(before).filter((opening) => opening > 0)).toHaveLength(0)

    fixture.bridge.supply(envelope({ audioRef: 'audio-b' }))
    sendClock(second, sample({ audioRef: 'audio-b' }, 'playing', 25))
    await waitUntil(() => fixture.writes.length > before)
    expect(fixture.writes.at(-1)).toBeCloseTo(0.5)
  })

  it('admits a replacement while the old terminal zero is held', async () => {
    const fixture = await startBridgeWithHeldZero()
    const token = tokenOf(fixture.bridge)
    const protocols = ['isla-mouth-v1', token]
    const oldClient = await openClock(fixture.port, protocols, fixture.origin)
    fixture.bridge.supply(envelope())
    sendClock(oldClient, sample())
    await waitUntil(() => fixture.writes.at(-1) === 0.25)
    let zeroObserved = false

    try {
      oldClient.close()
      await withTimeout(fixture.zeroStarted)
      zeroObserved = true

      fixture.bridge.supply(envelope({ audioRef: 'audio-b' }))
      const replacement = await openClock(fixture.port, protocols, fixture.origin)
      sendClock(replacement, sample({ audioRef: 'audio-b' }, 'playing', 25))
      await waitUntil(() => fixture.writes.at(-1) === 0.5)
      expect(fixture.zeroSignal()?.aborted).toBe(true)

      fixture.releaseZero()
      await withTimeout(fixture.zeroSettled)
      await delay(20)
      expect(fixture.writes).toEqual([0.25, 0.5])

      sendClock(replacement, sample({ audioRef: 'audio-b' }, 'playing', 45))
      await waitUntil(() => fixture.writes.at(-1) === 1)
      expect(replacement.readyState).toBe(WebSocket.OPEN)
      expect(await handshakeStatus(fixture.port, protocols, fixture.origin)).toBe(409)
    } finally {
      fixture.releaseZero()
      if (zeroObserved) await withTimeout(fixture.zeroSettled).catch(() => {})
    }
  })

  it('leaves the old neutral effective when the replacement never writes', async () => {
    const fixture = await startBridgeWithHeldZero()
    const token = tokenOf(fixture.bridge)
    const protocols = ['isla-mouth-v1', token]
    const oldClient = await openClock(fixture.port, protocols, fixture.origin)
    fixture.bridge.supply(envelope())
    sendClock(oldClient, sample({}, 'playing', 25))
    await waitUntil(() => fixture.writes.at(-1) === 0.5)
    let zeroObserved = false

    try {
      oldClient.close()
      await withTimeout(fixture.zeroStarted)
      zeroObserved = true

      fixture.bridge.supply(envelope({ audioRef: 'audio-b' }))
      const replacement = await openClock(fixture.port, protocols, fixture.origin)
      sendClock(replacement, sample({ audioRef: 'audio-b' }, 'waiting', 0))
      await delay(20)
      expect(fixture.writes).toEqual([0.5])
      expect(fixture.zeroSignal()?.aborted).toBe(false)

      fixture.releaseZero()
      await withTimeout(fixture.zeroSettled)
      await delay(20)
      expect(fixture.writes).toEqual([0.5, 0])

      sendClock(replacement, sample({ audioRef: 'audio-b' }, 'playing', 45))
      await waitUntil(() => fixture.writes.at(-1) === 1)
      expect(fixture.writes).toEqual([0.5, 0, 1])

      replacement.close()
      await waitUntil(() => fixture.writes.at(-1) === 0)
      const third = await openClock(fixture.port, protocols, fixture.origin)
      fixture.bridge.supply(envelope({ audioRef: 'audio-c' }))
      sendClock(third, sample({ audioRef: 'audio-c' }, 'playing', 45))
      await waitUntil(() => fixture.writes.at(-1) === 1)
      expect(fixture.writes).toEqual([0.5, 0, 1, 0, 1])
    } finally {
      fixture.releaseZero()
      if (zeroObserved) await withTimeout(fixture.zeroSettled).catch(() => {})
    }
  })

  it('leaves other upgrade routes untouched and does not close the HTTP server', async () => {
    const fixture = await startBridge()
    const token = tokenOf(fixture.bridge)
    const other = new WebSocketServer({ noServer: true })
    const handleOther = (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ): void => {
      if (request.url !== '/other' && request.url !== '/_isla/mouth/clock-info') return
      other.handleUpgrade(request, socket, head, (client) => other.emit('connection', client, request))
    }
    fixture.server.on('upgrade', handleOther)
    cleanups.push(() => {
      fixture.server.off('upgrade', handleOther)
      other.close()
    })

    const otherClient = trackClient(new WebSocket(`ws://127.0.0.1:${fixture.port}/other`))
    await once(otherClient, 'open')
    otherClient.close()

    const sibling = trackClient(
      new WebSocket(`ws://127.0.0.1:${fixture.port}/_isla/mouth/clock-info`),
    )
    await once(sibling, 'open')
    sibling.close()

    fixture.bridge.supply(envelope())
    const clock = await openClock(fixture.port, ['isla-mouth-v1', token], fixture.origin)
    sendClock(clock, sample())
    await waitUntil(() => fixture.writes.length > 0)

    const clockClosed = once(clock, 'close')
    await fixture.bridge.close()
    await clockClosed
    expect(fixture.writes.at(-1)).toBe(0)
    fixture.server.off('upgrade', handleOther)
    other.close()
    const response = await fetch(fixture.origin)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    await expectUpgradeRefused(fixture.port)
  })
})

interface FakeLocation {
  readonly hash: string
  readonly protocol: string
  readonly hostname: string
  readonly host: string
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly protocols: string[]
  readonly sent: string[] = []
  readyState = 0
  bufferedAmount = 0

  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(url: string, protocols: string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('fake socket is not open')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  private emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

function setRealm(
  hash: string,
  hostname = '127.0.0.1',
  host = '127.0.0.1:5173',
  protocol = 'http:',
): void {
  for (const socket of FakeWebSocket.instances) socket.close()
  FakeWebSocket.instances = []
  const location: FakeLocation = { hash, protocol, hostname, host }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket })
}

function clearRealm(): void {
  for (const socket of FakeWebSocket.instances) socket.close()
  FakeWebSocket.instances = []
  if (originalLocation === undefined) Reflect.deleteProperty(globalThis, 'location')
  else Object.defineProperty(globalThis, 'location', originalLocation)
  if (originalWebSocket === undefined) Reflect.deleteProperty(globalThis, 'WebSocket')
  else Object.defineProperty(globalThis, 'WebSocket', originalWebSocket)
}

afterEach(() => {
  clearRealm()
})

describe('M1 browser envelope connection', () => {
  it('opts in only for a valid local fragment', () => {
    setRealm('')
    expect(getEnvelopeObserver()).toBeUndefined()

    setRealm(`${FRAGMENT_PREFIX}short`)
    expect(getEnvelopeObserver()).toBeUndefined()

    setRealm(`${FRAGMENT_PREFIX}${TOKEN}`, 'example.test', 'example.test')
    expect(getEnvelopeObserver()).toBeUndefined()

    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('opens one socket and forwards only the latest pre-open sample', () => {
    setRealm(`${FRAGMENT_PREFIX}${TOKEN}`)
    const observe = getEnvelopeObserver()
    expect(observe).toBeTypeOf('function')
    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe(`ws://127.0.0.1:5173${CLOCK_PATH}`)
    expect(socket.protocols).toEqual(['isla-mouth-v1', TOKEN])

    observe?.(sample({}, 'playing', 1))
    observe?.({
      ...sample({}, 'playing', 2),
      volume: 0.5,
      levels: [1, 1, 1],
    } as unknown as ClockSample)
    socket.open()
    expect(socket.sent).toHaveLength(1)
    const forwarded = JSON.parse(socket.sent[0])
    expect(forwarded.positionMs).toBe(2)
    expect(forwarded.volume).toBeUndefined()
    expect(forwarded.levels).toBeUndefined()

    observe?.(sample({}, 'playing', 3))
    expect(socket.sent).toHaveLength(2)
    expect(JSON.parse(socket.sent[1]).positionMs).toBe(3)
    expect(getEnvelopeObserver()).toBe(observe)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not replay buffered playing after a terminal sample', () => {
    setRealm(`${FRAGMENT_PREFIX}${TOKEN}`)
    const observe = getEnvelopeObserver()
    const socket = FakeWebSocket.instances[0]

    observe?.(sample({}, 'playing', 1))
    observe?.(sample({}, 'stopped', 1))
    socket.open()
    expect(socket.sent).toHaveLength(0)
  })

  it('retires an old callback and reconnects for the next accepted handle', () => {
    setRealm(`${FRAGMENT_PREFIX}${TOKEN}`)
    const firstObserver = getEnvelopeObserver()
    const first = FakeWebSocket.instances[0]
    first.open()
    firstObserver?.(sample({}, 'playing', 1))
    expect(first.sent).toHaveLength(1)

    first.close()
    firstObserver?.(sample({}, 'playing', 2))
    expect(first.sent).toHaveLength(1)
    expect(FakeWebSocket.instances).toHaveLength(1)

    const secondObserver = getEnvelopeObserver()
    expect(secondObserver).not.toBe(firstObserver)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = FakeWebSocket.instances[1]
    secondObserver?.(sample({}, 'playing', 3))
    firstObserver?.(sample({}, 'playing', 4))
    second.open()
    expect(second.sent).toHaveLength(1)
    expect(JSON.parse(second.sent[0]).positionMs).toBe(3)
  })

  it('drops stale playing under backpressure but never delays a terminal sample', () => {
    setRealm(`${FRAGMENT_PREFIX}${TOKEN}`)
    const observe = getEnvelopeObserver()
    const socket = FakeWebSocket.instances[0]
    socket.open()

    socket.bufferedAmount = 100_000
    observe?.(sample({}, 'playing', 5))
    expect(socket.sent).toHaveLength(0)

    socket.bufferedAmount = 0
    observe?.(sample({}, 'playing', 6))
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0]).positionMs).toBe(6)

    socket.bufferedAmount = 100_000
    observe?.(sample({}, 'stopped', 6))
    expect(socket.sent).toHaveLength(2)
    expect(JSON.parse(socket.sent[1]).state).toBe('stopped')
  })
})

interface LauncherModelState {
  readonly loaded: boolean
  readonly modelID: string
}

interface LauncherModelWriter {
  readonly mode: string
  readonly snapshotQueries: number
  start(): Promise<string>
  write(opening: number, signal: AbortSignal): Promise<void> | void
  close(): void
}

interface LauncherVtsSession {
  request(
    messageType: string,
    data: unknown,
    expectedType: string,
    timeoutMs: number,
  ): Promise<unknown>
  setModelEventListener(listener: (event: unknown) => void): () => void
  onMessage(raw: unknown): void
}

interface LauncherModule {
  readonly MouthModelWriter: new (
    session: unknown,
    targetModelId: string,
    openingInput: string,
  ) => LauncherModelWriter
  readonly VtsSession: new (socket: unknown) => LauncherVtsSession
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

class FakeModelSession {
  closed = false
  listener: ((event: unknown) => void) | null = null
  subscribeError: Error | null = null
  subscribeResponse: unknown = {
    subscribedEventCount: 1,
    subscribedEvents: ['ModelLoadedEvent'],
  }
  baseline: LauncherModelState = { loaded: true, modelID: 'target' }
  currentModelCalls = 0
  currentModelHandler: (() => Promise<LauncherModelState>) | null = null
  openings: Array<{ input: string; value: number }> = []

  async request(messageType: string): Promise<unknown> {
    if (messageType !== 'EventSubscriptionRequest') {
      throw new Error(`unexpected request ${messageType}`)
    }
    if (this.subscribeError !== null) throw this.subscribeError
    return this.subscribeResponse
  }

  async currentModel(): Promise<LauncherModelState> {
    this.currentModelCalls += 1
    if (this.currentModelHandler !== null) return this.currentModelHandler()
    return this.baseline
  }

  async setOpening(input: string, value: number): Promise<void> {
    this.openings.push({ input, value })
  }

  setModelEventListener(listener: (event: unknown) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  emit(event: unknown): void {
    this.listener?.(event)
  }
}

interface FakeVtsSocket {
  readonly readyState: number
  readonly sent: Array<{
    requestID: string
    messageType: string
    data: unknown
  }>
  send(text: string): void
  close(): void
  terminate(): void
  removeAllListeners(): void
}

function fakeVtsSocket(): FakeVtsSocket {
  const sent: FakeVtsSocket['sent'] = []
  return {
    readyState: 1,
    sent,
    send(text) {
      sent.push(JSON.parse(text))
    },
    close() {},
    terminate() {},
    removeAllListeners() {},
  }
}

function vtsMessage(requestId: string, messageType: string, data: unknown): string {
  return JSON.stringify({
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    requestID: requestId,
    messageType,
    data,
  })
}

const launcherUrl = new URL(
  '../../src/performance/lipsync/windows/start-speaking-demo.mjs',
  import.meta.url,
).href
const launcher = (await import(/* @vite-ignore */ launcherUrl)) as unknown as LauncherModule

describe('M1 launcher event-driven mouth model safety', () => {
  it('uses one confirmed-subscription snapshot for a burst plus terminal zero', async () => {
    const session = new FakeModelSession()
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')
    await writer.start()
    expect(writer.mode).toBe('watched')
    expect(writer.snapshotQueries).toBe(1)

    const signal = new AbortController().signal
    for (const opening of [0.1, 0.2, 0.3, 0.4]) await writer.write(opening, signal)
    await writer.write(0, signal)

    expect(writer.snapshotQueries).toBe(1)
    expect(session.currentModelCalls).toBe(1)
    expect(session.openings).toEqual([
      { input: 'MouthOpen', value: 0.1 },
      { input: 'MouthOpen', value: 0.2 },
      { input: 'MouthOpen', value: 0.3 },
      { input: 'MouthOpen', value: 0.4 },
      { input: 'MouthOpen', value: 0 },
    ])
  })

  it('sends pause and ended neutrals from cached state without another query', async () => {
    const session = new FakeModelSession()
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')
    await writer.start()
    const signal = new AbortController().signal

    await writer.write(0, signal)
    await writer.write(0, signal)

    expect(session.currentModelCalls).toBe(1)
    expect(session.openings).toEqual([
      { input: 'MouthOpen', value: 0 },
      { input: 'MouthOpen', value: 0 },
    ])
  })

  it('lets an event during the baseline outrank the older model response', async () => {
    const session = new FakeModelSession()
    const baseline = deferred<LauncherModelState>()
    session.currentModelHandler = () => baseline.promise
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')

    const starting = writer.start()
    await waitUntil(() => session.currentModelCalls === 1)
    session.emit({ kind: 'model', loaded: true, modelID: 'other' })
    baseline.resolve({ loaded: true, modelID: 'target' })
    await starting

    const signal = new AbortController().signal
    await writer.write(0.5, signal)
    expect(session.openings).toHaveLength(0)

    session.emit({ kind: 'model', loaded: true, modelID: 'target' })
    await writer.write(0.5, signal)
    expect(session.openings).toEqual([{ input: 'MouthOpen', value: 0.5 }])
    expect(session.currentModelCalls).toBe(1)
  })

  it('rejects positive and neutral writes after switch, unload and transport close', async () => {
    const session = new FakeModelSession()
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')
    await writer.start()
    const signal = new AbortController().signal

    await writer.write(0.2, signal)
    session.emit({ kind: 'model', loaded: true, modelID: 'other' })
    await writer.write(0.3, signal)
    await writer.write(0, signal)
    expect(session.openings).toEqual([{ input: 'MouthOpen', value: 0.2 }])

    session.emit({ kind: 'model', loaded: false, modelID: '' })
    await writer.write(0, signal)
    expect(session.openings).toHaveLength(1)

    session.emit({ kind: 'model', loaded: true, modelID: 'target' })
    await writer.write(0.4, signal)
    expect(session.openings).toHaveLength(2)

    session.emit({ kind: 'closed' })
    await writer.write(0, signal)
    expect(writer.mode).toBe('fatal')
    expect(session.openings).toHaveLength(2)

    writer.close()
    await writer.write(0.5, signal)
    expect(session.openings).toHaveLength(2)
  })

  it('falls back when events are unsupported and never lets an old positive follow neutral', async () => {
    const session = new FakeModelSession()
    session.subscribeError = new Error('events unsupported')
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')
    await writer.start()
    expect(writer.mode).toBe('fallback')

    const first = deferred<LauncherModelState>()
    const second = deferred<LauncherModelState>()
    const pending = [first, second]
    session.currentModelHandler = () => {
      const next = pending.shift()
      if (next === undefined) throw new Error('unexpected snapshot')
      return next.promise
    }

    const positiveController = new AbortController()
    const positive = writer.write(0.8, positiveController.signal)
    await waitUntil(() => session.currentModelCalls === 1)

    const zero = writer.write(0, new AbortController().signal)
    await waitUntil(() => session.currentModelCalls === 2)

    second.resolve({ loaded: true, modelID: 'target' })
    await zero
    expect(session.openings).toEqual([{ input: 'MouthOpen', value: 0 }])

    positiveController.abort()
    first.resolve({ loaded: true, modelID: 'target' })
    await positive
    expect(session.openings).toEqual([{ input: 'MouthOpen', value: 0 }])
  })

  it('fails closed after a malformed event until a safe read recovers', async () => {
    const session = new FakeModelSession()
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')
    await writer.start()
    const signal = new AbortController().signal

    session.emit({ kind: 'invalid' })
    await writer.write(0.2, signal)
    expect(writer.snapshotQueries).toBe(2)
    expect(session.openings).toEqual([{ input: 'MouthOpen', value: 0.2 }])

    session.emit({ kind: 'invalid' })
    session.baseline = { loaded: true, modelID: 'other' }
    await writer.write(0.3, signal)
    expect(writer.snapshotQueries).toBe(3)
    expect(session.openings).toHaveLength(1)
  })

  it('routes ModelLoadedEvent before pending correlation when the request id is reused', async () => {
    const socket = fakeVtsSocket()
    const session = new launcher.VtsSession(socket)
    const events: unknown[] = []
    session.setModelEventListener((event) => events.push(event))

    const pending = session.request(
      'EventSubscriptionRequest',
      { eventName: 'ModelLoadedEvent', subscribe: true, config: {} },
      'EventSubscriptionResponse',
      1000,
    )
    const requestId = socket.sent[0].requestID
    session.onMessage(
      vtsMessage(requestId, 'ModelLoadedEvent', {
        modelLoaded: true,
        modelName: 'Target',
        modelID: 'target',
      }),
    )
    expect(events).toEqual([{ kind: 'model', loaded: true, modelID: 'target' }])

    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    session.onMessage(
      vtsMessage(requestId, 'EventSubscriptionResponse', {
        subscribedEventCount: 1,
        subscribedEvents: ['ModelLoadedEvent'],
      }),
    )
    await expect(pending).resolves.toEqual({
      subscribedEventCount: 1,
      subscribedEvents: ['ModelLoadedEvent'],
    })
  })

  it('falls back after APIError and still drives a checked update', async () => {
    const socket = fakeVtsSocket()
    const session = new launcher.VtsSession(socket)
    const writer = new launcher.MouthModelWriter(session, 'target', 'MouthOpen')
    const starting = writer.start()
    await waitUntil(() => socket.sent.length === 1)
    session.onMessage(vtsMessage(socket.sent[0].requestID, 'APIError', { errorID: 710 }))
    await starting
    expect(writer.mode).toBe('fallback')

    const write = writer.write(0.4, new AbortController().signal)
    await waitUntil(() => socket.sent.length === 2)
    expect(socket.sent[1].messageType).toBe('CurrentModelRequest')
    session.onMessage(
      vtsMessage(socket.sent[1].requestID, 'CurrentModelResponse', {
        modelLoaded: true,
        modelID: 'target',
      }),
    )
    await waitUntil(() => socket.sent.length === 3)
    expect(socket.sent[2].messageType).toBe('InjectParameterDataRequest')
    expect(socket.sent[2].data).toEqual({
      mode: 'set',
      parameterValues: [{ id: 'MouthOpen', value: 0.4 }],
    })
    session.onMessage(
      vtsMessage(socket.sent[2].requestID, 'InjectParameterDataResponse', {}),
    )
    await write
  })
})

const viteApi = await import('vite')
const { mkdtemp, mkdir, realpath, rm, writeFile } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')

async function createViteWatchFixture(): Promise<{
  root: string
  configFile: string
}> {
  const root = await realpath(await mkdtemp(joinPath(tmpdir(), 'isla-vite-watch-')))
  const configFile = joinPath(root, 'vite.config.mjs')
  await mkdir(joinPath(root, 'src', 'nested'), { recursive: true })
  await writeFile(
    configFile,
    "export default { server: { host: '127.0.0.1', proxy: { '/health': { target: 'http://127.0.0.1:9' } } } }\n",
  )
  await writeFile(
    joinPath(root, 'index.html'),
    '<!doctype html><script type="module" src="/src/nested/entry.js"></script>\n',
  )
  await writeFile(
    joinPath(root, 'src', 'nested', 'entry.js'),
    'export const fixtureValue = 42\n',
  )
  await writeFile(
    joinPath(root, 'src', 'nested', 'other.js'),
    'export const otherValue = 7\n',
  )
  return { root, configFile }
}

describe('M1 launcher Vite watch isolation', () => {
  it('loses an inline null watch when the fixture config is merged', async () => {
    const fixture = await createViteWatchFixture()
    try {
      const resolved = await viteApi.resolveConfig(
        {
          root: fixture.root,
          configFile: fixture.configFile,
          logLevel: 'silent',
          server: {
            host: '127.0.0.1',
            port: 0,
            strictPort: true,
            hmr: false,
            watch: null,
            fs: { strict: true, deny: ['.env'] },
            proxy: { '/health': { target: 'http://127.0.0.1:9' } },
          },
        },
        'serve',
      )
      expect(resolved.server.watch).not.toBeNull()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 20_000)

  it('resolves the launcher post hook to a real no-op watcher while serving sources', async () => {
    const pluginFactory = (
      launcher as unknown as {
        createSpeakingStaticFilesPlugin?: () => import('vite').PluginOption
      }
    ).createSpeakingStaticFilesPlugin
    expect(pluginFactory).toBeTypeOf('function')
    const plugin = pluginFactory?.()
    if (plugin === undefined) throw new Error('launcher plugin was not exported')

    const fixture = await createViteWatchFixture()
    try {
      const inline = {
        root: fixture.root,
        configFile: fixture.configFile,
        logLevel: 'silent' as const,
        server: {
          host: '127.0.0.1',
          port: 0,
          strictPort: false,
          hmr: false,
          watch: null,
          fs: { strict: true, allow: [fixture.root], deny: ['.env'] },
          proxy: { '/health': { target: 'http://127.0.0.1:9' } },
        },
      }
      const resolved = await viteApi.resolveConfig(
        { ...inline, plugins: [plugin] },
        'serve',
      )
      expect(resolved.server.watch).toBeNull()

      const server = await viteApi.createServer({ ...inline, plugins: [plugin] })
      try {
        await server.listen()
        expect(server.config.server.watch).toBeNull()
        expect(server.watcher.constructor.name).toBe('NoopWatcher')
        server.watcher.add(joinPath(fixture.root, 'src', 'nested', 'entry.js'))
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(server.watcher.getWatched()).toEqual({})

        const address = server.httpServer?.address()
        if (address === null || address === undefined || typeof address === 'string') {
          throw new Error('the fixture server has no loopback address')
        }
        const response = await fetch(
          `http://127.0.0.1:${address.port}/src/nested/entry.js`,
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('fixtureValue')
      } finally {
        await server.close()
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)
})
