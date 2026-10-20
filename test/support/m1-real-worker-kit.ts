/**
 * Test-only controlled real-thread transport for the M1 worker host.
 *
 * The host's `createWorker` seam receives an actual `node:worker_threads`
 * Worker running the scripted entry beside this module, so readiness, result
 * delivery, disposal and exit are real thread events rather than synthetic
 * calls. Generations are held until the test settles them, and the thread exits
 * only when the test asks, so an owner that awaits the actual worker exit is
 * distinguishable from one that only posts a dispose request. It never loads
 * Kokoro, the SDK or a model, and it does not replace the production host.
 */
import { Worker } from 'node:worker_threads'
import type { KokoroProviderConfig } from '../../src/performance/kokoro-provider'
import type {
  KokoroWorkerEventListener,
  KokoroWorkerEventName,
  KokoroWorkerGenerateMessage,
  KokoroWorkerTransport,
} from '../../src/performance/kokoro-worker-provider'

const WORKER_ENTRY = new URL('./m1-controlled-worker-entry.mjs', import.meta.url)

export interface RealWorkerKit {
  /** The `createWorker` seam: builds a real thread instead of the scripted transport. */
  readonly createWorker: (
    bootstrapUrl: URL,
    workerData: KokoroProviderConfig,
  ) => KokoroWorkerTransport
  /** Completes initialization from the worker side. */
  emitReady(): void
  /** Settles one held generation with controlled audio. */
  complete(jobId: number, options?: { sampleRate?: number; samples?: Float32Array }): void
  /** Settles one held generation as a failure. */
  fail(jobId: number, error: string): void
  /** Asks the real thread to exit; the actual `exit` event then fires. */
  requestExit(): void
  /** True once the real thread has exited. */
  exited(): boolean
  /** Every message the host posted, in order. */
  posted(): readonly unknown[]
  /** Generation requests the host posted. */
  generatePosts(): readonly KokoroWorkerGenerateMessage[]
  /** Dispose requests the host posted. */
  disposePosts(): number
  /** Result messages received from the thread. */
  results(): readonly unknown[]
  /** Forces thread termination and resolves after the actual exit; failure cleanup. */
  terminate(): Promise<void>
}

function hasKind(value: unknown, kind: string): boolean {
  return (
    value !== null && typeof value === 'object' && (value as { kind?: unknown }).kind === kind
  )
}

function isGenerateMessage(value: unknown): value is KokoroWorkerGenerateMessage {
  return hasKind(value, 'generate') && typeof (value as { jobId?: unknown }).jobId === 'number'
}

export function createRealWorkerKit(): RealWorkerKit {
  const posted: unknown[] = []
  const received: unknown[] = []
  const exitWaiters: Array<() => void> = []
  let worker: Worker | null = null
  let exited = false

  const markExited = (): void => {
    if (exited) return
    exited = true
    for (const waiter of exitWaiters.splice(0)) waiter()
  }

  const createWorker = (
    _bootstrapUrl: URL,
    workerData: KokoroProviderConfig,
  ): KokoroWorkerTransport => {
    const real = new Worker(WORKER_ENTRY, { workerData, execArgv: [] })
    worker = real
    real.on('exit', () => markExited())
    real.on('message', (value: unknown) => {
      received.push(value)
    })
    return {
      postMessage(message: unknown): void {
        posted.push(message)
        real.postMessage(message)
      },
      on(event: KokoroWorkerEventName, listener: KokoroWorkerEventListener): unknown {
        real.on(event as 'message', listener as (value: unknown) => void)
        return undefined
      },
      removeListener(event: KokoroWorkerEventName, listener: KokoroWorkerEventListener): unknown {
        real.removeListener(event as 'message', listener as (value: unknown) => void)
        return undefined
      },
      terminate(): unknown {
        return real.terminate()
      },
    }
  }

  const post = (message: unknown): void => {
    if (worker === null) throw new Error('m1-real-worker-kit: worker is not started')
    worker.postMessage(message)
  }

  return {
    createWorker,
    emitReady: () => post({ kind: 'test:ready' }),
    complete: (jobId, options = {}) => post({ kind: 'test:complete', jobId, ...options }),
    fail: (jobId, error) => post({ kind: 'test:fail', jobId, error }),
    requestExit: () => post({ kind: 'test:exit' }),
    exited: () => exited,
    posted: () => posted,
    generatePosts: () => posted.filter(isGenerateMessage),
    disposePosts: () => posted.filter((message) => hasKind(message, 'dispose')).length,
    results: () => received.filter((message) => hasKind(message, 'result')),
    async terminate() {
      if (worker === null || exited) return
      await worker.terminate()
      markExited()
    },
  }
}
