import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClockPort } from '../../src/contracts'
import { createAudioResourceRegistry } from '../../src/performance/audio-resources'
import type { AudioResourceRegistry } from '../../src/performance/audio-resources'
import type { AudioLease, AudioResolver } from '../../src/performance/browser/types'
import { createKokoroSynthesis } from '../../src/performance/kokoro-synthesis'
import { encodeMonoFloat32Wav } from '../../src/performance/wav'
import { createAudioResourceRoute } from '../../src/runtime/audio-resource-route'
import type {
  AudioResourceRoute,
  AudioResourceSource,
  AudioRouteIdentity,
} from '../../src/runtime/audio-resource-route'
import { createMonotonicClock } from '../../src/runtime/clock'
import { AUDIO_FETCH_HEADER, AUDIO_PATH } from '../../src/runtime/config'
import { createProductionApplication } from '../../src/runtime/production'
import type {
  ProductionApplication,
  ProductionAudioResources,
  ProductionPeers,
} from '../../src/runtime/production'
import type { ArchiveSelectionConfig } from '../../src/runtime/session-archives'
import type { StorageConfig } from '../../src/storage/config'
import { openDatabase } from '../../src/storage/sqlite'
import {
  createControlledMediaDriver,
  createM1ActualBlobMap,
  createRegistryResolver,
} from '../support/m1-kit'
import {
  createFakeKokoroProvider,
  createKokoroRawAudio,
  defaultKokoroProfile,
  M1_KOKORO_SAMPLE_RATE,
} from '../support/m1-kokoro-kit'
import { createPerformerClient } from '../support/performer-client'
import type { PerformerClient } from '../support/performer-client'
import { TEST_DEPLOYMENT_ORIGIN, createTestProductionPeers } from '../support/production-kit'

/**
 * Dynamic audio resource route acceptance.
 *
 * The direct layer drives the route over a real loopback HTTP server with a
 * controlled source, so cancellation, disposal, lifecycle and slot accounting
 * are deterministic. The application layer drives the real production
 * application, the real M1 registry and a real Kokoro synthesis adapter with a
 * clearly controlled raw-audio provider, so the served bytes are the bytes of
 * an assembled turn, acquired through the HTTP path. No live provider, network
 * download, inference or acoustic measurement is involved.
 */

const ALLOWED_ORIGIN = TEST_DEPLOYMENT_ORIGIN
const LIVE_SESSION = 'session-audio-route'
const OTHER_SESSION = 'session-audio-route-other'

const apps: ProductionApplication[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.stop()
    } catch {
      // A stop fault must not mask the test outcome.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempStorage(): StorageConfig {
  const dir = mkdtempSync(join(tmpdir(), 'm5-audio-route-'))
  tempDirs.push(dir)
  return { dbPath: join(dir, 'runtime.db'), backupDir: join(dir, 'backups') }
}

function selectionFor(liveSessionId: string): ArchiveSelectionConfig {
  const liveProfile = { profileId: 'character-fixture', profileVersion: '1' }
  return {
    liveSessionId,
    liveProfile,
    selectedSources: [],
    catalogue: new Map(),
  }
}

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface AudioHttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly bytes: Buffer
}

/**
 * One raw audio-route request. The caller controls the exact headers: the route
 * refuses a missing Origin and a missing fetch header, so tests must supply them
 * deliberately (a real browser supplies Origin itself; M2's resolver will).
 */
