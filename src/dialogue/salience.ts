import { isSubstantiveSpeech } from './text'

/**
 * Salience scoring for confirmed and listener turns (v2).
 *
 * Why this exists: `trimRank` in ./memory-semantics orders victims by persona
 * staleness, truncation and age only. There is no importance dimension, so a
 * high-value old turn (a listener's birthday, a promise, a stated preference)
 * is dropped from context as soon as it is the oldest current-persona turn and
 * the budget is tight. Scoring gives such turns a pin: pinned turns are trimmed
 * LAST, after every unpinned candidate.
 *
 * Hard rules:
 *   - Deterministic heuristics only. No model call, no I/O, no clock read inside
 *     this module (age arrives as a parameter). Scores are recomputed per
 *     assembly and never persisted.
 *   - A pin is a trim-order hint, not budget exemption: a pinned turn is still
 *     charged to `maxCharacters` and is still dropped when nothing else fits.
 */

export type SalienceRole = 'listener' | 'character'

export type SalienceSignal =
  | 'self-disclosure'
  | 'preference'
  | 'promise'
  | 'relationship'
  | 'emotion-peak'
  | 'unanswered-question'
  | 'concrete-detail'
  | 'commitment'
  | 'boundary'
  | 'identity'

export interface SalienceInput {
  role: SalienceRole
  text: string
  /**
   * Earlier same-session, same-role turns whose primary signal equals this
   * turn's primary signal: SIGNAL CO-OCCURRENCE, not entity/topic repetition.
   * Two turns about different subjects still count when they fire the same
   * signal; entity/topic-aware counting is out of scope for the keyword
   * scorer and belongs to the A10 episode round. Absent = 0.
   */
  mentionCount?: number
  /**
   * Age of the turn in milliseconds relative to the reference moment.
   * Absent or null = age unknown: decayed equals score (character turns
   * today, because confirmed records carry no delivery timestamp - the same
   * recorded limitation as the transcript pairing note).
   */
  ageMs?: number | null
}

export interface SalienceScore {
  /** Normalized 0..1 importance before decay (see normalization below). */
  score: number
  signals: readonly SalienceSignal[]
  /** score * exp(-ageDays / 45); equals score when the age is unknown. */
  decayed: number
}

export const SALIENCE_MAX_SIGNAL_WEIGHT = 3
export const SALIENCE_DECAY_DAYS = 45
export const SALIENCE_PIN_THRESHOLD = 0.35
export const MAX_PINNED_TURNS = 3
export const SALIENCE_MENTION_STEP = 0.05
export const SALIENCE_MENTION_CAP = 0.2

/*
 * Keyword tables are data, not configuration: they ship with the module and
 * never come from the environment. Both CJK and English forms are listed
 * because listener input and persona content are not guaranteed to be English.
 *
 * A cue list is a precision instrument, not a thesaurus: every entry has to be
 * a form that actually marks the signal in speech. "一定" alone ("那一定很好")
 * asserts a likelihood, not a promise, so only the emphatic constructions that
 * carry commitment are listed.
 */
const PROMISE_PATTERN =
  /记住|记得|答应|约定|说好了|说定了|拉钩|保证|发誓|承诺|许诺|允诺|一言为定|包在我身上|说到做到|别忘了|别再忘了|务必|千万(?:要|别)|一定(?:要|得|会)?记得|不忘|remember (?:this|that|me)|make sure|be sure|never forget|always remember|keep in mind|i promise|i promised|promised|don'?t forget|i swear|cross my heart|you have my word/i
const PREFERENCE_PATTERN =
  /我喜欢|我爱|我讨厌|我不喜欢|不爱|(?:最|很|超|真的|挺|比较)喜欢|(?:最|很|超)讨厌|最爱|超爱|特别爱|爱死|讨厌死了|烦死了|着迷|痴迷|更喜欢|我偏好|偏好|受不了|我宁愿|吃不(?:了|消)|i (?:really )?(?:like|love|hate|prefer)|my favorit|i can'?t stand|i'?d rather|obsessed with|can'?t get enough/i
const IDENTITY_PATTERN =
  /我叫|我的名字|大家都叫我|朋友(?:都)?叫我|观众(?:都)?叫我|请叫我|你可以叫我|我来自|我生日|我的生日|my name is|call me|my birthday|i'?m called/i

/**
 * A date or clock time. Every alternative pairs a NUMBER with a time unit, or
 * names a specific month/day. Bare time words ("今天", "晚上") are deliberately
 * absent. "周末" stays out because it names no day at all.
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

// Deliberate exclusions: "别"/"不会" are NOT in BOUNDARY_PATTERN ("别人",
// "你不会吧" mark nothing); "一定" alone stays out of the promise family.
const RELATIONSHIP_PATTERN =
  /我(?:们家|的朋友|家人|爸妈?|妈妈?|爸爸?|哥哥|姐姐|弟弟|妹妹|同学|同事|闺蜜|男朋友|女朋友|老婆|老公)|my (?:mom|mother|dad|father|brother|sister|friends?|family|girlfriend|boyfriend|classmates?|teacher)|we(?:'re| are) (?:friends|classmates)/i

const EMOTION_PEAK_PATTERN =
  /崩溃(?:了|到)|开心死了|难受死了|笑死了|气死了|激动死了|哭了|破防了?|泪目|can'?t take it (?:anymore|anymore\.)|broke down|started (?:crying|tearing up)|i'?m so (?:happy|excited|angry|sad|upset)|over the moon/i

/*
 * Boundary signal for character turns. The bare CJK forms 不能 and 无法 were
 * removed because they mark hedges (for example 这不能说明问题。); the
 * first-person anchored forms 我不能 and 我无法 carry the refusal the
 * scorer should see. The rest of the family (办不到|做不到|拒绝|禁止|恕不) and
 * the English alternatives are unchanged.
 */
