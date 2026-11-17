import { MAX_DIALOGUE_SEGMENTS } from '../contracts'
import type { ReplyIntent } from '../contracts'
import { scanContradictions } from './consistency'
import type { ConsistencyStatement, StatementRef } from './consistency'
import { intentTemplatesFor, resolveCharacterProfile } from './persona'
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
export const DEFAULT_STYLE_CONTRACT: Omit<StyleContract, 'profileId'> = {
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

export function deriveStyleContract(
  profile: CharacterProfile,
  overrides?: Partial<Omit<StyleContract, 'profileId'>>,
): StyleContract {
  return {
    ...DEFAULT_STYLE_CONTRACT,
    ...overrides,
    profileId: profile.profileId,
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
  const profile = resolveCharacterProfile(contract.profileId, '1') ??
    resolveCharacterProfile(contract.profileId, '2') ??
    null
  if (profile === null) return []
  return intentTemplatesFor(profile, options.replyIntent)
}

function firstPassingTemplate(
  lines: readonly string[],
  lineIndex: number,
  contract: StyleContract,
  options?: StyleCheckOptions,
): string | null {
  for (const template of candidateTemplates(contract, options)) {
    const trial = [...lines]
    trial[lineIndex] = template
    const violations = validateStyle(trial, contract, {
      recentTurns: options?.recentTurns,
      replyIntent: options?.replyIntent,
      standingFacts: options?.standingFacts,
    })
    if (violations.every((violation) => violation.lineIndex !== lineIndex)) {
      return template
    }
  }
  return null
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
  for (let lineIndex = 0; lineIndex < nextLines.length; lineIndex += 1) {
    const original = nextLines[lineIndex] ?? ''
    if (matchesAny(original, contract.boundaryPatterns) < 0) continue
    const replacement = firstPassingTemplate(nextLines, lineIndex, contract, options)
    if (replacement === null) continue
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
    },
  }
}
