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
 *
 * A cue list is a precision instrument, not a thesaurus: every entry has to be
 * a form that actually marks the signal in speech. "一定" alone ("那一定很好")
 * asserts a likelihood, not a promise, so only the emphatic constructions that
 * carry commitment are listed. CJK emphasis is spelled out because a Chinese
 * listener marks a promise with "千万"/"务必"/"别再忘了" rather than with the
 * English-shaped "记住" the first version only knew.
 */
const PROMISE_PATTERN =
  /记住|记得|答应|约定|说好了|说定了|拉钩|保证|发誓|承诺|许诺|允诺|一言为定|包在我身上|说到做到|别忘了|别再忘了|务必|千万(?:要|别)|一定(?:要|得|会)?记得|不忘|remember (?:this|that|me)|make sure|be sure|never forget|always remember|keep in mind|i promise|i promised|promised|don'?t forget|i swear|cross my heart|you have my word/i
const PREFERENCE_PATTERN =
  /我喜欢|我爱|我讨厌|我不喜欢|不爱|(?:最|很|超|真的|挺|比较)喜欢|(?:最|很|超)讨厌|最爱|超爱|特别爱|爱死|讨厌死了|烦死了|着迷|痴迷|更喜欢|我偏好|偏好|受不了|我宁愿|吃不(?:了|消)|i (?:really )?(?:like|love|hate|prefer)|my favorit|i can'?t stand|i'?d rather|obsessed with|can'?t get enough/i
const IDENTITY_PATTERN =
  /我叫|我的名字|大家都叫我|朋友(?:都)?叫我|观众(?:都)?叫我|请叫我|你可以叫我|我来自|我生日|我的生日|my name is|call me|my birthday|i'?m called/i

/*
 * Concrete detail, refined. The previous signal was `/\d/`: ANY digit scored,
 * so a turn mentioning "one of the 3 things" pinned itself, and a real date had
 * no more weight than a list index. A digit is only worth remembering when it
 * identifies something - a time, a quantity with a unit, or a multi-digit
 * identifier such as a date, a price or a room number. A bare single digit
 * carries none of that and no longer fires.
 */
/**
 * A date or clock time. Every alternative pairs a NUMBER with a time unit, or
 * names a specific month/day. Bare time words ("今天", "晚上") are deliberately
 * absent: they appear in ordinary chatter and would re-introduce the noise this
 * refinement removes. CJK weekdays ("周五", "星期三") name a specific day the
 * way an English weekday does, so they belong here; "周末" stays out with the
 * other bare time words, because it names no day at all.
 */
const TIME_PATTERN =
  /\d{1,4}\s*[年月日号点时分秒]|\d{1,2}\s*[:：]\s*\d{2}|\d{4}\s*[-/.]\s*\d{1,2}(?:\s*[-/.]\s*\d{1,2})?|(?:january|february|march|april|may|june|july|august|september|october|november|december)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:周|星期)[一二三四五六日天]/i
/** A quantity attached to a unit, which is what makes the number mean something. */
const QUANTITY_PATTERN =
  /\d+\s*(?:%|percent|个|只|条|件|位|次|回|遍|天|周|月|年|岁|块|元|美元|杯|本|页|盘|份|公里|km|kg|公斤|克|米|cm|厘米|小时|分钟|分|秒|度|倍|楼|号|点)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:times?|days?|weeks?|months?|years?|hours?|minutes?|seconds?|people|persons?|dollars?|bucks|pages?|copies?|kids?|cats?|dogs?)/i
/**
 * A multi-digit identifier: a birthday, a price, a year, a room or an order
 * number. Length alone is the signal; it needs no unit to be worth keeping.
 */
const IDENTIFIER_PATTERN = /\d{2,}/

const QUESTION_ENDING_PATTERN = /[?？]["'”’)\]】」]?\s*$/

/** True when the text names something concrete worth remembering. */
function hasConcreteDetail(text: string): boolean {
  return (
    TIME_PATTERN.test(text) || QUANTITY_PATTERN.test(text) || IDENTIFIER_PATTERN.test(text)
  )
}

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
  if (hasConcreteDetail(text)) signals.push('concrete-detail')
  if (QUESTION_ENDING_PATTERN.test(text)) signals.push('unanswered-question')
  const score = signals.reduce((total, signal) => total + SIGNAL_WEIGHTS[signal], 0)
  return { score, signals }
}
