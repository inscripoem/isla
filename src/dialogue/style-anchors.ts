import type { ReplyIntent } from '../contracts'
import type { AssembledTurn } from './context'
import { DEFAULT_STYLE_CONTRACT } from './style-contract'
import type { StyleContract } from './style-contract'

/**
 * Style anchors (issue #146 A11).
 *
 * A style anchor is a line the character ACTUALLY said, in the current persona
 * version, shown next to the persona block so a model has a concrete sample of
 * her voice and not only instructions about it. It is a voice reference, never
 * a fact: the rendered header says so, and nothing here is recalled as evidence.
 *
 * Hard rules:
 *   - The input is the assembled history, so an anchor can never add a turn.
 *     Admission, ordering and the turn limit are decided before this module
 *     runs; it only chooses among turns that already reached the prompt.
 *   - Selection is pure and deterministic: no clock, no I/O, no model call, no
 *     randomness. The same turns always produce the same anchors, which is what
 *     makes the probe suite and the byte-identical off path meaningful.
 *   - The feature is OFF by default (`STYLE_ANCHORS_ENABLED`), and disabled
 *     means no selection, no budget charge and no prompt line.
 */

/** Default switch. Off until a quality review has accepted the section. */
export const STYLE_ANCHORS_ENABLED = false

/** Most anchors rendered in one prompt. */
export const MAX_STYLE_ANCHORS = 3

/**
 * Shortest and longest text an anchor may have, in UTF-16 units.
 *
 * A shorter line carries too little voice to be a sample ("Yes."), and a longer
 * one costs the history budget more than it can teach. The bounds are on the
 * TRIMMED text so trailing whitespace cannot smuggle a short line past the floor.
 */
export const STYLE_ANCHOR_MIN_CHARS = 20
export const STYLE_ANCHOR_MAX_CHARS = 80

/** Section header. Not charged to the budget: the entry lines are. */
export const STYLE_ANCHORS_HEADER = 'Voice reference (style only, not facts):'

/** Why one candidate turn was not selected. Carries no text. */
export type StyleAnchorExclusionReason =
  | 'stale-persona'
  | 'too-short'
  | 'too-long'
  | 'interrupted'
  | 'conflicting'
  | 'standing-fact'
  | 'empty'
  | 'duplicate'
  | 'limit'
  | 'budget'

/** One refused candidate: which turn, and why. Never the turn's text. */
export interface StyleAnchorExclusion {
  sessionId: string
  turnId: string
  reason: StyleAnchorExclusionReason
}

export interface StyleAnchorSelection {
  /** Selected turns, in the order they were picked (best first). */
  anchors: readonly AssembledTurn[]
  /** Candidates refused by a filter, in input order. */
  exclusions: readonly StyleAnchorExclusion[]
}

/**
 * Collapses whitespace and trims, so two turns that differ only in spacing are
 * the same line for duplication purposes and for the length bounds.
 */
export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether a line carries a tic under the derived contract. A tic is the
 * character's signature, so a line with one is a better voice sample than a
 * neutral one.
 */
function hasTic(text: string, contract: StyleContract): boolean {
  if (contract.tic === null) return false
  // A fresh clone: a global or sticky pattern carries `lastIndex`, and reusing
  // the shared instance would make the second call answer differently.
  return new RegExp(contract.tic.pattern.source, contract.tic.pattern.flags).test(text)
}

/** True when the code unit could be part of a Latin word. */
function isLatinLetter(character: string | undefined): boolean {
  return character !== undefined && /[a-z]/i.test(character)
}

/**
 * Whether `needle` occurs in `text` (already lower-cased) without being part of
 * a longer Latin word, so "you" matches "you" but not "your".
 *
 * CJK address forms have no word boundaries and are matched as plain
 * substrings; the boundary test only applies when the needle starts and ends
 * with a Latin letter.
 */
function occursAsWord(text: string, needle: string): boolean {
  const needsBoundary = isLatinLetter(needle[0]) && isLatinLetter(needle[needle.length - 1])
  let at = text.indexOf(needle)
  while (at >= 0) {
    if (!needsBoundary) return true
    const before = text[at - 1]
    const after = text[at + needle.length]
    if (!isLatinLetter(before) && !isLatinLetter(after)) return true
    at = text.indexOf(needle, at + 1)
  }
  return false
}

/**
 * Whether a line uses a form of address from the contract's allowed set. The
 * audience-address list is the authored vocabulary ("you", "human", ...), so a
 * line that addresses the listener demonstrates the relationship, not only the
 * tone.
 */
function hasAddress(text: string, contract: StyleContract): boolean {
  const lowered = text.toLowerCase()
  return contract.audienceAddress.some((form) =>
    occursAsWord(lowered, form.toLowerCase()),
  )
}

/**
 * Preference weight of one candidate: how many of the three voice markers it
 * shows. Higher is preferred; the markers are the tic, a form of address, and
 * an emotional turn (a salience emotion signal, from ./salience).
 */
export function anchorScore(turn: AssembledTurn, contract: StyleContract): number {
  let score = 0
  if (hasTic(turn.text, contract)) score += 1
  if (hasAddress(turn.text, contract)) score += 1
  if (turn.salienceSignals.includes('emotion-peak')) score += 1
  return score
}

/** Empty boundary fallbacks: selection never renders one. */
const EMPTY_BOUNDARY_FALLBACKS: Readonly<Record<ReplyIntent, readonly string[]>> = {
  support: [],
  answer: [],
  clarify: [],
  acknowledge: [],
  playful: [],
  'check-correction': [],
}

