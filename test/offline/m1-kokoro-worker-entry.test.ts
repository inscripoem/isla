/**
 * M1-02 worker entry lifecycle regressions.
 *
 * These tests import the **actual** TypeScript worker entry
 * (`src/performance/kokoro-worker.ts`) with `vi.doMock`, a controlled provider
 * factory and a fake `model.dispose`, and a real Node `MessageChannel` as the
 * `parentPort`. They exercise the entry's real admission, disposal and transfer
 * paths; they are not a real-model or real-worker-thread proof. The real
 * bootstrap, a genuine subprocess and real CPU timing remain the explicit live
 * entrypoints' job. No SDK is imported and no model is downloaded.
 */
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KokoroProviderConfig } from '../../src/performance/kokoro-provider'
import type { KokoroRawAudio } from '../../src/performance/kokoro-types'

function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
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

interface Harness {
  send(message: unknown): void
  next(): Promise<unknown>
  releaseInit(): void
  initStarted(): boolean
  disposeCalls(): number
  exitCalls(): readonly number[]
  generateCalls(): number
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
    if (activeHarness !== null) {
      const harness = activeHarness
      activeHarness = null
      await harness.settle()
    }
    delete (globalThis as { __islaKokoroWorker?: unknown }).__islaKokoroWorker
    vi.doUnmock('node:worker_threads')
    vi.doUnmock('../../src/performance/kokoro-provider')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function startEntry(): Promise<Harness> {
    vi.resetModules()
    const { port1: workerPort, port2: testPort } = new MessageChannel()

    const sdkSamples = new Float32Array([0.25, -0.5, 0.75, 0])
    const state = {
      modelDisposeCalls: 0,
      providerGenerateCalls: 0,
      initStarted: false,
      resolveInitGate: null as (() => void) | null,
      pending: null as {
        resolve(audio: KokoroRawAudio): void
        reject(error: unknown): void
      } | null,
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
    const provider = {
      generate: (_input: unknown): Promise<KokoroRawAudio> =>
        new Promise<KokoroRawAudio>((resolve, reject) => {
          state.providerGenerateCalls += 1
          state.pending = { resolve, reject }
        }),
    }
    // The controlled provider factory exercises the entry's real
    // `createDisposingLoader` by loading through the supplied loader wrapper.
    const createProvider = async (
      config: unknown,
      loader: { loadModel(config: unknown): Promise<unknown> },
    ): Promise<unknown> => {
      state.initStarted = true
      await loader.loadModel(config)
      await initGate
      return provider
    }

    const posts: CapturedPost[] = []
    const originalPostMessage = workerPort.postMessage.bind(workerPort) as (
      message: unknown,
      transferList?: readonly ArrayBuffer[],
    ) => void
    workerPort.postMessage = ((message: unknown, transferList?: readonly ArrayBuffer[]) => {
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
    vi.doMock('../../src/performance/kokoro-provider', () => ({
      createRealKokoroSdkLoader: () => realLoader,
      createKokoroProvider: createProvider,
    }))

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
    // Sequence teardown without ever racing a timeout against exit: release and
    // observe held initialization, keep driving native queued messages and
    // admission until they become observable, close admission and drain every
    // controlled pending generation on each pass, then await the actual
    // controlled exit before closing ports. Idempotent across repeated calls. A
    // genuine failure surfaces as an ordinary test/hook timeout, never as a
    // falsely observed exit.
    const settle = (): Promise<void> => {
      if (cleanupPromise !== null) return cleanupPromise
      cleanupPromise = (async (): Promise<void> => {
        state.resolveInitGate?.()
        while (state.exitCodes.length === 0) {
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
        await exited
        if (!portsClosed) {
          portsClosed = true
          workerPort.close()
          testPort.close()
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
      disposeCalls: () => state.modelDisposeCalls,
      exitCalls: () => state.exitCodes.slice(),
      generateCalls: () => state.providerGenerateCalls,
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
})
