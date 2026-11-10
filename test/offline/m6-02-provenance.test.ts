import { describe, expect, it } from 'vitest'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import {
  buildOccurrenceKey,
  parseOccurrenceKey,
  parseProvenance,
  provenanceRunDigest,
  type ProvenanceParse,
} from '../../src/evaluation/provenance'

/**
 * M6-02 / ADR-008 — strict companion parser.
 *
 * These are structural fixtures, not measurements: the purpose is to pin the
 * refusal rules of D2/D3/D7/D8, so each negative case must fail for its own
 * stated reason. The digest is recomputed from the exact fixture bytes.
 */

const TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

const RECORD = {
  caseId: 'case-1',
  variantId: 'v1',
  cold: true,
  outcome: 'completed',
  timing: TIMING,
  totalMs: 100,
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, usageMissing: false },
  failureReason: null,
} as const

// Two records with the same (caseId, variantId) so the positional attempt index
// is exercised: this run's key set is case-1/v1 attempt 1 and attempt 2.
const RUN_TEXT = JSON.stringify({
  schemaVersion: 1,
  meta: { runId: 'run-1', generatedAt: '2026-11-06' },
  variants: [{ id: 'v1', kind: 'rules', combined: false }],
  conditions: {
    hardware: 'test host',
    providers: ['test-provider'],
    workload: 'two synthetic recorded attempts',
    sampleSize: 1,
    coldWarm: 'warm',
    persona: { profileId: 'isla', version: '1.0.0' },
    modelVersion: 'test-model-v1',
    promptVersion: 'prompt-v1',
    textBudget: { maxCharacters: 400, accounting: 'rendered characters' },
    history: { source: 'durable', recordSet: 'recorded-run-v1' },
    textSource: 'provider',
    clock: 'wall',
    recall: { supplied: false, maxTurns: null },
  },
  records: [RECORD, RECORD],
  notRun: [],
})

const parsedRun = parseRecordedRun(RUN_TEXT)
if (!parsedRun.ok) throw new Error('fixture run must parse')
const RUN = { runId: 'run-1', records: parsedRun.input.run.records }
const DIGEST = provenanceRunDigest(RUN_TEXT)
const REVISION = 'a'.repeat(64)

const INPUT = {
  inputId: 'corpus-v1/case-1/event-1',
  sourceId: 'source-1',
  requestMessageId: 'req-1',
  eventId: 'event-1',
  status: 'accepted',
} as const

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: 'case-1',
    variantId: 'v1',
    attempt: 1,
    inputs: [INPUT],
    recordSetRevision: REVISION,
    correlation: 'exact',
    ...overrides,
  }
}

function companion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provenanceVersion: 1,
    runId: 'run-1',
    runDigest: DIGEST,
    attempts: [attempt(), attempt({ attempt: 2 })],
    ...overrides,
  }
}

function refused(result: ProvenanceParse): readonly string[] {
  if (result.ok) throw new Error('expected a refusal, got an acceptance')
  return result.violations
}

