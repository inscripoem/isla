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
  let activeAbort: AbortController | null = null
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

  const execute = async (command: PerformanceCommand): Promise<void> => {
    if (disposed) {
      options.onFault(`ignored ${command.outputId}: the local player is disposed`)
      return
    }
    // A new output supersedes the previous one: abort it first so the controller
    // has a free admission slot and the previous output settles honestly.
    activeAbort?.abort()
    const abort = new AbortController()
    activeAbort = abort
    options.onSubtitle(command.subtitleText)
    refreshStatus()
    try {
      await controller.execute(command, { signal: abort.signal })
    } catch (error) {
      options.onFault(`${command.outputId}: ${describe(error)}`)
    } finally {
      if (activeAbort === abort) activeAbort = null
      refreshStatus()
    }
  }

  const applyCancel = async (request: PerformanceCancel): Promise<void> => {
    try {
      await controller.cancel(request)
    } catch (error) {
      options.onFault(`cancel ${request.requestId}: ${describe(error)}`)
    } finally {
      // Release the caller-side signal once the controller-owned revocation has
      // committed. The controller removed its abort listener already, so this
      // cannot select a second terminal.
      activeAbort?.abort()
      activeAbort = null
      refreshStatus()
    }
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
      const abort = activeAbort
      activeAbort = null
      if (abort === null) return
      abort.abort()
      refreshStatus()
    },
    dispose() {
      if (disposed) return
      disposed = true
      activeAbort?.abort()
      activeAbort = null
      controller.dispose()
      refreshStatus()
    },
    status() {
      return controller.status()
    },
  }
}
