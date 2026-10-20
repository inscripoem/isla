import type { ClockPort, SynthesisPort } from '../contracts'
import type { AudioResourceRegistry } from '../performance/audio-resources'
import type { DeadlineGate } from '../performance/browser/types'
import type { KokoroProviderConfig } from '../performance/kokoro-provider'
import { createKokoroSynthesis } from '../performance/kokoro-synthesis'
import type { KokoroSynthesis, KokoroVoiceProfile } from '../performance/kokoro-types'
import { createKokoroWorkerProvider } from '../performance/kokoro-worker-provider'
import type { KokoroWorkerProviderOptions } from '../performance/kokoro-worker-provider'
import type { RuntimeDeadlineGate } from './deadline'

/**
 * M5-owned retained physical synthesis.
 *
 * The M1 Kokoro provider is a long-lived, single-slot dependency: one worker
 * host owns at most one physical generation, and one synthesis adapter owns the
 * local physical-occupancy guard for that provider. This module assembles that
 * ownership exactly once from explicit configuration and retains it for the
 * whole application lifetime. Every composition — the initial one, each Stop
 * successor and each recovery successor — receives a facade over that one
 * adapter, so a new opportunity while a cancelled generation is still
 * physically active is refused by the adapter's own `busy` result instead of
 * starting a second generation or constructing a second adapter over the same
 * worker.
 *
 * Each facade owns the composition gate it was created for and hands it to the
 * adapter for the duration of the caller's own `prepare` call. The adapter
 * binds its effective (earliest-deadline) context through that gate, so an abort
 * or expiry reaches exactly the work of the composition that issued the
 * request: creating another facade never re-points an existing one, a disposed
 * origin gate can only abort bindings it owns, and a successor's gate never
 * revives or refuses an old request. Outside any facade call there is no origin
 * to bind, so the gate pre-aborts instead of silently extending an unknown
 * request.
 *
 * `release()` is the owned lifecycle: it closes provider admission
 * synchronously, drains the active physical job, disposes the worker SDK and
 * resolves only after the actual worker exit. It is idempotent. Neither a
 * logical abort nor a worker error event proves exit, so callers must await this
 * contract rather than infer settlement.
 */
export interface RetainedSynthesis {
  /**
   * Production peer factory: returns a per-composition facade over the single
   * retained adapter, bound to the supplied composition gate. It never
   * constructs a second adapter over the provider, and calling it never changes
   * the gate an earlier facade binds through.
   */
  createSynthesis(gate: RuntimeDeadlineGate): SynthesisPort
  /** Idempotent owned release; resolves only after the actual worker exit. */
  release(): Promise<void>
}

export interface RetainedSynthesisOptions {
  /** Explicit provider configuration; validated by the M1 worker host. */
  readonly config: KokoroProviderConfig
  /** Configured voice profiles mapped by the M1 adapter. */
  readonly profiles: readonly KokoroVoiceProfile[]
  /** Controlled audio resource registry, shared with the application. */
  readonly registry: AudioResourceRegistry
  readonly clock: ClockPort
  /**
   * Embedding/test seam for the worker transport. Omitted builds a real Node
   * worker; tests inject a controlled transport so no model is loaded.
   */
  readonly createWorker?: KokoroWorkerProviderOptions['createWorker']
}

export async function createRetainedSynthesis(
  options: RetainedSynthesisOptions,
): Promise<RetainedSynthesis> {
  const handle = await createKokoroWorkerProvider(
    options.config,
    options.createWorker !== undefined ? { createWorker: options.createWorker } : {},
  )

  // The origin gate of the bind the retained adapter performs inside the
  // synchronous prefix of one facade `prepare` call: the adapter validates,
  // computes the earliest deadline and binds before it awaits or invokes the
  // provider. The slot is scoped to that call, so a caller can only ever bind
  // through its own composition gate and a reentrant call restores the outer
  // origin. It owns no timer or listener of its own: every binding belongs to
  // the origin gate, so disposal of that gate aborts exactly its own work.
  let bindingOrigin: RuntimeDeadlineGate | null = null
  const gate: DeadlineGate = {
    bind(context) {
      const origin = bindingOrigin
      if (origin === null) {
        // No composition call owns this bind: pre-abort instead of extending an
        // unknown request.
        const controller = new AbortController()
        controller.abort()
        return { signal: controller.signal, release: () => {} }
      }
      return origin.bind(context)
    },
  }

  let adapter: KokoroSynthesis
  try {
    adapter = createKokoroSynthesis({
      provider: handle.provider,
      profiles: options.profiles,
      registry: options.registry,
      clock: options.clock,
      deadlineGate: gate,
    })
  } catch (error) {
    // The provider was acquired before the adapter was validated: release it
    // (drain, dispose, observed exit) before reporting the construction
    // failure. The M1 close contract cannot reject; the construction failure
    // stays the reportable error.
    try {
      await handle.close()
    } catch {
      // The adapter construction failure is the reportable error.
    }
    throw error
  }

  return {
    createSynthesis(origin) {
      return {
        prepare(request, context) {
          const previous = bindingOrigin
          bindingOrigin = origin
          try {
            return adapter.prepare(request, context)
          } finally {
            bindingOrigin = previous
          }
        },
      }
    },
    release: () => handle.close(),
  }
}
