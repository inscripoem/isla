/**
 * M1-02 Kokoro worker entry.
 *
 * Runs only inside the persistent worker started by `kokoro-worker-provider.ts`
 * through the `.mjs` tsx bootstrap. On ordinary import in the main thread it is
 * inert: it neither starts a worker nor imports or downloads the SDK. Inside the
 * worker it loads the SDK and model once from the validated local-only config,
 * reports readiness, and serves at most one generation at a time. A dispose
 * request closes new-generation admission immediately; if a generation is
 * already physical it keeps its genuine lifecycle, and the loaded model is
 * released through its public API exactly once and only after that generation's
 * result path finishes (or after initialization settles), then the worker exits.
 *
 * The message shapes are the host protocol declared in
 * `kokoro-worker-provider.ts`; they carry only plain tagged metadata and a
 * copied mono `Float32Array`, never signals, leases, SDK instances or `Error`
 * objects.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import type { KokoroProvider, KokoroProviderInput } from './kokoro-types'
import { KokoroProviderError } from './kokoro-types'
import type { KokoroProviderConfig, KokoroSdkLoader } from './kokoro-provider'
import { createKokoroProvider, createRealKokoroSdkLoader } from './kokoro-provider'
import type { KokoroWorkerOutboundMessage } from './kokoro-worker-provider'

/** True only in the persistent worker thread started by the host bootstrap. */
export function isKokoroWorkerRuntime(): boolean {
  return (
    !isMainThread &&
    parentPort !== null &&
    (globalThis as { __islaKokoroWorker?: unknown }).__islaKokoroWorker === true
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isGenerateMessage(
  value: unknown,
): value is { kind: 'generate'; jobId: number; input: KokoroProviderInput } {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.kind !== 'generate') return false
  if (typeof record.jobId !== 'number') return false
  const input = record.input
  if (input === null || typeof input !== 'object') return false
  const fields = input as Record<string, unknown>
  return (
    typeof fields.text === 'string' &&
    typeof fields.voiceId === 'string' &&
    typeof fields.speed === 'number'
  )
}

function isDisposeMessage(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'dispose'
  )
}

/**
 * Wrap the real SDK loader so the worker retains the loaded model object for a
 * normal public `dispose()` on shutdown. This is the only extra behavior the
 * worker adds to the shared provider/guard/cache code; it does not duplicate any
 * tokenizer or SDK algorithm and adds no production test hook.
 */
function createDisposingLoader(): { loader: KokoroSdkLoader; disposeModel: () => Promise<void> } {
  const real = createRealKokoroSdkLoader()
  let loadedModel: unknown = null
  const loader: KokoroSdkLoader = {
    configureEnvironment: (config) => real.configureEnvironment(config),
    loadTokenizer: (config) => real.loadTokenizer(config),
    ensureVoice: (voiceId) => real.ensureVoice(voiceId),
    async loadModel(config) {
      loadedModel = await real.loadModel(config)
      return loadedModel
    },
    createTts: (model, tokenizer) => real.createTts(model, tokenizer),
  }
  return {
    loader,
    async disposeModel() {
      const model = loadedModel
      loadedModel = null
      if (model !== null && typeof (model as { dispose?: unknown }).dispose === 'function') {
        await (model as { dispose(): Promise<void> | void }).dispose()
      }
    },
  }
}

async function runKokoroWorker(config: KokoroProviderConfig): Promise<void> {
  const port = parentPort
  if (port === null) return

  // Control and error messages carry plain tagged metadata and need no transfer.
  // Only a successful result transfers the dedicated owned sample copy below.
  const send = (message: KokoroWorkerOutboundMessage, transfer?: readonly ArrayBuffer[]): void => {
    port.postMessage(message, transfer)
  }

  let disposeModel: () => Promise<void> = async () => {}
  let provider: KokoroProvider | null = null
  let initialized = false
  let busy = false
  let disposing = false
  let shuttingDown = false
  let disposeRequested = false
  let shutdownPromise: Promise<void> | null = null

  // The physical generation's own settlement signal. A dispose defers model
  // disposal and process exit by awaiting it, so an admitted job finishes its
  // result path instead of being cut off.
  let generationSettled: Promise<void> | null = null
  let settleGeneration: (() => void) | null = null

  const beginGeneration = (): void => {
    busy = true
    generationSettled = new Promise<void>((resolve) => {
      settleGeneration = resolve
    })
  }

  const endGeneration = (): void => {
    busy = false
    const settle = settleGeneration
    settleGeneration = null
    if (settle !== null) settle()
  }

  /** Release the loaded model through its public API at most once. */
  const disposeOnce = async (): Promise<void> => {
    if (disposing) return
    disposing = true
    try {
      await disposeModel()
    } catch {
      // Best-effort SDK disposal; exit still releases the thread's resources.
    }
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      // Wait for a generation that was already admitted to fulfill or reject and
      // finish its single result path before disposing the model and exiting.
      if (generationSettled !== null) await generationSettled
      await disposeOnce()
      process.exit(0)
    })()
    return shutdownPromise
  }

  // Shutdown may only begin once initialization has actually settled; a dispose
  // during initialization closes admission but waits for that settlement first.
  const maybeShutdown = (): void => {
    if (!disposeRequested || !initialized) return
    void shutdown()
  }

  const handleGenerate = async (jobId: number, input: KokoroProviderInput): Promise<void> => {
    const active = provider
    if (active === null || shuttingDown || disposeRequested) {
      send({ kind: 'result', jobId, ok: false, error: 'worker is not accepting generation' })
      return
    }
    if (busy) {
      // Defensive single-job admission: async handlers must not overlap.
      send({ kind: 'result', jobId, ok: false, error: 'worker busy' })
      return
    }
    beginGeneration()
    try {
      const audio = await active.generate(input)
      // A dedicated owned copy keeps any SDK-owned view intact; only this copy's
      // buffer is transferred, never the SDK's own buffer.
      const samples = new Float32Array(audio.samples)
      send(
        { kind: 'result', jobId, ok: true, sampleRate: audio.sampleRate, samples },
        [samples.buffer as ArrayBuffer],
      )
    } catch (error) {
      if (error instanceof KokoroProviderError) {
        send({ kind: 'result', jobId, ok: false, code: error.code })
      } else {
        send({ kind: 'result', jobId, ok: false, error: describeError(error) })
      }
    } finally {
      endGeneration()
    }
  }

  port.on('message', (value: unknown) => {
    if (isGenerateMessage(value)) {
      void handleGenerate(value.jobId, value.input)
      return
    }
    if (isDisposeMessage(value)) {
      disposeRequested = true
      maybeShutdown()
    }
  })

  const loaded = createDisposingLoader()
  disposeModel = loaded.disposeModel
  try {
    provider = await createKokoroProvider(config, loaded.loader)
  } catch (error) {
    send({ kind: 'init_error', message: describeError(error) })
    await disposeOnce()
    process.exit(1)
    return
  }

  initialized = true
  if (!disposeRequested) send({ kind: 'ready' })
  maybeShutdown()
}

if (isKokoroWorkerRuntime()) {
  void runKokoroWorker(workerData as KokoroProviderConfig).catch(() => {
    process.exit(1)
  })
}
