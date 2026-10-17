import type {
  BootstrapSnapshot,
  PerformanceCancel,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerStatus,
  ServerMessage,
} from '../contracts'
import type {
  AudioResolver,
  MediaDriver,
  PlaybackController,
} from '../performance/browser'
import { PlayerDispatchError, createPlaybackController } from '../performance/browser'

/**
 * Adapter that mounts the M1 browser playback controller behind the M2 console.
 *
 * It translates the two inbound performance commands into local playback calls,
 * holds at most one caller-side abort signal per active output, and forwards
 * locally observed receipts and faults to the console. Two deliberate limits:
 *  - receipts go to a local sink only, because the console transport has no
 *    return channel for player messages yet, so nothing here claims that the
 *    runtime confirmed delivery;
 *  - only `performance.cancel` revokes an epoch. A disconnect aborts local
 *    playback without touching the server's epoch sequence.
 */

export interface PlaybackCallbacks {
  /** Locally observed receipts. Evidence of this browser session, not of runtime confirmation. */
  readonly onReceipt: (receipt: PerformanceReceipt) => void
  readonly onStatus: (status: PlayerStatus) => void
  /** Subtitle text of the command now being performed; rendering is separate from audio. */
  readonly onSubtitle: (subtitleText: string) => void
  readonly onFault: (message: string) => void
}

/** Composes a local playback binding once the bootstrap identity is known. */
export type PlaybackFactory = (bootstrap: BootstrapSnapshot, callbacks: PlaybackCallbacks) => PlaybackBinding

export interface PlaybackBindingOptions extends PlaybackCallbacks {
  readonly bootstrap: BootstrapSnapshot
  readonly resolver: AudioResolver
  readonly media: MediaDriver
  readonly newReceiptId: () => string
  readonly localNowMs: () => number | null
}

export interface PlaybackBinding {
  /** Act on one inbound server message. Non-performance messages are ignored. */
  handleServerMessage(message: ServerMessage): void
  /** Abort local playback on disconnect or unmount, without revoking an epoch. */
  cancelLocal(): void
  dispose(): void
  status(): PlayerStatus
}

function describe(error: unknown): string {
  if (error instanceof PlayerDispatchError) return `dispatch rejected (${error.code})`
  return error instanceof Error ? error.message : String(error)
}

export function createPlaybackBinding(options: PlaybackBindingOptions): PlaybackBinding {
  const ref: { current: PlaybackController | null } = { current: null }
  // One caller-side controller owns the operation currently admitted by the
  // player. Aborting it cancels that operation locally without revoking an
  // epoch. It is renewed only when an operation is deliberately superseded or
  // cancelled, so a duplicate, stale or invalid command never disturbs the
  // signal that the operation actually playing is bound to.
  let caller = new AbortController()
  let disposed = false

  const refreshStatus = (): void => {
    const current = ref.current
    if (current !== null) options.onStatus(current.status())
  }

  const controller = createPlaybackController({
    sessionId: options.bootstrap.sessionId,
    initialEpoch: options.bootstrap.epoch,
    resolver: options.resolver,
    media: options.media,
    receipts: { newReceiptId: options.newReceiptId, localNowMs: options.localNowMs },
    onReceipt: (receipt) => {
      options.onReceipt(receipt)
      refreshStatus()
    },
    reportFault: (error) => options.onFault(describe(error)),
  })
  ref.current = controller

  /**
   * Cancel the operation that currently owns the caller signal and hand back a
   * fresh signal for the next admission. Aborting reaches only the operation
   * bound to this signal; a controller that never admitted anything has no
   * listener and the abort is a harmless no-op.
   */
  const supersede = (): AbortSignal => {
    caller.abort()
    caller = new AbortController()
    return caller.signal
  }

  const execute = async (command: PerformanceCommand): Promise<void> => {
    if (disposed) {
      options.onFault(`ignored ${command.outputId}: the local player is disposed`)
      return
    }
    options.onSubtitle(command.subtitleText)
    refreshStatus()
    // Offer the command over the current caller signal before disturbing
    // anything. M1 validates identity, freshness and duplicates ahead of any
    // effect and binds this signal only when it admits a new operation, so a
    // duplicate, a stale command or a rejected session leaves the operation that
    // is playing untouched. Only an explicit `busy` slot conflict — a different
    // output already admitted — justifies superseding it.
    try {
      await controller.execute(command, { signal: caller.signal })
    } catch (error) {
      if (error instanceof PlayerDispatchError && error.code === 'busy') {
        try {
          await controller.execute(command, { signal: supersede() })
        } catch (retryError) {
          options.onFault(`${command.outputId}: ${describe(retryError)}`)
        }
      } else {
        options.onFault(`${command.outputId}: ${describe(error)}`)
      }
    }
    refreshStatus()
  }

  const applyCancel = async (request: PerformanceCancel): Promise<void> => {
    try {
      await controller.cancel(request)
    } catch (error) {
      // A rejected cancel (stale_cancel or invalid_command) must not disturb the
      // operation that is playing, so the caller signal stays bound to it.
      options.onFault(`cancel ${request.requestId}: ${describe(error)}`)
      refreshStatus()
      return
    }
    // Accepted: M1 revoked the epoch and settled the operation it owned, so the
    // caller signal it was bound to is released and renewed for the next
    // admission. Aborting it now only clears a listener M1 already removed.
    supersede()
    refreshStatus()
  }

  return {
    handleServerMessage(message) {
      if (message.kind === 'performance.execute') {
        void execute(message.payload)
        return
      }
      if (message.kind === 'performance.cancel') {
        void applyCancel(message.payload)
      }
    },
    cancelLocal() {
      // Abort local playback without revoking an epoch, then renew the caller
      // signal so the binding stays usable after a disconnect.
      supersede()
      refreshStatus()
    },
    dispose() {
      if (disposed) return
      disposed = true
      caller.abort()
      controller.dispose()
      refreshStatus()
    },
    status() {
      return controller.status()
    },
  }
}
