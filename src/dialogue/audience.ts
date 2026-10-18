/**
 * Audience identity and memory scope.
 *
 * Why this file exists. `sessionId` names a RUNNING session, not a listener. Two
 * different people can share one session id over a broadcast, and one person
 * gets a fresh id every time they reconnect, so a session id alone cannot say
 * whose memory is being kept. Without this distinction there is nothing that
 * stops a durable record about one listener from being recalled in front of
 * another.
 *
 * Division of authority.
 *   M4 owns SCOPE: given a kind of memory and an audience identity, it decides
 *   whether that memory may ever be treated as lasting beyond one session. M4
 *   does NOT own identity issuance, does not authenticate anybody, and does not
 *   decide who may READ a memory. A scope decision is a claim about how long a
 *   memory is allowed to live, not an access-control decision.
 *
 *   Nothing here is an M6 contract. The field names are chosen to line up with
 *   the durable record M6 will eventually carry, but this type is M4-local on
 *   purpose: M4 must be able to state its rules before the storage schema that
 *   will have to satisfy them exists.
 *
 * The rule that shapes everything else: ANONYMOUS IS NOT DURABLE. A session that
 * never established who was listening produces memory that dies with the
 * session. M5 settled this - a per-session temporary id does not make a memory
 * durable, because the id itself dies with the session and "durable" would only
 * mean "until the process restarts". An ephemeral id is therefore recognised
 * here (a later contract may need to carry it) but never grants durability.
 */

/**
 * Who is listening.
 *
 * - `anonymous`: nobody identified the listener. The default when a caller
 *   supplies nothing, so forgetting to pass an identity fails safe.
 * - `session-ephemeral`: an id exists but was minted for this session only. It
 *   identifies records within the session and NOTHING beyond it. Settled by M5.
 * - `identified`: a stable id that outlives sessions, with no personal name
 *   attached. Only this kind can anchor a durable memory.
 * - `pseudonymous`: a stable id plus a label the character may display. The label
 *   is presentational; durability is decided by the id exactly as above.
 */
export type AudienceIdentity =
  | { kind: 'anonymous' }
  | { kind: 'session-ephemeral'; audienceId: string }
  | { kind: 'identified'; audienceId: string }
  | { kind: 'pseudonymous'; audienceId: string; label: string }

/** The identity assumed when a caller supplies none. Fails safe by design. */
export const ANONYMOUS_AUDIENCE: AudienceIdentity = { kind: 'anonymous' }

/**
 * Normalise a possibly-absent identity.
 *
 * An empty or whitespace-only id is treated as no identity rather than as a
 * malformed one: a blank id carries exactly as much information as a missing
 * field, and neither may anchor durable memory.
 */
export function normalizeAudience(audience: AudienceIdentity | undefined): AudienceIdentity {
  if (audience === undefined) return ANONYMOUS_AUDIENCE
  if (audience.kind === 'anonymous') return ANONYMOUS_AUDIENCE
  if (audience.audienceId.trim().length === 0) return ANONYMOUS_AUDIENCE
  return audience
}

/**
 * True when this identity may anchor memory beyond a single session.
 *
 * Only `identified` and `pseudonymous` qualify. `session-ephemeral` is excluded
 * on M5's ruling: an id that expires with its session cannot carry a promise
 * about the next one.
 */
export function isDurableAudience(audience: AudienceIdentity | undefined): boolean {
  const normalized = normalizeAudience(audience)
  return normalized.kind === 'identified' || normalized.kind === 'pseudonymous'
}

/**
 * How long a memory is allowed to live.
 *
 * - `session-only`: dies with the session. Never eligible for cross-session
 *   recall, whatever else is true about it.
 * - `audience-bound`: may be retained across sessions, but ONLY for the audience
 *   it belongs to. This is a floor for durability, not a grant of it: a
 *   session-only memory stays session-only.
 */
export type MemoryScope = 'session-only' | 'audience-bound'