describe('provenance companion (ADR-008)', () => {
  it('accepts a companion whose key set and digest match the run', () => {
    const result = parseProvenance(companion(), RUN, RUN_TEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.companion.runId).toBe('run-1')
    expect(result.companion.attempts.map((entry) => entry.attempt)).toEqual([1, 2])
    expect(result.companion.attempts[0]?.inputs[0]?.status).toBe('accepted')
  })

  it('refuses an unknown root field instead of ignoring it', () => {
    const violations = refused(parseProvenance(companion({ extra: 'x' }), RUN, RUN_TEXT))
    expect(violations).toContain('extra is not a recognised field')
  })

  it('refuses a runId that names a different run', () => {
    const violations = refused(parseProvenance(companion({ runId: 'run-2' }), RUN, RUN_TEXT))
    expect(violations).toContain('runId does not match the run')
  })

  it('refuses a digest that does not match the exact run bytes', () => {
    const violations = refused(
      parseProvenance(companion({ runDigest: 'b'.repeat(64) }), RUN, RUN_TEXT),
    )
    expect(violations).toContain('runDigest does not match the exact run artifact')
  })

  it('refuses a companion that is missing an attempt of the run', () => {
    const violations = refused(
      parseProvenance(companion({ attempts: [attempt()] }), RUN, RUN_TEXT),
    )
    expect(violations.some((violation) => violation.includes('missing an entry'))).toBe(true)
  })

  it('refuses an attempt entry the run does not contain', () => {
    const violations = refused(
      parseProvenance(companion({ attempts: [attempt(), attempt({ attempt: 2 }), attempt({ attempt: 3 })] }), RUN, RUN_TEXT),
    )
    expect(violations.some((violation) => violation.includes('no run record'))).toBe(true)
  })

  it('refuses a duplicated occurrence key', () => {
    const violations = refused(
      parseProvenance(companion({ attempts: [attempt(), attempt()] }), RUN, RUN_TEXT),
    )
    expect(violations.some((violation) => violation.includes('repeats the occurrence key'))).toBe(
      true,
    )
  })

  it('refuses a submitted input that follows a not-submitted one', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({
              inputs: [
                { ...INPUT, status: 'not-submitted', requestMessageId: null, eventId: null },
                INPUT,
              ],
            }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('order cannot be established')),
    ).toBe(true)
  })

  it('accepts a stopped batch whose later inputs all stay not-submitted', () => {
    const result = parseProvenance(
      companion({
        attempts: [
          attempt({
            inputs: [
              INPUT,
              { ...INPUT, status: 'not-submitted', requestMessageId: null, eventId: null },
              { ...INPUT, status: 'not-submitted', requestMessageId: null, eventId: null },
            ],
          }),
          attempt({ attempt: 2 }),
        ],
      }),
      RUN,
      RUN_TEXT,
    )
    expect(result.ok).toBe(true)
  })

  it('refuses correlation exact when the record-set revision is null', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [attempt({ recordSetRevision: null }), attempt({ attempt: 2 })],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('cannot be null when correlation is exact')),
    ).toBe(true)
  })

  it('refuses more than five prepared inputs for one attempt', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({ inputs: [INPUT, INPUT, INPUT, INPUT, INPUT, INPUT] }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(violations.some((violation) => violation.includes('at most 5 entries'))).toBe(true)
  })

  it('refuses an undocumented input status', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({ inputs: [{ ...INPUT, status: 'maybe' }] }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(violations.some((violation) => violation.includes('.status must be one of'))).toBe(true)
  })

  it('accepts an uppercase digest and normalises it', () => {
    const result = parseProvenance(companion({ runDigest: DIGEST.toUpperCase() }), RUN, RUN_TEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.companion.runDigest).toBe(DIGEST)
  })

  it('records an unexported input identity as null, from null or the literal (D5)', () => {
    for (const inputId of [null, 'not-yet-observable']) {
      const result = parseProvenance(
        companion({
          attempts: [
            attempt({ inputs: [{ ...INPUT, inputId }] }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.companion.attempts[0]?.inputs[0]?.inputId).toBeNull()
    }
  })

  it('refuses a non-object root', () => {
    const violations = refused(parseProvenance('not an object', RUN, RUN_TEXT))
    expect(violations).toContain('the companion must be a JSON object')
  })

  it('refuses a non-array attempts field', () => {
    const violations = refused(parseProvenance(companion({ attempts: 'none' }), RUN, RUN_TEXT))
    expect(violations).toContain('attempts must be an array')
  })

  it('refuses an unknown provenance version', () => {
    const violations = refused(parseProvenance(companion({ provenanceVersion: 2 }), RUN, RUN_TEXT))
    expect(violations).toContain('provenanceVersion must be 1')
  })

  it('refuses a malformed record-set revision', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [attempt({ recordSetRevision: 'not-a-digest' }), attempt({ attempt: 2 })],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('.recordSetRevision must be a hex SHA-256')),
    ).toBe(true)
  })

  it('refuses an input entry that is not an object', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({ inputs: ['not an object'] }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(violations.some((violation) => violation.includes('must be an object'))).toBe(true)
  })
})


