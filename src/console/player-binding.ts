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
import { reduceSessionFrontier, type SessionFrontier } from './console-state'

/**
 * Adapter that mounts the M1 browser playback controller behind the M2 console.
 *
 * It translates the two inbound performance commands into local playback calls,
 * holds at most one caller-side abort signal per active output, and forwards
 * locally observed receipts and faults to the console. It also reduces every
 * decoded message onto the accepted session frontier and refuses a command
 * outside it, so an output the console has already superseded or stopped is
 * never admitted even though M1 only advances its own epoch boundary on the
 * commands it was given directly. Three deliberate limits:
 *  - receipts go to a local sink only, because this console slice has no return
 *    channel for player messages yet, so nothing here claims that the runtime
 *    confirmed delivery;
 *  - only `performance.cancel` revokes an epoch. A disconnect aborts local
 *    playback without touching the server's epoch sequence;
 *  - the frontier mirrors the console's accepted session view rather than
 *    proving acoustic silence, so it fences admission without itself claiming
 *    the runtime stopped delivering.
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
  // The accepted session frontier, seeded from the bootstrap identity and
  // advanced by every decoded message. M1 is only told about performance
  // commands, so its own epoch boundary can lag this frontier: the fence below
  // is what keeps a command the console has already superseded out of M1.
  let frontier: SessionFrontier = {
    sessionId: options.bootstrap.sessionId,
    epoch: options.bootstrap.epoch,
    lifecycle: options.bootstrap.lifecycle,
    lastSeq: options.bootstrap.seq,
  }
  // Bumped whenever the caller signal is deliberately renewed. A busy rejection
  // resumes after unrelated messages may have been decoded, so a generational
  // check distinguishes "nothing has superseded since this attempt started"
  // from "a newer operation already owns the slot".
  let generation = 0

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
    generation += 1
    caller.abort()
    caller = new AbortController()
    return caller.signal
  }

  /**
   * The frontier reason this command cannot be admitted, or null when it may be
   * offered to M1. It mirrors the console's accepted identity, so a command the
   * console has already superseded — a lower epoch after a snapshot or control
   * acknowledgement advanced it — or one for a stopped session never reaches
   * M1's admission and can never start or replace playback.
   */
  const refuse = (command: PerformanceCommand): string | null => {
    if (command.sessionId !== frontier.sessionId) return 'the command names another session'
    if (command.epoch < frontier.epoch) return 'the command is behind the accepted epoch'
    if (frontier.lifecycle === 'stopped') return 'the accepted session is stopped'
    return null
  }

  /**
   * Offer one command over a signal and show its subtitle only if M1 admits it.
   * M1 validates identity, freshness and duplicates ahead of any effect, so a
   * duplicate, stale or rejected command leaves the active output unchanged and
   * must not replace the subtitle of the output that is playing. Admission is
   * read synchronously from a change of the active output between two status
   * reads: M1 emits its admission receipt on a later microtask and the
   * `execute` promise settles only at the end of playback, so neither can be
   * awaited to learn admission.
   */
  const offer = (command: PerformanceCommand, signal: AbortSignal): Promise<PerformanceReceipt> => {
    const before = controller.status()
    const promise = controller.execute(command, { signal })
    const after = controller.status()
    if (after.activeOutputId === command.outputId && after.activeOutputId !== before.activeOutputId) {
      options.onSubtitle(command.subtitleText)
    }
    return promise
  }

  const execute = async (command: PerformanceCommand): Promise<void> => {
    if (disposed) {
      options.onFault(`ignored ${command.outputId}: the local player is disposed`)
      return
    }
    // Fence against the accepted session frontier before M1 sees the command.
    // The console accepts snapshots and control acknowledgements the binding is
    // never asked to perform, so M1's epoch boundary can lag the console: a Stop
    // acknowledgement advances the console to a newer epoch and stopped while M1
    // still admits the epoch it was bootstrapped with. A command the console has
    // already superseded or stopped must not start or replace playback.
    const refusal = refuse(command)
    if (refusal !== null) {
      options.onFault(`ignored ${command.outputId}: ${refusal}`)
      return
    }
    refreshStatus()
    // Capture the owning operation and generation before offering. A busy
    // rejection resumes on a later microtask, after any messages decoded in
    // between, so the retry must know whether the slot it wanted is still the
    // one it saw.
    const ownerAtStart = controller.status().activeOutputId
    const generationAtStart = generation
    // Offer the command over the current caller signal before disturbing
    // anything. M1 validates identity, freshness and duplicates ahead of any
    // effect and binds this signal only when it admits a new operation, so a
    // duplicate, a stale command or a rejected session leaves the operation that
    // is playing untouched. Only an explicit `busy` slot conflict — a different
    // output already admitted — justifies superseding it.
    try {
      await offer(command, caller.signal)
    } catch (error) {
      if (error instanceof PlayerDispatchError && error.code === 'busy') {
        // The slot conflict was only a conflict when this attempt started. A
        // newer output may have been admitted during the await — possibly reusing
        // the caller signal an accepted cancel deliberately left bound
        // (cancel → a newer execute) — and an unconditional supersede would
        // revoke that newer output. Revalidate the owning operation and the
        // generation first; if either changed, re-offer on the current caller so
        // M1 rejects the command on its own terms instead of aborting the owner.
        const stillOwner =
          generation === generationAtStart && controller.status().activeOutputId === ownerAtStart
        try {
          await offer(command, stillOwner ? supersede() : caller.signal)
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
    // An accepted cancel settles the operation M1 owned and removes its abort
    // listener, so this binding must not abort the caller signal here. A newer
    // operation may already be bound to it — a synchronous cancel → execute
    // through an injected transport — and aborting would cancel that newer
    // output. Ownership of the signal stays with whoever admits the next
    // operation; `cancelLocal` and `dispose` still abort whatever is bound.
    refreshStatus()
  }

  return {
    handleServerMessage(message) {
      // Reduce the accepted frontier first: the binding must know every epoch
      // and lifecycle advancement the console accepted, including the snapshot
      // and control acknowledgements M1 is never told about. Performance
      // commands project no session change, so this is a no-op for them.
      frontier = reduceSessionFrontier(frontier, message)
      if (message.kind === 'performance.execute') {
        void execute(message.payload)
        return
      }
      if (message.kind === 'performance.cancel') {
        // `PerformanceCancel` carries no sessionId, so the envelope's session is
        // the only identity check before cancellation reaches M1. A cancel for a
        // different session must not revoke this one's playing output.
        if (message.sessionId !== options.bootstrap.sessionId) {
          options.onFault(`cancel ${message.payload.requestId}: envelope names a different session`)
          return
        }
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
