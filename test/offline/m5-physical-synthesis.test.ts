import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallContext, ClockPort, PreparePerformance } from '../../src/contracts'
import { createAudioResourceRegistry } from '../../src/performance/audio-resources'
import type { AudioResourceRegistry } from '../../src/performance/audio-resources'
import { createMonotonicClock } from '../../src/runtime/clock'
import type { RuntimeCoordinator } from '../../src/runtime/coordinator'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import { createRetainedSynthesis } from '../../src/runtime/physical-synthesis'
import type { RetainedSynthesis } from '../../src/runtime/physical-synthesis'
import { createProductionApplication } from '../../src/runtime/production'
import type { ProductionApplication } from '../../src/runtime/production'
import { resolveStorageConfig } from '../../src/storage/config'
import type { StorageConfig } from '../../src/storage/config'
import {
  fixtureOperatorContext,
  fixturePreparePerformance,
  fixtureRuntimeEvent,
  fixtureViewerContext,
} from '../support/fixture-data'
import { M1_FIXTURE_SEGMENT_0_TEXT } from '../support/m1-kit'
import { defaultKokoroProfile } from '../support/m1-kokoro-kit'
import { kokoroSdkTestConfig } from '../support/m1-kokoro-sdk-kit'
import { createControlledWorkerKit } from '../support/m1-kokoro-worker-kit'
import type { ControlledWorkerKit } from '../support/m1-kokoro-worker-kit'
import { createRealWorkerKit } from '../support/m1-real-worker-kit'
import type { RealWorkerKit } from '../support/m1-real-worker-kit'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import { TEST_DEPLOYMENT_ORIGIN, createTestProductionPeers } from '../support/production-kit'

/**
 * M5 retained physical synthesis lifecycle.
 *
 * The real M1 adapter and worker host are exercised over a controlled transport
 * (no model is loaded): one provider is initialized once, every composition
 * receives a facade over the same adapter, and each caller keeps effective
 * cancellation through its own composition gate. Release drains the physical
 * job and resolves only after the actual worker exit. The production
 * application awaits that owned release on shutdown and on a failed creation.
 * One acceptance case runs the same lifecycle over a real Node worker thread
 * behind the `createWorker` seam, with scripted generations and a real thread
 * exit; it proves nothing about real Kokoro inference or acoustic output.
 */

const LIVE_1 = 'session-physical-live-1'
const SUCCESSOR = 'session-physical-successor'

interface Assembly {
  readonly retained: RetainedSynthesis
  readonly kit: ControlledWorkerKit
  readonly clock: ClockPort
  readonly registry: AudioResourceRegistry
}

interface RealAssembly {
  readonly retained: RetainedSynthesis
  readonly kit: RealWorkerKit
  readonly clock: ClockPort
  readonly registry: AudioResourceRegistry
}

const assemblies: Assembly[] = []
const realAssemblies: RealAssembly[] = []
const gates: RuntimeDeadlineGate[] = []
const apps: ProductionApplication[] = []
const dirs: string[] = []

