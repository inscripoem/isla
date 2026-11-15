import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runBench, serializeRecordedRun, type BenchConditions } from '../../src/evaluation/bench'
import {
  captureProvenance,
  type ProvenanceDraft,
} from '../../src/evaluation/provenance-capture'
import {
  parseProvenance,
  provenanceRunDigest,
  type ProvenanceAttempt,
  type ProvenanceInputEntry,
  type ProvenanceRun,
} from '../../src/evaluation/provenance'
import { parseRecordedRun } from '../../src/evaluation/recorded-run'
import { runReportCommand } from '../../src/evaluation/report-command'
import { SYNTHETIC_CASES, SYNTHETIC_VARIANT, syntheticRunVariant } from '../support/m6-02-synthetic'

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

const META = { runId: 'pilot-1', generatedAt: '2026-11-15' }
const REVISION = 'a'.repeat(64)

/** A recorded run produced by the merged producer, not a hand-written JSON blob. */
async function recordedRun(): Promise<{ bytes: string; run: ProvenanceRun }> {
  const recorded = await runBench(
    { meta: META, conditions: CONDITIONS, variants: [SYNTHETIC_VARIANT], cases: SYNTHETIC_CASES },
    { runVariant: syntheticRunVariant() },
  )
  const bytes = serializeRecordedRun(recorded)
  const parsed = parseRecordedRun(bytes)
  if (!parsed.ok) throw new Error(`fixture run did not parse: ${parsed.violations.join('; ')}`)
  return {
    bytes,
    run: {
      runId: parsed.input.meta.runId,
      records: parsed.input.run.records,
      notRun: parsed.input.run.notRun,
    },
  }
}

function input(overrides: Partial<ProvenanceInputEntry> = {}): ProvenanceInputEntry {
  return {
    inputId: 'input-1',
    sourceId: 'console',
    requestMessageId: 'msg-1',
    eventId: 'evt-1',
    status: 'accepted',
    ...overrides,
  }
}

function attempt(overrides: Partial<ProvenanceAttempt> = {}): ProvenanceAttempt {
  return {
    caseId: 'case-normal',
    variantId: SYNTHETIC_VARIANT.id,
    attempt: 1,
    inputs: [input()],
    recordSetRevision: REVISION,
    correlation: 'exact',
    ...overrides,
  }
}

function allAttempts(): ProvenanceAttempt[] {
  return SYNTHETIC_CASES.map((evalCase) => attempt({ caseId: evalCase.id }))
}

function draft(overrides: Partial<ProvenanceDraft> = {}): ProvenanceDraft {
  return { runId: META.runId, attempts: allAttempts(), ...overrides }
}

