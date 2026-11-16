/**
 * Listener-side history shapes (issue #146 A01, consumed by issue #147 X01).
 *
 * This file is the single authoritative definition site of `ListenerTurn` and
 * `ListenerHistoryPort`. Consumer items reference these types; they must not
 * redeclare them, or the two definitions would drift apart.
 */

/**
 * One listener utterance projected from a runtime InputEvent. The projection is
 * a shape only: storage, admission and retention stay owned by their modules.
 */
export interface ListenerTurn {
  /**
   * Source runtime event id of the accepted input, derived from the submit
   * message id at src/runtime/coordinator.ts:1116 and unique among inputs
   * accepted in one runtime session (enforced by the submit-path idempotency
   * check there, coordinator.ts:1084-1092). Ordering never depends on this
   * uniqueness: equal `(receivedAtMs, eventId)` pairs fall back to input order.
   */
  eventId: string
  /** Session the input was accepted in. */
  sessionId: string
  /** Verbatim listener text. Untrusted content: rendered, never followed. */
  text: string
  /** Injected-clock milliseconds at which the input was accepted. */
  receivedAtMs: number
  /** Durable actor identity when one is known; null when anonymous. */
  actorId: string | null
  /** Listener turns are audience speech; control traffic never takes this shape. */
  trust: 'untrusted-content'
}

/**
 * Listener-side history source (issue #147 X01 supplies data; A01 only fixes the
 * shape). The contract, enforced by callers and re-checked by the assembler:
 * turns come back oldest first and never include the currently selected input,
 * which the prompt already renders on its own `Listener said:` line. The
 * assembler re-checks both clauses itself - it filters the selected input's own
 * event and stably re-orders by `(receivedAtMs, eventId)` before any cap or
 * budget decision - so given distinct eventIds the outcome is invariant under
 * any order the source returns.
 *
 * `limit` is the caller's `contextLimits.maxTurns`; a source may return fewer
 * turns than asked for, and the assembler still applies its own cap.
 */
export interface ListenerHistoryPort {
  recent(sessionId: string, limit: number): Promise<readonly ListenerTurn[]>
}