function audioRequest(
  port: number,
  ref: string | null,
  options: {
    method?: string
    origin?: string | null
    fetchHeader?: boolean
    host?: string
    signal?: AbortSignal
  } = {},
): Promise<AudioHttpResult> {
  const query = ref === null ? '' : `?ref=${encodeURIComponent(ref)}`
  const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}` }
  if (options.origin !== null) headers.origin = options.origin ?? ALLOWED_ORIGIN
  if (options.fetchHeader !== false) headers[AUDIO_FETCH_HEADER] = '1'
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `${AUDIO_PATH}${query}`,
        method: options.method ?? 'POST',
        headers,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function errorCodeOf(result: AudioHttpResult): unknown {
  try {
    return (JSON.parse(result.bytes.toString('utf8')) as { error?: { code?: string } }).error?.code
  } catch {
    return null
  }
}

interface DeferredLease {
  readonly promise: Promise<AudioLease>
  settle(): void
  releaseCount(): number
}

/** Copies into an owned buffer so the Blob part is a plain ArrayBuffer. */
function toBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy.buffer], { type })
}

function createDeferredLease(bytes: Uint8Array, type = 'audio/wav'): DeferredLease {
  let releaseCount = 0
  let resolveLease: (lease: AudioLease) => void = () => {}
  const promise = new Promise<AudioLease>((resolve) => {
    resolveLease = resolve
  })
  return {
    promise,
    settle() {
      resolveLease({
        blob: toBlob(bytes, type),
        release: () => {
          releaseCount += 1
        },
      })
    },
    releaseCount: () => releaseCount,
  }
}

/**
 * A Blob whose body read is held open, so a test can invalidate the session
 * exactly while `arrayBuffer()` is pending — the route's second asynchronous
 * boundary, after the resolver has already settled.
 */
class GatedBodyBlob extends Blob {
  private readonly gate: Promise<void>
  private readonly onRead: () => void

  constructor(gate: Promise<void>, bytes: Uint8Array, type: string, onRead: () => void) {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    super([copy.buffer], { type })
    this.gate = gate
    this.onRead = onRead
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    this.onRead()
    return this.gate.then(() => super.arrayBuffer())
  }
}

interface GatedAudioResources {
  readonly resources: ProductionAudioResources
  entered(): number
  open(): void
  releases(): number
}

/**
 * The real registry behind a gate: `resolve` acquires the real lease first and
 * then holds it open, so a test can change the application state during a held
 * acquisition and observe whether the route publishes, refuses and releases.
 */
function createGatedAudioResources(registry: AudioResourceRegistry): GatedAudioResources {
  let entered = 0
  let releases = 0
  let openGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  return {
    resources: {
      retireBefore: (sessionId, newEpoch) => registry.retireBefore(sessionId, newEpoch),
      retireSession: (sessionId) => registry.retireSession(sessionId),
      admission: (audioRef, sessionId, epoch) => registry.admission(audioRef, sessionId, epoch),
      async resolve(audioRef, signal) {
        const lease = await registry.resolve(audioRef, signal)
        entered += 1
        await gate
        return {
          blob: lease.blob,
          release: () => {
            releases += 1
            lease.release()
          },
        }
      },
    },
    entered: () => entered,
    open: () => openGate(),
    releases: () => releases,
  }
}

interface HeldResponseEnd {
  /**
   * Defers the real end of the response for the first request carrying the
   * held reference; every other request is left untouched.
   */
  attach(req: IncomingMessage, res: ServerResponse): void
  /** True once the route has attempted to end the held response. */
  endRequested(): boolean
  /** Real `finish` events observed on the held response; zero while held. */
  finishes(): number
  /** Applies the captured end so the response can finish. */
  release(): void
}

/**
 * Test-only unfinished-response boundary.
 *
 * The route handles a real request on the real `ServerResponse` and attempts
 * the final `end()` with the complete payload; that call is captured and
 * applied only when the test releases it, so the response is deterministically
 * unfinished. Socket back-pressure (a paused client and a payload larger than
 * the platform's buffers) is deliberately not used: whether the server can
 * finish such a response depends on platform buffering, so the server may
 * already have finished before the client pauses.
 */
function createHeldResponseEnd(ref: string): HeldResponseEnd {
  let attached = false
  let endRequested = false
  let finishes = 0
  let applyEnd: (() => void) | null = null
  return {
    attach(req, res) {
      if (attached) return
      let url: URL
      try {
        url = new URL(req.url ?? '', 'http://localhost')
      } catch {
        return
      }
      if (url.pathname !== AUDIO_PATH || url.searchParams.get('ref') !== ref) return
      attached = true
      res.on('finish', () => {
        finishes += 1
      })
      const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse
      res.end = ((...args: unknown[]) => {
        endRequested = true
        applyEnd = () => {
          originalEnd(...args)
        }
        return res
      }) as unknown as typeof res.end
    },
    endRequested: () => endRequested,
    finishes: () => finishes,
    release() {
      const apply = applyEnd
      applyEnd = null
      if (apply !== null) apply()
    },
  }
}

interface DirectRoute {
  readonly route: AudioResourceRoute
  readonly port: number
  close(): Promise<void>
}

async function startDirectRoute(options: {
  source: AudioResourceSource
  liveIdentity: () => AudioRouteIdentity
  maxConcurrent?: number
  /** Test-only response boundary; see `createHeldResponseEnd`. */
  holdResponseEnd?: (req: IncomingMessage, res: ServerResponse) => void
}): Promise<DirectRoute> {
  const route = createAudioResourceRoute({
    source: options.source,
    liveIdentity: options.liveIdentity,
    allowOrigin: (origin) => origin === ALLOWED_ORIGIN,
    allowHost: () => true,
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
  })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    options.holdResponseEnd?.(req, res)
    if (!route.handleHttp(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"ok":false,"error":{"code":"no_route"}}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    route,
    port,
    async close() {
      route.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('dynamic audio route mechanics', () => {
  it('refuses a non-serving lifecycle at admission and again after acquisition, even when the epoch is unchanged', async () => {
    let identity: AudioRouteIdentity = {
      sessionId: LIVE_SESSION,
      epoch: 3,
      servable: false,
    }
    let resolveCalls = 0
    const deferred = createDeferredLease(new Uint8Array([1, 2, 3]))
    const direct = await startDirectRoute({
      source: {
        admission: () => null,
        resolve: () => {
          resolveCalls += 1
          return deferred.promise
        },
      },
      liveIdentity: () => identity,
    })
    try {
      const stopped = await audioRequest(direct.port, 'audio://route/ref')
      expect(stopped.status).toBe(409)
      expect(errorCodeOf(stopped)).toBe('conflict')
      expect(resolveCalls).toBe(0)

      identity = { ...identity, servable: true }
      const pending = audioRequest(direct.port, 'audio://route/ref')
      await until(() => resolveCalls, (calls) => calls === 1)

      // The session stops during acquisition; session id and epoch are unchanged.
      identity = { ...identity, servable: false }
      deferred.settle()
      const refused = await pending
      expect(refused.status).toBe(409)
      expect(errorCodeOf(refused)).toBe('conflict')
      expect(deferred.releaseCount()).toBe(1)
      expect(direct.route.pendingCount()).toBe(0)
    } finally {
      await direct.close()
    }
  })

  it('refuses when the lifecycle changes while the body is being acquired', async () => {
    let identity: AudioRouteIdentity = {
      sessionId: LIVE_SESSION,
      epoch: 5,
      servable: true,
    }
    let arrayBufferCalls = 0
    let releases = 0
    let openBody: () => void = () => {}
    const bodyGate = new Promise<void>((resolve) => {
      openBody = resolve
    })
    const blob = new GatedBodyBlob(bodyGate, new Uint8Array([4, 4, 4]), 'audio/wav', () => {
      arrayBufferCalls += 1
    })
    const direct = await startDirectRoute({
      source: {
        admission: () => null,
        resolve: async () => ({
          blob,
          release: () => {
            releases += 1
          },
        }),
      },
      liveIdentity: () => identity,
    })
    try {
      const pending = audioRequest(direct.port, 'audio://route/ref')
      await until(() => arrayBufferCalls, (calls) => calls === 1)

      // The session stops after the resolver settled but while the body is still
      // being read; the session id and epoch are unchanged.
      identity = { ...identity, servable: false }
      openBody()

      const refused = await pending
      expect(refused.status).toBe(409)
      expect(errorCodeOf(refused)).toBe('conflict')
      expect(releases).toBe(1)
      expect(direct.route.pendingCount()).toBe(0)
    } finally {
      await direct.close()
    }
  })

  it('releases the lease exactly once when the client disconnects before the resolver settles', async () => {
    let resolveCalls = 0
    const deferred = createDeferredLease(new Uint8Array([7, 7, 7]))
    const direct = await startDirectRoute({
      source: {
        admission: () => null,
        resolve: () => {
          resolveCalls += 1
          return deferred.promise
        },
      },
      liveIdentity: () => ({ sessionId: LIVE_SESSION, epoch: 1, servable: true }),
    })
    try {
      const req = request({
        host: '127.0.0.1',
        port: direct.port,
        path: `${AUDIO_PATH}?ref=${encodeURIComponent('audio://route/ref')}`,
        method: 'POST',
        headers: { origin: ALLOWED_ORIGIN, [AUDIO_FETCH_HEADER]: '1' },
      })
      req.on('error', () => {})
      const closed = new Promise<void>((resolve) => req.once('close', () => resolve()))
      req.end()
      await until(() => resolveCalls, (calls) => calls === 1)

      req.destroy()
      await closed
      deferred.settle()
      await until(() => deferred.releaseCount(), (count) => count === 1)
      expect(direct.route.pendingCount()).toBe(0)
    } finally {
      await direct.close()
    }
  })

  it('keeps the serving slot occupied while an early-disconnected resolver ignores abort', async () => {
    const bytes = new Uint8Array([5, 5, 5])
    const deferred = createDeferredLease(bytes)
    let resolveCalls = 0
    const direct = await startDirectRoute({
      source: {
        admission: () => null,
        // Deliberately ignores the abort signal: the route must keep the slot
        // until the resolver settles, not release capacity on disconnect.
        resolve: () => {
          resolveCalls += 1
          if (resolveCalls === 1) return deferred.promise
          return Promise.resolve({ blob: toBlob(bytes, 'audio/wav'), release: () => {} })
        },
      },
      liveIdentity: () => ({ sessionId: LIVE_SESSION, epoch: 1, servable: true }),
      maxConcurrent: 1,
    })
    try {
      const req = request({
        host: '127.0.0.1',
        port: direct.port,
        path: `${AUDIO_PATH}?ref=${encodeURIComponent('audio://route/ref')}`,
        method: 'POST',
        headers: { origin: ALLOWED_ORIGIN, [AUDIO_FETCH_HEADER]: '1' },
      })
      req.on('error', () => {})
      const closed = new Promise<void>((resolve) => req.once('close', () => resolve()))
      req.end()
      await until(() => resolveCalls, (calls) => calls === 1)

      req.destroy()
      await closed

      // The client is gone but the resolver has not settled: the slot stays
      // occupied, so the route cannot admit another serve yet.
      const busy = await audioRequest(direct.port, 'audio://route/other')
      expect(busy.status).toBe(429)
      expect(errorCodeOf(busy)).toBe('busy')
      await delay(50)
      const stillBusy = await audioRequest(direct.port, 'audio://route/other')
      expect(stillBusy.status).toBe(429)
      expect(errorCodeOf(stillBusy)).toBe('busy')

      deferred.settle()
      await until(() => deferred.releaseCount(), (count) => count === 1)
      await until(() => direct.route.pendingCount(), (count) => count === 0)

      const served = await audioRequest(direct.port, 'audio://route/other')
      expect(served.status).toBe(200)
      expect(Buffer.from(served.bytes).equals(Buffer.from(bytes))).toBe(true)
    } finally {
      await direct.close()
    }
  })

  it('holds the lease and the serving slot until the response finishes', async () => {
    // The response end is deferred by the test-only boundary in
    // `createHeldResponseEnd`: the route supplies the complete payload and
    // attempts the end, while the response stays deterministically unfinished.
    const bytes = new Uint8Array(4096)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    const heldRef = 'audio://route/held'
    const heldEnd = createHeldResponseEnd(heldRef)
    const deferred = createDeferredLease(bytes)
    let resolveCalls = 0
    const direct = await startDirectRoute({
      source: {
        admission: () => null,
        resolve: () => {
          resolveCalls += 1
          if (resolveCalls === 1) return deferred.promise
          return Promise.resolve({ blob: toBlob(bytes, 'audio/wav'), release: () => {} })
        },
      },
      liveIdentity: () => ({ sessionId: LIVE_SESSION, epoch: 1, servable: true }),
      maxConcurrent: 1,
      holdResponseEnd: heldEnd.attach,
    })
    try {
      const pending = audioRequest(direct.port, heldRef)
      // If the test fails before the release, teardown destroys the held
      // connection; keep that rejection from surfacing as an unhandled error
      // beside the actual assertion failure.
      void pending.catch(() => {})
      await until(() => resolveCalls, (calls) => calls === 1)
      deferred.settle()
      await until(() => heldEnd.endRequested(), (requested) => requested)

      // The route supplied the complete payload and attempted the end, but the
      // real response has not finished: neither the lease nor the serving slot
      // may be released.
      expect(heldEnd.finishes()).toBe(0)
      expect(deferred.releaseCount()).toBe(0)
      expect(direct.route.pendingCount()).toBe(1)

      // The occupied slot refuses further work while the response is unfinished,
      // without disturbing the held serve.
      const busy = await audioRequest(direct.port, 'audio://route/other')
      expect(busy.status).toBe(429)
      expect(errorCodeOf(busy)).toBe('busy')
      expect(resolveCalls).toBe(1)
      expect(heldEnd.finishes()).toBe(0)
      expect(deferred.releaseCount()).toBe(0)
      expect(direct.route.pendingCount()).toBe(1)

      // Releasing the deferred end finishes the real response: the client
      // receives every byte, the lease is released exactly once and capacity
      // is restored.
      heldEnd.release()
      const served = await pending
      expect(served.status).toBe(200)
      expect(served.headers['content-type']).toBe('audio/wav')
      expect(served.headers['content-length']).toBe(String(bytes.byteLength))
      expect(served.bytes.equals(Buffer.from(bytes))).toBe(true)
      await until(() => heldEnd.finishes(), (count) => count === 1)
      await until(() => deferred.releaseCount(), (count) => count === 1)
      await until(() => direct.route.pendingCount(), (count) => count === 0)

      const after = await audioRequest(direct.port, 'audio://route/after')
      expect(after.status).toBe(200)
      expect(after.bytes.equals(Buffer.from(bytes))).toBe(true)
      expect(deferred.releaseCount()).toBe(1)
    } finally {
      await direct.close()
    }
  })

  it('disposes a still-open response and releases a late settlement exactly once', async () => {
    let resolveCalls = 0
    const deferred = createDeferredLease(new Uint8Array([9, 9, 9]))
    const direct = await startDirectRoute({
      source: {
        admission: () => null,
        resolve: () => {
          resolveCalls += 1
          return deferred.promise
        },
      },
      liveIdentity: () => ({ sessionId: LIVE_SESSION, epoch: 1, servable: true }),
    })
    try {
      const req = request({
        host: '127.0.0.1',
        port: direct.port,
        path: `${AUDIO_PATH}?ref=${encodeURIComponent('audio://route/ref')}`,
        method: 'POST',
        headers: { origin: ALLOWED_ORIGIN, [AUDIO_FETCH_HEADER]: '1' },
      })
      req.on('error', () => {})
      const closed = new Promise<void>((resolve) => req.once('close', () => resolve()))
      req.end()
      await until(() => resolveCalls, (calls) => calls === 1)

      // Disposal must terminate the open response instead of waiting forever
      // for a response that a non-cooperating resolver is holding open.
      direct.route.dispose()
      await closed

      const refused = await audioRequest(direct.port, 'audio://route/ref')
      expect(refused.status).toBe(503)
      expect(errorCodeOf(refused)).toBe('unavailable')

      deferred.settle()
      await until(() => deferred.releaseCount(), (count) => count === 1)
      await until(() => direct.route.pendingCount(), (count) => count === 0)
    } finally {
      await direct.close()
    }
  })
})

interface RouteFixture {
  readonly app: ProductionApplication
  readonly storage: StorageConfig
  readonly port: number
  readonly clock: ClockPort
  readonly registry: AudioResourceRegistry
  newClient(resolver?: AudioResolver, sessionId?: string): PerformerClient
  boot(client: PerformerClient): Promise<void>
  operatorToken(): Promise<string>
}

async function startFixture(
  options: {
    clock?: ClockPort
    registry?: AudioResourceRegistry
    peers?: ProductionPeers
    liveSessionId?: string
    recovery?: { nextSessionId?: () => string; maxSources?: number }
  } = {},
): Promise<RouteFixture> {
  const storage = tempStorage()
  const clock = options.clock ?? createMonotonicClock()
  const registry =
    options.registry ??
    createAudioResourceRegistry({ clock, byteBudget: 32 * 1024 * 1024, retentionMs: 60_000 })
  const peers = options.peers ?? createTestProductionPeers({ clock, audioResources: registry })
  const app = await createProductionApplication({
    storage,
    initialSelection: selectionFor(options.liveSessionId ?? LIVE_SESSION),
    peers,
    allowedOrigins: [ALLOWED_ORIGIN],
    port: 0,
    graceMs: 200,
    clock,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  })
  apps.push(app)
  const bound = await app.start()

  const media = createControlledMediaDriver({ autoEvents: true })
  let clientCounter = 0
  let receiptCounter = 0
  const clients: PerformerClient[] = []
  const liveSessionId = options.liveSessionId ?? LIVE_SESSION

  const bootstrapOperator = async (): Promise<string> => {
    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: bound.port,
          path: '/operator/bootstrap',
          method: 'POST',
          headers: {
            origin: ALLOWED_ORIGIN,
            host: `127.0.0.1:${bound.port}`,
            'x-isla-operator-bootstrap': '1',
          },
        },
        (res: IncomingMessage) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            body += chunk
          })
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as unknown })
            } catch {
              resolve({ status: res.statusCode ?? 0, body })
            }
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
    const parsed = result.body as { ok?: boolean; token?: string }
    if (result.status !== 200 || parsed.ok !== true || typeof parsed.token !== 'string') {
      throw new Error(`operator bootstrap failed with status ${result.status}`)
    }
    return parsed.token
  }

  return {
    app,
    storage,
    port: bound.port,
    clock,
    registry,
    newClient(resolver?: AudioResolver, sessionId?: string): PerformerClient {
      clientCounter += 1
      const client = createPerformerClient({
        url: `ws://127.0.0.1:${bound.port}/app`,
        origin: ALLOWED_ORIGIN,
        sessionId: sessionId ?? liveSessionId,
        resolver: resolver ?? createRegistryResolver(createM1ActualBlobMap()),
        media,
        receipts: {
          newReceiptId: () => `audio-route-${clientCounter}-receipt-${(receiptCounter += 1)}`,
          localNowMs: () => null,
        },
      })
      clients.push(client)
      return client
    },
    operatorToken: bootstrapOperator,
    async boot(client: PerformerClient) {
      // A real client only sends operator and control messages after the
      // snapshot; awaiting it removes the connect race for successors too.
      await client.snapshot
      const ack = await client.bootstrapOperator(await bootstrapOperator())
      expect(ack.kind).toBe('operator.ack')
      expect((await client.attach()).kind).toBe('session.attach.ack')
      expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
    },
  }
}

