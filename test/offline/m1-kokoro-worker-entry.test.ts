/**
 * M1-02 worker entry lifecycle regressions.
 *
 * These tests import the **actual** TypeScript worker entry
 * (`src/performance/kokoro-worker.ts`) with `vi.doMock`, a controlled provider
 * factory and a fake `model.dispose`, and a real Node `MessageChannel` as the
 * `parentPort`. They exercise the entry's real admission, disposal, transfer and
 * narrow transport-fault paths; they are not a real-model or real-worker-thread
 * proof. The real bootstrap, a genuine subprocess and real CPU timing remain the
 * explicit live entrypoints' job. No SDK is imported and no model is downloaded.
 */
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KokoroProviderConfig } from '../../src/performance/kokoro-provider'
import type { KokoroRawAudio } from '../../src/performance/kokoro-types'

const TRANSPORT_FAULT_PREFIX = 'm1 entry test transport fault'

function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

function transportFault(stage: string): Error {
  return new Error(`${TRANSPORT_FAULT_PREFIX}: ${stage}`)
}

const TEST_CONFIG: KokoroProviderConfig = {
  modelRoot: 'entry-test-model',
  revision: 'entry-test-revision',
  maxTokens: 512,
  voiceId: 'af_heart',
  speed: 1,
  environment: { localModelPath: 'entry-test-local', cacheDir: 'entry-test-cache' },
}

interface CapturedPost {
  readonly message: unknown
  readonly transfer?: readonly ArrayBuffer[]
}

interface PostAttempt {
  readonly jobId: number | null
  readonly ok: boolean | null
  readonly delivered: boolean
}

interface Harness {
  send(message: unknown): void
  next(): Promise<unknown>
  releaseInit(): void
  initStarted(): boolean
  initModelLoaded(): boolean
  rejectInitialization(error: unknown): void
  disposeCalls(): number
  exitCalls(): readonly number[]
  generateCalls(): number
  failResultPosts(jobId: number, mode: 'success' | 'all'): void
  postAttempts(): readonly PostAttempt[]
  providerOwnedSamples(): Float32Array | null
  resolveGeneration(audio: KokoroRawAudio): void
  rejectGeneration(error: unknown): void
  capturedPosts(): readonly CapturedPost[]
  sdkSamples(): Float32Array
  until(predicate: () => boolean): Promise<void>
  awaitExit(): Promise<void>
  settle(): Promise<void>
}

