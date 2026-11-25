import { MAX_DIALOGUE_SEGMENTS, REPLY_INTENTS } from '../contracts'
import type { ReplyIntent } from '../contracts'
import { scanContradictions } from './consistency'
import type { ConsistencyStatement } from './consistency'
import type { CharacterProfile } from './persona'

/**
 * Character style contract: what a line must look like, what it may never say,
 * and how a delivery is repaired without changing what the character means.
 *
 * Two surfaces share one model:
 *   - `validateStyle` reports violations and never rewrites anything;
 *   - `repairStyledLines` fixes only the mechanical kinds (forbidden spans, tic
 *     spacing, boundary hits) and reports the rest, because a self-reference, a
 *     long sentence or a contradiction with a standing fact cannot be corrected
 *     without inventing content.
 *
 * Both are pure: no clock, no I/O, no randomness, no persona lookup at repair
 * time. The same inputs always produce deep-equal outputs.
 */

export interface StyleContract {
  /** Profile the contract was derived for (provenance in the report). */
  profileId: string
  /** First-person forms the character may use. Data in v0: documents the allowed set. */
  selfReferences: readonly string[]
  /** Audience address forms the character may use. Data in v0. */
  audienceAddress: readonly string[]
  /** First-person forms OUTSIDE the allowed set: a hit is a violation. */
  selfReferenceViolations: readonly RegExp[]
  /** Audience address outside the allowed set: a hit is a violation. */
  addressViolations: readonly RegExp[]
  /** Verbal tic and the minimum gap (in lines) between tic-bearing lines; null disables. */
  tic: { pattern: RegExp; minGapTurns: number } | null
  /** Any sentence longer than this many UTF-16 units is a violation (report only). */
  maxSentenceChars: number
  /** Patterns that must never appear; a hit is repaired by removing the matched span. */
  forbiddenPatterns: readonly RegExp[]
  /** Patterns that must never appear; a hit segment is replaced by an intent template. */
  boundaryPatterns: readonly RegExp[]
  /**
   * Replacement candidates for a boundary hit, per intent, frozen into the
   * contract at derivation time. Repair consults THIS and never re-resolves the
   * character profile, so the repair path has no persona lookup of its own and a
   * contract stays valid even if the profile registry changes underneath it.
   *
   * Order matters: speaking templates first (preserving the character's normal
   * voice), then the tic-free fallbacks that exist so a tic collision can be
   * avoided without stripping a tic mechanically. An empty list for an intent
   * means repair reports the boundary as unrepaired rather than inventing text.
   */
  boundaryFallbacks: Readonly<Record<ReplyIntent, readonly string[]>>
}

// Authored-profile alignment (src/dialogue/persona-content.ts):
// - styleNotes[1]: tic appears "sparingly ... never in every sentence" -> /hmph|nya/i, minGapTurns 2.
// - boundaries[0]: "Never claim that fictional magic can diagnose, cure or replace professional
//   medical, mental-health or emergency care." -> medical-promise/diagnosis/cure/replace patterns.
// - boundaries[2]: "Never shame the audience for being tired, afraid, confused or in need of help."
//   -> audience-shaming address violations.
// - boundaries[4]: "Never claim to be a real supernatural being or make promises of guaranteed
//   protection outside the fictional persona." -> real-magic/supernatural/guaranteed-safety patterns.
// Prose styleNotes/boundaries strings are not parsed into patterns; this is code-owned defaults
// plus explicit overrides and prose remains prose.
export const DEFAULT_STYLE_CONTRACT: Omit<StyleContract, 'profileId' | 'boundaryFallbacks'> = {
  selfReferences: ['I', 'me', 'my', 'mine', 'this one', 'this mage'],
  audienceAddress: ['you', 'everyone', 'human', 'humans', 'weary human', 'audience'],
  selfReferenceViolations: [/\u4eba\u5bb6|\u8001\u5b50|\u672c\u5ea7|\u4ffa/i],
  addressViolations: [
    /\u7b28\u86cb|\u8822\u8d27|\u5e9f\u7269|idiot|stupid|moron|useless/i,
  ],
  tic: { pattern: /hmph|nya/i, minGapTurns: 2 },
  maxSentenceChars: 120,
  forbiddenPatterns: [],
  boundaryPatterns: [
    // boundaries[0], boundaries[4]: medical promises and real-supernatural/guaranteed protection (CJK).
    /\u6cbb\u597d(?:\u4f60\u7684)?(?:\u75c5|\u4f24)|\u5305\u6cbb|\u8bca\u65ad|\u8bca\u7597|\u771f\u7684(?:\u9b54\u6cd5|\u8d85\u81ea\u7136)|\u4fdd\u8bc1(?:\u4f60|\u4f1a)?(?:\u5b89\u5168|\u5e73\u5b89\u65e0\u4e8b)/i,
    // boundaries[0], boundaries[4]: medical promises and real-supernatural/guaranteed protection (English).
    /\bcure\b|\bheal\b(?: your)?|\bdiagnos(?:e|ing)\b|guarantee(?:s|d)? (?:your )?(?:safety|protection)|real (?:magic|supernatural)|replace(?:ing)? (?:proper )?(?:medical|professional) (?:help|care)/i,
  ],
}