afterEach(async () => {
  // A clean worker exit must be observable before an application stop awaits its
  // owned release; the app stop then drains its compositions over the registry.
  for (const assembly of assemblies) assembly.kit.transport.emitExit(0)
  // A real thread is terminated (and its actual exit awaited) before the app
  // stop awaits the owned release, so failed tests still clean up the thread.
  for (const assembly of realAssemblies) await assembly.kit.terminate()
  for (const app of apps.splice(0)) await app.stop().catch(() => {})
  for (const assembly of assemblies.splice(0)) {
    await assembly.retained.release().catch(() => {})
    assembly.registry.dispose()
  }
  for (const assembly of realAssemblies.splice(0)) {
    await assembly.retained.release().catch(() => {})
    assembly.registry.dispose()
  }
  for (const gate of gates.splice(0)) gate.dispose()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function until(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function trackGate(gate: RuntimeDeadlineGate): RuntimeDeadlineGate {
  gates.push(gate)
  return gate
}

/** One retained assembly over the real M1 adapter and a controlled worker. */
async function createAssembly(): Promise<Assembly> {
  const clock = createMonotonicClock()
  const registry = createAudioResourceRegistry({
    clock,
    byteBudget: 4_000_000,
    retentionMs: 60_000,
  })
  const kit = createControlledWorkerKit()
  const creating = createRetainedSynthesis({
    config: kokoroSdkTestConfig(),
    profiles: [defaultKokoroProfile()],
    registry,
    clock,
    createWorker: kit.createWorker,
  })
  await tick()
  kit.transport.emitReady()
  const retained = await creating
  const assembly: Assembly = { retained, kit, clock, registry }
  assemblies.push(assembly)
  return assembly
}

/**
 * One retained assembly over the real M1 adapter with a real Node worker thread
 * behind the `createWorker` seam. The thread is fully scripted: generations are
 * held until the test settles them and the thread exits only when asked.
 */
async function createRealWorkerAssembly(): Promise<RealAssembly> {
  const clock = createMonotonicClock()
  const registry = createAudioResourceRegistry({
    clock,
    byteBudget: 4_000_000,
    retentionMs: 60_000,
  })
  const kit = createRealWorkerKit()
  const creating = createRetainedSynthesis({
    config: kokoroSdkTestConfig(),
    profiles: [defaultKokoroProfile()],
    registry,
    clock,
    createWorker: kit.createWorker,
  })
  // The seam creates the thread synchronously; initialization completes when
  // the controlled worker reports ready.
  kit.emitReady()
  const retained = await creating
  const assembly: RealAssembly = { retained, kit, clock, registry }
  realAssemblies.push(assembly)
  return assembly
}

function requestFor(
  deadlineAtMs: number,
  overrides: Partial<PreparePerformance> = {},
): PreparePerformance {
  const profile = defaultKokoroProfile()
  return fixturePreparePerformance({
    voiceProfileId: profile.voiceProfileId,
    voiceProfileVersion: profile.voiceProfileVersion,
    deadline: { atMs: deadlineAtMs },
    ...overrides,
  })
}

function contextFor(deadlineAtMs: number): CallContext {
  return { signal: new AbortController().signal, deadline: { atMs: deadlineAtMs } }
}

function tempStorage(): StorageConfig {
  const dir = mkdtempSync(join(tmpdir(), 'isla-m5-physical-'))
  dirs.push(dir)
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(dir, 'isla.db') }, dir)
}

function selectionFor(liveSessionId: string) {
  const liveProfile = { profileId: 'character-fixture', profileVersion: '1' }
  return {
    liveSessionId,
    liveProfile,
    selectedSources: [],
    catalogue: new Map<string, { profileId: string; profileVersion: string }>(),
  }
}

async function resumeSession(
  coordinator: RuntimeCoordinator,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const ack = await coordinator.endpoint.control(
    {
      protocolVersion: '0.2',
      kind: 'control.resume',
      messageId: `msg-resume-${requestId}`,
      sessionId,
      epoch: coordinator.epoch(),
      payload: { requestId: `request-resume-${requestId}` },
    },
    fixtureOperatorContext(),
  )
  expect(ack.status).toBe('applied')
}

async function stopSession(
  coordinator: RuntimeCoordinator,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const ack = await coordinator.endpoint.control(
    {
      protocolVersion: '0.2',
      kind: 'control.stop',
      messageId: `msg-stop-${requestId}`,
      sessionId,
      epoch: coordinator.epoch(),
      payload: { requestId: `request-stop-${requestId}` },
    },
    fixtureOperatorContext(),
  )
  expect(ack.status).toBe('applied')
}

async function submitTurnInput(
  coordinator: RuntimeCoordinator,
  sessionId: string,
  text: string,
  requestId: string,
): Promise<void> {
  const ack = await coordinator.endpoint.submitInput(
    {
      protocolVersion: '0.2',
      kind: 'input.submit',
      messageId: `msg-input-${requestId}`,
      sessionId,
      epoch: coordinator.epoch(),
      payload: { source: 'local-audience', text },
    },
    fixtureViewerContext(),
  )
  expect(ack.status).toBe('accepted')
}

describe('retained physical synthesis ownership', () => {
  it('refuses a retired origin gate even after a successor factory call', async () => {
    const assembly = await createAssembly()
    const oldGate = trackGate(createDeadlineGate(assembly.clock))
    const nextGate = trackGate(createDeadlineGate(assembly.clock))
    const oldPort = assembly.retained.createSynthesis(oldGate)
    // Creating the successor facade must not re-point the existing one.
    assembly.retained.createSynthesis(nextGate)
    oldGate.dispose()
    const now = assembly.clock.nowMs()

    const prepared = await oldPort.prepare(
      requestFor(now + 5000),
      contextFor(now + 5000),
    )
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(assembly.kit.transport.generatePosts()).toHaveLength(0)
  })

  it('keeps a live origin working after a failed candidate successor gate', async () => {
    const assembly = await createAssembly()
    const validGate = trackGate(createDeadlineGate(assembly.clock))
    const candidateGate = trackGate(createDeadlineGate(assembly.clock))
    const validPort = assembly.retained.createSynthesis(validGate)
    // A successor build that failed disposes only its own gate.
    assembly.retained.createSynthesis(candidateGate)
    candidateGate.dispose()
    const now = assembly.clock.nowMs()

    const preparing = validPort.prepare(
      requestFor(now + 5000, { requestId: 'valid-origin' }),
      contextFor(now + 5000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 1)
    const job = assembly.kit.transport.generatePosts()[0]!
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: job.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.1, -0.1]),
    })
    expect(await preparing).toMatchObject({ ok: true, requestId: 'valid-origin' })
    expect(assembly.registry.snapshot().activeCount).toBe(1)
  })

  it('routes interleaved callers through their own gates while one generation is held', async () => {
    const assembly = await createAssembly()
    const gateA = trackGate(createDeadlineGate(assembly.clock))
    const gateB = trackGate(createDeadlineGate(assembly.clock))
    const portA = assembly.retained.createSynthesis(gateA)
    const portB = assembly.retained.createSynthesis(gateB)
    const now = assembly.clock.nowMs()

    const preparingA = portA.prepare(
      requestFor(now + 5000, { requestId: 'held-a' }),
      contextFor(now + 5000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 1)
    const heldJob = assembly.kit.transport.generatePosts()[0]!

    // B's own gate is live: the refusal is the retained adapter's physical
    // occupancy, not a cancellation routed from another composition.
    const refusedWhileHeld = await portB.prepare(
      requestFor(now + 5000, { requestId: 'busy-b' }),
      contextFor(now + 5000),
    )
    expect(refusedWhileHeld).toMatchObject({ ok: false, reasonCode: 'busy' })
    expect(assembly.kit.transport.generatePosts()).toHaveLength(1)

    // Disposing A's gate revokes only A's logical wait; the physical job stays
    // held and B is still refused by its own live origin.
    gateA.dispose()
    expect(await preparingA).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(assembly.kit.transport.generatePosts()).toHaveLength(1)
    const refusedAfterDisposal = await portB.prepare(
      requestFor(now + 5000, { requestId: 'busy-b-2' }),
      contextFor(now + 5000),
    )
    expect(refusedAfterDisposal).toMatchObject({ ok: false, reasonCode: 'busy' })

    // The original settlement frees the single slot and publishes nothing for
    // the cancelled request; B reuses the same retained adapter afterwards.
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: heldJob.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.2, -0.2]),
    })
    await tick()
    expect(assembly.registry.snapshot().activeCount).toBe(0)

    const preparingB = portB.prepare(
      requestFor(now + 5000, { requestId: 'reuse-b' }),
      contextFor(now + 5000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 2)
    const reuseJob = assembly.kit.transport.generatePosts()[1]!
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: reuseJob.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.3, -0.3]),
    })
    expect(await preparingB).toMatchObject({ ok: true, requestId: 'reuse-b' })
    expect(assembly.registry.snapshot().activeCount).toBe(1)
  })

  it('consumes a late rejection without blocking reuse', async () => {
    const assembly = await createAssembly()
    const gate = trackGate(createDeadlineGate(assembly.clock))
    const port = assembly.retained.createSynthesis(gate)
    const now = assembly.clock.nowMs()

    const preparing = port.prepare(
      requestFor(now + 5000, { requestId: 'late-reject' }),
      contextFor(now + 5000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 1)
    const job = assembly.kit.transport.generatePosts()[0]!
    gate.dispose()
    expect(await preparing).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })

    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: job.jobId,
      ok: false,
      error: 'controlled late failure',
    })
    await tick()
    expect(assembly.registry.snapshot().activeCount).toBe(0)

    const reusePort = assembly.retained.createSynthesis(
      trackGate(createDeadlineGate(assembly.clock)),
    )
    const reuse = reusePort.prepare(
      requestFor(now + 5000, { requestId: 'after-late-reject' }),
      contextFor(now + 5000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 2)
    const reuseJob = assembly.kit.transport.generatePosts()[1]!
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: reuseJob.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.4, -0.4]),
    })
    expect(await reuse).toMatchObject({ ok: true, requestId: 'after-late-reject' })
  })

  it('preserves the earliest of the request and context deadlines through the caller gate', async () => {
    const assembly = await createAssembly()
    const realGate = trackGate(createDeadlineGate(assembly.clock))
    const boundDeadlines: number[] = []
    const recordingGate: RuntimeDeadlineGate = {
      bind(context) {
        boundDeadlines.push(context.deadline.atMs)
        return realGate.bind(context)
      },
      dispose: () => realGate.dispose(),
    }
    const port = assembly.retained.createSynthesis(recordingGate)
    const now = assembly.clock.nowMs()

    const requestFirst = port.prepare(
      requestFor(now + 1000, { requestId: 'request-first' }),
      contextFor(now + 2000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 1)
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: assembly.kit.transport.generatePosts()[0]!.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.1]),
    })
    expect(await requestFirst).toMatchObject({ ok: true })
    expect(boundDeadlines).toEqual([now + 1000])

    const contextFirst = port.prepare(
      requestFor(now + 3000, { requestId: 'context-first' }),
      contextFor(now + 1500),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 2)
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: assembly.kit.transport.generatePosts()[1]!.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.1]),
    })
    expect(await contextFirst).toMatchObject({ ok: true })
    expect(boundDeadlines).toEqual([now + 1000, now + 1500])

    // Either expired deadline refuses before any physical generation.
    const expiredRequest = await port.prepare(
      requestFor(now - 1, { requestId: 'expired-request' }),
      contextFor(now + 5000),
    )
    expect(expiredRequest).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    const expiredContext = await port.prepare(
      requestFor(now + 5000, { requestId: 'expired-context' }),
      contextFor(now - 1),
    )
    expect(expiredContext).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(assembly.kit.transport.generatePosts()).toHaveLength(2)
    expect(boundDeadlines).toHaveLength(2)
  })
})

