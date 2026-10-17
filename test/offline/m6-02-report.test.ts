import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComparisonRun, Variant } from '../../src/evaluation/comparison'
import { summarise, type AttemptRecord } from '../../src/evaluation/metrics'
import * as reportModule from '../../src/evaluation/report'
import {
  renderEvaluationReport,
  writeEvaluationReport,
  type FixedConditions,
  type ReportInput,
} from '../../src/evaluation/report'

const VARIANT: Variant = { id: 'rules-baseline', kind: 'rules', combined: false }

const CONDITIONS: FixedConditions = {
  hardware: 'Sample host — Apple M3, 16 GB (test data)',
  providers: ['sample-provider'],
  workload: '3 synthetic cases x 1 variant (test data)',
  sampleSize: 3,
  coldWarm: 'warm',
  persona: { profileId: 'isla', version: '1.0.0' },
  modelVersion: 'sample-model-v1',
  promptVersion: 'prompt-v1',
  textBudget: { maxCharacters: 400, accounting: 'rendered characters, shared with recall' },
  history: { source: 'durable', recordSet: 'case-history-v1' },
  textSource: 'provider',
  clock: 'wall',
  recall: { supplied: true, maxTurns: 0 },
}

function record(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    caseId: 'case-normal',
    variantId: VARIANT.id,
    cold: false,
    outcome: 'completed',
    timing: { ...FULL_TIMING },
    totalMs: 245,
    attempts: 1,
    usage: { inputTokens: 120, outputTokens: 60, costUsd: 0.002, usageMissing: false },
    failureReason: null,
    ...overrides,
  }
}

/** One completed (first attempt), one cancelled, one failed with no usage. */
function sampleRun(): ComparisonRun {
  const records = [
    record({ caseId: 'case-normal', outcome: 'completed', cold: true }),
    record({
      caseId: 'case-stop',
      outcome: 'cancelled',
      cold: false,
      totalMs: 150,
      timing: {
        submitMs: 5,
        planMs: 40,
        dialogueMs: 120,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
    }),
    record({
      caseId: 'case-fail',
      outcome: 'failed',
      cold: false,
      totalMs: null,
      timing: {
        submitMs: null,
        planMs: null,
        dialogueMs: null,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
      failureReason: 'sample provider rejection',
    }),
  ]
  return {
    records,
    notRun: [{ variantId: VARIANT.id, caseId: 'case-skip', reason: 'no provider for this case' }],
    summary: summarise(records),
  }
}

const META = { runId: 'run-2026-10-17-1', generatedAt: '2026-10-17' }

const FULL_TIMING = {
  submitMs: 5,
  planMs: 40,
  dialogueMs: 120,
  synthesisMs: 80,
  firstAudibleMs: 245,
  stopToSilenceMs: null,
} as const

const NO_TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

function input(overrides: {
  run?: ComparisonRun
  conditions?: Partial<FixedConditions>
  meta?: { runId: string; generatedAt: string }
} = {}): ReportInput {
  return {
    run: overrides.run ?? sampleRun(),
    variants: [VARIANT],
    conditions: { ...CONDITIONS, ...overrides.conditions },
    meta: overrides.meta ?? META,
  }
}

describe('the evaluation report is a receipt for a real run', () => {
  it('records the five conditions gate G4 requires, plus the ones #41 asked for', () => {
    const result = renderEvaluationReport(input())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const text = result.markdown.toLowerCase()
    for (const word of ['hardware', 'provider', 'workload', 'sample', 'cold']) {
      expect(text).toContain(word)
    }
    for (const detail of ['persona', 'model version', 'prompt version', 'text budget', 'history', 'clock', 'maxturns', 'recall port']) {
      expect(text).toContain(detail)
    }
  })

  it('escapes a pipe or newline in a table cell instead of breaking the table', () => {
    const run = sampleRun()
    const withPipe = {
      ...run,
      notRun: [
        ...run.notRun,
        { variantId: VARIANT.id, caseId: 'case-pipe', reason: 'a | b\nc' },
      ],
    }
    const table = renderEvaluationReport(input({ run: withPipe }))
    if (!table.ok) throw new Error('unreachable')
    expect(table.markdown).toContain('| rules-baseline | case-pipe | a \\| b c |')
  })

  it('names the run it describes', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('> Run `run-2026-10-17-1` — generated 2026-10-17.')
  })

  it('prints a small cost with enough precision to be true', () => {
    const known = sampleRun()
    const records = [record({ caseId: 'case-normal', cold: true })]
    const run = { ...known, records, notRun: [], summary: summarise(records) }
    const result = renderEvaluationReport(input({ run, conditions: { sampleSize: 1 } }))
    if (!result.ok) throw new Error('unreachable')
    // 0.002 at one decimal would print "0.0": a non-zero cost reported as zero.
    expect(result.markdown).toContain('$0.002')
    expect(result.markdown).not.toContain('$0.0 |')
  })

  it('counts completed, cancelled and failed attempts, and reports the failure rate', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| rules-baseline | rules | no | 3 | 1 | 1 | 1 | 33.3% | unknown |')
  })

  it('prints no number for a stage that was never observed, and keeps usage unknown', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| stop→silence (M1/M2) | 0 | — | — |')
    expect(result.markdown).toContain('| unknown |')
  })

  it('distinguishes bench attempts from provider attempts', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| Variant | Kind | Combined | Bench attempts |')
    expect(result.markdown).toContain('| Case | Variant | Window | Outcome | total ms | Provider attempts |')
  })

  it('prints — when the provider-attempt count was not observed', () => {
    const run = sampleRun()
    run.records[2]!.attempts = null
    const result = renderEvaluationReport(input({ run }))
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain(
      '| case-fail | rules-baseline | later | failed | — | — | sample provider rejection |',
    )
    expect(result.markdown).toContain('not observed, for example when an')
  })

  it('labels each attempt row as the first attempt or a later one', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| case-normal | rules-baseline | first | completed |')
    expect(result.markdown).toContain('| case-stop | rules-baseline | later | cancelled |')
  })

  it('lists a not-run case with its reason and does not count it as an attempt', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('| rules-baseline | case-skip | no provider for this case |')
    expect(result.markdown).toContain('| 3 | 1 | 1 | 1 |')
  })

  it('labels the first attempt honestly instead of calling it cold', () => {
    const result = renderEvaluationReport(input())
    if (!result.ok) throw new Error('unreachable')
    expect(result.markdown).toContain('first attempt')
    expect(result.markdown).toContain('not** evidence of a')
    expect(result.markdown).toContain('declared cold/warm state above is the run condition')
  })
})

