import { describe, expect, it } from 'vitest'
import { REPLY_INTENTS } from '../../src/contracts'
import type { ReplyIntent } from '../../src/contracts'
import { AUTHOR_CHARACTER_PROFILE } from '../../src/dialogue'
import { CHARACTER_CONTENT } from '../../src/dialogue/persona-content'
import {
  DEFAULT_STYLE_CONTRACT,
  deriveStyleContract,
  repairStyledLines,
  validateStyle,
} from '../../src/dialogue/style-contract'

describe('style contract derivation', () => {
  it('derivation: carries profile id, shallow-merges overrides, and is deterministic', () => {
    const base = deriveStyleContract(AUTHOR_CHARACTER_PROFILE)
    expect(base.profileId).toBe(AUTHOR_CHARACTER_PROFILE.profileId)
    expect(base.maxSentenceChars).toBe(120)

    const merged = deriveStyleContract(AUTHOR_CHARACTER_PROFILE, {
      maxSentenceChars: 42,
      forbiddenPatterns: [/secret/i],
    })
    expect(merged.profileId).toBe(AUTHOR_CHARACTER_PROFILE.profileId)
    expect(merged.maxSentenceChars).toBe(42)
    expect(merged.forbiddenPatterns).toHaveLength(1)
    expect(merged.selfReferences).toEqual(DEFAULT_STYLE_CONTRACT.selfReferences)

    const again = deriveStyleContract(AUTHOR_CHARACTER_PROFILE, {
      maxSentenceChars: 42,
      forbiddenPatterns: [/secret/i],
    })
    expect({
      ...again,
      selfReferenceViolations: again.selfReferenceViolations.map((p) => [p.source, p.flags]),
      addressViolations: again.addressViolations.map((p) => [p.source, p.flags]),
      boundaryPatterns: again.boundaryPatterns.map((p) => [p.source, p.flags]),
      forbiddenPatterns: again.forbiddenPatterns.map((p) => [p.source, p.flags]),
      tic: again.tic ? { source: again.tic.pattern.source, flags: again.tic.pattern.flags, minGapTurns: again.tic.minGapTurns } : null,
    }).toEqual({
      ...merged,
      selfReferenceViolations: merged.selfReferenceViolations.map((p) => [p.source, p.flags]),
      addressViolations: merged.addressViolations.map((p) => [p.source, p.flags]),
      boundaryPatterns: merged.boundaryPatterns.map((p) => [p.source, p.flags]),
      forbiddenPatterns: merged.forbiddenPatterns.map((p) => [p.source, p.flags]),
      tic: merged.tic ? { source: merged.tic.pattern.source, flags: merged.tic.pattern.flags, minGapTurns: merged.tic.minGapTurns } : null,
    })
  })
})