describe('retained physical synthesis release', () => {
  it('drains the held physical job and resolves only after the actual worker exit', async () => {
    const assembly = await createAssembly()
    const port = assembly.retained.createSynthesis(
      trackGate(createDeadlineGate(assembly.clock)),
    )
    const now = assembly.clock.nowMs()
    const preparing = port.prepare(
      requestFor(now + 5000, { requestId: 'drain-me' }),
      contextFor(now + 5000),
    )
    await until(() => assembly.kit.transport.generatePosts().length === 1)
    const job = assembly.kit.transport.generatePosts()[0]!

    const closing = assembly.retained.release()
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await tick()
    // The dispose request is not posted while the physical job is still held.
    expect(assembly.kit.transport.disposePosts()).toBe(0)
    expect(closed).toBe(false)

    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: job.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.5, -0.5]),
    })
    expect(await preparing).toMatchObject({ ok: true, requestId: 'drain-me' })
    await tick()
    // The job drained and the SDK dispose was posted once, but exit is not yet
    // observed.
    expect(assembly.kit.transport.disposePosts()).toBe(1)
    expect(closed).toBe(false)

    assembly.kit.transport.emitExit(0)
    await closing
    expect(closed).toBe(true)
  })

  it('is idempotent: one dispose and one observed exit for repeated releases', async () => {
    const assembly = await createAssembly()
    const first = assembly.retained.release()
    const second = assembly.retained.release()
    await tick()
    expect(assembly.kit.transport.disposePosts()).toBe(1)
    let closed = false
    void first.then(() => {
      closed = true
    })
    await tick()
    expect(closed).toBe(false)

    assembly.kit.transport.emitExit(0)
    await Promise.all([first, second])
    expect(closed).toBe(true)
    await assembly.retained.release()
    expect(assembly.kit.transport.disposePosts()).toBe(1)
    // A clean close never requests native termination.
    expect(assembly.kit.transport.terminateCount()).toBe(0)
  })

  it('releases the acquired provider when the adapter configuration is invalid', async () => {
    const clock = createMonotonicClock()
    const registry = createAudioResourceRegistry({
      clock,
      byteBudget: 1_000_000,
      retentionMs: 60_000,
    })
    const kit = createControlledWorkerKit()
    const creating = createRetainedSynthesis({
      config: kokoroSdkTestConfig(),
      profiles: [defaultKokoroProfile(), defaultKokoroProfile()],
      registry,
      clock,
      createWorker: kit.createWorker,
    })
    await tick()
    kit.transport.emitReady()
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
    const failure = creating.then(
      () => {
        outcome = 'resolved'
        return null
      },
      (error: unknown) => {
        outcome = 'rejected'
        return error
      },
    )
    await tick()
    // The acquired provider is disposed and its actual exit awaited before the
    // construction failure is reported.
    expect(kit.transport.disposePosts()).toBe(1)
    expect(outcome).toBe('pending')
    kit.transport.emitExit(0)
    expect(String(await failure)).toContain('duplicate voice profile tuple')
    expect(outcome).toBe('rejected')
    registry.dispose()
  })
})

