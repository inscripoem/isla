/**
 * Test-only controlled transport for the M1-02 Kokoro worker host.
 *
 * This is an injected scripted Worker-like dependency: it never starts a
 * subprocess and never imports or downloads the SDK. It lets the tests drive the
 * host's real control logic (admission, job-id matching, error/exit distinction,
 * drain-before-close) deterministically. It is a transport control, not a
 * re-implementation of the host or the provider, so it cannot serve as its own
 * oracle. Real bootstrap/startup and real CPU timing are exercised by the
 * explicit live entrypoints instead.
 */
import type { KokoroProviderConfig } from '../../src/performance/kokoro-provider'
import type {
  KokoroWorkerEventListener,
  KokoroWorkerEventName,
  KokoroWorkerTransport,
} from '../../src/performance/kokoro-worker-provider'

export interface PostedWorkerMessage {
  readonly message: unknown
  readonly transfer?: readonly ArrayBuffer[]
}

export interface GeneratePost {
  readonly jobId: number
  readonly input: { readonly text: string; readonly voiceId: string; readonly speed: number }
}

export interface ControlledWorkerTransport extends KokoroWorkerTransport {
  posts(): PostedWorkerMessage[]
  generatePosts(): GeneratePost[]
  disposePosts(): number
  emitReady(): void
  emitInitError(message: string): void
  emitResult(value: unknown): void
  emitError(error: unknown): void
  emitMessageError(error: unknown): void
  emitExit(code?: number): void
  terminateCount(): number
}

function isGeneratePost(message: unknown): message is {
  kind: 'generate'
  jobId: number
  input: { text: string; voiceId: string; speed: number }
} {
  if (message === null || typeof message !== 'object') return false
  const record = message as Record<string, unknown>
  return (
    record.kind === 'generate' &&
    typeof record.jobId === 'number' &&
    record.input !== null &&
    typeof record.input === 'object'
  )
}

export function createControlledWorkerTransport(): ControlledWorkerTransport {
  const listeners = new Map<KokoroWorkerEventName, Set<KokoroWorkerEventListener>>()
  const posts: PostedWorkerMessage[] = []
  let terminates = 0

  const emit = (event: KokoroWorkerEventName, value: unknown): void => {
    const set = listeners.get(event)
    if (set === undefined) return
    for (const listener of [...set]) listener(value)
  }

  return {
    postMessage(message, transfer) {
      posts.push(transfer === undefined ? { message } : { message, transfer })
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<KokoroWorkerEventListener>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    terminate() {
      terminates += 1
      // A real terminate eventually causes an exit; the scripted transport lets
      // the test control that separately with `emitExit` so the host's
      // "reject only after real exit" ordering can be observed.
      return Promise.resolve(0)
    },
    posts: () => posts.slice(),
    generatePosts: () =>
      posts
        .map((post) => post.message)
        .filter(isGeneratePost)
        .map((message) => ({ jobId: message.jobId, input: message.input })),
    disposePosts: () =>
      posts.filter(
        (post) =>
          post.message !== null &&
          typeof post.message === 'object' &&
          (post.message as { kind?: unknown }).kind === 'dispose',
      ).length,
    emitReady: () => emit('message', { kind: 'ready' }),
    emitInitError: (message) => emit('message', { kind: 'init_error', message }),
    emitResult: (value) => emit('message', value),
    emitError: (error) => emit('error', error),
    emitMessageError: (error) => emit('messageerror', error),
    emitExit: (code = 0) => emit('exit', code),
    terminateCount: () => terminates,
  }
}

export interface ControlledWorkerKit {
  readonly transport: ControlledWorkerTransport
  createWorker(bootstrapUrl: URL, workerData: KokoroProviderConfig): KokoroWorkerTransport
  createCalls(): number
  lastWorkerData(): KokoroProviderConfig | null
  lastBootstrapUrl(): URL | null
}

/** A controlled transport plus the `createWorker` seam the host accepts. */
export function createControlledWorkerKit(): ControlledWorkerKit {
  const transport = createControlledWorkerTransport()
  let calls = 0
  let lastData: KokoroProviderConfig | null = null
  let lastUrl: URL | null = null
  return {
    transport,
    createWorker(bootstrapUrl, workerData) {
      calls += 1
      lastUrl = bootstrapUrl
      lastData = workerData
      return transport
    },
    createCalls: () => calls,
    lastWorkerData: () => lastData,
    lastBootstrapUrl: () => lastUrl,
  }
}
