/**
 * Node-only worker host for the M1-02 Kokoro provider.
 *
 * This module runs inference in one persistent Node worker so the main event
 * loop is not blocked by the SDK's CPU-bound Promise. The host exposes exactly
 * the same {@link KokoroProvider} seam the in-process factory does, plus an
 * owner-only idempotent `close` operation. It adds no scheduler, queue, pool,
 * automatic respawn or cancellation message: at most one physical generation is
 * pending, and a second call fails rather than queueing.
 *
 * The worker is started from a small explicit `.mjs` bootstrap
 * (`kokoro-worker-bootstrap.mjs`) that registers the project's existing `tsx`
 * development runtime and then imports the TypeScript worker entry. The Worker
 * is built with a module-relative file URL and an explicit `execArgv: []` so a
 * tsx/pnpm parent cannot silently preload its hooks a second time. This is a
 * documented development/demo runtime only; production packaging and dependency
 * approval remain an M5/M6 decision.
 *
 * Lifecycle rules enforced here:
 * - The host snapshots and validates the same configuration the worker loads;
 *   the SDK and model are loaded only inside the worker, using the local-only
 *   revision cache. No HF environment is mutated on the main process.
 * - Request scalars are validated before `postMessage`, so a malformed request
 *   posts nothing; each accepted job keeps a unique, non-reused id and only a
 *   matching result can settle it. Unknown, duplicate or old replies cannot
 *   settle another job or clear its slot.
 * - A logical caller abort is owned by the existing `SynthesisPort` adapter and
 *   never settles this physical Promise. Occupancy is freed only by a matching
 *   result or by an actual worker exit. Worker `error` (an uncaught exception)
 *   and worker `exit` are distinct: an error closes admission but keeps the
 *   pending slot until exit, when the original Promise is rejected.
 * - `close` synchronously stops new admission, drains the current physical job,
 *   asks the worker to dispose its SDK resources, and resolves only after the
 *   actual worker exit. It is idempotent and posts the dispose request once.
 *   There is no timeout that manufactures replacement permission.
 */
import { Worker } from 'node:worker_threads'
import type { KokoroProvider, KokoroProviderInput, KokoroRawAudio } from './kokoro-types'
import { KokoroProviderError } from './kokoro-types'
import type { KokoroProviderConfig } from './kokoro-provider'
import { snapshotKokoroProviderConfig } from './kokoro-provider'

/** Worker event names this host listens to. */
export type KokoroWorkerEventName = 'message' | 'error' | 'messageerror' | 'exit'

/** A single-argument worker event listener. */
export type KokoroWorkerEventListener = (value: unknown) => void

/**
 * The minimal worker transport the host depends on. The default is a real Node
 * `Worker`; tests inject a small scripted transport to exercise the host's
 * control logic deterministically without starting a subprocess.
 */
export interface KokoroWorkerTransport {
  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void
  on(event: KokoroWorkerEventName, listener: KokoroWorkerEventListener): unknown
  removeListener(event: KokoroWorkerEventName, listener: KokoroWorkerEventListener): unknown
  terminate(): unknown
}

/** Host -> worker: run one generation for the given job id. */
export interface KokoroWorkerGenerateMessage {
  readonly kind: 'generate'
  readonly jobId: number
  readonly input: KokoroProviderInput
}

/** Host -> worker: dispose SDK resources and exit. */
export interface KokoroWorkerDisposeMessage {
  readonly kind: 'dispose'
}

export type KokoroWorkerInboundMessage = KokoroWorkerGenerateMessage | KokoroWorkerDisposeMessage

/** Worker -> host: initialization finished and the provider is usable. */
export interface KokoroWorkerReadyMessage {
  readonly kind: 'ready'
}

/** Worker -> host: initialization failed; the worker will exit. */
export interface KokoroWorkerInitErrorMessage {
  readonly kind: 'init_error'
  readonly message: string
}

/**
 * Worker -> host: one generation settled. A success carries controlled samples
 * and rate; a refusal preserves `input_too_long`; anything else is an honest
 * generic failure. No worker message carries a fabricated cancellation receipt.
 */
export type KokoroWorkerOutboundMessage =
  | KokoroWorkerReadyMessage
  | KokoroWorkerInitErrorMessage
  | {
      readonly kind: 'result'
      readonly jobId: number
      readonly ok: true
      readonly sampleRate: number
      readonly samples: Float32Array
    }
  | {
      readonly kind: 'result'
      readonly jobId: number
      readonly ok: false
      readonly code?: 'input_too_long'
      readonly error?: string
    }