describe('production application owned release', () => {
  it('awaits the owned release on stop before startup and calls it once', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    let releaseCalls = 0
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock,
      ownedRelease: async () => {
        releaseCalls += 1
      },
    })
    apps.push(app)
    expect(app.state()).toBe('created')

    await app.stop()
    expect(releaseCalls).toBe(1)
    await app.stop()
    expect(releaseCalls).toBe(1)
    expect(app.state()).toBe('stopped')
  })

  it('keeps an unsuccessful owned release observable to every later stop caller', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    const releaseError = new Error('controlled physical release failure')
    let releaseCalls = 0
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock,
      ownedRelease: async () => {
        releaseCalls += 1
        throw releaseError
      },
    })
    apps.push(app)

    const first = await app.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(first).toBeInstanceOf(Error)
    expect((first as Error).message).toContain(
      'production application shutdown: owned release failed',
    )
    expect((first as Error).message).toContain('controlled physical release failure')
    expect((first as Error).cause).toBe(releaseError)
    expect(releaseCalls).toBe(1)

    const second = await app.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(second).toBe(first)
    expect(releaseCalls).toBe(1)
    expect(app.state()).toBe('stopped')

    // Concurrent callers observe the same incomplete close.
    const concurrent = await Promise.all([
      app.stop().then(
        () => null,
        (error: unknown) => error,
      ),
      app.stop().then(
        () => null,
        (error: unknown) => error,
      ),
    ])
    expect(concurrent[0]).toBe(first)
    expect(concurrent[1]).toBe(first)
  })

  it('preserves every failed shutdown phase while completing cleanup once', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    let releaseCalls = 0
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock,
      ownedRelease: async () => {
        releaseCalls += 1
        throw new Error('controlled physical release failure')
      },
    })
    apps.push(app)

    // The transport phase fails after its real disposal work, and the physical
    // release fails too: both failures must survive in the reported error.
    const dispose = app.endpoint.dispose.bind(app.endpoint)
    let disposed = false
    app.endpoint.dispose = () => {
      dispose()
      disposed = true
      throw new Error('controlled endpoint disposal failure')
    }

    const failure = await app.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(disposed).toBe(true)
    expect(releaseCalls).toBe(1)
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors).toHaveLength(2)
    expect(String(errors[0])).toContain('transport shutdown failed')
    expect(String(errors[0])).toContain('controlled endpoint disposal failure')
    expect(String(errors[1])).toContain('owned release failed')
    expect(String(errors[1])).toContain('controlled physical release failure')
    expect(String(failure)).toContain('controlled endpoint disposal failure')
    expect(String(failure)).toContain('controlled physical release failure')
    expect((failure as Error).cause).toBe(errors[0])
    expect(app.state()).toBe('stopped')

    // Repeated and concurrent callers observe the same aggregate, and cleanup
    // still ran exactly once.
    const repeated = await app.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(repeated).toBe(failure)
    const concurrent = await Promise.all([
      app.stop().then(
        () => null,
        (error: unknown) => error,
      ),
      app.stop().then(
        () => null,
        (error: unknown) => error,
      ),
    ])
    expect(concurrent[0]).toBe(failure)
    expect(concurrent[1]).toBe(failure)
    expect(releaseCalls).toBe(1)
  })

  it('reports both the original creation failure and the owned release failure', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    let releaseCalls = 0
    const failure = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [],
      clock,
      ownedRelease: async () => {
        releaseCalls += 1
        throw new Error('controlled startup release failure')
      },
    }).catch((error: unknown) => error)

    expect(releaseCalls).toBe(1)
    expect(String(failure)).toContain('at least one allowed origin')
    expect(String(failure)).toContain('controlled startup release failure')
    expect((failure as Error).cause).toBeInstanceOf(TypeError)
  })

  it('preserves the original creation failure when the owned release succeeds', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    let releaseCalls = 0
    const failure = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      allowedHosts: ['not a valid host'],
      clock,
      ownedRelease: async () => {
        releaseCalls += 1
      },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RangeError)
    expect(releaseCalls).toBe(1)
  })

  it('awaits the owned release after the durable shutdown boundary has closed', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    let releaseCalls = 0
    let writeRejectedAtRelease: boolean | null = null
    let created: ProductionApplication | null = null
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock,
      ownedRelease: async () => {
        releaseCalls += 1
        writeRejectedAtRelease = await created!.store
          .append(
            fixtureRuntimeEvent({
              eventId: 'event-during-release',
              seq: 1,
              sessionId: LIVE_1,
            }),
          )
          .then(
            () => false,
            () => true,
          )
      },
    })
    created = app
    apps.push(app)

    await app.stop()
    expect(releaseCalls).toBe(1)
    // The shared handle was already closed when the owned release ran.
    expect(writeRejectedAtRelease).toBe(true)
    expect(app.state()).toBe('stopped')
  })
})