export type StyleViolationKind =
  | 'self-reference'
  | 'audience-address'
  | 'tic-frequency'
  | 'sentence-length'
  | 'forbidden'
  | 'boundary'
  | 'fact-contradiction'

export interface StyleViolation {
  kind: StyleViolationKind
  /** 0-based index into the candidate lines. */
  lineIndex: number
  /** Which rule fired: the pattern's array index, or the finding's position. Never statement text. */
  rule: string
}

export interface StyleCheckOptions {
  /** Confirmed prior lines for the tic window (only the last `minGapTurns` matter). */
  recentTurns?: readonly string[]
  /** Reply intent used for boundary fallback repairs. */
  replyIntent?: ReplyIntent
  /** Standing facts for the contradiction scan (passed through to ./consistency). */
  standingFacts?: readonly string[]
}

export interface DialogueStyleReport {
  violations: readonly StyleViolation[] // as found BEFORE repair
  repaired: boolean // any line changed by a repair
  fallbackUsed: boolean // any segment replaced by an intent template
  /**
   * Boundary lines that still violate the contract after repair, because either
   * no replacement candidate could be used without creating a new violation, or
   * the contract carries no fallbacks for the intent (which is also what a call
   * with no `replyIntent` produces). `repaired` alone cannot express this: a run
   * can repair one line and leave another, and a caller that only reads
   * `repaired` would treat a partly unrepaired delivery as clean. Empty means
   * every detected boundary hit was resolved.
   */
  unrepairedBoundaryLines: readonly number[]
}

/* ------------------------------------------------------------------------- *
 * Pattern helpers
 *
 * RegExp objects carry `lastIndex` when they are global or sticky, so a shared
 * contract pattern tested with `.test()` twice can answer differently the second
 * time. Every test therefore runs on a fresh clone with the caller's flags.
 * ------------------------------------------------------------------------- */

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags)
}

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

/** Index of the first pattern that matches, or -1. */
function matchingPatternIndex(line: string, patterns: readonly RegExp[]): number {
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index]
    if (pattern !== undefined && clonePattern(pattern).test(line)) return index
  }
  return -1
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ')
}

/** Removes every span matched by any forbidden pattern; whitespace is collapsed only if something changed. */
function stripForbiddenSpans(
  line: string,
  patterns: readonly RegExp[],
): { text: string; changed: boolean } {
  let text = line
  for (const pattern of patterns) {
    text = text.replace(globalPattern(pattern), '')
  }
  if (text === line) return { text: line, changed: false }
  return { text: collapseWhitespace(text), changed: true }
}

