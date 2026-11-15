import { describe, expect, it } from 'vitest'
import { evaluateEligibility } from '../../src/evaluation/eligibility'
import type { AttemptRecord } from '../../src/evaluation/metrics'
import {
  type ProvenanceAttempt,
  type ProvenanceCompanionV1,
} from '../../src/evaluation/provenance'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import { renderEvaluationReport } from '../../src/evaluation/report'

/**
 * M6-02 — eligibility per attempt (protocol §3).
 *
 * The fixture is structural: it proves which named reason is chosen and in what
 * order, not that a real run is provenance-eligible.
 */

const TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

function record(caseId: string): AttemptRecord {
  return {
    caseId,
    variantId: 'v1',
    cold: true,
    outcome: 'completed',
    timing: TIMING,
    totalMs: 100,
    attempts: 1,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, usageMissing: false },
    failureReason: null,
  }
}

const RECORDS = [record('case-1'), record('case-2')]

const INPUT = {
  inputId: 'corpus-v1/case/event-1',
  sourceId: 'source-1',
  requestMessageId: 'req-1',
  eventId: 'event-1',
  status: 'accepted',
} as const

const REVISION = 'a'.repeat(64)

function attempt(caseId: string, overrides: Partial<ProvenanceAttempt> = {}): ProvenanceAttempt {
  return {
    caseId,
    variantId: 'v1',
    attempt: 1,
    inputs: [INPUT],
    recordSetRevision: REVISION,
    correlation: 'exact',
    ...overrides,
  }
}

function companion(
  attempts: readonly ProvenanceAttempt[] = [attempt('case-1'), attempt('case-2')],
): ProvenanceCompanionV1 {
  return {
    provenanceVersion: 1,
    runId: 'run-1',
    runDigest: 'a'.repeat(64),
    attempts,
    notRun: [],
  }
}

describe('scoring eligibility (protocol §3)', () => {
  it('marks every attempt no-provenance-record when no companion exists', () => {
    const result = evaluateEligibility(null, RECORDS)
    expect(result.map((entry) => entry.caseId)).toEqual(['case-1', 'case-2'])
    for (const entry of result) {
      expect(entry.eligibility).toEqual({ state: 'unscored', reason: 'no-provenance-record' })
    }
  })

  it('marks a missing link missing-acknowledgement-link', () => {
    const result = evaluateEligibility(
      companion([attempt('case-1', { correlation: 'missing' }), attempt('case-2')]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({
      state: 'unscored',
      reason: 'missing-acknowledgement-link',
    })
    expect(result[1]?.eligibility).toEqual({ state: 'provenance-eligible' })
  })

  it('marks an ambiguous link ambiguous-acknowledgement-link', () => {
    const result = evaluateEligibility(
      companion([attempt('case-1', { correlation: 'ambiguous' }), attempt('case-2')]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({
      state: 'unscored',
      reason: 'ambiguous-acknowledgement-link',
    })
  })

  it('marks an unobservable input identity missing-input-identity', () => {
    const result = evaluateEligibility(
      companion([
        attempt('case-1', { inputs: [{ ...INPUT, inputId: null }] }),
        attempt('case-2'),
      ]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({
      state: 'unscored',
      reason: 'missing-input-identity',
    })
  })

  it('marks an attempt with no accepted or duplicate input missing-input-identity', () => {
    const result = evaluateEligibility(
      companion([
        attempt('case-1', {
          inputs: [{ ...INPUT, status: 'not-submitted', requestMessageId: null, eventId: null }],
        }),
        attempt('case-2'),
      ]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({
      state: 'unscored',
      reason: 'missing-input-identity',
    })
  })

  it('marks an unobserved record set missing-history-observation', () => {
    const result = evaluateEligibility(
      companion([attempt('case-1', { recordSetRevision: null }), attempt('case-2')]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({
      state: 'unscored',
      reason: 'missing-history-observation',
    })
  })

  it('names the first failure in protocol order', () => {
    // Both the link and the record set are missing; the link comes first.
    const result = evaluateEligibility(
      companion([
        attempt('case-1', { correlation: 'missing', recordSetRevision: null }),
        attempt('case-2'),
      ]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({
      state: 'unscored',
      reason: 'missing-acknowledgement-link',
    })
  })

  it('accepts a duplicate submission with an identity as provenance-eligible', () => {
    const result = evaluateEligibility(
      companion([
        attempt('case-1', { inputs: [{ ...INPUT, status: 'duplicate' }] }),
        attempt('case-2'),
      ]),
      RECORDS,
    )
    expect(result[0]?.eligibility).toEqual({ state: 'provenance-eligible' })
  })
})

describe('eligibility in the rendered table', () => {
  const RUN_TEXT = JSON.stringify({
    schemaVersion: 1,
    meta: { runId: 'run-1', generatedAt: '2026-11-06' },
    variants: [{ id: 'v1', kind: 'rules', combined: false }],
    conditions: {
      hardware: 'test host',
      providers: ['test-provider'],
      workload: 'two synthetic attempts',
      sampleSize: 2,
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
    records: [
      {
        caseId: 'case-1',
        variantId: 'v1',
        cold: true,
        outcome: 'completed',
        timing: TIMING,
        totalMs: 100,
        attempts: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, usageMissing: false },
        failureReason: null,
      },
      {
        caseId: 'case-2',
        variantId: 'v1',
        cold: true,
        outcome: 'completed',
        timing: TIMING,
        totalMs: 100,
        attempts: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, usageMissing: false },
        failureReason: null,
      },
    ],
    notRun: [],
  })

  it('renders the provenance-eligibility column and states that a scored attempt needs a label', () => {
    const parsed = parseRecordedRun(RUN_TEXT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = renderEvaluationReport({
      ...parsed.input,
      provenance: companion([
        attempt('case-1', { inputs: [{ ...INPUT, inputId: null }] }),
        attempt('case-2'),
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain('| Provenance eligibility |')
    expect(result.markdown).toContain('provenance-eligible')
    expect(result.markdown).toContain('unscored (missing-input-identity)')
    expect(result.markdown).toContain('**`provenance-eligible` does not mean scored:**')
    expect(result.markdown).toContain('condition-mismatch')
  })

  it('renders the all-attempts note when no companion exists', () => {
    const parsed = parseRecordedRun(RUN_TEXT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = renderEvaluationReport(parsed.input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain('every attempt is `unscored (no-provenance-record)`')
  })
})
