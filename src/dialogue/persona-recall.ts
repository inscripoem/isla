/**
 * On-demand recall of persona facts - the INTERFACE AND THE SWITCH. The
 * implementation is left to layer L3.
 *
 * Why the seam lands before the implementation:
 *   1. Once the interface shape is fixed in M4-01, the A/B attribution for NFR-03
 *      is fixed with it: the "recall on / off" axis has to exist before anyone can
 *      compare recall's contribution to character consistency.
 *   2. The switch defaults to `off`, so existing behaviour is unchanged in every
 *      respect: with no recall the context is identical to today's, and the M4
 *      tests are unaffected.
 *
 * Why it is kept separate from delivery memory:
 *   - Delivery memory is EVIDENCE (what she said). It must pass FR-02 admission and
 *     travel through `MemoryCommitPort`.
 *   - Persona facts are a NORM (who she is). They come from the character bible,
 *     where "did the audience hear it" does not apply, so they do NOT pass
 *     admission, do NOT enter `confirmedHistory` and never claim "she said this".
 *   The two may share a retrieval mechanism, but the data sources must stay apart.
 *
 * Hard constraints the implementation must obey:
 *   - Deduplicate against `standingFacts`: a fact already rendered every turn must
 *     not be recalled again.
 *   - Do NOT open a second budget: the recall block shares
 *     `contextLimits.maxCharacters` with confirmed history, so the more is
 *     recalled, the less room history has. Context assembly enforces that cap, so
 *     a port returning more than fits will have the excess dropped.
 *   - Every recalled item must carry provenance (which bible entry it came from)
 *     so a reviewer can trace it.
 */

/** Recall policy. Defaults to `off` so A/B and NFR-03 attribution stay possible. */
export type PersonaRecallPolicy = 'off' | 'keyword'

export const PERSONA_RECALL_POLICY: PersonaRecallPolicy = 'off'

/**
 * Maximum number of facts a single recall may inject.
 *
 * The same order of magnitude as `MAX_STANDING_FACTS`: the standing block already
 * takes a large share of the budget, and a larger recall block would crowd out the
 * recent conversation it is supposed to support.
 */
export const MAX_RECALLED_FACTS = 5

/** One recallable persona fact. `id` must resolve inside the character bible. */
export interface PersonaFact {
  /** Stable identifier, used for deduplication and provenance rendering. */
  id: string
  /** Fact text, rendered into the prompt. */
  text: string
  /** Trigger keywords; a hit in this turn's message or recent history scores it. */
  keywords: readonly string[]
  /** Extra score when one of these intents is active. */
  intents?: readonly string[]
}

/** A recall result, with provenance. */
export interface RecalledFact {
  fact: PersonaFact
  score: number
}

/**
 * Recall input: the current message, recent history and the intent only. No extra
 * model call is made.
 *
 * `replyIntent` is carried for a future intent-aware ranking rule but is not
 * consumed by the implementations today. It can only rank among facts already
 * eligible under M4's policies; it never grants access or changes ownership
 * (M3 coordination, issue #44 §1). `PersonaFact.intents` has no consumer in the
 * tree yet; intent-aware ranking is follow-up work with explicit rules and tests.
 */
export interface PersonaRecallRequest {
  inputText: string
  recentHistory: readonly string[]
  replyIntent: string
  /** Fact texts already standing every turn, used for deduplication. */
  standingFacts: readonly string[]
}

/**
 * Persona fact source and recall implementation.
 *
 * The implementation must be DETERMINISTIC scoring, with no extra model call: zero
 * latency, zero cost, reproducible (NFR-03 human evaluation needs that), testable
 * offline, and clear of the campus gateway rate limit. If an LLM or embedding
 * implementation replaces it later, the interface stays the same.
 */
export interface PersonaRecallPort {
  recall(request: PersonaRecallRequest): readonly RecalledFact[]
}

/**
 * The empty recall implementation used under the `off` policy.
 *
 * It returns an empty result rather than throwing, so callers need no branch for
 * "recall is not enabled" and context assembly keeps a single code path.
 */
export function createDisabledPersonaRecall(): PersonaRecallPort {
  return {
    recall() {
      return []
    },
  }
}
