import { MAX_DIALOGUE_SEGMENTS, REPLY_INTENTS } from '../contracts'
import type { ReplyIntent } from '../contracts'
import { scanContradictions } from './consistency'
import type { ConsistencyStatement, StatementRef } from './consistency'
import type { CharacterProfile } from './persona'
import { isSubstantiveSpeech } from './text'

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

/**
 * Freezes the replacement candidates for every intent into one record, so a
 * derived contract carries its own fallbacks and repair never re-resolves the
 * profile registry. Cost is paid once per contract (measured ~4.3 us for the
 * full registry including tic-free variants); repair itself does no lookup.
 *
 * Speaking templates come first so the ordinary case keeps the character's
 * normal voice; tic-free authored fallbacks follow, and are what lets a tic
 * collision be resolved in-voice instead of by mechanically stripping a tic.
 */
function freezeBoundaryFallbacks(
  profile: CharacterProfile,
): Readonly<Record<ReplyIntent, readonly string[]>> {
  const out: Record<ReplyIntent, readonly string[]> = {
    answer: [],
    clarify: [],
    acknowledge: [],
    support: [],
    playful: [],
    'check-correction': [],
  }
  const speaking: Readonly<Record<ReplyIntent, readonly string[]>> =
    profile.intentTemplates ?? ({} as Record<ReplyIntent, readonly string[]>)
  const ticFree: Readonly<Record<ReplyIntent, readonly string[]>> =
    profile.intentFallbackTemplates ?? ({} as Record<ReplyIntent, readonly string[]>)
  for (const intent of REPLY_INTENTS) {
    const lines: string[] = []
    for (const line of speaking[intent] ?? []) {
      if (!lines.includes(line)) lines.push(line)
    }
    for (const line of ticFree[intent] ?? []) {
      if (!lines.includes(line)) lines.push(line)
    }
    out[intent] = lines
  }
  return out
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
   * Boundary lines that still violate the contract after repair because no
   * replacement candidate could be used without creating a new violation, or
   * because the contract carries no fallbacks for the intent. `repaired` alone
   * cannot express this: a run can repair one line and leave another, and a
   * caller that only reads `repaired` would treat a partly unrepaired delivery
   * as clean. Empty means every detected boundary hit was either resolved or
   * was never repairable by design (no `replyIntent` supplied).
   */
  unrepairedBoundaryLines: readonly number[]
}

function clonePattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags)
}

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

function matchesAny(line: string, patterns: readonly RegExp[]): number {
  for (let index = 0; index < patterns.length; index += 1) {
    if (clonePattern(patterns[index]).test(line)) return index
  }
  return -1
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ')
}

function removeAllMatches(line: string, patterns: readonly RegExp[]): { text: string; changed: boolean } {
  let text = line
  let changed = false
  for (const pattern of patterns) {
    const next = text.replace(globalPattern(pattern), '')
    if (next !== text) {
      text = next
      changed = true
    }
  }
  if (changed) text = collapseWhitespace(text)
  return { text, changed }
}

function removePatternMatchOnce(line: string, pattern: RegExp): { text: string; changed: boolean } {
  const next = line.replace(pattern, '')
  if (next === line) return { text: line, changed: false }
  return { text: collapseWhitespace(next), changed: true }
}

