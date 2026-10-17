import type { ConfirmedDelivery, DeliveryClassification, Modality } from '../contracts'
import { isSubstantiveSpeech } from './text'

/**
 * M4 memory semantics: what counts as already spoken, what is only allowed into
 * the audit view, and in which order versioned memory is dropped from a bounded
 * context.
 *
 * Division of authority - read this before changing the file.
 *   M5 decides how a delivery is classified. M4 does not upgrade, downgrade or
 *   otherwise "correct" a classification. M4 owns ADMISSION: given a record, it
 *   decides whether that record may enter spoken history and be recalled as
 *   something the listener actually heard. Refusing a claim does not contradict
 *   M5's classification; it refuses to remember something the evidence does not
 *   support.
 *
 * FR-02 depends on this file. If a record without playback evidence entered
 * spoken history, every later reply could reference words the listener never
 * heard, and the fault would only surface when a human noticed the character
 * remembering something it never said.
 */

/**
 * `spoken` - may enter confirmed history and be recalled in later context.
 * `audit-only` - retained for traceability only; never recalled, never folded
 *                into context. "The audience might have heard it" is not memory.
 */
export type MemoryBucket = 'spoken' | 'audit-only'

export type MemoryBucketReason =
  | 'delivered-with-receipt'
  | 'delivered-without-receipt'
  | 'not-fully-delivered'
  | 'empty-text'

export interface MemoryBucketDecision {
  bucket: MemoryBucket
  reason: MemoryBucketReason
}

/**
 * Policy - audio needs playback evidence before it counts as spoken.
 *
 * M1's receipt is the only evidence that sound actually played, and M5's
 * classification is built on top of that evidence. A `fully-delivered` audio
 * record with no receipt therefore carries a claim without proof and must be
 * held back from memory.
 *
 * To relax the policy, change only this constant:
 *   1. 'required' - every fully-delivered record needs a receiptId.
 *   2. 'required-for-audio' - audio needs a receipt; subtitle and avatar are
 *                             presentation rather than playback, so they do not
 *                             (the default).
 *   3. 'preferred' - trust M5's classification and treat the receipt as metadata;
 *                    choose this only if M5 is known to omit receipts for audio
 *                    that really did play.
 * Whichever is chosen, `not-fully-delivered` can only ever reach the audit view.
 * That is an FR-02 requirement, not a tunable policy.
 */
export type SpokenReceiptPolicy = 'required' | 'required-for-audio' | 'preferred'
export const SPOKEN_RECEIPT_POLICY: SpokenReceiptPolicy = 'required-for-audio'

function hasReceipt(record: ConfirmedDelivery): boolean {
  const receiptId = record.receiptId
  return typeof receiptId === 'string' && receiptId.length > 0
}

/**
 * Decide whether a record is admitted.
 *
 * The order is deliberately conservative:
 *   1. everything other than `fully-delivered` is excluded - partially delivered
 *      or never delivered text is not memory;
 *   2. text with no letter or digit is excluded - there is nothing audible;
 *   3. audio without a receipt is excluded - a claim, not proof.
 */
export function classifyMemoryBucket(record: ConfirmedDelivery): MemoryBucketDecision {
  if (record.classification !== 'fully-delivered') {
    return { bucket: 'audit-only', reason: 'not-fully-delivered' }
  }
  if (!isSubstantiveSpeech(record.text)) {
    return { bucket: 'audit-only', reason: 'empty-text' }
  }
  if (SPOKEN_RECEIPT_POLICY !== 'preferred') {
    const needsReceipt = SPOKEN_RECEIPT_POLICY === 'required' || record.modality === 'audio'
    if (needsReceipt && !hasReceipt(record)) {
      return { bucket: 'audit-only', reason: 'delivered-without-receipt' }
    }
  }
  return { bucket: 'spoken', reason: 'delivered-with-receipt' }
}

/**
 * Which classifications may enter spoken history.
 *
 * `fully-delivered` - admission depends on the receipt policy above.
 * `partial-unknown` - never admitted. Playback may have started and then been
 *                     interrupted; recalling it would present half a sentence
 *                     as a finished statement.
 * `not-delivered` - never admitted.
 *
 * A conflict freezes a record: it is neither admitted nor overwritten. A frozen
 * record is visible only in the audit view.
 */
export const SPOKEN_ADMISSION: Readonly<
  Record<DeliveryClassification, 'admitted' | 'audit-only'>
> = {
  'fully-delivered': 'admitted',
  'partial-unknown': 'audit-only',
  'not-delivered': 'audit-only',
}

/* -------------------------------------------------------------------------- */
/* Interrupted speech                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Characters that end a statement. Used to detect speech that stopped mid
 * sentence: fully delivered text is not the same as a complete sentence, and
 * context must not present a truncated fragment as a finished thought.
 *
 * The set includes CJK terminators because persona content and listener input are
 * not guaranteed to be English. These are data, not comments.
 */
