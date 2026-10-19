import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBench, serializeRecordedRun, type BenchConditions } from '../../src/evaluation/bench'
import type { EvalCase, Variant } from '../../src/evaluation/comparison'
import type { AttemptRecord } from '../../src/evaluation/metrics'
import { parseRecordedRun, type RecordedRunV1 } from '../../src/evaluation/recorded-run'
import { runReportCommand } from '../../src/evaluation/report-command'
import {
  SYNTHETIC_CASES,
  SYNTHETIC_VARIANT,
  syntheticRunVariant,
} from '../support/m6-02-synthetic'

const CONDITIONS: BenchConditions = {
  hardware: 'test host',
  providers: ['test-provider'],
  workload: 'synthetic recorded bench',
  coldWarm: 'warm',
  persona: { profileId: 'isla', version: '1.0.0' },
  modelVersion: 'test-model-v1',
  promptVersion: 'prompt-v1',
  textBudget: { maxCharacters: 400, accounting: 'rendered characters' },
  history: { source: 'durable', recordSet: 'recorded-run-v1' },
  textSource: 'provider',
  clock: 'wall',
  recall: { supplied: false, maxTurns: null },
}

const META = { runId: 'bench-1', generatedAt: '2026-10-19' }
const CASE: EvalCase = { id: 'case-1', input: 'hello' }
const VARIANT: Variant = { id: 'v1', kind: 'rules', combined: false }

const TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function completedRecord(caseId: string, variantId: string): AttemptRecord {
  return {
    caseId,
    variantId,
    cold: false,
    outcome: 'completed',
    timing: TIMING,
    totalMs: 10,
    attempts: 1,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, usageMissing: false },
    failureReason: null,
  }
}

