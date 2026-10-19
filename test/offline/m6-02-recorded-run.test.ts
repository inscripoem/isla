import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import { runReportCommand } from '../../src/evaluation/report-command'
import { renderEvaluationReport } from '../../src/evaluation/report'

const CONDITIONS = {
  hardware: 'test host',
  providers: ['test-provider'],
  workload: 'one synthetic recorded attempt',
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
} as const

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

const VARIANT = { id: 'v1', kind: 'rules', combined: false } as const

// Structural fixture: the conditions are synthetic; this is not a measurement.
const RUN = {
  schemaVersion: 1,
  meta: { runId: 'run-1', generatedAt: '2026-10-19' },
  variants: [VARIANT],
  conditions: CONDITIONS,
  records: [RECORD],
  notRun: [],
} as const

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'm6-r1-'))
  directories.push(directory)
  return directory
}

function writeRun(directory: string, value: unknown): string {
  const path = join(directory, 'run.json')
  writeFileSync(path, JSON.stringify(value), 'utf8')
  return path
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('recorded-run parser', () => {
  it('accepts a versioned run and recomputes its summary', () => {
    const parsed = parseRecordedRun(JSON.stringify(RUN))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.input.run.summary.attempts).toBe(1)
    expect(parsed.input.run.summary.failureRate).toBe(0)
    expect(parsed.input.run.summary.usage.unknown).toBe(false)
  })

  it('rejects an embedded summary instead of trusting it', () => {
    const parsed = parseRecordedRun(JSON.stringify({ ...RUN, summary: { attempts: 99 } }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('unreachable')
    expect(parsed.violations.join(' ')).toContain('summary is not a recognised field')
  })

  it('rejects blank variant, case and not-run identifiers or reasons', () => {
    const blankVariant = parseRecordedRun(
      JSON.stringify({ ...RUN, variants: [{ ...VARIANT, id: '   ' }] }),
    )
    expect(blankVariant.ok).toBe(false)
    if (blankVariant.ok) throw new Error('unreachable')
    expect(blankVariant.violations.join(' ')).toContain('must not be blank')

    const blankCase = parseRecordedRun(
      JSON.stringify({ ...RUN, records: [{ ...RECORD, caseId: '   ' }] }),
    )
    expect(blankCase.ok).toBe(false)
    if (blankCase.ok) throw new Error('unreachable')
    expect(blankCase.violations.join(' ')).toContain('must not be blank')

    const blankNotRun = parseRecordedRun(
      JSON.stringify({
        ...RUN,
        notRun: [{ variantId: 'v1', caseId: 'case-1', reason: '   ' }],
      }),
    )
    expect(blankNotRun.ok).toBe(false)
    if (blankNotRun.ok) throw new Error('unreachable')
    expect(blankNotRun.violations.join(' ')).toContain('must not be blank')
  })

  it('rejects malformed JSON and a wrong schema version', () => {
    const malformed = parseRecordedRun('{')
    expect(malformed.ok).toBe(false)
    if (malformed.ok) throw new Error('unreachable')
    expect(malformed.violations.join(' ')).toContain('not valid JSON')

    const wrongVersion = parseRecordedRun(JSON.stringify({ ...RUN, schemaVersion: 2 }))
    expect(wrongVersion.ok).toBe(false)
    if (wrongVersion.ok) throw new Error('unreachable')
    expect(wrongVersion.violations.join(' ')).toContain('schemaVersion must be 1')
  })
})

describe('evaluation:report command', () => {
  it('writes the rendered report to the explicit output path', () => {
    const directory = tempDirectory()
    const input = writeRun(directory, RUN)
    const output = join(directory, 'table.md')

    expect(runReportCommand(['--input', input, '--output', output])).toBe(0)
    expect(existsSync(output)).toBe(true)

    const parsed = parseRecordedRun(JSON.stringify(RUN))
    if (!parsed.ok) throw new Error('unreachable')
    const rendered = renderEvaluationReport(parsed.input)
    if (!rendered.ok) throw new Error('unreachable')
    expect(readFileSync(output, 'utf8')).toBe(rendered.markdown)
  })

  it('prints help without writing anything', () => {
    expect(runReportCommand(['--help'])).toBe(0)
  })

  it('requires an explicit output and rejects duplicate options', () => {
    const directory = tempDirectory()
    const input = writeRun(directory, RUN)
    expect(runReportCommand(['--input', input])).toBe(2)
    expect(
      runReportCommand(['--input', input, '--input', input, '--output', join(directory, 'table.md')]),
    ).toBe(2)
    expect(
      runReportCommand(['--input', input, '--output', join(directory, 'a.md'), '--output', join(directory, 'b.md')]),
    ).toBe(2)
  })

  it('returns a usage error when --input is missing', () => {
    expect(runReportCommand([])).toBe(2)
    expect(runReportCommand(['--output', join(tempDirectory(), 'table.md')])).toBe(2)
  })

  it('returns a usage error for an unknown argument', () => {
    expect(runReportCommand(['--input', 'x', '--nope'])).toBe(2)
  })

  it('refuses a malformed or unpublishable run and writes nothing', () => {
    const cases: ReadonlyArray<{ name: string; text: string }> = [
      { name: 'malformed JSON', text: '{' },
      { name: 'wrong version', text: JSON.stringify({ ...RUN, schemaVersion: 2 }) },
      {
        name: 'fixture source',
        text: JSON.stringify({ ...RUN, conditions: { ...CONDITIONS, textSource: 'fixture' } }),
      },
      {
        name: 'injected clock',
        text: JSON.stringify({ ...RUN, conditions: { ...CONDITIONS, clock: 'injected' } }),
      },
      {
        name: 'sample mismatch',
        text: JSON.stringify({ ...RUN, conditions: { ...CONDITIONS, sampleSize: 2 } }),
      },
      {
        name: 'empty attempts',
        text: JSON.stringify({ ...RUN, records: [], conditions: { ...CONDITIONS, sampleSize: 1 } }),
      },
      {
        name: 'blank not-run reason',
        text: JSON.stringify({
          ...RUN,
          notRun: [{ variantId: 'v1', caseId: 'case-1', reason: '   ' }],
        }),
      },
      {
        name: 'unknown record variant',
        text: JSON.stringify({
          ...RUN,
          records: [{ ...RECORD, variantId: 'other' }],
        }),
      },
    ]

    for (const entry of cases) {
      const directory = tempDirectory()
      const input = join(directory, 'run.json')
      const output = join(directory, 'table.md')
      writeFileSync(input, entry.text, 'utf8')
      expect(runReportCommand(['--input', input, '--output', output]), entry.name).toBe(1)
      expect(existsSync(output), entry.name).toBe(false)
    }
  })

  it('preserves an existing output when the run is refused', () => {
    const directory = tempDirectory()
    const input = writeRun(directory, {
      ...RUN,
      conditions: { ...CONDITIONS, textSource: 'fixture' },
    })
    const output = join(directory, 'table.md')
    writeFileSync(output, 'previous table\n', 'utf8')

    expect(runReportCommand(['--input', input, '--output', output])).toBe(1)
    expect(readFileSync(output, 'utf8')).toBe('previous table\n')
  })
})