function registerFixture(
  registry: AudioResourceRegistry,
  sessionId: string,
  epoch: number,
  bytes: Uint8Array,
  overrides: { format?: string } = {},
): string {
  return registry.register({
    requestId: 'audio-route-test',
    sessionId,
    epoch,
    turnId: 'turn-audio-route',
    segmentId: 'segment-audio-route',
    voiceProfileId: 'voice-audio-route',
    voiceProfileVersion: '1',
    format: overrides.format ?? 'audio/wav',
    bytes,
  }).audioRef
}

describe('dynamic audio route through the production application', () => {
  it('refuses every fetch while the session is stopped', async () => {
    const fixture = await startFixture()
    const ref = registerFixture(fixture.registry, LIVE_SESSION, 0, new Uint8Array([1, 2, 3]))

    const stopped = await audioRequest(fixture.port, ref)
    expect(stopped.status).toBe(409)
    expect(errorCodeOf(stopped)).toBe('conflict')

    const wrongMethod = await audioRequest(fixture.port, ref, { method: 'GET' })
    expect(wrongMethod.status).toBe(405)
    expect(errorCodeOf(wrongMethod)).toBe('method_not_allowed')

    const noHeader = await audioRequest(fixture.port, ref, { fetchHeader: false })
    expect(noHeader.status).toBe(403)
    expect(errorCodeOf(noHeader)).toBe('forbidden')

    const noOrigin = await audioRequest(fixture.port, ref, { origin: null })
    expect(noOrigin.status).toBe(403)
    expect(errorCodeOf(noOrigin)).toBe('forbidden')

    const badOrigin = await audioRequest(fixture.port, ref, { origin: 'http://not-allowed.example' })
    expect(badOrigin.status).toBe(403)
    expect(errorCodeOf(badOrigin)).toBe('forbidden')

    const badHost = await audioRequest(fixture.port, ref, { host: 'not-allowed.example' })
    expect(badHost.status).toBe(403)
    expect(errorCodeOf(badHost)).toBe('forbidden')

    expect(fixture.registry.snapshot().activeCount).toBe(1)
  })

  it('serves only the live session/epoch and reclaims the lease after the response', async () => {
    const fixture = await startFixture()
    const client = fixture.newClient()
    await fixture.boot(client)
    const epoch = fixture.app.currentComposition().coordinator.epoch()
    expect(epoch).toBe(1)

    const wrongSession = registerFixture(fixture.registry, OTHER_SESSION, epoch, new Uint8Array([4]))
    expect((await audioRequest(fixture.port, wrongSession)).status).toBe(404)

    const wrongEpoch = registerFixture(fixture.registry, LIVE_SESSION, epoch + 1, new Uint8Array([5]))
    expect((await audioRequest(fixture.port, wrongEpoch)).status).toBe(404)

    expect((await audioRequest(fixture.port, 'audio://kokoro/unknown')).status).toBe(404)
    expect((await audioRequest(fixture.port, 'file:///etc/passwd')).status).toBe(404)
    expect((await audioRequest(fixture.port, null)).status).toBe(400)

    const bytes = new Uint8Array(4096)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    const ref = registerFixture(fixture.registry, LIVE_SESSION, epoch, bytes)
    const served = await audioRequest(fixture.port, ref)
    expect(served.status).toBe(200)
    expect(served.headers['content-type']).toBe('audio/wav')
    expect(served.headers['content-length']).toBe(String(bytes.byteLength))
    expect(served.headers['cache-control']).toBe('no-store')
    expect(served.headers['x-content-type-options']).toBe('nosniff')
    expect(served.bytes.equals(Buffer.from(bytes))).toBe(true)

    // The lease is released when the response finishes, so the served entry is
    // reclaimed; the scope-test entries stay active and unleased.
    const snapshot = fixture.registry.snapshot()
    expect(snapshot.resources.some((resource) => resource.audioRef === ref)).toBe(false)
    expect(snapshot.activeCount).toBe(2)
    expect(snapshot.usedBytes).toBe(2)
  })

  it('refuses after Stop and never serves a retired epoch after Resume', async () => {
    const fixture = await startFixture()
    const client = fixture.newClient()
    await fixture.boot(client)
    const firstRef = registerFixture(fixture.registry, LIVE_SESSION, 1, new Uint8Array([1, 1]))
    expect((await audioRequest(fixture.port, firstRef)).status).toBe(200)

    const stopAck = await client.stop()
    expect((stopAck.payload as { status?: string }).status).toBe('applied')
    const epochAfterStop = fixture.app.currentComposition().coordinator.epoch()
    expect(epochAfterStop).toBe(2)
    const stopped = await audioRequest(fixture.port, firstRef)
    expect(stopped.status).toBe(409)
    expect(errorCodeOf(stopped)).toBe('conflict')

    const resumeAck = await client.resume()
    expect((resumeAck.payload as { status?: string }).status).toBe('applied')
    const epochAfterResume = fixture.app.currentComposition().coordinator.epoch()
    expect(epochAfterResume).toBe(3)
    const retired = await audioRequest(fixture.port, firstRef)
    expect(retired.status).toBe(404)
    expect(errorCodeOf(retired)).toBe('not_found')

    const secondRef = registerFixture(
      fixture.registry,
      LIVE_SESSION,
      epochAfterResume,
      new Uint8Array([2, 2]),
    )
    expect((await audioRequest(fixture.port, secondRef)).status).toBe(200)
  })

  it('does not publish bytes when the session stops during acquisition', async () => {
    const clock = createMonotonicClock()
    const registry = createAudioResourceRegistry({
      clock,
      byteBudget: 32 * 1024 * 1024,
      retentionMs: 60_000,
    })
    const gated = createGatedAudioResources(registry)
    const fixture = await startFixture({
      clock,
      registry,
      peers: createTestProductionPeers({ clock, audioResources: gated.resources }),
    })
    const client = fixture.newClient()
    await fixture.boot(client)

    const ref = registerFixture(registry, LIVE_SESSION, 1, new Uint8Array([3, 3, 3]))
    const pending = audioRequest(fixture.port, ref)
    await until(() => gated.entered(), (entered) => entered === 1)

    const stopAck = await client.stop()
    expect((stopAck.payload as { status?: string }).status).toBe('applied')
    gated.open()

    const refused = await pending
    expect(refused.status).toBe(409)
    expect(errorCodeOf(refused)).toBe('conflict')
    expect(gated.releases()).toBe(1)
    const snapshot = registry.snapshot()
    expect(snapshot.activeCount).toBe(0)
    expect(snapshot.usedBytes).toBe(0)
  })

  it('serves the bytes of a real assembled turn through the route', async () => {
    const clock = createMonotonicClock()
    const registry = createAudioResourceRegistry({
      clock,
      byteBudget: 32 * 1024 * 1024,
      retentionMs: 60_000,
    })
    const provider = createFakeKokoroProvider()
    const samples = createKokoroRawAudio(64, M1_KOKORO_SAMPLE_RATE, (index) => Math.sin(index / 3) * 0.25)
    provider.setAutoResolve(samples)

    const fixture = await startFixture({
      clock,
      registry,
      peers: createTestProductionPeers({
        clock,
        audioResources: registry,
        createSynthesis: (gate) =>
          createKokoroSynthesis({
            provider,
            profiles: [defaultKokoroProfile()],
            registry,
            clock,
            deadlineGate: gate,
          }),
      }),
    })

    // The performer acquires the generated reference over the real HTTP route,
    // exactly as a consumer resolver would.
    const fetched: Array<{ ref: string; status: number; bytes: Uint8Array }> = []
    const resolver: AudioResolver = {
      async resolve(audioRef, signal) {
        const result = await audioRequest(fixture.port, audioRef, { signal })
        fetched.push({ ref: audioRef, status: result.status, bytes: result.bytes })
        if (result.status !== 200) {
          throw new Error(`audio route refused the generated reference with ${result.status}`)
        }
        const type = result.headers['content-type']
        return {
          blob: toBlob(result.bytes, typeof type === 'string' ? type : 'audio/wav'),
          release() {},
        }
      },
    }
    const client = fixture.newClient(resolver)
    await fixture.boot(client)

    const ack = await client.input('a dynamic turn')
    expect((ack.payload as { status?: string }).status).toBe('accepted')
    // The turn dispatches two segments; wait until both are confirmed so both
    // prepared resources have been acquired and released through the route.
    await until(
      async () => (await fixture.app.history.confirmedHistory(LIVE_SESSION)).length,
      (count) => count >= 2,
    )

    expect(provider.calls().length).toBeGreaterThanOrEqual(2)
    expect(fetched.length).toBe(2)
    const expected = encodeMonoFloat32Wav(samples.samples, samples.sampleRate)
    for (const acquired of fetched) {
      expect(acquired.status).toBe(200)
      expect(acquired.ref.startsWith('audio://kokoro/')).toBe(true)
      expect(Buffer.from(acquired.bytes).equals(Buffer.from(expected))).toBe(true)
    }
    const snapshot = registry.snapshot()
    expect(snapshot.leasedCount).toBe(0)
    expect(snapshot.activeCount).toBe(0)
    expect(snapshot.usedBytes).toBe(0)
  })

  it('does not publish bytes when the running session becomes degraded during acquisition', async () => {
    const clock = createMonotonicClock()
    const registry = createAudioResourceRegistry({
      clock,
      byteBudget: 32 * 1024 * 1024,
      retentionMs: 60_000,
    })
    const gated = createGatedAudioResources(registry)
    const fixture = await startFixture({
      clock,
      registry,
      peers: createTestProductionPeers({ clock, audioResources: gated.resources }),
    })
    const client = fixture.newClient()
    await fixture.boot(client)
    const epochBefore = fixture.app.currentComposition().coordinator.epoch()

    const ref = registerFixture(registry, LIVE_SESSION, epochBefore, new Uint8Array([6, 6, 6]))
    const pending = audioRequest(fixture.port, ref)
    await until(() => gated.entered(), (entered) => entered === 1)

    // A real storage fault while the acquisition is held: the running session
    // degrades without an operator command and without an epoch change. The
    // fault renames the real event table, so the next admitted durable write
    // fails on the actual SQLite backend.
    const database = openDatabase(fixture.app.storage.dbPath)
    try {
      database.exec('ALTER TABLE events RENAME TO events_sabotaged')
    } finally {
      database.close()
    }
    const ack = await client.input('a turn whose first durable write fails')
    expect((ack.payload as { status?: string }).status).toBe('accepted')
    await until(
      async () =>
        (await fixture.app.currentComposition().coordinator.endpoint.snapshot()).lifecycle,
      (lifecycle) => lifecycle === 'degraded',
    )
    expect(fixture.app.currentComposition().coordinator.epoch()).toBe(epochBefore)

    gated.open()
    const refused = await pending
    expect(refused.status).toBe(409)
    expect(errorCodeOf(refused)).toBe('conflict')
    expect(gated.releases()).toBe(1)
    const snapshot = registry.snapshot()
    expect(snapshot.leasedCount).toBe(0)
    expect(snapshot.resources.some((resource) => resource.audioRef === ref)).toBe(false)

    const afterDegrade = await audioRequest(fixture.port, ref)
    expect(afterDegrade.status).toBe(409)
    expect(errorCodeOf(afterDegrade)).toBe('conflict')
  })

  it('retires the session under a held acquisition and refuses the stopped successor until resumed', async () => {
    const clock = createMonotonicClock()
    const registry = createAudioResourceRegistry({
      clock,
      byteBudget: 32 * 1024 * 1024,
      retentionMs: 60_000,
    })
    const gated = createGatedAudioResources(registry)
    const successor = 'session-audio-route-successor'
    const fixture = await startFixture({
      clock,
      registry,
      peers: createTestProductionPeers({ clock, audioResources: gated.resources }),
      recovery: { nextSessionId: () => successor },
    })
    const performer = fixture.newClient()
    await fixture.boot(performer)
    const epochBefore = fixture.app.currentComposition().coordinator.epoch()

    const ref = registerFixture(registry, LIVE_SESSION, epochBefore, new Uint8Array([7, 7, 7]))
    const pending = audioRequest(fixture.port, ref)
    await until(() => gated.entered(), (entered) => entered === 1)

    // The operator retires the running session while the acquisition is held.
    const operator = fixture.newClient()
    await operator.snapshot
    await operator.bootstrapOperator(await fixture.operatorToken())
    const ack = await operator.recover()
    expect(ack.kind).toBe('session.recovery.ack')
    expect(ack.payload).toMatchObject({
      status: 'applied',
      retiredSessionId: LIVE_SESSION,
      successorSessionId: successor,
    })
    expect(fixture.app.currentSessionId()).toBe(successor)

    gated.open()
    const refused = await pending
    expect(refused.status).toBe(409)
    expect(errorCodeOf(refused)).toBe('conflict')
    expect(gated.releases()).toBe(1)
    const snapshot = registry.snapshot()
    expect(snapshot.leasedCount).toBe(0)
    expect(snapshot.resources.some((resource) => resource.audioRef === ref)).toBe(false)

    // The successor starts stopped: it refuses new audio until the operator resumes it.
    const stoppedFetch = await audioRequest(fixture.port, ref)
    expect(stoppedFetch.status).toBe(409)
    expect(errorCodeOf(stoppedFetch)).toBe('conflict')

    const successorClient = fixture.newClient(undefined, successor)
    await fixture.boot(successorClient)
    const successorEpoch = fixture.app.currentComposition().coordinator.epoch()

    const retiredRef = await audioRequest(fixture.port, ref)
    expect(retiredRef.status).toBe(404)
    expect(errorCodeOf(retiredRef)).toBe('not_found')

    const successorRef = registerFixture(
      registry,
      successor,
      successorEpoch,
      new Uint8Array([8, 8, 8]),
    )
    const served = await audioRequest(fixture.port, successorRef)
    expect(served.status).toBe(200)
    expect(Buffer.from(served.bytes).equals(Buffer.from([8, 8, 8]))).toBe(true)
  })

  it('fails visibly when a peer set declares audio resources without serving methods', async () => {
    const clock = createMonotonicClock()
    const registry = createAudioResourceRegistry({
      clock,
      byteBudget: 1024,
      retentionMs: 60_000,
    })
    const peers = {
      ...createTestProductionPeers({ clock }),
      audioResources: {
        retireBefore: registry.retireBefore.bind(registry),
        retireSession: registry.retireSession.bind(registry),
      },
    } as unknown as ProductionPeers
    await expect(
      createProductionApplication({
        storage: tempStorage(),
        initialSelection: selectionFor(LIVE_SESSION),
        peers,
        allowedOrigins: [ALLOWED_ORIGIN],
      }),
    ).rejects.toThrowError('peers.audioResources.admission')
  })
})
