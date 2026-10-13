import type { CallContext } from '../../contracts/app'

/**
 * Browser-safe shared declarations for the M1 performance adapters.
 * This module is part of the browser-safe M1 subtree that M2 may import; its
 * transitive imports must remain free of Node, backend and test code. The three
 * declarations here are used by both the backend mapped renderer and the future
 * browser player, so they live in the browser-safe module rather than in either
 * adapter. Backend adapters may import these as types only.
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