/** Removes the first match of `pattern`; whitespace is collapsed only if something changed. */
function stripOneMatch(line: string, pattern: RegExp): { text: string; changed: boolean } {
  const next = line.replace(pattern, '')
  if (next === line) return { text: line, changed: false }
  return { text: collapseWhitespace(next), changed: true }
}

/** Sentences of a line, trimmed and without empty fragments (CJK and Latin terminators). */
function sentencesOf(line: string): readonly string[] {
  return line
    .split(/[\u3002\uff01\uff1f!?\u2026]+|\.(?:\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/* ------------------------------------------------------------------------- *
 * Derivation
 * ------------------------------------------------------------------------- */

/**
 * Freezes the replacement candidates for every intent into one record, so a
 * derived contract carries its own fallbacks and repair never re-resolves the
 * profile registry.
 *
 * Speaking templates come first so the ordinary case keeps the character's
 * normal voice; tic-free authored fallbacks follow, and are what lets a tic
 * collision be resolved in-voice instead of by mechanically stripping a tic.
 * Duplicates are dropped while preserving the first occurrence.
 */
function freezeBoundaryFallbacks(
  profile: CharacterProfile,
): Readonly<Record<ReplyIntent, readonly string[]>> {
  const speaking = profile.intentTemplates
  const ticFree = profile.intentFallbackTemplates
  const frozen = {} as Record<ReplyIntent, readonly string[]>
  for (const intent of REPLY_INTENTS) {
    const lines: string[] = []
    for (const line of speaking?.[intent] ?? []) {
      if (!lines.includes(line)) lines.push(line)
    }
    for (const line of ticFree?.[intent] ?? []) {
      if (!lines.includes(line)) lines.push(line)
    }
    frozen[intent] = lines
  }
  return frozen
}

export function deriveStyleContract(
  profile: CharacterProfile,
  overrides?: Partial<Omit<StyleContract, 'profileId'>>,
): StyleContract {
  return {
    ...DEFAULT_STYLE_CONTRACT,
    ...overrides,
    profileId: profile.profileId,
    boundaryFallbacks: overrides?.boundaryFallbacks ?? freezeBoundaryFallbacks(profile),
  }
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

/**
 * Candidate-line indexes whose tic breaks `minGapTurns`.
 *
 * The check runs over `[...recentTurns.slice(-minGapTurns), ...lines]` so a
 * tic in the confirmed history still spaces the new delivery. Entries at or
 * before the recent turns are context only; a violation is reported at the
 * candidate index `windowIndex - recent.length`, and only when that is >= 0.
 */
function ticViolationIndexes(
  lines: readonly string[],
  contract: StyleContract,
  options?: StyleCheckOptions,
): readonly number[] {
  if (contract.tic === null) return []
  const { pattern: ticPattern, minGapTurns: gap } = contract.tic
  const recent = (options?.recentTurns ?? []).slice(-gap)
  const window = [...recent, ...lines]
  const violations: number[] = []
  let lastTicIndex = -1
  for (let index = 0; index < window.length; index += 1) {
    const entry = window[index]
    if (entry === undefined || !clonePattern(ticPattern).test(entry)) continue
    if (lastTicIndex >= 0 && index - lastTicIndex < gap) {
      const candidateIndex = index - recent.length
      if (candidateIndex >= 0) violations.push(candidateIndex)
    }
    lastTicIndex = index
  }
  return violations
}

/**
 * Contradictions between candidate lines and the standing facts.
 *
 * Facts and lines are offered as one statement list so the existing scan does
 * the comparing; only refs that point back at a candidate line become
 * violations, and `rule` is the finding's position, never statement text. The
 * scan is bounded internally and only findings it actually returned are
 * reported.
 */
function factContradictionViolations(
  lines: readonly string[],
  standingFacts?: readonly string[],
): readonly StyleViolation[] {
  if (standingFacts === undefined || standingFacts.length === 0) return []
  const sessionId = 'style-candidate'
  const statements: ConsistencyStatement[] = []
  for (let index = 0; index < standingFacts.length; index += 1) {
    const fact = standingFacts[index]
    if (fact === undefined) continue
    statements.push({ ref: { kind: 'persona-fact', factIndex: index }, text: fact })
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.length === 0) continue
    statements.push({ ref: { kind: 'turn', sessionId, turnId: String(index) }, text: line })
  }
  const { findings } = scanContradictions({ statements })
  const violations: StyleViolation[] = []
  for (let findingIndex = 0; findingIndex < findings.length; findingIndex += 1) {
    const finding = findings[findingIndex]
    if (finding === undefined) continue
    for (const ref of [finding.left, finding.right]) {
      if (ref.kind !== 'turn' || ref.sessionId !== sessionId) continue
      const lineIndex = Number(ref.turnId)
      if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) continue
      violations.push({ kind: 'fact-contradiction', lineIndex, rule: `finding:${findingIndex}` })
    }
  }
  return violations
}

export function validateStyle(
  lines: readonly string[],
  contract: StyleContract,
  options?: StyleCheckOptions,
): readonly StyleViolation[] {
  const violations: StyleViolation[] = []
  // Iteration order defines the output order and is part of the contract.
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const index = matchingPatternIndex(line, contract.selfReferenceViolations)
    if (index >= 0) {
      violations.push({ kind: 'self-reference', lineIndex, rule: `selfReferenceViolations:${index}` })
    }
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const index = matchingPatternIndex(line, contract.addressViolations)
    if (index >= 0) {
      violations.push({ kind: 'audience-address', lineIndex, rule: `addressViolations:${index}` })
    }
  }
  for (const lineIndex of ticViolationIndexes(lines, contract, options)) {
    violations.push({ kind: 'tic-frequency', lineIndex, rule: 'tic' })
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const tooLong = sentencesOf(lines[lineIndex] ?? '').some(
      (sentence) => sentence.length > contract.maxSentenceChars,
    )
    if (tooLong) {
      violations.push({
        kind: 'sentence-length',
        lineIndex,
        rule: `maxSentenceChars:${contract.maxSentenceChars}`,
      })
    }
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const index = matchingPatternIndex(lines[lineIndex] ?? '', contract.forbiddenPatterns)
    if (index >= 0) {
      violations.push({ kind: 'forbidden', lineIndex, rule: `forbiddenPatterns:${index}` })
    }
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const index = matchingPatternIndex(lines[lineIndex] ?? '', contract.boundaryPatterns)
    if (index >= 0) {
      violations.push({ kind: 'boundary', lineIndex, rule: `boundaryPatterns:${index}` })
    }
  }
  violations.push(...factContradictionViolations(lines, options?.standingFacts))
  return violations
}

/* ------------------------------------------------------------------------- *
 * Repair
 * ------------------------------------------------------------------------- */

/** Kinds a replacement candidate must not leave behind or introduce. */
function isResolvableKind(kind: StyleViolationKind): boolean {
  return kind === 'boundary' || kind === 'tic-frequency' || kind === 'forbidden'
}

/**
 * Identity of one violation that survives a renumbering, used to decide whether
 * a candidate introduced something new.
 *
 * `rule` is dropped for `kind`s whose rule string is an ordinal rather than a
 * name: `fact-contradiction` uses the finding's array position, and replacing a
 * line drops that line's findings, so every later finding - including one on an
 * untouched line, or a second contradiction on an untouched line - shifts down
 * and would look newly introduced. The rules of the other kinds are stable
 * names and keep theirs, so two different rules on one line stay
 * distinguishable.
 *
 * Two contradictions on one line still share a key, so identity there is the
 * kind, the line and how many such violations the baseline showed on it.
 */
function stableViolationKey(violation: StyleViolation): string {
  if (violation.kind === 'fact-contradiction') return `${violation.kind}|${violation.lineIndex}`
  return `${violation.kind}|${violation.lineIndex}|${violation.rule}`
}

/**
 * Violations on each line, for lines this repair repeatedly re-assesses.
 */
function groupByLine(violations: readonly StyleViolation[]): Map<number, StyleViolation[]> {
  const grouped = new Map<number, StyleViolation[]>()
  for (const violation of violations) {
    const existing = grouped.get(violation.lineIndex)
    if (existing === undefined) grouped.set(violation.lineIndex, [violation])
    else existing.push(violation)
  }
  return grouped
}

/** Maps every baseline key to how many times the baseline showed it. */
function countViolations(violations: readonly StyleViolation[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const violation of violations) {
    const key = stableViolationKey(violation)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * A violation is introduced when its key occurs more often after than before.
 * The after-list may be narrowed to the lines a replacement can affect.
 */
function findIntroducedViolation(
  before: ReadonlyMap<string, number>,
  after: readonly StyleViolation[],
): StyleViolation | null {
  const used = new Map<string, number>()
  for (const violation of after) {
    const key = stableViolationKey(violation)
    const already = (used.get(key) ?? 0) + 1
    used.set(key, already)
    if (already > (before.get(key) ?? 0)) return violation
  }
  return null
}

/**
 * First candidate for a boundary hit that can replace the whole line.
 *
 * Acceptance is judged against a baseline measured on the CURRENT lines, so a
 * violation this stage cannot fix never vetoes a repair. A candidate must:
 *
 * - leave the replaced line free of the kinds this stage resolves. Report-only
 *   kinds it already had (a long sentence, a contradiction) are not its fault;
 * - introduce no violation in the WINDOW of lines this replacement can reach
 *   (earlier candidates already placed, this line, the lines a tic gap away)
 *   that the baseline did not already carry there by `stableViolationKey`.
 *   Line-local checks are not enough: `tic-frequency` spans a window, so one
 *   line's replacement can push a tic next to a tic on its neighbour. Lines
 *   outside the window are untouched and re-report exactly what they did
 *   before, so they cannot be evidence of an introduced violation - and with
 *   `fact-contradiction` keyed on the line alone, findings on them can only
 *   differ by renumbering, or by pairings the scan never got to.
 */
function firstAcceptableTemplate(
  lines: readonly string[],
  lineIndex: number,
  windowLines: readonly number[],
  baselineCounts: ReadonlyMap<string, number>,
  candidates: readonly string[],
  contract: StyleContract,
  options: StyleCheckOptions | undefined,
): string | null {
  const window = new Set(windowLines)
  const inWindow = (v: StyleViolation): boolean => window.has(v.lineIndex)
  for (const template of candidates) {
    // A line reaches this stage because it matched a boundary pattern, so a
    // byte-identical candidate would be rejected below anyway; skipping it keeps
    // the intent of "replace" explicit.
    if (template === lines[lineIndex]) continue
    const trial = [...lines]
    trial[lineIndex] = template
    const affected = validateStyle(trial, contract, options).filter(inWindow)
    const leavesResolvable = affected.some(
      (v) => v.lineIndex === lineIndex && isResolvableKind(v.kind),
    )
    if (leavesResolvable) continue
    if (findIntroducedViolation(baselineCounts, affected) !== null) continue
    return template
  }
  return null
}

// Any change to a line counts as a repair, including one that empties the line
// or leaves it non-substantive; those outcomes do not alter the result, so the
// decision reduces to whether the line changed at all.
function markEmptied(repaired: boolean, original: string, next: string): boolean {
  return repaired || original !== next
}

export function repairStyledLines(
  lines: readonly string[],
  contract: StyleContract,
  options?: StyleCheckOptions,
): { lines: readonly string[]; report: DialogueStyleReport } {
  const capped = lines.slice(0, MAX_DIALOGUE_SEGMENTS)
  const preViolations = validateStyle(capped, contract, options)
  const nextLines = [...capped]
  let repaired = false
  let fallbackUsed = false
  const unrepairedBoundaryLines: number[] = []

  // Stage 1 - forbidden: remove every matched span in every line, collapse
  // doubled whitespace, never remove the line itself.
  for (let lineIndex = 0; lineIndex < nextLines.length; lineIndex += 1) {
    const original = nextLines[lineIndex] ?? ''
    if (matchingPatternIndex(original, contract.forbiddenPatterns) < 0) continue
    const { text } = stripForbiddenSpans(original, contract.forbiddenPatterns)
    if (text === original) continue
    nextLines[lineIndex] = text
    repaired = markEmptied(repaired, original, text)
  }

  // Stage 2 - tic frequency: repeatedly take the first violating line and
  // remove one tic from it, until the window is clean. Each pass sees the
  // result of the previous one, so removing a tic can un-violate neighbours.
  while (contract.tic !== null) {
    const target = ticViolationIndexes(nextLines, contract, options)[0]
    if (target === undefined) break
    const original = nextLines[target] ?? ''
    const { text, changed } = stripOneMatch(original, contract.tic.pattern)
    // No match left to remove (cannot happen for a reported tic); stop rather
    // than spin.
    if (!changed) break
    nextLines[target] = text
    repaired = markEmptied(repaired, original, text)
  }

  // Stage 3 - boundary: replace the whole line with the first acceptable
  // candidate for the reply intent. A hit nothing can resolve is recorded, not
  // hidden.
  //
  // Baselines are per line and are refreshed only for the lines a replacement
  // can reach, so untouched lines are never re-scanned and cannot contribute a
  // renumbered finding to the comparison. The tic gap bounds that reach: every
  // other kind is line-local.
  const candidates =
    options?.replyIntent === undefined
      ? []
      : (contract.boundaryFallbacks[options.replyIntent] ?? [])
  const gap = contract.tic?.minGapTurns ?? 0
  const reach = Math.max(1, gap)
  const baselineByLine = groupByLine(validateStyle(nextLines, contract, options))
  for (let lineIndex = 0; lineIndex < nextLines.length; lineIndex += 1) {
    const original = nextLines[lineIndex] ?? ''
    if (matchingPatternIndex(original, contract.boundaryPatterns) < 0) continue
    // Lines already replaced earlier in this stage are part of the window: a
    // later replacement can re-violate them, and that must veto it.
    const placed: number[] = []
    for (let earlier = lineIndex - 1; earlier >= 0; earlier -= 1) {
      if (nextLines[earlier] !== capped[earlier]) placed.push(earlier)
    }
    const windowLines = [...placed]
    for (let offset = -reach; offset <= reach; offset += 1) {
      const at = lineIndex + offset
      if (at >= 0 && at < nextLines.length) windowLines.push(at)
    }
    const baseline: StyleViolation[] = []
    for (const line of windowLines) baseline.push(...(baselineByLine.get(line) ?? []))
    const replacement = firstAcceptableTemplate(
      nextLines,
      lineIndex,
      windowLines,
      countViolations(baseline),
      candidates,
      contract,
      options,
    )
    if (replacement === null) {
      unrepairedBoundaryLines.push(lineIndex)
      continue
    }
    nextLines[lineIndex] = replacement
    repaired = markEmptied(repaired, original, replacement)
    fallbackUsed = true
    // Refresh the baselines of the reachable lines against the new lines; every
    // other line was not touched, so its baseline cannot have changed.
    const refreshed = groupByLine(validateStyle(nextLines, contract, options))
    const touched = new Set(placed)
    for (let offset = -reach; offset <= reach; offset += 1) {
      const at = lineIndex + offset
      if (at >= 0 && at < nextLines.length) touched.add(at)
    }
    for (const line of touched) baselineByLine.set(line, refreshed.get(line) ?? [])
  }

  // Stage 4 - self-reference, audience-address, sentence-length and
  // fact-contradiction are report-only: fixing them would mean writing new
  // content. Line count and empty slots survive every stage.
  return {
    lines: nextLines,
    report: {
      violations: preViolations,
      repaired,
      fallbackUsed,
      unrepairedBoundaryLines,
    },
  }
}