const BOUNDARY_PATTERN =
  /我不能|我无法|办不到|做不到|拒绝|禁止|恕不|can'?t|won'?t|refuse to|not allowed/i

/** True when the text names something concrete worth remembering. */
function hasConcreteDetail(text: string): boolean {
  return (
    TIME_PATTERN.test(text) || QUANTITY_PATTERN.test(text) || IDENTIFIER_PATTERN.test(text)
  )
}

interface CatalogEntry {
  signal: SalienceSignal
  weight: number
  pattern: RegExp | ((text: string) => boolean)
}

const LISTENER_CATALOG: readonly CatalogEntry[] = [
  { signal: 'self-disclosure', weight: 3, pattern: IDENTITY_PATTERN },
  { signal: 'promise', weight: 3, pattern: PROMISE_PATTERN },
  { signal: 'preference', weight: 2, pattern: PREFERENCE_PATTERN },
  { signal: 'relationship', weight: 2, pattern: RELATIONSHIP_PATTERN },
  { signal: 'emotion-peak', weight: 2, pattern: EMOTION_PEAK_PATTERN },
  { signal: 'unanswered-question', weight: 1, pattern: QUESTION_ENDING_PATTERN },
  { signal: 'concrete-detail', weight: 1, pattern: hasConcreteDetail },
]

const CHARACTER_CATALOG: readonly CatalogEntry[] = [
  { signal: 'commitment', weight: 3, pattern: PROMISE_PATTERN },
  { signal: 'identity', weight: 3, pattern: IDENTITY_PATTERN },
  { signal: 'boundary', weight: 2, pattern: BOUNDARY_PATTERN },
  { signal: 'concrete-detail', weight: 1, pattern: hasConcreteDetail },
]

function matches(entry: CatalogEntry, text: string): boolean {
  if (typeof entry.pattern === 'function') return entry.pattern(text)
  return entry.pattern.test(text)
}

function catalogFor(role: SalienceRole): readonly CatalogEntry[] {
  return role === 'listener' ? LISTENER_CATALOG : CHARACTER_CATALOG
}

/** Primary signal = highest-weight fired signal; tie broken by catalog order. */
export function primarySignalOf(
  role: SalienceRole,
  signals: readonly SalienceSignal[],
): SalienceSignal | null {
  if (signals.length === 0) return null
  const fired = new Set(signals)
  const catalog = catalogFor(role)
  let best: CatalogEntry | null = null
  for (const entry of catalog) {
    if (!fired.has(entry.signal)) continue
    if (best === null || entry.weight > best.weight) best = entry
  }
  return best === null ? null : best.signal
}

/**
 * Score one rendered turn text for a given role. The result lists every signal
 * that fired so a reviewer can see WHY a turn was pinned; the numeric score
 * alone would not be auditable. Age is an explicit parameter (no clock read).
 */
export function scoreSalience(input: SalienceInput): SalienceScore {
  // Punctuation-only text is not speech (see ./text), so it carries no salience.
  if (!isSubstantiveSpeech(input.text)) return { score: 0, signals: [], decayed: 0 }
  const catalog = catalogFor(input.role)
  const signals: SalienceSignal[] = []
  let weightedSum = 0
  for (const entry of catalog) {
    if (!matches(entry, input.text)) continue
    signals.push(entry.signal)
    weightedSum += entry.weight
  }
  /*
   * Mention bonus guard (Low 2): a negative or non-finite mentionCount
   * contributes zero, so it can only lower nothing; an absent count stays 0.
   */
  const mentionCandidate = input.mentionCount
  const mentionSteps =
    typeof mentionCandidate === 'number' &&
    Number.isFinite(mentionCandidate) &&
    mentionCandidate > 0
      ? Math.min(mentionCandidate, SALIENCE_MENTION_CAP / SALIENCE_MENTION_STEP)
      : 0
  const score = Math.min(
    1,
    weightedSum / SALIENCE_MAX_SIGNAL_WEIGHT + SALIENCE_MENTION_STEP * mentionSteps,
  )
  const ageMs = input.ageMs
  /*
   * Decay anchor guard (Low 2): a non-finite age is treated as age unknown,
   * so decayed === score; zero and negative ages decay to score as before.
   */
  const decayed =
    ageMs == null || !Number.isFinite(ageMs)
      ? score
      : score * Math.exp(-Math.max(0, ageMs) / 86_400_000 / SALIENCE_DECAY_DAYS)
  return { score, signals, decayed }
}