describe('production application retained synthesis integration', () => {
  it('refuses a recovery successor while the cancelled generation is held, then reuses the adapter after settlement', async () => {
    const assembly = await createAssembly()
    const storage = tempStorage()
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({
        clock: assembly.clock,
        textSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
        createSynthesis: (gate) => assembly.retained.createSynthesis(gate),
        audioResources: assembly.registry,
      }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock: assembly.clock,
      ownedRelease: assembly.retained.release,
      recovery: { nextSessionId: () => SUCCESSOR },
    })
    apps.push(app)

    const coordinator = app.currentComposition().coordinator
    expect(app.currentSessionId()).toBe(LIVE_1)
    await resumeSession(coordinator, LIVE_1, '1')
    await submitTurnInput(coordinator, LIVE_1, 'a turn whose generation is held', '1')
    const firstTurn = coordinator.runTurn()
    await until(() => assembly.kit.transport.generatePosts().length === 1)
    const heldJob = assembly.kit.transport.generatePosts()[0]!

    // Stop while the generation is physically active: the logical wait is
    // revoked, but the single physical job stays held.
    await stopSession(coordinator, LIVE_1, '1')
    expect((await firstTurn).status).toBe('cancelled')
    expect(assembly.kit.transport.generatePosts()).toHaveLength(1)
    expect(assembly.registry.snapshot().activeCount).toBe(0)

    // Recovery builds a successor over the same retained adapter.
    const recovered = await app.recovery.recover(LIVE_1)
    expect(recovered.status).toBe('applied')
    expect(app.currentSessionId()).toBe(SUCCESSOR)
    const successor = app.currentComposition().coordinator
    expect(successor).not.toBe(coordinator)

    await resumeSession(successor, SUCCESSOR, '2')
    await submitTurnInput(successor, SUCCESSOR, 'a successor turn while the old job is held', '2')
    const successorTurn = successor.runTurn()
    expect((await successorTurn).status).toBe('cancelled')
    // No replacement generation while the first is physically held: the
    // successor observed the retained adapter's own busy refusal.
    expect(assembly.kit.transport.generatePosts()).toHaveLength(1)
    const evidence = await app.store.readSession(SUCCESSOR)
    expect(
      evidence.filter(
        (event) =>
          event.type === 'dependency.failed' &&
          (event.payload as { reason?: string }).reason === 'busy',
      ),
    ).toHaveLength(1)

    // The original settlement frees the single slot and publishes nothing.
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: heldJob.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.1, -0.1]),
    })
    await tick()
    expect(assembly.registry.snapshot().activeCount).toBe(0)

    // The successor reuses the retained adapter: one new generation publishes
    // one admitted resource for the successor session.
    await submitTurnInput(successor, SUCCESSOR, 'a successor turn after the settlement', '3')
    const reuseTurn = successor.runTurn()
    await until(() => assembly.kit.transport.generatePosts().length === 2)
    const reuseJob = assembly.kit.transport.generatePosts()[1]!
    assembly.kit.transport.emitResult({
      kind: 'result',
      jobId: reuseJob.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.25, -0.25]),
    })
    expect((await reuseTurn).status).toBe('cancelled')

    const snapshot = assembly.registry.snapshot()
    expect(snapshot.activeCount).toBe(1)
    const published = snapshot.resources[0]!
    expect(published.sessionId).toBe(SUCCESSOR)
    expect(published.retired).toBe(false)
    expect(assembly.registry.admission(published.audioRef, SUCCESSOR, successor.epoch())).toBeNull()
  })
})