/** Options controlling how the host builds its worker transport. */
export interface KokoroWorkerProviderOptions {
  /**
   * Embedding/test seam. It receives the explicit bootstrap file URL and the
   * frozen validated configuration. The default creates a real Node `Worker`
   * with `execArgv: []`.
   */
  readonly createWorker?: (
    bootstrapUrl: URL,
    workerData: KokoroProviderConfig,
  ) => KokoroWorkerTransport
}

/** A long-lived initialized worker provider plus its owner-only teardown. */
export interface KokoroWorkerProviderHandle {
  readonly provider: KokoroProvider
  /** Idempotent: drains the pending physical job, disposes the worker SDK and resolves only after worker exit. */
  close(): Promise<void>
}

interface PendingJob {
  readonly jobId: number
  readonly done: Promise<void>
  resolve(audio: KokoroRawAudio): void
  reject(error: unknown): void
  settleDone(): void
}

/** The explicit `.mjs` bootstrap URL beside this module. */
export function kokoroWorkerBootstrapUrl(): URL {
  return new URL('./kokoro-worker-bootstrap.mjs', import.meta.url)
}

/** The default real transport: a Node worker with an explicit empty execArgv. */
function createDefaultWorkerTransport(
  bootstrapUrl: URL,
  workerData: KokoroProviderConfig,
): KokoroWorkerTransport {
  const worker = new Worker(bootstrapUrl, { workerData, execArgv: [] })
  return worker as unknown as KokoroWorkerTransport
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Create and initialize one long-lived worker-backed provider. The returned
 * host owns exactly one worker and one pending generation slot.
 */
export async function createKokoroWorkerProvider(
  config: KokoroProviderConfig,
  options: KokoroWorkerProviderOptions = {},
): Promise<KokoroWorkerProviderHandle> {
  const snapshot = snapshotKokoroProviderConfig(config)
  const createWorker = options.createWorker ?? createDefaultWorkerTransport
  const worker = createWorker(kokoroWorkerBootstrapUrl(), snapshot)

  let initialized = false
  let closed = false
  let exited = false
  let fatalError: Error | null = null
  let jobCounter = 0
  let current: PendingJob | null = null
  let closePromise: Promise<void> | null = null
  let terminationRequested = false

  let resolveInit!: () => void
  let rejectInit!: (error: unknown) => void
  const initPromise = new Promise<void>((resolve, reject) => {
    resolveInit = resolve
    rejectInit = reject
  })

  let resolveExit!: () => void
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const cleanupListeners = (): void => {
    worker.removeListener('message', onMessage)
    worker.removeListener('error', onError)
    worker.removeListener('messageerror', onMessageError)
    worker.removeListener('exit', onExit)
  }

  /**
   * Request native worker termination at most once. This is fault cleanup for a
   * broken transport, never logical generation cancellation; a pending physical
   * job is preserved and rejected only on the observed actual exit.
   */
  const requestTermination = (): void => {
    if (terminationRequested) return
    terminationRequested = true
    try {
      void worker.terminate()
    } catch {
      // The transport may already be stopping; exit observation still governs.
    }
  }

  const settleJob = (job: PendingJob, result: Record<string, unknown>): void => {
    if (result.ok === true) {
      const sampleRate = result.sampleRate
      const samples = result.samples
      if (
        typeof sampleRate !== 'number' ||
        !Number.isFinite(sampleRate) ||
        sampleRate <= 0 ||
        !(samples instanceof Float32Array) ||
        samples.length === 0
      ) {
        // A matching but malformed result fails honestly and never publishes
        // raw or fabricated audio; the slot is already cleared for reuse.
        job.reject(new Error('m1-kokoro-worker-provider: malformed worker audio result'))
        return
      }
      job.resolve({ samples, sampleRate })
      return
    }
    if (result.code === 'input_too_long') {
      job.reject(new KokoroProviderError('input_too_long'))
      return
    }
    job.reject(
      new Error(
        `m1-kokoro-worker-provider: worker generation failed${
          typeof result.error === 'string' ? `: ${result.error}` : ''
        }`,
      ),
    )
  }

  const onMessage = (value: unknown): void => {
    if (!isRecord(value)) return
    const kind = value.kind
    if (kind === 'ready') {
      // Readiness is admissible only while initialization is still open. A
      // queued ready delivered after a fatal error, an init_error or a
      // messageerror must not resolve the factory before the real exit.
      if (!initialized && !closed && !exited && fatalError === null) {
        initialized = true
        resolveInit()
      }
      return
    }
    if (kind === 'init_error') {
      fatalError = new Error(
        `m1-kokoro-worker-provider: worker initialization failed${
          typeof value.message === 'string' ? `: ${value.message}` : ''
        }`,
      )
      closed = true
      // Request termination so a worker that reported a failure without exiting
      // still yields a real exit; initialization is rejected only on exit.
      requestTermination()
      return
    }
    if (kind === 'result') {
      // A result delivered after a fatal error or messageerror is ignored: the
      // physical slot is rejected only by the observed actual exit.
      if (fatalError !== null) return
      const jobId = value.jobId
      if (current === null || typeof jobId !== 'number' || current.jobId !== jobId) {
        // An old, duplicate or unknown reply cannot settle or clear another job.
        return
      }
      const job = current
      current = null
      job.settleDone()
      settleJob(job, value)
    }
  }

  const onError = (value: unknown): void => {
    // An uncaught worker exception closes admission, but occupancy is NOT freed
    // here: the thread may still be running and final rejection waits for exit.
    fatalError = value instanceof Error ? value : new Error(String(value))
    closed = true
  }

  const onMessageError = (value: unknown): void => {
    fatalError = new Error(
      `m1-kokoro-worker-provider: worker message could not be deserialized: ${describeError(value)}`,
    )
    closed = true
    // A broken message transport is a fault: request termination once. Occupancy
    // is preserved and the pending job is rejected only on the actual exit.
    requestTermination()
  }

  const onExit = (value: unknown): void => {
    exited = true
    const code = typeof value === 'number' ? value : null
    const suffix = code === null ? '' : ` (code ${code})`
    if (current !== null) {
      const job = current
      current = null
      job.settleDone()
      job.reject(
        fatalError ??
          new Error(`m1-kokoro-worker-provider: worker exited${suffix} before the generation settled`),
      )
    }
    if (!initialized) {
      rejectInit(
        fatalError ?? new Error(`m1-kokoro-worker-provider: worker exited${suffix} during initialization`),
      )
    }
    resolveExit()
    cleanupListeners()
  }

  worker.on('message', onMessage)
  worker.on('error', onError)
  worker.on('messageerror', onMessageError)
  worker.on('exit', onExit)

  const provider: KokoroProvider = {
    generate(input: KokoroProviderInput): Promise<KokoroRawAudio> {
      if (closed || exited || fatalError !== null) {
        return Promise.reject(new Error('m1-kokoro-worker-provider: provider is closed'))
      }
      if (input === null || typeof input !== 'object') {
        return Promise.reject(new Error('m1-kokoro-worker-provider: malformed provider input'))
      }
      if (typeof input.text !== 'string' || input.text.length === 0) {
        return Promise.reject(new Error('m1-kokoro-worker-provider: text must be a nonempty string'))
      }
      if (typeof input.voiceId !== 'string' || input.voiceId.length === 0) {
        return Promise.reject(new Error('m1-kokoro-worker-provider: voice id must be a nonempty string'))
      }
      if (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed <= 0) {
        return Promise.reject(new Error('m1-kokoro-worker-provider: speed must be a finite positive number'))
      }
      if (current !== null) {
        return Promise.reject(new Error('m1-kokoro-worker-provider: busy'))
      }

      const jobId = ++jobCounter
      // Snapshot the validated scalars before `postMessage` so a caller mutation
      // cannot change what the worker receives.
      const frozenInput: KokoroProviderInput = Object.freeze({
        text: input.text,
        voiceId: input.voiceId,
        speed: input.speed,
      })

      return new Promise<KokoroRawAudio>((resolve, reject) => {
        let settleDone!: () => void
        const done = new Promise<void>((resolveDone) => {
          settleDone = resolveDone
        })
        current = { jobId, done, resolve, reject, settleDone }
        try {
          const message: KokoroWorkerGenerateMessage = { kind: 'generate', jobId, input: frozenInput }
          worker.postMessage(message)
        } catch (error) {
          current = null
          settleDone()
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
  }

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise
    closed = true
    closePromise = (async () => {
      // Drain the current physical job; a logical abort elsewhere does not clear it.
      while (current !== null) {
        const pending = current
        await pending.done
      }
      if (!exited) {
        try {
          const message: KokoroWorkerDisposeMessage = { kind: 'dispose' }
          worker.postMessage(message)
        } catch {
          // The worker is already unreachable; exit observation still governs.
        }
      }
      await exitPromise
    })()
    return closePromise
  }

  try {
    await initPromise
  } catch (error) {
    // Initialization already requested termination; wait for the real exit so
    // the owner can safely construct a replacement.
    await exitPromise
    throw error instanceof Error ? error : new Error(String(error))
  }

  return { provider, close }
}
