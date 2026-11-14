import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  provenanceRunDigest,
  type ProvenanceAttempt,
  type ProvenanceCompanionV1,
} from '../../src/evaluation/provenance'
import { runComparison } from '../../src/evaluation/comparison'
import type { AttemptRecord } from '../../src/evaluation/metrics'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import { parseReportCommandArgs, runReportCommand } from '../../src/evaluation/report-command'
import { renderEvaluationReport } from '../../src/evaluation/report'

/**
 * M6-02 / ADR-008 D8 — the report command consumes the companion or refuses.
 *
 * The command is the only place that holds the exact run bytes, so it is the
 * only place that can verify the digest. These cases pin the refusal behaviour:
 * a mismatched or malformed companion must never produce a table.
 */

const TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

const CONDITIONS = {
  hardware: 'test host',
  providers: ['test-provider'],
  workload: 'two synthetic recorded attempts',
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

const RUN = {
  schemaVersion: 1,
  meta: { runId: 'run-1', generatedAt: '2026-11-06' },
  variants: [{ id: 'v1', kind: 'rules', combined: false }],
  conditions: CONDITIONS,
  records: [record('case-1'), record('case-2')],
  notRun: [],
} as const

const RUN_TEXT = JSON.stringify(RUN)
const DIGEST = provenanceRunDigest(RUN_TEXT)
const REVISION = 'a'.repeat(64)

const INPUT = {
  inputId: 'corpus-v1/case-1/event-1',
  sourceId: 'source-1',
  requestMessageId: 'req-1',
  eventId: 'event-1',
  status: 'accepted',
} as const

function attempt(caseId: string, overrides: Record<string, unknown> = {}) {
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

function companion(overrides: Record<string, unknown> = {}) {
  return {
    provenanceVersion: 1,
    runId: 'run-1',
    runDigest: DIGEST,
    attempts: [attempt('case-1'), attempt('case-2')],
    ...overrides,
  }
}

function typedAttempt(caseId: string): ProvenanceAttempt {
  return {
    caseId,
    variantId: 'v1',
    attempt: 1,
    inputs: [INPUT],
    recordSetRevision: REVISION,
    correlation: 'exact',
  }
}

const directories: string[] = []

function workspace(): { dir: string; input: string; output: string; provenance: string } {
  const dir = mkdtempSync(join(tmpdir(), 'isla-provenance-command-'))
  directories.push(dir)
  const input = join(dir, 'recorded-run.json')
  const output = join(dir, 'evaluation-table.md')
  const provenance = join(dir, 'provenance.json')
  writeFileSync(input, RUN_TEXT, 'utf8')
  return { dir, input, output, provenance }
}

/**
 * Directory symlinks need Developer Mode or elevation on Windows. The refusal is
 * still exercised on Linux CI; the Windows run skips the symlink cases instead of
 * failing for an environment privilege it cannot grant.
 */
function symlinksSupported(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'isla-symlink-probe-'))
  try {
    symlinkSync(dir, join(dir, 'probe'), 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SYMLINKS = symlinksSupported()

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('evaluation:report --provenance', () => {
  it('writes a table with the accepted companion rows', () => {
    const { input, output, provenance } = workspace()
    writeFileSync(provenance, JSON.stringify(companion()), 'utf8')

    expect(runReportCommand(['--input', input, '--output', output, '--provenance', provenance])).toBe(
      0,
    )
    const table = readFileSync(output, 'utf8')
    expect(table).toContain('## Prepared-input provenance')
    expect(table).toContain('| case-1 | v1 | 1 | exact |')
    expect(table).toContain('accepted 1')
    expect(table).toContain('Companion source:')
    expect(table).toContain(provenance)
    expect(table).not.toContain('no-provenance-record')
  })

  it('refuses --output equal to --provenance and leaves the companion intact', () => {
    const { input, provenance } = workspace()
    const companionText = JSON.stringify(companion())
    writeFileSync(provenance, companionText, 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(
      runReportCommand(['--input', input, '--output', provenance, '--provenance', provenance]),
    ).toBe(1)
    expect(readFileSync(provenance, 'utf8')).toBe(companionText)
    expect(stderr.mock.calls.flat().join('')).toContain(
      '--output must not be the --provenance input',
    )
  })

  it('writes the no-companion note when the flag is absent', () => {
    const { input, output } = workspace()
    expect(runReportCommand(['--input', input, '--output', output])).toBe(0)
    const table = readFileSync(output, 'utf8')
    expect(table).toContain('no-provenance-record')
    expect(table).not.toContain('| case-1 | v1 | 1 | exact |')
  })

  it('refuses a companion from a different run and writes nothing', () => {
    const { input, output, provenance } = workspace()
    writeFileSync(provenance, JSON.stringify(companion({ runDigest: 'b'.repeat(64) })), 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(runReportCommand(['--input', input, '--output', output, '--provenance', provenance])).toBe(
      1,
    )
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain('runDigest does not match')
  })

  it('refuses a companion that is missing an attempt and writes nothing', () => {
    const { input, output, provenance } = workspace()
    writeFileSync(
      provenance,
      JSON.stringify(companion({ attempts: [attempt('case-1')] })),
      'utf8',
    )
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(runReportCommand(['--input', input, '--output', output, '--provenance', provenance])).toBe(
      1,
    )
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain('missing an entry')
  })

  it('refuses malformed JSON as a refusal, not a crash', () => {
    const { input, output, provenance } = workspace()
    writeFileSync(provenance, '{"provenanceVersion": 1,', 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(runReportCommand(['--input', input, '--output', output, '--provenance', provenance])).toBe(
      1,
    )
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain('not valid JSON')
  })

  it('returns the I/O code when the companion file cannot be read', () => {
    const { input, output, provenance } = workspace()
    expect(runReportCommand(['--input', input, '--output', output, '--provenance', provenance])).toBe(
      2,
    )
    expect(existsSync(output)).toBe(false)
  })

  it('rejects --provenance without a path', () => {
    const parsed = parseReportCommandArgs(['--input', 'in.json', '--output', 'out.md', '--provenance'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('--provenance requires a path')
  })

  it('rejects a repeated --provenance flag', () => {
    const parsed = parseReportCommandArgs([
      '--input',
      'in.json',
      '--output',
      'out.md',
      '--provenance',
      'a.json',
      '--provenance',
      'b.json',
    ])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('--provenance may be specified only once')
  })

  it('refuses a digest taken over different bytes of the same content', () => {
    const { dir, output, provenance } = workspace()
    const pretty = join(dir, 'recorded-run.pretty.json')
    writeFileSync(pretty, JSON.stringify(RUN, null, 2), 'utf8')
    // The digest names the compact artifact; the file on disk is the pretty one.
    writeFileSync(provenance, JSON.stringify(companion()), 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(runReportCommand(['--input', pretty, '--output', output, '--provenance', provenance])).toBe(
      1,
    )
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain('runDigest does not match')
  })

  it('refuses to render a companion that belongs to another run', () => {
    const parsed = parseRecordedRun(RUN_TEXT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const foreign: ProvenanceCompanionV1 = {
      provenanceVersion: 1,
      runId: 'another-run',
      runDigest: DIGEST,
      attempts: [typedAttempt('case-1'), typedAttempt('case-2')],
      notRun: [],
    }
    const result = renderEvaluationReport({ ...parsed.input, provenance: foreign })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations).toContain('runId does not match the run')
  })

  it('refuses to render a companion whose key set is not the run\'s', () => {
    const parsed = parseRecordedRun(RUN_TEXT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const partial: ProvenanceCompanionV1 = {
      provenanceVersion: 1,
      runId: 'run-1',
      runDigest: DIGEST,
      attempts: [typedAttempt('case-1')],
      notRun: [],
    }
    const result = renderEvaluationReport({ ...parsed.input, provenance: partial })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.some((violation) => violation.includes('missing an entry'))).toBe(true)
  })
})


describe('M5 review rules at the report boundary (2026-11-09)', () => {
  it('refuses exact when an accepted input has no observed acknowledgement', () => {
    const { input, output, provenance } = workspace()
    writeFileSync(
      provenance,
      JSON.stringify(
        companion({
          attempts: [
            attempt('case-1', { inputs: [{ ...INPUT, requestMessageId: null, eventId: null }] }),
            attempt('case-2'),
          ],
        }),
      ),
      'utf8',
    )
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(
      runReportCommand(['--input', input, '--output', output, '--provenance', provenance]),
    ).toBe(1)
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain('no observed acknowledgement')
  })

  it('renders observed inputs for a not-run case', () => {
    const run = {
      ...RUN,
      notRun: [{ variantId: 'v1', caseId: 'case-3', reason: 'declined' }],
    }
    const runText = JSON.stringify(run)
    const digest = provenanceRunDigest(runText)
    const { input, output, provenance } = workspace()
    writeFileSync(input, runText, 'utf8')
    writeFileSync(
      provenance,
      JSON.stringify({
        provenanceVersion: 1,
        runId: 'run-1',
        runDigest: digest,
        attempts: [attempt('case-1'), attempt('case-2')],
        notRun: [
          {
            caseId: 'case-3',
            variantId: 'v1',
            inputs: [{ ...INPUT, status: 'rejected', eventId: null }],
          },
        ],
      }),
      'utf8',
    )

    expect(
      runReportCommand(['--input', input, '--output', output, '--provenance', provenance]),
    ).toBe(0)
    const table = readFileSync(output, 'utf8')
    expect(table).toContain('### Not-run observations')
    expect(table).toContain('| case-3 | v1 | 1 | declined |')
    expect(table).toContain('rejected 1')
  })
})


describe('repeated not-run pairs (M5 contract, 2026-11-09)', () => {
  it('binds each occurrence and renders the run reason', () => {
    const run = {
      ...RUN,
      notRun: [
        { variantId: 'v1', caseId: 'case-3', reason: 'rejected' },
        { variantId: 'v1', caseId: 'case-3', reason: 'held' },
      ],
    }
    const runText = JSON.stringify(run)
    const digest = provenanceRunDigest(runText)
    const { input, output, provenance } = workspace()
    writeFileSync(input, runText, 'utf8')
    writeFileSync(
      provenance,
      JSON.stringify({
        provenanceVersion: 1,
        runId: 'run-1',
        runDigest: digest,
        attempts: [attempt('case-1'), attempt('case-2')],
        notRun: [
          {
            caseId: 'case-3',
            variantId: 'v1',
            occurrence: 1,
            inputs: [{ ...INPUT, status: 'rejected', eventId: null }],
          },
          {
            caseId: 'case-3',
            variantId: 'v1',
            occurrence: 2,
            inputs: [{ ...INPUT, status: 'not-submitted', eventId: null }],
          },
        ],
      }),
      'utf8',
    )
    expect(
      runReportCommand(['--input', input, '--output', output, '--provenance', provenance]),
    ).toBe(0)
    const table = readFileSync(output, 'utf8')
    expect(table).toContain('| case-3 | v1 | 1 | rejected |')
    expect(table).toContain('| case-3 | v1 | 2 | held |')
  })

  it('refuses an occurrence the run does not have', () => {
    const run = {
      ...RUN,
      notRun: [{ variantId: 'v1', caseId: 'case-3', reason: 'rejected' }],
    }
    const runText = JSON.stringify(run)
    const digest = provenanceRunDigest(runText)
    const { input, output, provenance } = workspace()
    writeFileSync(input, runText, 'utf8')
    writeFileSync(
      provenance,
      JSON.stringify({
        provenanceVersion: 1,
        runId: 'run-1',
        runDigest: digest,
        attempts: [attempt('case-1'), attempt('case-2')],
        notRun: [
          {
            caseId: 'case-3',
            variantId: 'v1',
            occurrence: 2,
            inputs: [{ ...INPUT, status: 'rejected', eventId: null }],
          },
        ],
      }),
      'utf8',
    )
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(
      runReportCommand(['--input', input, '--output', output, '--provenance', provenance]),
    ).toBe(1)
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain('not a not-run occurrence')
  })

  it('refuses a not-submitted not-run input that claims an event id', () => {
    const run = {
      ...RUN,
      notRun: [{ variantId: 'v1', caseId: 'case-3', reason: 'declined' }],
    }
    const runText = JSON.stringify(run)
    const digest = provenanceRunDigest(runText)
    const { input, output, provenance } = workspace()
    writeFileSync(input, runText, 'utf8')
    writeFileSync(
      provenance,
      JSON.stringify({
        provenanceVersion: 1,
        runId: 'run-1',
        runDigest: digest,
        attempts: [attempt('case-1'), attempt('case-2')],
        notRun: [
          {
            caseId: 'case-3',
            variantId: 'v1',
            occurrence: 1,
            inputs: [
              { ...INPUT, status: 'rejected', eventId: null },
              { ...INPUT, status: 'not-submitted', requestMessageId: 'req-2', eventId: 'event-1' },
            ],
          },
        ],
      }),
      'utf8',
    )
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(
      runReportCommand(['--input', input, '--output', output, '--provenance', provenance]),
    ).toBe(1)
    expect(existsSync(output)).toBe(false)
    expect(stderr.mock.calls.flat().join('')).toContain(
      'eventId must be null when status is not-submitted',
    )
  })
})

describe('repeated case id: attempt and not-run for the same pair (M5, 2026-11-11)', () => {
  it('writes the attempt and the not-run observation that the runner produced', async () => {
    const cases = [
      { id: 'case-1', input: 'first' },
      { id: 'case-1', input: 'second' },
    ]
    const comparison = await runComparison(
      { variants: [{ id: 'v1', kind: 'rules', combined: false }], cases },
      {
        runVariant: async (_variant, evalCase) =>
          evalCase.input === 'first'
            ? { ran: true, record: record('case-1') }
            : { ran: false, reason: 'rejected' },
      },
    )
    expect(comparison.records).toHaveLength(1)
    expect(comparison.notRun).toHaveLength(1)

    const run = {
      ...RUN,
      conditions: { ...CONDITIONS, sampleSize: 1 },
      records: comparison.records,
      notRun: comparison.notRun,
    }
    const runText = JSON.stringify(run)
    const digest = provenanceRunDigest(runText)
    const { input, output, provenance } = workspace()
    writeFileSync(input, runText, 'utf8')
    writeFileSync(
      provenance,
      JSON.stringify({
        provenanceVersion: 1,
        runId: 'run-1',
        runDigest: digest,
        attempts: [attempt('case-1')],
        notRun: [
          {
            caseId: 'case-1',
            variantId: 'v1',
            occurrence: 1,
            inputs: [{ ...INPUT, status: 'rejected', eventId: null }],
          },
        ],
      }),
      'utf8',
    )

    expect(
      runReportCommand(['--input', input, '--output', output, '--provenance', provenance]),
    ).toBe(0)
    const table = readFileSync(output, 'utf8')
    expect(table).toContain('| case-1 | v1 | 1 | exact |')
    expect(table).toContain('| case-1 | v1 | 1 | rejected |')
    expect(table).toContain('rejected 1')
  })
})

describe('evidence-preservation collisions beyond the direct path', () => {
  it.skipIf(!SYMLINKS)('refuses an output that reaches the provenance through a symlinked parent', () => {
    const { dir, input, provenance } = workspace()
    const companionText = JSON.stringify(companion())
    writeFileSync(provenance, companionText, 'utf8')
    const linked = join(dir, 'linked')
    symlinkSync(dir, linked, 'junction')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(
      runReportCommand([
        '--input',
        input,
        '--output',
        join(linked, 'provenance.json'),
        '--provenance',
        provenance,
      ]),
    ).toBe(1)
    expect(readFileSync(provenance, 'utf8')).toBe(companionText)
    expect(stderr.mock.calls.flat().join('')).toContain('--provenance input')
  })

  it.skipIf(!SYMLINKS)('refuses an output that is a symlink to the provenance file', () => {
    const { dir, input, provenance } = workspace()
    const companionText = JSON.stringify(companion())
    writeFileSync(provenance, companionText, 'utf8')
    const alias = join(dir, 'alias.json')
    symlinkSync(provenance, alias, 'file')

    expect(
      runReportCommand(['--input', input, '--output', alias, '--provenance', provenance]),
    ).toBe(1)
    expect(readFileSync(provenance, 'utf8')).toBe(companionText)
  })

  it('refuses an output that is a hard link to the provenance file', () => {
    const { dir, input, provenance } = workspace()
    const companionText = JSON.stringify(companion())
    writeFileSync(provenance, companionText, 'utf8')
    const hard = join(dir, 'hard.json')
    linkSync(provenance, hard)

    expect(
      runReportCommand(['--input', input, '--output', hard, '--provenance', provenance]),
    ).toBe(1)
    expect(readFileSync(provenance, 'utf8')).toBe(companionText)
  })

  it('refuses an output equal to the input run file and leaves the run intact', () => {
    const { input } = workspace()
    const runText = readFileSync(input, 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(runReportCommand(['--input', input, '--output', input])).toBe(1)
    expect(readFileSync(input, 'utf8')).toBe(runText)
    expect(stderr.mock.calls.flat().join('')).toContain('--input run file')
  })

  it.skipIf(!SYMLINKS)('still writes to a distinct output inside a symlinked directory', () => {
    const { dir, input, output, provenance } = workspace()
    writeFileSync(provenance, JSON.stringify(companion()), 'utf8')
    const linked = join(dir, 'linked')
    symlinkSync(dir, linked, 'junction')
    void output

    expect(
      runReportCommand([
        '--input',
        input,
        '--output',
        join(linked, 'table.md'),
        '--provenance',
        provenance,
      ]),
    ).toBe(0)
    expect(readFileSync(join(dir, 'table.md'), 'utf8')).toContain('Prepared-input provenance')
  })
})