describe('M5 review rules (2026-11-09)', () => {
  it('refuses exact when the accepted input has no observed acknowledgement', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({ inputs: [{ ...INPUT, requestMessageId: null, eventId: null }] }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('no observed acknowledgement')),
    ).toBe(true)
  })

  it('accepts missing when the accepted input has no observed acknowledgement', () => {
    const result = parseProvenance(
      companion({
        attempts: [
          attempt({
            correlation: 'missing',
            inputs: [{ ...INPUT, requestMessageId: null, eventId: null }],
          }),
          attempt({ attempt: 2 }),
        ],
      }),
      RUN,
      RUN_TEXT,
    )
    expect(result.ok).toBe(true)
  })

  it('refuses a submission after a rejection', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({
              inputs: [
                INPUT,
                { ...INPUT, status: 'rejected' },
                { ...INPUT, status: 'accepted' },
              ],
            }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('follows a terminal input')),
    ).toBe(true)
  })

  it('refuses a submission after no-acknowledgement', () => {
    const violations = refused(
      parseProvenance(
        companion({
          attempts: [
            attempt({
              inputs: [
                INPUT,
                { ...INPUT, status: 'no-acknowledgement' },
                { ...INPUT, status: 'accepted' },
              ],
            }),
            attempt({ attempt: 2 }),
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('follows a terminal input')),
    ).toBe(true)
  })

  it('allows not-submitted entries after a rejection', () => {
    const result = parseProvenance(
      companion({
        attempts: [
          attempt({
            inputs: [
              INPUT,
              { ...INPUT, status: 'rejected' },
              { ...INPUT, status: 'not-submitted' },
            ],
          }),
          attempt({ attempt: 2 }),
        ],
      }),
      RUN,
      RUN_TEXT,
    )
    expect(result.ok).toBe(true)
  })

  it('does not collide when identifiers contain the old NUL delimiter', () => {
    const left = buildOccurrenceKey('alpha\u0000beta', 'gamma', 1)
    const right = buildOccurrenceKey('alpha', 'beta\u0000gamma', 1)
    expect(left).not.toBe(right)
    expect(parseOccurrenceKey(left)).toEqual({
      caseId: 'alpha\u0000beta',
      variantId: 'gamma',
      attempt: 1,
    })
    expect(parseOccurrenceKey(right)).toEqual({
      caseId: 'alpha',
      variantId: 'beta\u0000gamma',
      attempt: 1,
    })
  })

  it('refuses a malformed occurrence key', () => {
    expect(parseOccurrenceKey('case-1-v1-1')).toBeNull()
    expect(parseOccurrenceKey('[]')).toBeNull()
  })
})


describe('not-run observations (ADR-008 D4)', () => {
  it('refuses a null occurrence', () => {
    const violations = refused(
      parseProvenance(
        companion({
          notRun: [
            { caseId: 'case-9', variantId: 'v1', occurrence: null, inputs: [INPUT] },
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(
      violations.some((violation) => violation.includes('occurrence must be an integer')),
    ).toBe(true)
  })

  it('refuses the removed companion reason field', () => {
    const violations = refused(
      parseProvenance(
        companion({
          notRun: [
            { caseId: 'case-9', variantId: 'v1', reason: 'declined', inputs: [INPUT] },
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(violations.some((violation) => violation.includes('reason is not a recognised field'))).toBe(
      true,
    )
  })

  it('refuses a not-run observation for a case the run executed', () => {
    const violations = refused(
      parseProvenance(
        companion({
          notRun: [
            { caseId: 'case-1', variantId: 'v1', inputs: [INPUT] },
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(violations.some((violation) => violation.includes('not a not-run occurrence'))).toBe(true)
  })

  it('refuses a duplicate not-run pair', () => {
    const entry = {
      caseId: 'case-9',
      variantId: 'v1',
      inputs: [INPUT],
    }
    const violations = refused(
      parseProvenance(companion({ notRun: [entry, entry] }), RUN, RUN_TEXT),
    )
    expect(
      violations.some((violation) => violation.includes('repeats the case, variant and occurrence')),
    ).toBe(true)
  })

  it('refuses an unknown not-run field', () => {
    const violations = refused(
      parseProvenance(
        companion({
          notRun: [
            {
              caseId: 'case-9',
              variantId: 'v1',
              inputs: [INPUT],
              extra: 'x',
            },
          ],
        }),
        RUN,
        RUN_TEXT,
      ),
    )
    expect(violations.some((violation) => violation.includes('is not a recognised field'))).toBe(
      true,
    )
  })
})