describe('the report refuses a run it cannot honestly publish', () => {
  const violationsOf = (overrides: Parameters<typeof input>[0]): readonly string[] => {
    const result = renderEvaluationReport(input(overrides))
    return result.ok ? [] : result.violations
  }

  it('refuses a fixture text source', () => {
    expect(violationsOf({ conditions: { textSource: 'fixture' } }).join(' ')).toContain(
      'fixture text source is not a benchmark',
    )
  })

  it('refuses latency measured with an injected clock', () => {
    expect(violationsOf({ conditions: { clock: 'injected' } }).join(' ')).toContain('injected clock cannot measure')
  })

  it('allows an injected clock when nothing was measured', () => {
    const noTiming = sampleRun()
    const records = noTiming.records.map((entry) => ({
      ...entry,
      timing: {
        submitMs: null,
        planMs: null,
        dialogueMs: null,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
      totalMs: null,
    }))
    expect(
      renderEvaluationReport(
        input({ run: { ...noTiming, records, summary: summarise(records) }, conditions: { clock: 'injected' } }),
      ).ok,
    ).toBe(true)
  })

  it('refuses a run with no attempts', () => {
    const empty: ComparisonRun = { records: [], notRun: [], summary: summarise([]) }
    const violations = violationsOf({ run: empty, conditions: { sampleSize: 1 } })
    expect(violations.join(' ')).toContain('no attempts were recorded')
  })

  it('refuses a declared sample size that does not match the records', () => {
    expect(violationsOf({ conditions: { sampleSize: 9 } }).join(' ')).toContain('does not match the 3 attempts')
  })

  it('refuses a missing fixed condition, naming it', () => {
    expect(violationsOf({ conditions: { hardware: '  ' } }).join(' ')).toContain('hardware is required')
    expect(violationsOf({ conditions: { workload: '' } }).join(' ')).toContain('workload is required')
    expect(violationsOf({ conditions: { providers: [] } }).join(' ')).toContain('at least one provider')
  })

  it('refuses a report that cannot be attributed', () => {
    expect(violationsOf({ meta: { runId: '   ', generatedAt: '2026-10-17' } }).join(' ')).toContain('run id is required')
    expect(violationsOf({ meta: { runId: 'run-1', generatedAt: '17/10/2026' } }).join(' ')).toContain('YYYY-MM-DD')
  })

  it('refuses injected-clock latency recorded only as a total', () => {
    const run = sampleRun()
    const records = run.records.map((entry) => ({
      ...entry,
      timing: {
        submitMs: null,
        planMs: null,
        dialogueMs: null,
        synthesisMs: null,
        firstAudibleMs: null,
        stopToSilenceMs: null,
      },
      totalMs: 245,
    }))
    const violations = violationsOf({ run: { ...run, records }, conditions: { clock: 'injected' } })
    expect(violations.join(' ')).toContain('injected clock cannot measure latency')
  })

  it('refuses a negative or non-finite duration', () => {
    const negative = sampleRun()
    negative.records[0]!.timing.submitMs = -5
    expect(violationsOf({ run: negative }).join(' ')).toContain('negative or not a finite number')
    const notFinite = sampleRun()
    notFinite.records[1]!.totalMs = Number.NaN
    expect(violationsOf({ run: notFinite }).join(' ')).toContain('not a finite number')
  })

  it('refuses a negative or fractional provider-attempt count', () => {
    const negative = sampleRun()
    negative.records[0]!.attempts = -1
    expect(violationsOf({ run: negative }).join(' ')).toContain('null or a whole number')
    const fractional = sampleRun()
    fractional.records[0]!.attempts = 1.5
    expect(violationsOf({ run: fractional }).join(' ')).toContain('null or a whole number')
  })

  it('refuses a failed attempt with no reason', () => {
    const run = sampleRun()
    run.records[2]!.failureReason = null
    expect(violationsOf({ run }).join(' ')).toContain('failed attempt with no reason')
  })

  it('refuses an impossible calendar date', () => {
    expect(violationsOf({ meta: { runId: 'run-1', generatedAt: '2026-02-31' } }).join(' ')).toContain(
      'real YYYY-MM-DD calendar date',
    )
  })

  it('refuses a record for a variant the run did not declare', () => {
    const run = sampleRun()
    const result = renderEvaluationReport({
      run,
      variants: [{ ...VARIANT, id: 'other' }],
      conditions: { ...CONDITIONS },
      meta: META,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.violations.join(' ')).toContain('not declared in the run')
  })
})

describe('two variants are reported side by side without leaking aggregates', () => {
  const MODEL: Variant = { id: 'model-candidate', kind: 'model', combined: true }

  function twoVariantRun(): ComparisonRun {
    const records = [
      record({ caseId: 'case-a', variantId: 'rules-baseline', cold: true }),
      record({
        caseId: 'case-a',
        variantId: 'rules-baseline',
        cold: false,
        timing: { ...FULL_TIMING, submitMs: 7, planMs: 44 },
      }),
      record({
        caseId: 'case-a',
        variantId: 'model-candidate',
        cold: true,
        timing: { ...FULL_TIMING, submitMs: 9, planMs: 80, dialogueMs: 200, synthesisMs: 120, firstAudibleMs: 420 },
        totalMs: 420,
        usage: { inputTokens: 150, outputTokens: 70, costUsd: 0.004, usageMissing: false },
      }),
      record({
        caseId: 'case-a',
        variantId: 'model-candidate',
        cold: false,
        outcome: 'failed',
        timing: { ...NO_TIMING },
        totalMs: null,
        usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
        failureReason: 'sample rejection',
      }),
    ]
    return { records, notRun: [], summary: summarise(records) }
  }

  const run = twoVariantRun()
  const result = renderEvaluationReport({
    run,
    variants: [VARIANT, MODEL],
    conditions: { ...CONDITIONS, sampleSize: 4 },
    meta: META,
  })
  const text = result.ok ? result.markdown : ''

  it('reports a separate row per variant, with separate usage', () => {
    expect(result.ok).toBe(true)
    expect(text).toContain('| rules-baseline | rules | no | 2 | 2 | 0 | 0 | 0.0% | 240 in / 120 out / $0.004 |')
    expect(text).toContain('| model-candidate | model | yes | 2 | 1 | 0 | 1 | 50.0% | unknown |')
  })

  it('reports separate first-attempt and later-attempt percentiles per variant', () => {
    expect(text).toContain('| rules-baseline | first attempt | submit (M5) | 1 | 5 | 5 |')
    expect(text).toContain('| model-candidate | first attempt | submit (M5) | 1 | 9 | 9 |')
    expect(text).toContain('| model-candidate | later attempts | submit (M5) | 0 | — | — |')
  })
})

describe('the writer is the only path to the G4 artifact', () => {
  const directories: string[] = []
  afterEach(() => {
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
  })
  const target = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'm6-report-'))
    directories.push(directory)
    return join(directory, 'evaluation-table.md')
  }

  it('writes exactly the rendered report', () => {
    const path = target()
    const result = writeEvaluationReport(input(), path)
    expect(result).toEqual({ ok: true, path })
    const rendered = renderEvaluationReport(input())
    if (!rendered.ok) throw new Error('unreachable')
    expect(readFileSync(path, 'utf8')).toBe(rendered.markdown)
    // The temporary file is renamed into place; the directory must hold only the table.
    expect(readdirSync(dirname(path))).toEqual(['evaluation-table.md'])
  })

  it('writes nothing when the run cannot be published', () => {
    const path = target()
    const result = writeEvaluationReport(input({ conditions: { textSource: 'fixture' } }), path)
    expect(result.ok).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('does not overwrite an existing table when the run is refused', () => {
    const path = target()
    writeFileSync(path, 'previous table\n', 'utf8')
    const result = writeEvaluationReport(input({ conditions: { clock: 'injected' } }), path)
    expect(result.ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('previous table\n')
  })

  it('refuses a fixture source at the writer, with the reason', () => {
    const path = target()
    const result = writeEvaluationReport(input({ conditions: { textSource: 'fixture' } }), path)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.violations.join(' ')).toContain('fixture text source is not a benchmark')
    expect(existsSync(path)).toBe(false)
  })
})

describe('every condition the report prints is also validated', () => {
  const rendered = renderEvaluationReport(input())
  if (!rendered.ok) throw new Error('the fixture run must render')
  const conditionSection = rendered.markdown.split('## Fixed conditions')[1]?.split('## ')[0] ?? ''
  const labels = conditionSection
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .map((line) => line.split('|')[1]?.trim() ?? '')
    .filter((label) => label.length > 0 && label !== 'Condition')

  const checks: ReadonlyArray<{
    label: string
    mutate: (conditions: FixedConditions) => FixedConditions
    expect: string
  }> = [
    { label: 'Hardware', mutate: (c) => ({ ...c, hardware: ' ' }), expect: 'hardware' },
    { label: 'Providers', mutate: (c) => ({ ...c, providers: [] }), expect: 'provider' },
    { label: 'Workload', mutate: (c) => ({ ...c, workload: '' }), expect: 'workload' },
    { label: 'Sample size (attempts)', mutate: (c) => ({ ...c, sampleSize: 0 }), expect: 'sample size' },
    {
      label: 'Cold/warm state (declared)',
      mutate: (c) => ({ ...c, coldWarm: 'lukewarm' as never }),
      expect: 'cold/warm',
    },
    {
      label: 'Persona profile',
      mutate: (c) => ({ ...c, persona: { ...c.persona, version: '' } }),
      expect: 'persona',
    },
    { label: 'Model version', mutate: (c) => ({ ...c, modelVersion: '' }), expect: 'model version' },
    { label: 'Prompt version', mutate: (c) => ({ ...c, promptVersion: '' }), expect: 'prompt' },
    {
      label: 'Text budget',
      mutate: (c) => ({ ...c, textBudget: { ...c.textBudget, accounting: '' } }),
      expect: 'text-budget accounting',
    },
    {
      label: 'History',
      mutate: (c) => ({ ...c, history: { ...c.history, recordSet: '' } }),
      expect: 'history',
    },
    { label: 'Text source', mutate: (c) => ({ ...c, textSource: 'fixture' }), expect: 'fixture text source' },
    { label: 'Clock', mutate: (c) => ({ ...c, clock: 'injected' }), expect: 'injected clock' },
    { label: 'maxTurns', mutate: (c) => ({ ...c, recall: { ...c.recall, maxTurns: -1 } }), expect: 'maxTurns' },
    {
      label: 'Recall port',
      mutate: (c) => ({ ...c, recall: { ...c.recall, supplied: undefined as never } }),
      expect: 'recall port',
    },
  ]

  it('prints exactly the conditions that have a validation case', () => {
    expect(labels).toEqual(checks.map((check) => check.label))
  })

  it('refuses the run when any printed condition is missing or invalid', () => {
    for (const check of checks) {
      const result = renderEvaluationReport({ ...input(), conditions: check.mutate(CONDITIONS) })
      expect(result.ok, check.label).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.violations.join(' '), check.label).toContain(check.expect)
    }
  })
})

describe('the module exposes only its documented surface', () => {
  it('has exactly two runtime exports', () => {
    expect(Object.keys(reportModule).sort()).toEqual(['renderEvaluationReport', 'writeEvaluationReport'])
  })
})