/**
 * What a memory is about.
 *
 * The kind decides the scope floor. A kind exists because the same delivery
 * evidence can be harmless for one kind and a leak for another: "my birthday is
 * in June" needs no more evidence than "we talked about the concert", but it
 * belongs to a person rather than to a conversation.
 */
export type MemoryKind =
  /** Something the character said and the listener heard. */
  | 'utterance'
  /** A fact the listener disclosed about themselves. */
  | 'listener-fact'
  /** Sensitive or intimate content. Never eligible for the persona bible. */
  | 'private-content'
  /** A fact about the character. Belongs to the bible, not to memory. */
  | 'persona-fact'

/** Why a memory holds the scope it holds. Recorded so the decision is auditable. */
export type MemoryScopeReason =
  | 'audience-bound'
  | 'anonymous-audience'
  | 'ephemeral-audience-id'
  | 'persona-fact-not-memory'

export interface MemoryScopeDecision {
  scope: MemoryScope
  reason: MemoryScopeReason
  /**
   * True when the memory may be RETAINED beyond its session. Distinct from
   * `scope`: an `audience-bound` memory under an anonymous audience is still not
   * durable, and saying otherwise would let a session-scoped fact be filed as a
   * long-term one on the strength of its category alone.
   */
  durable: boolean
}

/**
 * Decide the scope floor for a memory, and whether it can actually be retained.
 *
 * Rules, in order:
 *   1. A `persona-fact` is never audience memory. It describes the character, so
 *      it belongs to the bible and is rendered from there every turn. Filing it
 *      as memory would create a second, drifting copy of who she is.
 *   2. `private-content` and `listener-fact` describe a PERSON. Without a
 *      durable identity there is nobody to attach them to, so they degrade to
 *      `session-only` rather than being kept under a placeholder.
 *   3. `utterance` under an anonymous audience is `session-only`: the words were
 *      really said, but with no listener to remember them for, keeping them
 *      would mean keeping an unattributed transcript.
 *
 * A scope floor never upgrades anything: `scopeFor` can only ever return
 * `session-only` or the `audience-bound` floor for its kind. Callers still have
 * to decide whether a memory is worth keeping at all.
 */
export function scopeFor(kind: MemoryKind, audience: AudienceIdentity | undefined): MemoryScopeDecision {
  const normalized = normalizeAudience(audience)

  if (kind === 'persona-fact') {
    return { scope: 'session-only', reason: 'persona-fact-not-memory', durable: false }
  }

  if (normalized.kind === 'anonymous') {
    return { scope: 'session-only', reason: 'anonymous-audience', durable: false }
  }

  if (normalized.kind === 'session-ephemeral') {
    return { scope: 'session-only', reason: 'ephemeral-audience-id', durable: false }
  }

  return { scope: 'audience-bound', reason: 'audience-bound', durable: true }
}

/**
 * Whether a memory may be recalled in a DIFFERENT session from the one that
 * produced it.
 *
 * Three conditions, all required:
 *   1. the memory holds `audience-bound` scope;
 *   2. the identity that can retain it is durable;
 *   3. the CURRENT listener carries the SAME stable id.
 *
 * Condition 3 is why scope alone is not enough. A durable memory recalled for a
 * different audience would be a leak, so the ids must match exactly. Missing or
 * blank ids are treated as no match: an unidentifiable listener can never satisfy
 * an audience check.
 */
export function mayRecallAcrossSessions(input: {
  scope: MemoryScope
  ownerAudienceId: string | null | undefined
  currentAudience: AudienceIdentity | undefined
}): boolean {
  if (input.scope !== 'audience-bound') return false
  if (!isDurableAudience(input.currentAudience)) return false
  const owner = input.ownerAudienceId
  if (typeof owner !== 'string' || owner.trim().length === 0) return false
  const current = normalizeAudience(input.currentAudience)
  if (current.kind !== 'identified' && current.kind !== 'pseudonymous') return false
  return owner === current.audienceId
}