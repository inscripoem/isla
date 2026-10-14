import type { PerformanceReceipt, PlayerPort } from '../../contracts/app'
import type { DeadlineBinding, DeadlineGate, PlaybackController } from './types'

/**
 * Adapts the browser {@link PlaybackController} to the shared `PlayerPort`
 * contract used by M5's same-process orchestration.
 *
 * The wrapper binds the required {@link DeadlineGate} for every call and tracks
 * the returned core-operation promise: the first binding owns that operation and
 * is released when it settles, while a duplicate call reusing the same returned
 * promise releases its unused binding immediately. An admission rejection also
 * releases its binding. `cancel` forwards the trusted cancellation independently
 * of the call context's expiry, so an already-expired context cannot preserve
 * revoked playback; it never fabricates a new deadline.
 */
export function createPlayerPort(deps: {
  readonly controller: PlaybackController
  readonly deadlineGate: DeadlineGate
}): PlayerPort {
  // Ownership is keyed by the actual core-operation promise identity, not by
  // output id, so an admission rejection cannot displace another owner.
  const owned = new Map<Promise<PerformanceReceipt>, DeadlineBinding>()

  return {
    execute(command, context) {
      const binding = deps.deadlineGate.bind(context)
      let promise: Promise<PerformanceReceipt>
      try {
        promise = deps.controller.execute(command, { signal: binding.signal })
      } catch (error) {
        binding.release()
        return Promise.reject(error)
      }
      if (owned.has(promise)) {
        // This returned promise is already owned by an earlier call, so this
        // call does not own the operation: release its binding at once.
        binding.release()
        return promise
      }
      owned.set(promise, binding)
      const release = (): void => {
        binding.release()
        if (owned.get(promise) === binding) owned.delete(promise)
      }
      // `release` handles both fulfillment and rejection, so no unhandled
      // rejection is created and the binding is released exactly once.
      promise.then(release, release)
      return promise
    },

    cancel(request) {
      return deps.controller.cancel(request)
    },

    status() {
      return deps.controller.status()
    },
  }
}