const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？'])

/** Quotes and brackets that may follow a terminator, as in `He said "hello."`. */
const SENTENCE_CLOSERS = new Set(['”', '"', "'", ')', ']', '】', '」'])

/** Strip trailing closers so `"hello."` is judged on its real final character. */
function stripClosers(text: string): string {
  let end = text.length
  while (end > 0 && SENTENCE_CLOSERS.has(text.charAt(end - 1))) {
    end -= 1
  }
  return text.slice(0, end)
}

/**
 * True when the text does not end a sentence.
 *
 * A heuristic, not a parse: the goal is to make assembly mark a fragment rather
 * than present it as complete. A false negative only omits a marker and is not a
 * correctness error; a false positive only adds one.
 */
export function isTruncatedSpeech(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  const body = stripClosers(trimmed)
  if (body.length === 0) return false
  const last = body.charAt(body.length - 1)
  return !SENTENCE_TERMINATORS.has(last)
}

/* -------------------------------------------------------------------------- */
/* Versioned memory and trimming                                              */
/* -------------------------------------------------------------------------- */

/**
 * Modality preference when one segment is confirmed more than once, for example
 * by audio and by subtitle. Context keeps only one of them: showing both counts
 * the same utterance twice and inflates the character budget.
 */
export const MODALITY_PREFERENCE: readonly Modality[] = ['audio', 'subtitle', 'avatar']

export function modalityRank(modality: Modality): number {
  const index = MODALITY_PREFERENCE.indexOf(modality)
  return index === -1 ? MODALITY_PREFERENCE.length : index
}

/**
 * Trim classes, ordered from "dropped first" to "dropped last".
 *
 * Memory carries three kinds of survival information:
 *   - persona version: the record knows which persona said it. Words from an
 *     older persona are still words the audience heard, so they are not deleted
 *     immediately; they give way first only under pressure, because continuity
 *     with the current persona matters more.
 *   - truncation: an interrupted fragment is less useful for continuity than a
 *     complete statement, so it is dropped before complete statements.
 *   - salience: a turn the scorer in ./salience pinned (a promise, a stated
 *     preference, an identity detail) outlives every unpinned candidate,
 *     because importance is not a function of age. A pin is trim-order only:
 *     it never exempts a turn from the character budget.
 */
export type TrimClass =
  | 'stale-persona-truncated'
  | 'stale-persona'
  | 'truncated'
  | 'current-persona'
  | 'pinned'

export const TRIM_ORDER: readonly TrimClass[] = [
  'stale-persona-truncated',
  'stale-persona',
  'truncated',
  'current-persona',
  'pinned',
]

export interface TrimInput {
  /** Persona version used when the record was produced; null when unknown. */
  personaVersion: string | null
  /** Persona version of the turn currently being assembled. */
  activePersonaVersion: string | null
  truncated: boolean
  /** True when salience scoring pinned this turn; pinned turns drop last. */
  pinned: boolean
}

/**
 * An unknown persona version is treated as current rather than stale: M4 cannot
 * prove the record is out of date, and dropping it would silently shorten the
 * character's memory of what was really said.
 */
export function trimClassOf(input: TrimInput): TrimClass {
  // A pin outranks staleness and truncation: importance is decided by what the
  // turn contains, not by which persona said it or whether it completed.
  if (input.pinned) return 'pinned'

  const stale =
    input.personaVersion !== null &&
    input.activePersonaVersion !== null &&
    input.personaVersion !== input.activePersonaVersion

  if (stale && input.truncated) return 'stale-persona-truncated'
  if (stale) return 'stale-persona'
  if (input.truncated) return 'truncated'
  return 'current-persona'
}

export function trimRank(input: TrimInput): number {
  const index = TRIM_ORDER.indexOf(trimClassOf(input))
  return index === -1 ? TRIM_ORDER.length : index
}

/**
 * Policy - trimming a bounded context.
 *
 * `keepNewestWithinBudget` replaced an earlier `alwaysKeepMostRecent` flag, which
 * kept the newest turn even when it alone exceeded the character budget. That
 * made the configured cap advisory rather than binding, and a zero budget still
 * produced content.
 *
 * The cap is now hard: the newest turn is protected only while it fits, and when
 * a single turn cannot fit it is dropped too, with an exclusion recorded so the
 * loss is auditable. Stored evidence is unaffected - only the context view is
 * trimmed. See `trimToCharacterBudget` in ./context for the order and the
 * character-counting rule.
 */
export const MEMORY_TRIM_POLICY = {
  dropOrder: TRIM_ORDER,
  keepNewestWithinBudget: true,
} as const