describe('M1-02 worker entry lifecycle (B02, actual entry)', () => {
  let activeHarness: Harness | null = null

  afterEach(async () => {
    try {
      if (activeHarness !== null) {
        const harness = activeHarness
        activeHarness = null
        await harness.settle()
      }
    } finally {
      delete (globalThis as { __islaKokoroWorker?: unknown }).__islaKokoroWorker
      vi.doUnmock('node:worker_threads')
      vi.doUnmock('../../src/performance/kokoro-provider')
      vi.restoreAllMocks()
      vi.resetModules()
    }
  })

  async function startEntry(): Promise<Harness> {
    vi.resetModules()
    const { port1: workerPort, port2: testPort } = new MessageChannel()

    const sdkSamples = new Float32Array([0.25, -0.5, 0.75, 0])
    const state = {
      modelDisposeCalls: 0,
      providerGenerateCalls: 0,
      initStarted: false,
      modelLoaded: false,
      rejectInit: null as { error: unknown } | null,
      resolveInitGate: null as (() => void) | null,
      pending: null as {
        resolve(audio: KokoroRawAudio): void
        reject(error: unknown): void
      } | null,
      providerOwnedSamples: null as Float32Array | null,
      resultPostFailure: null as { jobId: number; mode: 'success' | 'all' } | null,
      exitCodes: [] as number[],
    }
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const initGate = new Promise<void>((resolve) => {
      state.resolveInitGate = resolve
    })

    const model = {
      dispose: async (): Promise<void> => {
        state.modelDisposeCalls += 1
      },
    }
    const realLoader: Record<string, unknown> = {
      configureEnvironment: () => {},
      loadTokenizer: () => Promise.resolve({}),
      loadModel: () => Promise.resolve(model),
      createTts: () => ({
        generate: () => Promise.resolve({ audio: new Float32Array([0]), sampling_rate: 24000 }),
      }),
      ensureVoice: () => {},
    }
    // The controlled provider factory exercises the entry's real
    // `createDisposingLoader` by loading through the supplied loader wrapper.
    // Its `generate` mirrors the real provider's ownership boundary through the
    // actual `toKokoroRawAudio`, so the worker receives a dedicated copy rather
    // than the SDK's own sample buffer.
    const createProvider = async (
      config: unknown,
      loader: { loadModel(config: unknown): Promise<unknown> },
      toRawAudio: (raw: unknown) => KokoroRawAudio,
    ): Promise<unknown> => {
      state.initStarted = true
      await loader.loadModel(config)
      state.modelLoaded = true
      await initGate
      // A deliberate rejection only takes effect once the model was loaded, so
      // the failure path still exercises the loaded-model disposal.
      if (state.rejectInit !== null) throw state.rejectInit.error
      return {
        async generate(): Promise<KokoroRawAudio> {
          state.providerGenerateCalls += 1
          const raw = await new Promise<KokoroRawAudio>((resolve, reject) => {
            state.pending = { resolve, reject }
          })
          const owned = toRawAudio({
            audio: raw.samples,
            sampling_rate: raw.sampleRate,
          })
          state.providerOwnedSamples = owned.samples
          return owned
        },
      }
    }

    const posts: CapturedPost[] = []
    const attempts: PostAttempt[] = []
    const originalPostMessage = workerPort.postMessage.bind(workerPort) as (
      message: unknown,
      transferList?: readonly ArrayBuffer[],
    ) => void
    workerPort.postMessage = ((message: unknown, transferList?: readonly ArrayBuffer[]) => {
      const record = (
        message !== null && typeof message === 'object' ? message : {}
      ) as { kind?: unknown; jobId?: unknown; ok?: unknown }
      const isResult = record.kind === 'result'
      const jobId = typeof record.jobId === 'number' ? record.jobId : null
      const ok = isResult && typeof record.ok === 'boolean' ? record.ok : null
      const fault = state.resultPostFailure
      const fails =
        isResult &&
        fault !== null &&
        jobId === fault.jobId &&
        (fault.mode === 'all' || ok === true)
      attempts.push({ jobId, ok, delivered: !fails })
      if (fails) {
        throw transportFault(ok === true ? 'success result' : 'failure result')
      }
      posts.push(transferList === undefined ? { message } : { message, transfer: transferList })
      originalPostMessage(message, transferList)
    }) as unknown as typeof workerPort.postMessage

    const queue: unknown[] = []
    const waiters: Array<(value: unknown) => void> = []
    testPort.on('message', (message) => {
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(message)
      else queue.push(message)
    })

    vi.doMock('node:worker_threads', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:worker_threads')>()
      return {
        ...actual,
        isMainThread: false,
        parentPort: workerPort,
        workerData: TEST_CONFIG,
      }
    })
    vi.doMock('../../src/performance/kokoro-provider', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/performance/kokoro-provider')>()
      return {
        ...actual,
        createRealKokoroSdkLoader: () => realLoader,
        createKokoroProvider: (config: unknown, loader: { loadModel(config: unknown): Promise<unknown> }) =>
          createProvider(config, loader, actual.toKokoroRawAudio),
      }
    })

    ;(globalThis as { __islaKokoroWorker?: unknown }).__islaKokoroWorker = true
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      state.exitCodes.push(typeof code === 'number' ? code : 0)
      resolveExited()
      return undefined as never
    })

    await import('../../src/performance/kokoro-worker')

    const next = (): Promise<unknown> => {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise<unknown>((resolve) => {
        waiters.push(resolve)
      })
    }

    const until = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (predicate()) return
        await tick()
      }
      throw new Error('m1-kokoro-worker-entry: condition was not met')
    }

    let cleanupPromise: Promise<void> | null = null
    let portsClosed = false
    const closePorts = (): void => {
      if (portsClosed) return
      portsClosed = true
      workerPort.close()
      testPort.close()
    }
    // Sequence teardown without racing a timeout against exit: release and
    // observe held initialization, keep driving native queued messages and
    // admission until they become observable, close admission and drain every
    // controlled pending generation on each pass, then await the actual
    // controlled exit. Idempotent across repeated calls. The bounded drive is
    // only a safety limit; exhausting it is an explicit failure, never a silent
    // success, and the fixture ports still close in `finally`.
    const settle = (): Promise<void> => {
      if (cleanupPromise !== null) return cleanupPromise
      cleanupPromise = (async (): Promise<void> => {
        try {
          state.resolveInitGate?.()
          for (let attempt = 0; state.exitCodes.length === 0 && attempt < 500; attempt += 1) {
            await tick()
            try {
              testPort.postMessage({ kind: 'dispose' })
            } catch {
              // The port may already be closed; the drain below still runs.
            }
            if (state.pending !== null) {
              const pending = state.pending
              state.pending = null
              pending.resolve({ samples: sdkSamples, sampleRate: 24000 })
            }
          }
          if (state.exitCodes.length === 0) {
            throw new Error('m1-kokoro-worker-entry: cleanup did not observe worker exit')
          }
          await exited
        } finally {
          closePorts()
        }
      })()
      return cleanupPromise
    }

    const harness: Harness = {
      send: (message) => {
        testPort.postMessage(message)
      },
      next,
      releaseInit: () => {
        state.resolveInitGate?.()
      },
      initStarted: () => state.initStarted,
      initModelLoaded: () => state.modelLoaded,
      rejectInitialization: (error) => {
        state.rejectInit = { error }
        state.resolveInitGate?.()
      },
      disposeCalls: () => state.modelDisposeCalls,
      exitCalls: () => state.exitCodes.slice(),
      generateCalls: () => state.providerGenerateCalls,
      failResultPosts: (jobId, mode) => {
        state.resultPostFailure = { jobId, mode }
      },
      postAttempts: () => attempts.slice(),
      providerOwnedSamples: () => state.providerOwnedSamples,
      resolveGeneration: (audio) => {
        const pending = state.pending
        state.pending = null
        pending?.resolve(audio)
      },
      rejectGeneration: (error) => {
        const pending = state.pending
        state.pending = null
        pending?.reject(error)
      },
      capturedPosts: () => posts.slice(),
      sdkSamples: () => sdkSamples,
      until,
      awaitExit: () => exited,
      settle,
    }
    activeHarness = harness
    return harness
  }

  it('closes admission immediately on dispose and defers disposal and exit until the pending generation settles', async () => {
    const harness = await startEntry()
    harness.releaseInit()
    expect(await harness.next()).toMatchObject({ kind: 'ready' })

    harness.send({ kind: 'generate', jobId: 1, input: { text: 'a', voiceId: 'af_heart', speed: 1 } })
    await harness.until(() => harness.generateCalls() === 1)

    // The generation is physically in flight when dispose arrives.
    harness.send({ kind: 'dispose' })
    await tick()
    expect(harness.disposeCalls()).toBe(0)
    expect(harness.exitCalls()).toEqual([])

    // New-generation admission is refused without a second provider call.
    harness.send({ kind: 'generate', jobId: 2, input: { text: 'b', voiceId: 'af_heart', speed: 1 } })
    expect(await harness.next()).toMatchObject({
      kind: 'result',
      jobId: 2,
      ok: false,
      error: 'worker is not accepting generation',
    })
    expect(harness.generateCalls()).toBe(1)

    // The admitted generation still finishes its single result path, and only
    // then does disposal and exit happen exactly once.
    harness.resolveGeneration({ samples: new Float32Array([1, 2, 3]), sampleRate: 24000 })
    expect(await harness.next()).toMatchObject({
      kind: 'result',
      jobId: 1,
      ok: true,
      sampleRate: 24000,
    })
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([0])
  })

  it('disposes and exits once when the deferred pending generation rejects', async () => {
    const harness = await startEntry()
    harness.releaseInit()
    expect(await harness.next()).toMatchObject({ kind: 'ready' })

    harness.send({ kind: 'generate', jobId: 1, input: { text: 'a', voiceId: 'af_heart', speed: 1 } })
    await harness.until(() => harness.generateCalls() === 1)

    harness.send({ kind: 'dispose' })
    await tick()
    expect(harness.disposeCalls()).toBe(0)
    expect(harness.exitCalls()).toEqual([])

    harness.rejectGeneration(new Error('physical failure'))
    expect(await harness.next()).toMatchObject({
      kind: 'result',
      jobId: 1,
      ok: false,
      error: 'physical failure',
    })
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([0])
  })

  it('closes admission when dispose arrives during initialization and disposes/exits once for repeated dispose', async () => {
    const harness = await startEntry()
    await harness.until(() => harness.initStarted())

    harness.send({ kind: 'dispose' })
    harness.send({ kind: 'dispose' })
    await tick()
    // Initialization has not settled, so nothing is disposed or exited yet.
    expect(harness.disposeCalls()).toBe(0)
    expect(harness.exitCalls()).toEqual([])

    harness.releaseInit()
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([0])
  })

  it('drains a generation queued during initialization and observes the actual exit before closing', async () => {
    const harness = await startEntry()
    await harness.until(() => harness.initStarted())

    // Queue a generation before initialization is released, then clean up.
    harness.send({ kind: 'generate', jobId: 1, input: { text: 'queued', voiceId: 'af_heart', speed: 1 } })
    await harness.settle()
    const exitObservedByCleanup = harness.exitCalls()

    // Red-safety: if cleanup raced its timeout, settle the late physical job and
    // await the real controlled exit before asserting, so a late process.exit
    // after spy restoration can never kill the runner.
    harness.resolveGeneration({ samples: harness.sdkSamples(), sampleRate: 24000 })
    await harness.awaitExit()

    // Cleanup must have observed the controlled exit, not merely a timeout or
    // port closure, and must have drained the queued generation exactly once.
    expect(exitObservedByCleanup).toEqual([0])
    expect(harness.generateCalls()).toBe(1)
    expect(harness.disposeCalls()).toBe(1)
  })

  it('transfers only the owned sample copy and leaves the SDK buffer intact', async () => {
    const harness = await startEntry()
    harness.releaseInit()
    expect(await harness.next()).toMatchObject({ kind: 'ready' })

    const sdkSamples = harness.sdkSamples()
    harness.send({ kind: 'generate', jobId: 7, input: { text: 'hi', voiceId: 'af_heart', speed: 1 } })
    await harness.until(() => harness.generateCalls() === 1)
    harness.resolveGeneration({ samples: sdkSamples, sampleRate: 24000 })

    const received = (await harness.next()) as {
      kind: string
      jobId: number
      ok: boolean
      sampleRate: number
      samples: Float32Array
    }
    expect(received).toMatchObject({ kind: 'result', jobId: 7, ok: true, sampleRate: 24000 })
    expect(received.samples).toBeInstanceOf(Float32Array)
    expect(Array.from(received.samples)).toEqual([0.25, -0.5, 0.75, 0])

    // Only the successful result carries a transfer; control messages do not.
    const transferred = harness.capturedPosts().filter((post) => post.transfer !== undefined)
    expect(transferred).toHaveLength(1)
    const transfer = transferred[0]!.transfer!
    expect(transfer).toHaveLength(1)
    // The real provider already returned its own copy through
    // `toKokoroRawAudio`; the worker must transfer that buffer directly rather
    // than making a second copy of it.
    const providerOwned = harness.providerOwnedSamples()
    expect(providerOwned).not.toBeNull()
    expect(providerOwned).not.toBe(sdkSamples)
    expect(providerOwned!.byteLength).toBe(0)
    expect(providerOwned!.buffer).toBe(transfer[0])
    // The dedicated owned copy's buffer is detached in the sender.
    const ownedMessage = transferred[0]!.message as { samples: Float32Array }
    expect(ownedMessage.samples.buffer).toBe(transfer[0])
    expect(transfer[0]!.byteLength).toBe(0)
    expect(ownedMessage.samples.byteLength).toBe(0)
    // The SDK-owned original buffer and view are untouched.
    expect(sdkSamples.buffer).not.toBe(transfer[0])
    expect(sdkSamples.byteLength).toBe(sdkSamples.length * 4)
    expect(Array.from(sdkSamples)).toEqual([0.25, -0.5, 0.75, 0])

    harness.send({ kind: 'dispose' })
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
  })

  it('publishes one correlated failure when the success result cannot be posted', async () => {
    const harness = await startEntry()
    harness.releaseInit()
    expect(await harness.next()).toMatchObject({ kind: 'ready' })

    harness.send({
      kind: 'generate',
      jobId: 9,
      input: { text: 'broken success', voiceId: 'af_heart', speed: 1 },
    })
    await harness.until(() => harness.generateCalls() === 1)
    harness.failResultPosts(9, 'success')
    harness.resolveGeneration({ samples: harness.sdkSamples(), sampleRate: 24000 })

    // The unpostable success is replaced by exactly one correlated failure.
    expect(await harness.next()).toMatchObject({
      kind: 'result',
      jobId: 9,
      ok: false,
      error: `${TRANSPORT_FAULT_PREFIX}: success result`,
    })
    const results = harness.capturedPosts().filter((post) => {
      const message = post.message as { kind?: unknown }
      return message.kind === 'result'
    })
    expect(results).toHaveLength(1)
    expect(results[0]!.message).toMatchObject({
      kind: 'result',
      jobId: 9,
      ok: false,
      error: `${TRANSPORT_FAULT_PREFIX}: success result`,
    })
    expect(results[0]!.transfer).toBeUndefined()

    // The recoverable transport fault is a result, not a shutdown.
    await tick()
    expect(harness.disposeCalls()).toBe(0)
    expect(harness.exitCalls()).toEqual([])

    // The recoverable transport fault does not block a normal dispose.
    harness.send({ kind: 'dispose' })
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([0])
  })

  it('exits once with failure when neither result can be posted while dispose is pending', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const harness = await startEntry()
      harness.releaseInit()
      expect(await harness.next()).toMatchObject({ kind: 'ready' })

      const originalJobId = 11
      harness.send({
        kind: 'generate',
        jobId: originalJobId,
        input: { text: 'lost result', voiceId: 'af_heart', speed: 1 },
      })
      await harness.until(() => harness.generateCalls() === 1)

      // Break only the original job's result path after the drain has started:
      // dispose closes admission, and the native channel proves it by refusing
      // the second job while the original generation is still held.
      harness.failResultPosts(originalJobId, 'all')
      harness.send({ kind: 'dispose' })
      harness.send({
        kind: 'generate',
        jobId: 12,
        input: { text: 'refused', voiceId: 'af_heart', speed: 1 },
      })
      expect(await harness.next()).toMatchObject({
        kind: 'result',
        jobId: 12,
        ok: false,
        error: 'worker is not accepting generation',
      })
      expect(harness.disposeCalls()).toBe(0)
      expect(harness.exitCalls()).toEqual([])

      // Both the success and correlated failure sends for the original job now
      // fail. The entry must lock the transport fault before releasing the
      // drain wait, dispose once, and exit once with failure.
      harness.resolveGeneration({ samples: harness.sdkSamples(), sampleRate: 24000 })
      await harness.awaitExit()
      await tick()

      // No production rejection may escape the double-failure path.
      expect(unhandled).toEqual([])
      expect(harness.disposeCalls()).toBe(1)
      expect(harness.exitCalls()).toEqual([1])
      const originalAttempts = harness
        .postAttempts()
        .filter((attempt) => attempt.jobId === originalJobId)
      expect(originalAttempts).toEqual([
        { jobId: originalJobId, ok: true, delivered: false },
        { jobId: originalJobId, ok: false, delivered: false },
      ])
      const deliveredOriginalResults = harness.capturedPosts().filter((post) => {
        const message = post.message as { kind?: unknown; jobId?: unknown }
        return message.kind === 'result' && message.jobId === originalJobId
      })
      expect(deliveredOriginalResults).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('refuses a second generation while the first is physically pending without a second provider call or overlap', async () => {
    const harness = await startEntry()
    harness.releaseInit()
    expect(await harness.next()).toMatchObject({ kind: 'ready' })

    harness.send({
      kind: 'generate',
      jobId: 1,
      input: { text: 'first', voiceId: 'af_heart', speed: 1 },
    })
    await harness.until(() => harness.generateCalls() === 1)

    // The second generation arrives before any dispose while the first is still
    // physically pending.
    harness.send({
      kind: 'generate',
      jobId: 2,
      input: { text: 'second', voiceId: 'af_heart', speed: 1 },
    })
    expect(await harness.next()).toMatchObject({
      kind: 'result',
      jobId: 2,
      ok: false,
      error: 'worker busy',
    })
    // Exactly one refusal for job 2, no second provider call and no overlap: the
    // first generation is still the only physical job in flight.
    expect(harness.generateCalls()).toBe(1)
    const job2Results = harness.capturedPosts().filter((post) => {
      const message = post.message as { kind?: unknown; jobId?: unknown }
      return message.kind === 'result' && message.jobId === 2
    })
    expect(job2Results).toHaveLength(1)

    // The admitted first generation keeps its original correlated success.
    harness.resolveGeneration({ samples: new Float32Array([1, 2, 3]), sampleRate: 24000 })
    expect(await harness.next()).toMatchObject({
      kind: 'result',
      jobId: 1,
      ok: true,
      sampleRate: 24000,
    })
    expect(harness.generateCalls()).toBe(1)

    harness.send({ kind: 'dispose' })
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([0])
    // After the final controlled exit the refusal count is still exactly one: no
    // second job2 result was emitted by any late path.
    const job2ResultsAfterExit = harness.capturedPosts().filter((post) => {
      const message = post.message as { kind?: unknown; jobId?: unknown }
      return message.kind === 'result' && message.jobId === 2
    })
    expect(job2ResultsAfterExit).toHaveLength(1)
  })

  it('reports the original job with the provider failure code and stays available for a safe dispose', async () => {
    const harness = await startEntry()
    // startEntry resets the module registry and imports the actual entry; import
    // the real error class only now so `instanceof` matches the worker's class
    // identity instead of a second copy of the module.
    const { KokoroProviderError } = await import('../../src/performance/kokoro-types')
    harness.releaseInit()
    expect(await harness.next()).toMatchObject({ kind: 'ready' })

    harness.send({
      kind: 'generate',
      jobId: 5,
      input: { text: 'too long', voiceId: 'af_heart', speed: 1 },
    })
    await harness.until(() => harness.generateCalls() === 1)

    harness.rejectGeneration(new KokoroProviderError('input_too_long'))
    const result = await harness.next()
    expect(result).toMatchObject({
      kind: 'result',
      jobId: 5,
      ok: false,
      code: 'input_too_long',
    })
    // A declared provider failure carries only the code, never a generic error.
    expect(result).not.toHaveProperty('error')

    // The coded refusal is a result, not a shutdown: no premature disposal/exit.
    await tick()
    expect(harness.disposeCalls()).toBe(0)
    expect(harness.exitCalls()).toEqual([])

    harness.send({ kind: 'dispose' })
    await harness.awaitExit()
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([0])
  })

  it('reports one init_error, no ready, zero generations and one loaded-model dispose when initialization rejects', async () => {
    const harness = await startEntry()
    // Reject initialization only after the factory's model has been loaded, so
    // the failure path still disposes that loaded model exactly once.
    await harness.until(() => harness.initModelLoaded())
    harness.rejectInitialization(new Error('m1 entry init failure'))

    expect(await harness.next()).toMatchObject({
      kind: 'init_error',
      message: 'm1 entry init failure',
    })

    // Almost all assertions run on the fully settled snapshot after the actual
    // controlled exit, so the one-terminal/no-ready contract is enforced on the
    // complete message history rather than inferred from a single next().
    await harness.awaitExit()
    const captured = harness.capturedPosts().map((post) => post.message)
    const initErrors = captured.filter(
      (message) => (message as { kind?: unknown }).kind === 'init_error',
    )
    expect(initErrors).toHaveLength(1)
    expect(initErrors[0]).toMatchObject({
      kind: 'init_error',
      message: 'm1 entry init failure',
    })
    const readyPosts = captured.filter(
      (message) => (message as { kind?: unknown }).kind === 'ready',
    )
    expect(readyPosts).toHaveLength(0)
    expect(harness.generateCalls()).toBe(0)
    expect(harness.disposeCalls()).toBe(1)
    expect(harness.exitCalls()).toEqual([1])
  })
})