describe('M6 CP05 #100 provenance capture', () => {
  it('derives the digest from the run bytes and emits a companion that re-parses', async () => {
    const { bytes, run } = await recordedRun()
    const captured = captureProvenance(bytes, draft())

    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    expect(captured.companion.provenanceVersion).toBe(1)
    expect(captured.companion.runId).toBe(META.runId)
    expect(captured.companion.runDigest).toBe(provenanceRunDigest(bytes))
    expect(captured.companion.runDigest).toBe(
      createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex'),
    )
    expect(captured.companion.attempts).toHaveLength(SYNTHETIC_CASES.length)
    expect(captured.json.endsWith('\n')).toBe(true)

    const reparsed = parseProvenance(JSON.parse(captured.json), run, bytes)
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.companion).toEqual(captured.companion)
  })

  it('records an absent notRun list explicitly instead of omitting it', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(bytes, draft())
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    expect(captured.companion.notRun).toEqual([])
    expect(captured.json).toContain('"notRun": []')
  })

  it('is deterministic for the same run and draft', async () => {
    const { bytes } = await recordedRun()
    const first = captureProvenance(bytes, draft())
    const second = captureProvenance(bytes, draft())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.json).toBe(second.json)
  })

  it('refuses a draft that asserts its own digest', async () => {
    const { bytes } = await recordedRun()
    const asserted = { ...draft(), runDigest: 'b'.repeat(64) } as unknown as ProvenanceDraft
    const captured = captureProvenance(bytes, asserted)
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.join(' ')).toContain('runDigest is derived from the run bytes')
  })

  it('refuses a companion for a different run id', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(bytes, draft({ runId: 'another-run' }))
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations).toContain('runId does not match the run')
  })

  it('refuses a missing attempt for a record the run produced', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(
      bytes,
      draft({ attempts: allAttempts().filter((entry) => entry.caseId !== 'case-stop') }),
    )
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.join(' ')).toContain('missing an entry for case-stop')
  })

  it('refuses an attempt with no run record', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(
      bytes,
      draft({ attempts: [...allAttempts(), attempt({ caseId: 'case-not-in-run' })] }),
    )
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.join(' ')).toContain('no run record')
  })

  it('refuses a repeated occurrence key', async () => {
    const { bytes } = await recordedRun()
    const duplicated = allAttempts()
    const captured = captureProvenance(
      bytes,
      draft({ attempts: [...duplicated, duplicated[0] as ProvenanceAttempt] }),
    )
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.join(' ')).toContain('repeats the occurrence key')
  })

  it('refuses a not-run observation the run did not record', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(
      bytes,
      draft({
        notRun: [
          {
            caseId: 'case-normal',
            variantId: SYNTHETIC_VARIANT.id,
            occurrence: 1,
            inputs: [input()],
          },
        ],
      }),
    )
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.join(' ')).toContain('not a not-run occurrence in the run')
  })

  it('refuses an exact correlation with no observed revision', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(
      bytes,
      draft({
        attempts: allAttempts().map((entry) =>
          entry.caseId === 'case-normal' ? { ...entry, recordSetRevision: null } : entry,
        ),
      }),
    )
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.join(' ')).toContain('recordSetRevision cannot be null')
  })

  it('binds the companion to the exact bytes, not a re-encode of the same run', async () => {
    const { bytes, run } = await recordedRun()
    const captured = captureProvenance(bytes, draft())
    expect(captured.ok).toBe(true)
    if (!captured.ok) return

    const reformatted = JSON.stringify(JSON.parse(bytes), null, 4)
    const againstOtherBytes = parseProvenance(JSON.parse(captured.json), run, reformatted)
    expect(againstOtherBytes.ok).toBe(false)
    if (againstOtherBytes.ok) return
    expect(againstOtherBytes.violations).toContain('runDigest does not match the exact run artifact')
  })

  it('refuses when the bytes are not a recorded run', () => {
    const captured = captureProvenance('{"schemaVersion":1}', draft())
    expect(captured.ok).toBe(false)
    if (captured.ok) return
    expect(captured.violations.length).toBeGreaterThan(0)
  })

  it('produces a companion the report command accepts end to end', async () => {
    const { bytes } = await recordedRun()
    const captured = captureProvenance(bytes, draft())
    expect(captured.ok).toBe(true)
    if (!captured.ok) return

    const dir = mkdtempSync(join(tmpdir(), 'isla-capture-'))
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const runPath = join(dir, 'run.json')
      const provenancePath = join(dir, 'provenance.json')
      const reportPath = join(dir, 'report.md')
      writeFileSync(runPath, bytes, 'utf8')
      writeFileSync(provenancePath, captured.json, 'utf8')

      const code = runReportCommand([
        '--input',
        runPath,
        '--output',
        reportPath,
        '--provenance',
        provenancePath,
      ])
      expect(code).toBe(0)
      const report = readFileSync(reportPath, 'utf8')
      expect(report).toContain('## Prepared-input provenance')
      expect(report).toContain(`Companion source: \`${provenancePath}\``)
      expect(report).not.toContain('no-provenance-record')
    } finally {
      out.mockRestore()
      err.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
