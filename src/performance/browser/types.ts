import type {
  CallContext,
  PerformanceCancel,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerStatus,
} from '../../contracts/app'

/**
 * Browser-safe shared declarations for the M1 performance adapters.
 * This module is part of the browser-safe M1 subtree that M2 may import; its
 * transitive imports must remain free of Node, backend and test code. The
 * declarations here are used by both the backend mapped renderer and the
 * browser player, so they live in the browser-safe module rather than in
 * either adapter. Backend adapters may import these as types only.
 *
 * `Blob` is deliberately part of the local browser resolver/driver contracts:
 * it is a browser-safe platform type and never crosses a JSON wire boundary.
 */

/**
 * A binding produced by a {@link DeadlineGate}. `signal` aborts when the
 * server deadline expires or the owner cancels; `release()` must be called once
 * by whoever bound the gate, and is idempotent and non-throwing.
 */
export interface DeadlineBinding {
  readonly signal: AbortSignal
  release(): void
}

/**
 * Binds an original {@link CallContext} into a server-domain abort signal. The
 * bound signal is already aborted if expired, and is later aborted by the
 * arena's scheduler in the same clock domain. The gate cannot lengthen the
 * original deadline.
 */
export interface DeadlineGate {
  bind(context: CallContext): DeadlineBinding
}

/**
 * Identifier and timestamp helpers supplied by the owner so adapters produce
 * stable unique receipts and honest local observation times.
 */
export interface ReceiptTools {
  newReceiptId(): string
  localNowMs(): number | null
}

/**
 * An owned, opaque audio resource returned by an {@link AudioResolver}. The
 * `blob` is local media data; `release()` returns the resource to its owner and
 * is idempotent and non-throwing. A lease never travels over the wire.
 */
export interface AudioLease {
  readonly blob: Blob
  release(): void
}

/**
 * Maps a registered opaque audio reference to an owned Blob lease. The resolver
 * must never treat a reference as a filename, URL or direct `src`; it resolves
 * only references it was configured for. It may fail, settle late, and should
 * honor the signal when it can, but cancellation cooperation is not assumed.
 */
export interface AudioResolver {
  resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease>
}

/** Observed media events from one playback handle. */
export type MediaEvent =
  | { readonly type: 'playing' }
  | { readonly type: 'ended' }
  | { readonly type: 'error'; readonly reasonCode: string }

/**
 * A single playback handle. The controller subscribes before loading and
 * playing; it observes actual playback through `playing`, never through the
 * fulfillment of `play()`.
 */
export interface MediaHandle {
  subscribe(listener: (event: MediaEvent) => void): () => void
  load(blob: Blob): void
  play(): Promise<void>
  /** Synchronous, non-throwing, idempotent local detachment observation. */
  detach(): boolean
}

/** Creates independent media handles for successive outputs. */
export interface MediaDriver {
  create(): MediaHandle
}

/**
 * Local execution context for the browser player. The signal aborts on owner
 * cancellation or a server-domain deadline; it is never serialized and carries
 * no deadline field of its own.
 */
export interface PlaybackContext {
  readonly signal: AbortSignal
}

/** Local rejection code for an inadmissible playback call (never a performance fact). */
export type PlayerDispatchErrorCode =
  | 'conflict'
  | 'busy'
  | 'stale'
  | 'stale_cancel'
  | 'session_mismatch'
  | 'invalid_command'
  | 'unavailable'

/**
 * Rejection of an inadmissible call. It is an admission error, not an observed
 * failed performance, so it never produces a `failed` performance receipt.
 */
export class PlayerDispatchError extends Error {
  readonly code: PlayerDispatchErrorCode

  constructor(code: PlayerDispatchErrorCode) {
    super(`m1-player: dispatch rejected (${code})`)
    this.name = 'PlayerDispatchError'
    this.code = code
  }
}

/**
 * Single-output browser playback controller. It owns admission, the one active
 * operation, current-epoch duplicate records and terminal cleanup. It never
 * invokes a renderer, schedules turns or commits history.
 */
export interface PlaybackController {
  execute(command: PerformanceCommand, context: PlaybackContext): Promise<PerformanceReceipt>
  cancel(request: PerformanceCancel): Promise<PerformanceReceipt | null>
  status(): PlayerStatus
  dispose(): void
}

export interface PlaybackDeps {
  readonly sessionId: string
  readonly initialEpoch: number
  readonly resolver: AudioResolver
  readonly media: MediaDriver
  readonly receipts: ReceiptTools
  readonly onReceipt: (receipt: PerformanceReceipt) => void
  readonly reportFault: (error: unknown) => void
}