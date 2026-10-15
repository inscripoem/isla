/**
 * M1-02 Kokoro worker entry.
 *
 * Runs only inside the persistent worker started by `kokoro-worker-provider.ts`
 * through the `.mjs` tsx bootstrap. On ordinary import in the main thread it is
 * inert: it neither starts a worker nor imports or downloads the SDK. Inside the
 * worker it loads the SDK and model once from the validated local-only config,
 * reports readiness, and serves at most one generation at a time. Dispose
 * requests release the loaded model through its public API and then exit.
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

  const send = (message: KokoroWorkerOutboundMessage): void => {
    port.postMessage(message)
  }

  let disposeModel: () => Promise<void> = async () => {}
  let provider: KokoroProvider | null = null
  let initialized = false
  let busy = false
  let shuttingDown = false
  let disposeRequested = false

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await disposeModel()
    } catch {
      // Best-effort SDK disposal; exit still releases the thread's resources.
    }
    process.exit(0)
  }

  const handleGenerate = async (jobId: number, input: KokoroProviderInput): Promise<void> => {
    const active = provider
    if (active === null || shuttingDown) {
      send({ kind: 'result', jobId, ok: false, error: 'worker is not accepting generation' })
      return
    }
    if (busy) {
      // Defensive single-job admission: async handlers must not overlap.
      send({ kind: 'result', jobId, ok: false, error: 'worker busy' })
      return
    }
    busy = true
    try {
      const audio = await active.generate(input)
      // A dedicated owned copy keeps any SDK-owned view intact.
      const samples = new Float32Array(audio.samples)
      send({ kind: 'result', jobId, ok: true, sampleRate: audio.sampleRate, samples })
    } catch (error) {
      if (error instanceof KokoroProviderError) {
        send({ kind: 'result', jobId, ok: false, code: error.code })
      } else {
        send({ kind: 'result', jobId, ok: false, error: describeError(error) })
      }
    } finally {
      busy = false
    }
  }

  port.on('message', (value: unknown) => {
    if (isGenerateMessage(value)) {
      void handleGenerate(value.jobId, value.input)
      return
    }
    if (isDisposeMessage(value)) {
      disposeRequested = true
      if (initialized) void shutdown()
    }
  })

  const loaded = createDisposingLoader()
  disposeModel = loaded.disposeModel
  try {
    provider = await createKokoroProvider(config, loaded.loader)
  } catch (error) {
    send({ kind: 'init_error', message: describeError(error) })
    try {
      await disposeModel()
    } catch {
      // Best-effort disposal of any partially loaded model before exit.
    }
    process.exit(1)
    return
  }

  initialized = true
  send({ kind: 'ready' })
  if (disposeRequested) void shutdown()
}

if (isKokoroWorkerRuntime()) {
  void runKokoroWorker(workerData as KokoroProviderConfig).catch(() => {
    process.exit(1)
  })
}
