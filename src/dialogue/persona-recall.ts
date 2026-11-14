/**
 * On-demand recall of persona facts - the INTERFACE AND THE IMPLEMENTATIONS.
 *
 * Why the seam landed before the implementation:
 *   1. Once the interface shape was fixed in M4-01, the A/B attribution for NFR-03
 *      was fixed with it: the "recall on / off" axis has to exist before anyone can
 *      compare recall's contribution to character consistency.
 *   2. Enablement is the composition wiring, not a constant. A caller that omits
 *      `personaRecall` gets an empty recall, so the context is identical to
 *      running without the feature. `PERSONA_RECALL_POLICY` declares which
 *      strategy this module ships; it is not a switch, and production wiring still
 *      omits the port, so the running default stays off.
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

import { CHARACTER_CONTENT } from './persona-content'
import { contentTokensOf } from './memory-recall'

/**
 * Recall policy.
 *
 * Declared, not a switch: whether recall runs is decided by composition wiring -
 * `createDialoguePort` only forwards a `personaRecall` it was given, and the
 * production composition supplies none, so the running default stays off and the
 * A/B axis for NFR-03 attribution stays possible. The value names the strategy
 * this module ships alongside the port, `createKeywordPersonaRecall`.
 */
export type PersonaRecallPolicy = 'off' | 'keyword'

export const PERSONA_RECALL_POLICY: PersonaRecallPolicy = 'keyword'

/**
 * Maximum number of facts a single recall may inject.
 *
 * The same order of magnitude as `MAX_STANDING_FACTS`: the standing block already
 * takes a large share of the budget, and a larger recall block would crowd out the
 * recent conversation it is supposed to support.
 */
export const MAX_RECALLED_FACTS = 5

/**
 * How many trailing `recentHistory` turns the scan window covers.
 *
 * The current message plus these turns are tokenized as one query. Unlike the
 * delivery-recall port, the assembly hands this port only the turns that survived
 * the recency window, so the slice is a bound, not a second window.
 */
export const PERSONA_RECALL_SCAN_TURNS = 3

/**
 * Extra score when `PersonaFact.intents` contains the active `replyIntent`.
 *
 * Ranking only: an intent can reorder facts that already cleared the keyword
 * admission bar, and can never admit one on its own (M3 coordination, issue #44
 * §1).
 */
export const INTENT_BONUS = 0.5

/**
 * Admission bar. A fact needs at least this many distinct keyword hits to be
 * recalled; intent never substitutes for a hit.
 */
export const PERSONA_RECALL_MIN_KEYWORD_HITS = 1

/**
 * Query-side synonym/inflection groups. If any member appears in the scan window,
 * every member counts as present.
 *
 * Each group must keep at least one member that is a keyword of some pool fact, so
 * no dead group ships (enforced by test). A member may also be an inflection that
 * appears in no fact text - `exhausted` and `熬夜` exist so a message phrased that
 * way still reaches `exhaustion` - and such members are exempt from the rule that
 * a keyword be a token of its own fact text.
 */
export const KEYWORD_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['exhaustion', 'exhausted', '疲劳', '熬夜'],
  ['teasing', 'tease', 'teased', '可爱'],
  ['rest', 'resting', '休息'],
  ['evenings', 'evening', '晚上'],
]

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
  /**
   * Bible section the entry was parsed from (`recallFactsFromBible`). Review and
   * test evidence only: it is never rendered, because `renderRecallLine` uses the
   * id and text alone.
   */
  source?: string
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
 * `replyIntent` is consumed only as a ranking bonus by
 * `createKeywordPersonaRecall`: it can only reorder facts already admitted by a
 * keyword hit, and never grants access or changes ownership (M3 coordination,
 * issue #44 §1). The disabled implementation ignores it. The request carries no
 * model call and no extra I/O.
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
 * The empty recall implementation used when recall is not enabled.
 *
 * It returns an empty result rather than throwing, so callers need no branch for
 * "recall is not enabled" and context assembly keeps a single code path. Passing
 * it explicitly renders exactly what omitting the port renders.
 */
export function createDisabledPersonaRecall(): PersonaRecallPort {
  return {
    recall() {
      return []
    },
  }
}

/**
 * Deterministic keyword persona recall.
 *
 * The pool defaults to the authored bible `[R]` pool; tests inject their own. One
 * keyword hit admits a fact; `replyIntent` only reorders the admitted facts
 * (+`INTENT_BONUS`); facts whose text already stands every turn are dropped before
 * scoring. Pure function of the request: no model call, clock, randomness or I/O,
 * so the same request always yields the same result (NFR-04).
 *
 * The cap is not enforced here. A port may return more than `MAX_RECALLED_FACTS`;
 * context assembly takes the first entries that fit and records every dropped one.
 */
export function createKeywordPersonaRecall(
  facts: readonly PersonaFact[] = CHARACTER_CONTENT.recallFacts,
): PersonaRecallPort {
  return {
    recall(request) {
      // The recentHistory array is oldest-first, so the window is its tail.
      const window = [
        request.inputText,
        ...request.recentHistory.slice(-PERSONA_RECALL_SCAN_TURNS),
      ]
      const present = new Set<string>()
      for (const text of window) {
        for (const token of contentTokensOf(text).keys()) present.add(token)
      }
      if (present.size === 0) return []

      // Query-side expansion: one member in the window makes the whole group
      // count as present, so an inflection reaches the keyword it stands for.
      for (const group of KEYWORD_ALIAS_GROUPS) {
        if (!group.some((member) => present.has(member))) continue
        for (const member of group) present.add(member)
      }

      const standing = new Set(request.standingFacts.map((text) => text.trim()))
      const scored: RecalledFact[] = []
      for (const fact of facts) {
        if (standing.has(fact.text.trim())) continue
        const hits = new Set(fact.keywords.filter((keyword) => present.has(keyword))).size
        if (hits < PERSONA_RECALL_MIN_KEYWORD_HITS) continue
        const bonus = fact.intents?.includes(request.replyIntent) === true ? INTENT_BONUS : 0
        scored.push({ fact, score: hits + bonus })
      }

      // Descending score; the sort is stable, so ties keep pool order.
      return scored.sort((left, right) => right.score - left.score)
    },
  }
}

/**
 * DECLARED, NOT IMPLEMENTED: a future lightweight selector that resolves facts by
 * an explicit QID instead of keyword scoring. No consumer exists in the tree, and
 * nothing here depends on it; it is recorded so the selector's shape is fixed
 * before the pool grows past what keyword scoring can serve.
 */
export interface PersonaSelectorPort {
  select(request: PersonaRecallRequest): readonly PersonaFact[]
}