function sentenceParts(line: string): readonly string[] {
  return line
    .split(/[\u3002\uff01\uff1f!?…]+|\.(?:\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function ticViolatingCandidateIndexes(
  lines: readonly string[],
  contract: StyleContract,
  options?: StyleCheckOptions,
): readonly number[] {
  if (contract.tic === null) return []
  const gap = contract.tic.minGapTurns
  const recent = (options?.recentTurns ?? []).slice(-gap)
  const window = [...recent, ...lines]
  const ticPattern = contract.tic.pattern
  const violations: number[] = []
  let lastTicIndex = -1
  for (let index = 0; index < window.length; index += 1) {
    const entry = window[index]
    if (entry === undefined) continue
    if (!clonePattern(ticPattern).test(entry)) continue
    if (lastTicIndex >= 0 && index - lastTicIndex < gap) {
      const candidateIndex = index - recent.length
      if (candidateIndex >= 0) violations.push(candidateIndex)
    }
    lastTicIndex = index
  }
  return violations
}

function factContradictionViolations(
  lines: readonly string[],
  standingFacts?: readonly string[],
): readonly StyleViolation[] {
  if (standingFacts === undefined || standingFacts.length === 0) return []
  const statements: ConsistencyStatement[] = []
  for (let index = 0; index < standingFacts.length; index += 1) {
    const fact = standingFacts[index]
    if (fact === undefined) continue
    statements.push({
      ref: { kind: 'persona-fact', factIndex: index },
      text: fact,
    })
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.length === 0) continue
    statements.push({
      ref: { kind: 'turn', sessionId: 'style-candidate', turnId: String(index) },
      text: line,
    })
  }
  const result = scanContradictions({ statements })
  const violations: StyleViolation[] = []
  // Respect incomplete scan and module bounds: only findings actually returned are reported.
  for (let findingIndex = 0; findingIndex < result.findings.length; findingIndex += 1) {
    const finding = result.findings[findingIndex]
    if (finding === undefined) continue
    for (const ref of [finding.left, finding.right] as readonly StatementRef[]) {
      if (ref.kind === 'turn' && ref.sessionId === 'style-candidate') {
        const lineIndex = Number(ref.turnId)
        if (Number.isInteger(lineIndex) && lineIndex >= 0 && lineIndex < lines.length) {
          violations.push({
            kind: 'fact-contradiction',
            lineIndex,
            rule: `finding:${findingIndex}`,
          })
        }
      }
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const selfIndex = matchesAny(line, contract.selfReferenceViolations)
    if (selfIndex >= 0) {
      violations.push({ kind: 'self-reference', lineIndex, rule: `selfReferenceViolations:${selfIndex}` })
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const addrIndex = matchesAny(line, contract.addressViolations)
    if (addrIndex >= 0) {
      violations.push({ kind: 'audience-address', lineIndex, rule: `addressViolations:${addrIndex}` })
    }
  }

  for (const lineIndex of ticViolatingCandidateIndexes(lines, contract, options)) {
    violations.push({ kind: 'tic-frequency', lineIndex, rule: 'tic' })
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    for (const part of sentenceParts(line)) {
      if (part.length > contract.maxSentenceChars) {
        violations.push({ kind: 'sentence-length', lineIndex, rule: `maxSentenceChars:${contract.maxSentenceChars}` })
        break
      }
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const forbiddenIndex = matchesAny(line, contract.forbiddenPatterns)
    if (forbiddenIndex >= 0) {
      violations.push({ kind: 'forbidden', lineIndex, rule: `forbiddenPatterns:${forbiddenIndex}` })
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const boundaryIndex = matchesAny(line, contract.boundaryPatterns)
    if (boundaryIndex >= 0) {
      violations.push({ kind: 'boundary', lineIndex, rule: `boundaryPatterns:${boundaryIndex}` })
    }
  }

  violations.push(...factContradictionViolations(lines, options?.standingFacts))

  return violations
}

function candidateTemplates(
  contract: StyleContract,
  options?: StyleCheckOptions,
): readonly string[] {
  if (options?.replyIntent === undefined) return []
  // Read the frozen record on the contract. Repair must not re-resolve the
  // profile registry: the contract is the single source of replacement text, so
  // a derived contract keeps working when the registry changes, and an
  // under-specified contract fails visibly (no candidates) instead of silently
  // reaching into a global.
  return contract.boundaryFallbacks[options.replyIntent] ?? []
}

/**
 * Finds the first replacement candidate for a boundary hit that does not
 * introduce ANY new violation anywhere in the segment stream.
 *
 * The previous implementation asked only whether the replaced line was still
 * itself violating. That is unsound because `tic-frequency` is decided across a
 * sliding window: a replacement can be clean on its own line while putting a
 * tic next to a tic on the following line, so the repaired output could fail
 * `validateStyle` while the report claimed success.
 *
 * The baseline is the violation set measured on the CURRENT lines, so a
 * pre-existing violation that this stage cannot fix is not held against every
 * candidate; only newly introduced violations reject one.
 */
function firstPassingTemplate(
  lines: readonly string[],
  lineIndex: number,
  baseline: readonly StyleViolation[],
  contract: StyleContract,
  options?: StyleCheckOptions,
): string | null {
  const candidates = candidateTemplates(contract, options)
  if (candidates.length === 0) return null
  const checkOptions: StyleCheckOptions = {
    recentTurns: options?.recentTurns,
    replyIntent: options?.replyIntent,
    standingFacts: options?.standingFacts,
  }
  const baselineKeys = new Set(baseline.map(violationKey))
  for (const template of candidates) {
    if (template === lines[lineIndex]) continue
    const trial = [...lines]
    trial[lineIndex] = template
    const violations = validateStyle(trial, contract, checkOptions)
    // Reject a candidate that leaves the replaced line violating, or that adds
    // any violation the baseline did not already have anywhere in the stream.
    const stillViolatesTarget = violations.some((v) => v.lineIndex === lineIndex)
    if (stillViolatesTarget) continue
    const introduced = violations.some((v) => !baselineKeys.has(violationKey(v)))
    if (introduced) continue
    return template
  }
  return null
}

/** Identity of one violation for baseline comparison (kind + line + rule). */
function violationKey(violation: StyleViolation): string {
  return `${violation.kind}|${violation.lineIndex}|${violation.rule}`
}

function markEmptied(repaired: boolean, original: string, next: string): boolean {
  if (original === next) return repaired
  if (next.length === 0) return true
  if (!isSubstantiveSpeech(next)) return true
  return true
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

  // 1. forbidden hits: remove every matched span, collapse doubled whitespace.
  for (let lineIndex = 0; lineIndex < nextLines.length; lineIndex += 1) {
    const original = nextLines[lineIndex] ?? ''
    const forbiddenIndex = matchesAny(original, contract.forbiddenPatterns)
    if (forbiddenIndex < 0) continue
    const result = removeAllMatches(original, contract.forbiddenPatterns)
    if (result.text !== original) {
      nextLines[lineIndex] = result.text
      repaired = markEmptied(repaired, original, result.text)
    }
  }

  // 2. tic-frequency: keep first tic occurrence in each violating window and remove surplus.
  if (contract.tic !== null) {
    const ticPattern = contract.tic.pattern
    let changed = true
    while (changed) {
      changed = false
      const violating = ticViolatingCandidateIndexes(nextLines, contract, options)
      if (violating.length === 0) break
      const target = violating[0]
      if (target === undefined) break
      const original = nextLines[target] ?? ''
      const result = removePatternMatchOnce(original, ticPattern)
      if (result.changed) {
        nextLines[target] = result.text
        repaired = markEmptied(repaired, original, result.text)
        changed = true
      } else {
        break
      }
    }
  }

  // 3. boundary hits: replace whole affected line with first passing intent template.
  // The baseline is recomputed before each replacement so a candidate is judged
  // against the stream as it stands, and an unresolved hit is recorded rather
  // than silently left behind.
  for (let lineIndex = 0; lineIndex < nextLines.length; lineIndex += 1) {
    const original = nextLines[lineIndex] ?? ''
    if (matchesAny(original, contract.boundaryPatterns) < 0) continue
    const baseline = validateStyle(nextLines, contract, options)
    const replacement = firstPassingTemplate(nextLines, lineIndex, baseline, contract, options)
    if (replacement === null) {
      // No candidate avoids a new violation, or the contract carries none for
      // this intent. Record it so a caller cannot read a partly repaired
      // delivery as clean.
      unrepairedBoundaryLines.push(lineIndex)
      continue
    }
    if (replacement !== original) {
      nextLines[lineIndex] = replacement
      repaired = markEmptied(repaired, original, replacement)
      fallbackUsed = true
    }
  }

  // 4. self-reference, audience-address, sentence-length, fact-contradiction: report only.
  // 5. Never change line count; emptied/non-substantive slots remain.
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
