import { isSubstantiveSpeech } from './text'

/**
 * Salience scoring for confirmed turns.
 *
 * Why this exists: `trimRank` in ./memory-semantics orders victims by persona
 * staleness, truncation and age only. There is no importance dimension, so a
 * high-value old turn (a listener's birthday, a promise, a stated preference)
 * is dropped from context as soon as it is the oldest current-persona turn and
 * the budget is tight. Scoring gives such turns a pin: pinned turns are trimmed
 * LAST, after every unpinned candidate.
 *
 * Hard rules:
 *   - Deterministic heuristics only. No model call, no I/O, so the score is
 *     reproducible offline, costs nothing, and keeps NFR-03 A/B attribution
 *     possible.
 *   - Scores are recomputed at every assembly and never persisted. Persisting
 *     them would be a contract change; recomputation is cheap and cannot drift
 *     from the stored evidence.
 *   - A pin is a trim-order hint, not budget exemption: a pinned turn is still
 *     charged to `maxCharacters` and is still dropped when nothing else fits.
 */

export type SalienceSignal =
  | 'promise'
  | 'preference'
  | 'identity'
  | 'concrete-detail'
  | 'unanswered-question'

export interface SalienceScore {
  score: number
  signals: readonly SalienceSignal[]
}

/**
 * A turn scoring at or above this threshold is pinned. Below it the turn
 * competes on the normal trim order.
 */
export const SALIENCE_PIN_THRESHOLD = 3

/**
 * Maximum pinned turns per assembly. Without a cap, pinned turns could pile up
 * until they themselves consume the whole budget, recreating the problem the
 * pin was meant to solve. Ties keep the older turn: the pin exists to protect
 * important memories formed early.
 */
export const MAX_PINNED_TURNS = 3

const SIGNAL_WEIGHTS: Readonly<Record<SalienceSignal, number>> = {
  promise: 3,
  preference: 2,
  identity: 2,
  'concrete-detail': 1,
  'unanswered-question': 1,
}

/*
 * Keyword tables are data, not configuration: they ship with the module and
 * never come from the environment. Both CJK and English forms are listed
 * because listener input and persona content are not guaranteed to be English.
 */
const PROMISE_PATTERN =
  /记住|答应|约定|别忘了|下次|remember this|promise me|don'?t forget/i
const PREFERENCE_PATTERN =
  /我喜欢|我讨厌|不爱|最爱|i (?:really )?(?:like|love|hate|prefer)|my favorite/i
const IDENTITY_PATTERN = /我叫|叫我|我的名字|my name is|call me/i
const CONCRETE_DETAIL_PATTERN = /\d/
const QUESTION_ENDING_PATTERN = /[?？]["'”’)\]】」]?\s*$/

/**
 * Score one rendered turn text. The result lists every signal that fired so a
 * reviewer can see WHY a turn was pinned; the numeric score alone would not be
 * auditable.
 */
export function scoreSalience(text: string): SalienceScore {
  // Punctuation-only text is not speech (see ./text), so it carries no
  // salience; a trailing '?' in '...!?' is not an unanswered question.
  if (!isSubstantiveSpeech(text)) return { score: 0, signals: [] }
  const signals: SalienceSignal[] = []
  if (PROMISE_PATTERN.test(text)) signals.push('promise')
  if (PREFERENCE_PATTERN.test(text)) signals.push('preference')
  if (IDENTITY_PATTERN.test(text)) signals.push('identity')
  if (CONCRETE_DETAIL_PATTERN.test(text)) signals.push('concrete-detail')
  if (QUESTION_ENDING_PATTERN.test(text)) signals.push('unanswered-question')
  const score = signals.reduce((total, signal) => total + SIGNAL_WEIGHTS[signal], 0)
  return { score, signals }
}