describe('M6-02 R2 runBench', () => {
  it('returns the frozen v1 shape with an actual attempt sample size', async () => {
    const run = await runBench(
      {
        meta: META,
        conditions: CONDITIONS,
        variants: [SYNTHETIC_VARIANT],
        cases: SYNTHETIC_CASES,
      },
      { runVariant: syntheticRunVariant() },
    )

    expect(run.schemaVersion).toBe(1)
    expect(run.conditions.sampleSize).toBe(3)
    expect(run.records).toHaveLength(3)
    expect(run.notRun).toEqual([])
    expect(run.records.map((record) => record.cold)).toEqual([true, false, false])
    expect('summary' in run).toBe(false)

    const serialized = serializeRecordedRun(run)
    expect(serialized.endsWith('\n')).toBe(true)
    const parsed = parseRecordedRun(serialized)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.input.run.summary.attempts).toBe(3)
  })

  it('counts attempts, not cases, when a case is not run', async () => {
    const cases: EvalCase[] = [
      { id: 'case-run', input: 'run' },
      { id: 'case-skip', input: 'skip' },
    ]
    const run = await runBench(
      { meta: META, conditions: CONDITIONS, variants: [VARIANT], cases },
      {
        runVariant: async (_variant, evalCase) =>
          evalCase.id === 'case-skip'
            ? { ran: false, reason: 'not configured' }
            : {
                ran: true,
                record: {
                  caseId: 'ignored',
                  variantId: 'ignored',
                  cold: false,
                  outcome: 'completed',
                  timing: {
                    submitMs: null,
                    planMs: null,
                    dialogueMs: null,
                    synthesisMs: null,
                    firstAudibleMs: null,
                    stopToSilenceMs: null,
                  },
                  totalMs: 10,
                  attempts: 1,
                  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, usageMissing: false },
                  failureReason: null,
                },
              },
      },
    )

    expect(run.conditions.sampleSize).toBe(1)
    expect(run.records).toHaveLength(1)
    expect(run.notRun).toEqual([
      { variantId: 'v1', caseId: 'case-skip', reason: 'not configured' },
    ])
    expect(parseRecordedRun(JSON.stringify(run)).ok).toBe(true)
  })

  it('writes a runBench recording through the R1 report command without losing attempts or not-run entries', async () => {
    const first: Variant = { id: 'rules-a', kind: 'rules', combined: false }
    const second: Variant = { id: 'model-b', kind: 'model', combined: true }
    const cases: EvalCase[] = [
      { id: 'case-run', input: 'execute this case' },
      { id: 'case-skip', input: 'skip this case' },
    ]

    const run = await runBench(
      { meta: META, conditions: CONDITIONS, variants: [first, second], cases },
      {
        runVariant: async (variant, evalCase) =>
          evalCase.id === 'case-skip'
            ? { ran: false, reason: `${variant.id} skipped by test` }
            : { ran: true, record: completedRecord(evalCase.id, variant.id) },
      },
    )

    expect(run.conditions.sampleSize).toBe(2)
    expect(run.records).toHaveLength(2)
    expect(run.notRun).toHaveLength(2)

    const directory = mkdtempSync(join(tmpdir(), 'm6-r2-integration-'))
    directories.push(directory)
    const input = join(directory, 'run.json')
    const output = join(directory, 'table.md')
    writeFileSync(input, serializeRecordedRun(run), 'utf8')
    expect(runReportCommand(['--input', input, '--output', output])).toBe(0)
    expect(existsSync(output)).toBe(true)

    const report = readFileSync(output, 'utf8')
    expect(report).toContain('| rules-a | rules | no | 1 | 1 | 0 | 0 | 0.0% | 1 in / 1 out / $0 |')
    expect(report).toContain('| model-b | model | yes | 1 | 1 | 0 | 0 | 0.0% | 1 in / 1 out / $0 |')
    expect(report).toContain('| rules-a | case-skip | rules-a skipped by test |')
    expect(report).toContain('| model-b | case-skip | model-b skipped by test |')
  })

  it('rejects non-finite observations before serialization', async () => {
    const invalid = { ...completedRecord('case-1', 'v1'), totalMs: Number.NaN }
    await expect(
      runBench(
        { meta: META, conditions: CONDITIONS, variants: [VARIANT], cases: [CASE] },
        { runVariant: async () => ({ ran: true, record: invalid }) },
      ),
    ).rejects.toThrow('totalMs must be a finite number')
  })

  it('rejects non-finite values in the serializer without converting them to null', () => {
    const invalid = {
      schemaVersion: 1 as const,
      meta: META,
      variants: [VARIANT],
      conditions: { ...CONDITIONS, sampleSize: 1 },
      records: [{ ...completedRecord('case-1', 'v1'), timing: { ...TIMING, submitMs: Number.POSITIVE_INFINITY } }],
      notRun: [],
    } satisfies RecordedRunV1
    expect(() => serializeRecordedRun(invalid)).toThrow('records[0].timing.submitMs must be a finite number')
  })

  it('keeps a thrown variant as a failed record', async () => {
    const run = await runBench(
      { meta: META, conditions: CONDITIONS, variants: [VARIANT], cases: [CASE] },
      { runVariant: () => Promise.reject(new Error('synthetic failure')) },
    )

    expect(run.conditions.sampleSize).toBe(1)
    expect(run.records[0]?.outcome).toBe('failed')
    expect(run.records[0]?.failureReason).toBe('synthetic failure')
    expect(run.records[0]?.attempts).toBeNull()
    const parsed = parseRecordedRun(JSON.stringify(run))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.input.run.summary.outcomes.failed).toBe(1)
  })

  it('does not mutate the supplied cases or variants', async () => {
    const cases = [...SYNTHETIC_CASES]
    const variants = [SYNTHETIC_VARIANT]
    await runBench(
      { meta: META, conditions: CONDITIONS, variants, cases },
      { runVariant: syntheticRunVariant() },
    )
    expect(cases).toEqual(SYNTHETIC_CASES)
    expect(variants).toEqual([SYNTHETIC_VARIANT])
  })
})