/**
 * Contract used when the caller does not supply one.
 *
 * It is `DEFAULT_STYLE_CONTRACT` (the same table `deriveStyleContract` starts
 * from) plus the two profile fields that constant leaves out. The previous
 * fallback was a hand-written empty contract - no tic, no address list - which
 * silently scored two of the three preference dimensions at zero forever, so
 * omitting the argument degraded the ordering instead of using the documented
 * defaults. The tic and the address vocabulary now come from the shipped table,
 * and the boundary fallbacks are empty because selection never renders one:
 * they belong to delivery repair.
 */
const DEFAULT_ANCHOR_CONTRACT: StyleContract = {
  ...DEFAULT_STYLE_CONTRACT,
  profileId: '',
  boundaryFallbacks: EMPTY_BOUNDARY_FALLBACKS,
}

/**
 * Choose up to `limit` style anchors from turns that are already in the prompt.
 *
 * Filters, in order, each recording its own reason:
 *   - persona version must equal `profileVersion`; a stale or unknown version is
 *     someone else speaking in her place, and an unknown one cannot be shown as
 *     her voice at all;
 *   - the trimmed text must be 20..80 characters;
 *   - `interrupted` and `conflicting` turns are excluded: a fragment teaches an
 *     unfinished voice, and a contradicted line would anchor the identity of a
 *     claim the character does not stand behind;
 *   - a line that merely restates a STANDING FACT is excluded (`standingFacts`):
 *     the anchor section is a voice reference, not a second place to say what
 *     the persona block already says;
 *   - normalized duplicates are kept once.
 *
 * `contract` defaults to `DEFAULT_ANCHOR_CONTRACT` (the shipped defaults), so
 * omitting it is well defined: tics and address forms are still preferred. Pass
 * `deriveStyleContract(profile)` to rank against a specific authored character.
 * `standingFacts` defaults to none, so an omitting caller gets the previous
 * selection exactly.
 *
 * Survivors are ordered by `anchorScore` (descending), ties keeping the input
 * order - which is the history's own order - and the first `limit` are kept. The
 * rest are reported with reason `'limit'`.
 */
export function selectStyleAnchors(
  turns: readonly AssembledTurn[],
  profileVersion: string,
  limit: number = MAX_STYLE_ANCHORS,
  contract: StyleContract = DEFAULT_ANCHOR_CONTRACT,
  standingFacts: readonly string[] = [],
): StyleAnchorSelection {
  const style = contract
  const exclusions: StyleAnchorExclusion[] = []
  const seen = new Set<string>()
  const scored: { turn: AssembledTurn; score: number; order: number }[] = []
  /*
   * Normalized, lower-cased standing facts. Both sides go through
   * `normalizeAnchorText`, so the comparison ignores spacing and case - the same
   * notion of "the same line" the duplicate filter uses. A fact that normalizes
   * to nothing is skipped: an empty needle is a substring of every line, which
   * would exclude every anchor.
   */
  const facts = standingFacts
    .map((fact) => normalizeAnchorText(fact).toLowerCase())
    .filter((fact) => fact.length > 0)
  const restatesStandingFact = (text: string): boolean => {
    const normalised = text.toLowerCase()
    return facts.some(
      (fact) => normalised.includes(fact) || fact.includes(normalised),
    )
  }

  for (let order = 0; order < turns.length; order += 1) {
    const turn = turns[order]
    if (turn === undefined) continue
    const refuse = (reason: StyleAnchorExclusionReason): void => {
      exclusions.push({ sessionId: turn.sessionId, turnId: turn.turnId, reason })
    }
    if (turn.personaVersion !== profileVersion) {
      refuse('stale-persona')
      continue
    }
    if (turn.interrupted) {
      refuse('interrupted')
      continue
    }
    if (turn.conflicting === true) {
      refuse('conflicting')
      continue
    }
    const text = normalizeAnchorText(turn.text)
    if (text.length === 0) {
      refuse('empty')
      continue
    }
    if (text.length < STYLE_ANCHOR_MIN_CHARS) {
      refuse('too-short')
      continue
    }
    if (text.length > STYLE_ANCHOR_MAX_CHARS) {
      refuse('too-long')
      continue
    }
    if (restatesStandingFact(text)) {
      refuse('standing-fact')
      continue
    }
    if (seen.has(text)) {
      refuse('duplicate')
      continue
    }
    seen.add(text)
    scored.push({ turn, score: anchorScore(turn, style), order })
  }

  // Stable sort by score: `order` breaks ties, so equal scores keep the input
  // order and the output is fully deterministic.
  const ordered = [...scored].sort((left, right) => right.score - left.score || left.order - right.order)
  const keep = Math.max(0, limit)
  const anchors = ordered.slice(0, keep).map((entry) => entry.turn)
  for (const entry of ordered.slice(keep)) {
    exclusions.push({
      sessionId: entry.turn.sessionId,
      turnId: entry.turn.turnId,
      reason: 'limit',
    })
  }
  return { anchors, exclusions }
}

/**
 * Rendered anchor lines: one `- <text>` per anchor, in selection order. The
 * caller renders `STYLE_ANCHORS_HEADER` itself so that the header and the
 * charged lines can be budgeted differently.
 */
export function renderStyleAnchorLines(
  anchors: readonly AssembledTurn[],
): readonly string[] {
  return anchors.map((turn) => `- ${normalizeAnchorText(turn.text)}`)
}