describe('production application retained synthesis over a real worker thread', () => {
  it('holds a generation, stops, refuses the busy successor, reuses after settlement and closes pending on the actual thread exit', async () => {
    const assembly = await createRealWorkerAssembly()
    const storage = tempStorage()
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({
        clock: assembly.clock,
        textSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
        createSynthesis: (gate) => assembly.retained.createSynthesis(gate),
        audioResources: assembly.registry,
      }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock: assembly.clock,
      ownedRelease: assembly.retained.release,
      recovery: { nextSessionId: () => SUCCESSOR },
    })
    apps.push(app)

    const coordinator = app.currentComposition().coordinator
    await resumeSession(coordinator, LIVE_1, '1')
    await submitTurnInput(coordinator, LIVE_1, 'a turn held by the real thread', '1')
    const firstTurn = coordinator.runTurn()
    await until(() => assembly.kit.generatePosts().length === 1)
    const heldJob = assembly.kit.generatePosts()[0]!

    // Stop while the generation is physically active on the thread: the logical
    // wait is revoked, but the real job stays held.
    await stopSession(coordinator, LIVE_1, '1')
    expect((await firstTurn).status).toBe('cancelled')
    expect(assembly.kit.generatePosts()).toHaveLength(1)
    expect(assembly.registry.snapshot().activeCount).toBe(0)

    // Recovery builds a successor over the same retained adapter: the refusal is
    // the retained adapter's physical occupancy of the real thread.
    const recovered = await app.recovery.recover(LIVE_1)
    expect(recovered.status).toBe('applied')
    const successor = app.currentComposition().coordinator
    await resumeSession(successor, SUCCESSOR, '2')
    await submitTurnInput(successor, SUCCESSOR, 'a successor turn while the thread holds the old job', '2')
    expect((await successor.runTurn()).status).toBe('cancelled')
    expect(assembly.kit.generatePosts()).toHaveLength(1)
    const evidence = await app.store.readSession(SUCCESSOR)
    expect(
      evidence.filter(
        (event) =>
          event.type === 'dependency.failed' &&
          (event.payload as { reason?: string }).reason === 'busy',
      ),
    ).toHaveLength(1)

    // The real thread settles the held generation: the slot frees and nothing is
    // published for the cancelled request.
    assembly.kit.complete(heldJob.jobId, { samples: new Float32Array([0.1, -0.1]) })
    await until(() => assembly.kit.results().length === 1)
    await tick()
    expect(assembly.registry.snapshot().activeCount).toBe(0)

    // The successor reuses the retained adapter: one new real-thread generation
    // publishes one admitted resource.
    await submitTurnInput(successor, SUCCESSOR, 'a successor turn after the real settlement', '3')
    const reuseTurn = successor.runTurn()
    await until(() => assembly.kit.generatePosts().length === 2)
    const reuseJob = assembly.kit.generatePosts()[1]!
    assembly.kit.complete(reuseJob.jobId, { samples: new Float32Array([0.25, -0.25]) })
    expect((await reuseTurn).status).toBe('cancelled')
    const snapshot = assembly.registry.snapshot()
    expect(snapshot.activeCount).toBe(1)
    const published = snapshot.resources[0]!
    expect(published.sessionId).toBe(SUCCESSOR)
    expect(assembly.registry.admission(published.audioRef, SUCCESSOR, successor.epoch())).toBeNull()

    // The app-owned close requests disposal and stays pending until the actual
    // thread exit is observed.
    const stopping = app.stop()
    let stopped = false
    void stopping.then(
      () => {
        stopped = true
      },
      () => {
        stopped = true
      },
    )
    await until(() => assembly.kit.disposePosts() === 1)
    expect(assembly.kit.exited()).toBe(false)
    await tick()
    expect(stopped).toBe(false)

    assembly.kit.requestExit()
    await stopping
    expect(stopped).toBe(true)
    expect(assembly.kit.exited()).toBe(true)
    expect(assembly.kit.generatePosts()).toHaveLength(2)
  })
})