describe('style validation and repair', () => {
  const authoredContract = deriveStyleContract(AUTHOR_CHARACTER_PROFILE)

  it('zero false kills: every authored intent template line passes the default contract', () => {
    for (const intent of REPLY_INTENTS) {
      const lines = CHARACTER_CONTENT.intentTemplates[intent as ReplyIntent]
      const violations = validateStyle(lines, authoredContract)
      expect(violations, `intent ${intent}`).toEqual([])
    }
  })

  it('OOC self-reference: forbidden first-person form violates and authored templates do not', () => {
    const violations = validateStyle(['\u4eba\u5bb6 can help you.'], authoredContract)
    expect(violations).toContainEqual({
      kind: 'self-reference',
      lineIndex: 0,
      rule: 'selfReferenceViolations:0',
    })
    const safe = validateStyle(['I can help you.'], authoredContract)
    expect(safe.filter((v) => v.kind === 'self-reference')).toEqual([])
  })

  it('audience shaming: insulting the listener violates', () => {
    const violations = validateStyle(['You are \u7b28\u86cb.'], authoredContract)
    expect(violations).toContainEqual({
      kind: 'audience-address',
      lineIndex: 0,
      rule: 'addressViolations:0',
    })
  })

  it('tic frequency: enforces gap across candidates and recent turns, and disables when null', () => {
    const close = validateStyle(['Hmph, nya.', 'Another one, nya.'], authoredContract)
    expect(close).toContainEqual({ kind: 'tic-frequency', lineIndex: 1, rule: 'tic' })

    const separated = validateStyle(['Hmph, nya.', 'A calm line.', 'Another one, nya.'], authoredContract)
    expect(separated.filter((v) => v.kind === 'tic-frequency')).toEqual([])

    const withRecent = validateStyle(['Another one, nya.'], authoredContract, {
      recentTurns: ['Earlier, nya.'],
    })
    expect(withRecent).toContainEqual({ kind: 'tic-frequency', lineIndex: 0, rule: 'tic' })

    const noTic = deriveStyleContract(AUTHOR_CHARACTER_PROFILE, { tic: null })
    expect(validateStyle(['Hmph, nya.', 'Another one, nya.'], noTic)).toEqual([])
  })

  it('sentence length: overlong run-on violates and authored templates do not', () => {
    const long = `I ${'really '.repeat(30)}mean it.`
    expect(long.length).toBeGreaterThan(120)
    const violations = validateStyle([long], authoredContract)
    expect(violations.some((v) => v.kind === 'sentence-length' && v.lineIndex === 0)).toBe(true)
    for (const intent of REPLY_INTENTS) {
      const lines = CHARACTER_CONTENT.intentTemplates[intent as ReplyIntent]
      expect(validateStyle(lines, authoredContract).filter((v) => v.kind === 'sentence-length')).toEqual([])
    }
  })

  it('forbidden: overridden pattern is removed deterministically and line count is unchanged', () => {
    const contract = deriveStyleContract(AUTHOR_CHARACTER_PROFILE, { forbiddenPatterns: [/SECRET/gi] })
    const input = ['Keep SECRET this SECRET safe.', 'Untouched.']
    const result = repairStyledLines(input, contract)
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]).toBe('Keep this safe.')
    expect(result.lines[1]).toBe('Untouched.')
    expect(result.report.repaired).toBe(true)
    expect(result.report.violations.some((v) => v.kind === 'forbidden' && v.lineIndex === 0)).toBe(true)
  })

  it('boundary fallback: replaces with first passing intent template, keeps original when no intent or no template qualifies', () => {
    const boundaryLine = 'I can cure your illness with real magic.'
    const replaced = repairStyledLines([boundaryLine], authoredContract, { replyIntent: 'support' })
    expect(replaced.report.fallbackUsed).toBe(true)
    expect(replaced.report.repaired).toBe(true)
    expect(replaced.report.violations.some((v) => v.kind === 'boundary' && v.lineIndex === 0)).toBe(true)
    expect(replaced.lines[0]).toBe(CHARACTER_CONTENT.intentTemplates.support[0])
    expect(validateStyle(replaced.lines, authoredContract, { replyIntent: 'support' }).filter((v) => v.lineIndex === 0 && v.kind === 'boundary')).toEqual([])

    const noIntent = repairStyledLines([boundaryLine], authoredContract)
    expect(noIntent.report.fallbackUsed).toBe(false)
    expect(noIntent.lines[0]).toBe(boundaryLine)
    expect(noIntent.report.violations.some((v) => v.kind === 'boundary')).toBe(true)

    const impossible = deriveStyleContract(AUTHOR_CHARACTER_PROFILE, {
      boundaryPatterns: [/cure/i, /nya/i],
    })
    const allViolate = repairStyledLines([boundaryLine], impossible, { replyIntent: 'clarify' })
    // clarify has one template containing "nya", so every candidate replacement violates this contract.
    expect(allViolate.lines[0]).toBe(boundaryLine)
    expect(allViolate.report.fallbackUsed).toBe(false)
    expect(allViolate.report.violations.some((v) => v.kind === 'boundary')).toBe(true)
  })

  it('fact contradiction: reports contradiction against standing fact and does not repair', () => {
    const input = ['I am 160 cm tall, you know.']
    const options = { standingFacts: ['Elleya is 151 cm tall'] }
    const violations = validateStyle(input, authoredContract, options)
    expect(violations.some((v) => v.kind === 'fact-contradiction' && v.lineIndex === 0)).toBe(true)
    const repaired = repairStyledLines(input, authoredContract, options)
    expect(repaired.lines).toEqual(input)
    expect(repaired.report.repaired).toBe(false)
    expect(repaired.report.fallbackUsed).toBe(false)
  })

  it('line-count invariant: repairs never change line count and emptied slots remain', () => {
    const contract = deriveStyleContract(AUTHOR_CHARACTER_PROFILE, { forbiddenPatterns: [/BAD/gi] })
    const result = repairStyledLines(['BAD', 'ok'], contract)
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]).toBe('')
    expect(result.lines[1]).toBe('ok')
    expect(result.report.repaired).toBe(true)
  })

  it('purity: same inputs produce deep-equal outputs', () => {
    const input = ['Hmph, nya.', 'Another nya.', 'I can cure you.']
    const options = { recentTurns: ['Earlier nya.'], replyIntent: 'support' as const, standingFacts: ['Elleya is 151 cm tall'] }
    const a = repairStyledLines(input, authoredContract, options)
    const b = repairStyledLines(input, authoredContract, options)
    expect(JSON.stringify(a, (_, v) => (v instanceof RegExp ? `${v.source}/${v.flags}` : v))).toBe(
      JSON.stringify(b, (_, v) => (v instanceof RegExp ? `${v.source}/${v.flags}` : v)),
    )
  })
})
