import type { CallContext, ClockPort } from '../contracts'
import type { DeadlineBinding, DeadlineGate } from '../performance/browser/types'

/**
 * Production server-owned deadline gate. It converts a `CallContext` deadline
 * (expressed in the injected monotonic server clock) into a local abort signal,
 * so Node-side adapters such as the M1 mapped renderer or the performance bridge
 * cannot outlive the server's expiry even when the underlying peer is
 * uncooperative.
 *
 * Clock-domain rule: the returned signal is local to this process and is never
 * serialized. Browser and server monotonic clocks have different origins, so no
 * absolute clock reading is ever sent to a peer; the server owns expiry and the
 * browser owns its own abort/detach.
 *
 * Resource rule: each binding owns exactly one timer and one source-abort
 * listener. Both are removed by `release()` and by `dispose()`, including when
 * the binding aborts immediately. A disposed gate never retains a new entry.
 */
export interface RuntimeDeadlineGate extends DeadlineGate {
  /** Aborts and releases every outstanding binding; further binds are pre-aborted. */
  dispose(): void
}

interface ActiveBinding {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  source: AbortSignal
  onSourceAbort: () => void
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as { unref?: () => void }
  candidate.unref?.()
}

function isFiniteDeadline(deadline: { atMs: number } | undefined): boolean {
  return deadline !== undefined && Number.isFinite(deadline.atMs)
}

export function createDeadlineGate(clock: ClockPort): RuntimeDeadlineGate {
  const active = new Set<ActiveBinding>()
  let disposed = false

  const removeEntry = (entry: ActiveBinding): void => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.source.removeEventListener('abort', entry.onSourceAbort)
    active.delete(entry)
  }

  return {
    bind(context: CallContext): DeadlineBinding {
      const controller = new AbortController()
      const entry: ActiveBinding = {
        controller,
        timer: null,
        source: context.signal,
        onSourceAbort: () => {
          if (!controller.signal.aborted) controller.abort()
        },
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        removeEntry(entry)
      }

      // A disposed gate, an aborted source, a non-finite deadline or an already
      // expired deadline all abort immediately and retain nothing.
      const nowMs = clock.nowMs()
      const valid = isFiniteDeadline(context.deadline)
      const remainingMs = valid ? Math.max(0, context.deadline.atMs - nowMs) : 0
      if (disposed || context.signal.aborted || !valid || remainingMs === 0) {
        controller.abort()
        return { signal: controller.signal, release }
      }

      entry.timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort()
      }, remainingMs)
      unrefTimer(entry.timer)
      context.signal.addEventListener('abort', entry.onSourceAbort, { once: true })
      active.add(entry)

      return {
        signal: controller.signal,
        // Idempotent, non-throwing release. A late release after disposal is a
        // no-op rather than an error.
        release,
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of [...active]) {
        if (!entry.controller.signal.aborted) entry.controller.abort()
        removeEntry(entry)
      }
    },
  }
}
