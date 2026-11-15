import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvalCase, Variant, VariantRun } from '../../src/evaluation/comparison'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import {
  executeRun,
  parseRunArgs,
  readRunSpec,
  runEvaluationCommand,
  validateHarness,
} from '../../src/evaluation/run-command'
import type { EvaluationHarness, RunSpec } from '../../src/evaluation/run-command'

const CONDITIONS = {
  hardware: 'test host',
  providers: ['test-provider'],
  workload: 'run-command fixture',
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

const SPEC: RunSpec = {
  meta: { runId: 'run-command-1', generatedAt: '2026-11-15' },
  conditions: CONDITIONS,
  cases: [
    { id: 'case-a', input: 'hello' },
    { id: 'case-b', input: 'again' },
  ],
}

const HARNESS_MODULE = 'test/support/evaluation-harness-fake.ts'

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'isla-run-command-'))
  directories.push(dir)
  return dir
}

function harness(overrides: Partial<EvaluationHarness> = {}): EvaluationHarness {
  const variant: Variant = { id: 'v1', kind: 'rules', combined: false }
  return {
    variants: [variant],
    async runVariant(_variant: Variant, evalCase: EvalCase): Promise<VariantRun> {
      return {
        ran: true,
        record: {
          caseId: evalCase.id,
          variantId: 'v1',
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
          totalMs: null,
          attempts: 1,
          usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
          failureReason: null,
        },
      }
    },
    ...overrides,
  }
}

describe('M6 CP05 #103 run command', () => {
  it('parses the three required options in any order', () => {
    expect(parseRunArgs(['--out', 'o', '--spec', 's', '--harness', 'h'])).toEqual({
      ok: true,
      value: { spec: 's', harness: 'h', out: 'o' },
    })
  })

  it('refuses a missing option', () => {
    const parsed = parseRunArgs(['--spec', 's', '--out', 'o'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('--harness')
  })

  it('refuses an unknown option', () => {
    const parsed = parseRunArgs(['--spec', 's', '--harness', 'h', '--out', 'o', '--fast'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('--fast')
  })

  it('refuses a repeated option', () => {
    const parsed = parseRunArgs(['--spec', 's', '--spec', 't', '--harness', 'h', '--out', 'o'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain('more than once')
  })

  it('refuses a spec that is not JSON', () => {
    const parsed = readRunSpec('{')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.violations.join(' ')).toContain('not valid JSON')
  })

  it('refuses a spec with no cases', () => {
    const parsed = readRunSpec(JSON.stringify({ ...SPEC, cases: [] }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.violations.join(' ')).toContain('cases must be a non-empty array')
  })

  it('refuses a spec whose meta is incomplete', () => {
    const parsed = readRunSpec(JSON.stringify({ ...SPEC, meta: { runId: '' } }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.violations.join(' ')).toContain('meta.runId')
  })

  it('refuses a harness with no variants or no runVariant', () => {
    const noVariants = validateHarness({ variants: [], runVariant: () => {} })
    expect(noVariants.ok).toBe(false)
    if (noVariants.ok) return
    expect(noVariants.violations.join(' ')).toContain('at least one variant')

    const noSeam = validateHarness({ variants: [{ id: 'v', kind: 'rules', combined: false }] })
    expect(noSeam.ok).toBe(false)
    if (noSeam.ok) return
    expect(noSeam.violations.join(' ')).toContain('runVariant')
  })

  it('writes a recorded run the parser accepts', async () => {
    const dir = workspace()
    const out = join(dir, 'run.json')
    const result = await executeRun(SPEC, harness(), out)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.records).toBe(2)
    expect(result.notRun).toBe(0)
    expect(result.outcomes).toEqual({ completed: 2 })

    const parsed = parseRecordedRun(readFileSync(out, 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.input.meta.runId).toBe('run-command-1')
    expect(parsed.input.run.records).toHaveLength(2)
  })

  it('refuses to write a run its own parser rejects', async () => {
    const dir = workspace()
    const out = join(dir, 'run.json')
    const bad: RunSpec = { ...SPEC, conditions: {} as never }
    const result = await executeRun(bad, harness(), out)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.join(' ')).toContain('its own parser rejects')
    expect(existsSync(out)).toBe(false)
  })

  it('refuses an unreadable artifact through the CLI and writes nothing', async () => {
    const dir = workspace()
    const specPath = join(dir, 'spec.json')
    const out = join(dir, 'run.json')
    writeFileSync(specPath, JSON.stringify({ ...SPEC, conditions: {} }), 'utf8')

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await runEvaluationCommand([
      '--spec',
      specPath,
      '--harness',
      HARNESS_MODULE,
      '--out',
      out,
    ])

    expect(code).toBe(1)
    expect(existsSync(out)).toBe(false)
    expect(stderr.mock.calls.map((call) => String(call[0])).join(' ')).toContain(
      'parser rejects',
    )
  })

  it('refuses to replace an existing recorded run', async () => {
    const dir = workspace()
    const out = join(dir, 'run.json')
    writeFileSync(out, 'previous evidence', 'utf8')
    const result = await executeRun(SPEC, harness(), out)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.join(' ')).toContain('never replaced')
    expect(readFileSync(out, 'utf8')).toBe('previous evidence')
  })

  it('records a thrown variant as a failure and still writes', async () => {
    const dir = workspace()
    const out = join(dir, 'run.json')
    const throwing = harness({
      async runVariant() {
        throw new Error('synthetic provider fault')
      },
    })
    const result = await executeRun(SPEC, throwing, out)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcomes).toEqual({ failed: 2 })

    const parsed = parseRecordedRun(readFileSync(out, 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.input.run.records[0]?.failureReason).toContain('synthetic provider fault')
  })

  it('runs end to end through a harness module named on the command line', async () => {
    const dir = workspace()
    const specPath = join(dir, 'spec.json')
    const out = join(dir, 'run.json')
    writeFileSync(specPath, JSON.stringify(SPEC), 'utf8')

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await runEvaluationCommand([
      '--spec',
      specPath,
      '--harness',
      HARNESS_MODULE,
      '--out',
      out,
    ])

    expect(code).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(stderr).not.toHaveBeenCalled()
    expect(String(stdout.mock.calls[0]?.[0])).toContain('"records":2')
  })

  it('refuses a harness module that does not exist', async () => {
    const dir = workspace()
    const specPath = join(dir, 'spec.json')
    writeFileSync(specPath, JSON.stringify(SPEC), 'utf8')

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const code = await runEvaluationCommand([
      '--spec',
      specPath,
      '--harness',
      'test/support/does-not-exist.ts',
      '--out',
      join(dir, 'run.json'),
    ])

    expect(code).toBe(1)
    expect(stderr.mock.calls.map((call) => String(call[0])).join(' ')).toContain('does not exist')
  })
})
