import type { AssembledTurn } from './context'

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
}

/** Delivery-memory recall source. */
export interface DeliveryRecallPort {
  recall(request: DeliveryRecallRequest): readonly RecalledTurn[]
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
  return {
    recall(request) {
      const query = tokensOf(request.inputText)
      if (query.size === 0) return []
      const scored: RecalledTurn[] = []
      for (const turn of request.candidates) {
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
