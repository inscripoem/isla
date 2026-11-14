/**
 * Listener-side history shapes (issue #146 A01, consumed by issue #147 X01).
 *
 * This file is the single authoritative definition site of `ListenerTurn`,
 * `ListenerHistoryQuery`, `ListenerHistoryRead` and `ListenerHistoryPort`.
 * Consumer items reference these types; they must not redeclare them, or the
 * definitions would drift apart.
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
 * One read request over listener history.
 *
 * `dialogueRequestSchema` carries no admission timestamp and no sequence number
 * (src/contracts/app/pipeline.ts is frozen), so the generation boundary is an
 * event id rather than a time. M4 never infers a timestamp or sequence from any
 * other source.
 */
export interface ListenerHistoryQuery {
  sessionId: string
  /** Maximum number of turns to return. The assembler still applies its own cap. */
  limit: number
  /**
   * Event id of the currently selected input. The source returns only turns
   * strictly earlier than this admission position, resolved by the source's own
   * ordering. M4 does not infer an admission timestamp.
   */
  beforeEventId: string
}

/**
 * The three-state outcome of one read — null = the read succeeded (possibly
 * legitimately empty), 'timeout' / 'rejected' = the source was unavailable —
 * kept on the value channel so a failed read never throws across the port.
 *
 * `unavailable` is `null` exactly when the read succeeded; `turns` may
 * legitimately be empty then. On `'timeout'` or `'rejected'` the caller uses no
 * turns at all, whatever the source put in `turns`, and reports the reason.
 */
export interface ListenerHistoryRead {
  turns: readonly ListenerTurn[]
  /** null = the read succeeded (turns may legitimately be empty). */
  unavailable: 'timeout' | 'rejected' | null
}

/**
 * Listener-side history source (issue #147 X01 supplies data; A01 fixes the
 * shape). `recent` is called at most once per `generate`.
 *
 * The source owns the boundary clause: it resolves "strictly earlier than
 * `beforeEventId`" using its own admission ordering, and a turn at or after
 * that position is never returned. M4 cannot check that by time - the request
 * has no admission timestamp - so exclusion of later admissions is the
 * source's contract; M4's guarantee is that it passes the boundary correctly
 * and never invents turns.
 *
 * The contract M4 enforces and re-checks itself: turns come back oldest first
 * and never include the currently selected input, which the prompt already
 * renders on its own `Listener said:` line. The assembler filters the selected
 * input's own event, stably re-orders by `(receivedAtMs, eventId)` and applies
 * its own cap, so given distinct eventIds the outcome is invariant under any
 * order the source returns. A source may return fewer turns than `limit`.
 *
 * A synchronous throw or a rejected promise is treated by the caller as
 * `{ turns: [], unavailable: 'rejected' }`; timeout classification belongs to
 * the returned `unavailable` value, never to a thrown exception.
 */
export interface ListenerHistoryPort {
  recent(query: ListenerHistoryQuery): Promise<ListenerHistoryRead>
}
