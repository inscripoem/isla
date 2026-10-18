import type { AssembledTurn } from './context'
import { isDurableAudience, normalizeAudience } from './audience'
import type { AudienceIdentity, MemoryScope } from './audience'

/**
 * Delivery-memory recall: bring back confirmed turns that aged out of the
 * context window but are relevant to what the listener just said.
 *
 * Why this is separate from ./persona-recall:
 *   - Persona recall serves NORM facts (who she is) from the character bible.
 *   - This port serves EVIDENCE (what was actually said) from confirmed
 *     history. The two data sources stay apart, exactly as delivery memory and
 *     persona facts stay apart everywhere else.
 *
 * Latency and cost constraints (why the candidates arrive pre-fetched):
 *   - Context assembly already loads the full confirmed history for the session
 *     before the turn window is applied, so recall over the dropped remainder
 *     adds NO extra I/O and no model call. The M6 port does not need a search
 *     method for this stage.
 *   - The implementation must stay deterministic (keyword scoring), for the
 *     same reasons as persona recall: zero cost, reproducible for NFR-03,
 *     testable offline. An embedding/LLM scorer could replace it later without
 *     changing the interface.
 *
 * Budget rule: recalled turns are charged to the same `maxCharacters` as
 * persona recall and recent history. Context assembly enforces the cap; a port
 * returning more than fits will have the excess dropped with an exclusion.
 */

/** Maximum recalled turns injected per assembly. */
export const MAX_RECALLED_TURNS = 3

/**
 * Minimum keyword overlap for a candidate to qualify. One shared word is too
 * weak a signal and would surface near-random old turns; two is the cheapest
 * bar that still catches genuine topical callbacks.
 */
export const MIN_RECALL_SCORE = 2

/** One recalled turn, with the score that selected it. */
export interface RecalledTurn {
  turn: AssembledTurn
  score: number
}

/** Recall input: the current message and the turns dropped by the turn window. */
export interface DeliveryRecallRequest {
  inputText: string
  replyIntent: string
  /** Confirmed turns that aged out of the recency window, oldest first. */
  candidates: readonly AssembledTurn[]
  /**
   * The session the recall is being performed FOR.
   *
   * Required because a candidate's own `sessionId` cannot answer the question:
   * without the requesting session there is nothing to compare it against, and a
   * guard that compares two unknowns passes everything.
   */
  sessionId: string
  /**
   * Scope of the requesting turn. Absent means `'session-only'`, the safe
   * direction: a caller that has not thought about scope gets the stricter rule.
   */
  scope?: MemoryScope
  /** Who is listening; absent means anonymous, and therefore never durable. */
  audience?: AudienceIdentity
  /**
   * Audience that owns each candidate's memory, when the candidate came from a
   * long-lived store. Absent means the candidate has no recorded owner, which
   * is treated as no match.
   */
  ownerAudienceIdOf?: (turn: AssembledTurn) => string | null
}

/** Delivery-memory recall source. */
export interface DeliveryRecallPort {
  recall(request: DeliveryRecallRequest): readonly RecalledTurn[]
  /**
   * Candidates refused for crossing a session boundary, by the most recent call
   * to `recall`.
   *
   * Read-only and for auditing only. A refused candidate is the kind of loss
   * that would otherwise be invisible: the port did exactly its job, so nothing
   * failed and no warning fired, yet a memory the user might expect is absent.
   * The count lets the caller say so. Exposed as a counter rather than as
   * per-turn detail so the port stays stateless and deterministic.
   *
   * Optional: a port that filters silently is still correct, it just cannot
   * report what it refused. The built-in port always reports.
   */
  readonly crossSessionDrops?: number
}

/**
 * Whether one candidate may be recalled in this request.
 *
 * Same-session candidates are always allowed: that is ordinary recall, and it
 * carries no disclosure risk because the listener is the one who already heard
 * those words.
 *
 * A candidate from ANOTHER session is a different matter, and this is where the
 * guard earns its keep. Such a candidate was produced for some earlier listener,
 * possibly a different person. A cross-session recall therefore requires BOTH:
 *   1. the current identity is durable (an anonymous or per-session temporary id
 *      never qualifies - M5 ruled the latter does not make memory durable); and
 *   2. the candidate is `audience-bound`, which assembly derived from that same
 *      identity when the candidate was admitted.
 *
 * When the source records an OWNER for the candidate, the ids must also match
 * exactly. That check is skipped when no owner is recorded, because an absent
 * owner is missing evidence rather than a mismatch - refusing every candidate
 * from a store that simply has no owner column would disable cross-session
 * recall entirely. Recorded as a known limitation rather than left silent: once
 * M6 persists an owner per durable record, this branch disappears and the id
 * comparison becomes unconditional.
 *
 * The check runs BEFORE scoring, so a cross-session candidate cannot influence
 * the result even when it would be dropped later anyway.
 */
export function mayRecallCandidate(request: DeliveryRecallRequest, turn: AssembledTurn): boolean {
  if (turn.sessionId === request.sessionId) return true
  if (!isDurableAudience(request.audience)) return false
  if (turn.scope !== 'audience-bound') return false
  const owner = request.ownerAudienceIdOf?.(turn)
  if (owner === undefined) return true
  const current = normalizeAudience(request.audience)
  if (current.kind !== 'identified' && current.kind !== 'pseudonymous') return false
  return owner === current.audienceId
}

/*
 * Stopwords are the words that appear in almost every listener message; letting
 * them score would make every old turn "relevant". The list stays small and
 * English-only because CJK tokens are bigrams, which are specific enough.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'you', 'your', 'yours', 'what', 'did',
  'say', 'said', 'about', 'are', 'was', 'were', 'is', 'it', 'its', 'to', 'of',
  'in', 'on', 'for', 'with', 'me', 'my', 'we', 'our', 'do', 'does', 'how',
  'that', 'this', 'tell',
])

/**
 * Tokenize for overlap scoring: latin words of 3+ letters, plus CJK bigrams.
 * CJK bigrams are used because single characters carry almost no topical
 * signal and whole runs would never match across phrasings.
 */
function tokensOf(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9]+/g)) {
    const word = match[0]
    if (word.length >= 3 && !STOPWORDS.has(word)) tokens.add(word)
  }
  for (const match of lower.matchAll(/[一-鿿]+/g)) {
    const run = match[0]
    for (let index = 0; index + 2 <= run.length; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  return tokens
}

/**
 * Keyword-overlap recall. Candidates score by shared tokens with the listener's
 * message; results are ordered by score (ties keep the older turn first, so the
 * budget cap drops the newest of equals rather than the earliest memory).
 */
export function createKeywordDeliveryRecall(): DeliveryRecallPort {
  let dropped = 0
  return {
    get crossSessionDrops(): number {
      return dropped
    },
    recall(request) {
      dropped = 0
      const query = tokensOf(request.inputText)
      if (query.size === 0) return []
      const scored: RecalledTurn[] = []
      for (const turn of request.candidates) {
        /*
         * Scope guard first. Scoring a forbidden candidate would let a
         * cross-session memory compete for the budget before being discarded,
         * which is a subtler leak than returning it: it changes what ELSE gets
         * recalled. Refusing here keeps the result independent of who is not
         * allowed to be heard.
         */
        if (!mayRecallCandidate(request, turn)) {
          dropped += 1
          continue
        }
        const turnTokens = tokensOf(turn.text)
        let score = 0
        for (const token of query) {
          if (turnTokens.has(token)) score += 1
        }
        if (score >= MIN_RECALL_SCORE) scored.push({ turn, score })
      }
      scored.sort((left, right) => right.score - left.score)
      return scored
    },
  }
}
