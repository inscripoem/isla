import { pathToFileURL } from 'node:url'
import { gateOutcomesRecord, writeGateRecord } from './gate-record'

/**
 * M6 / R3 — POL-PIPE-01: report the gates that never ran.
 *
 * A job stops at its first failed step, so a single red gate used to hide every
 * gate after it. With `if: always()` each gate runs, but a step that is skipped or
 * absent must never read as a pass. This aggregator turns the per-step outcomes
 * into one record: `success` stays silent, anything else (`failure`, `cancelled`,
 * `skipped`) is recorded as not-verified.
 */

export const GATE_STEPS = ['g1', 'g2', 'g3', 'trace', 'g5', 'g6', 'g4', 'build'] as const

export interface AggregateResult {
  readonly notVerified: Readonly<Record<string, string>>
  readonly failed: boolean
}

export interface AggregateOptions {
  /** GitHub event name. Only an explicit non-PR event excuses a skipped G1. */
  readonly event?: string | null
}

export function aggregateOutcomes(
  outcomes: Readonly<Record<string, string>>,
  options: AggregateOptions = {},
): AggregateResult {
  const notVerified: Record<string, string> = {}
  for (const step of GATE_STEPS) {
    const outcome = outcomes[step] ?? 'absent'
    if (outcome !== 'success') {
      // G1 runs only for pull requests. On a push to main its skip is by design,
      // but it is still not a pass: the record says so instead of hiding it.
      notVerified[step] =
        step === 'g1' &&
        outcome === 'skipped' &&
        options.event !== undefined &&
        options.event !== null &&
        options.event !== 'pull_request'
          ? 'skipped-by-design'
          : outcome
    }
  }
  return { notVerified, failed: Object.keys(notVerified).length > 0 }
}

function main(): number {
  const outcomes: Record<string, string> = {
    g1: process.env.GATE_G1 ?? 'absent',
    g2: process.env.GATE_G2 ?? 'absent',
    g3: process.env.GATE_G3 ?? 'absent',
    trace: process.env.GATE_TRACE ?? 'absent',
    g5: process.env.GATE_G5 ?? 'absent',
    g6: process.env.GATE_G6 ?? 'absent',
    g4: process.env.GATE_G4 ?? 'absent',
    build: process.env.GATE_BUILD ?? 'absent',
  }
  const event = process.env.GATE_EVENT ?? null
  const result = aggregateOutcomes(outcomes, { event })
  if (!result.failed) {
    process.stdout.write('PIPE: every gate ran and passed\n')
    return 0
  }
  const record = gateOutcomesRecord(result.notVerified, {
    commit: process.env.GITHUB_SHA ?? null,
    base: process.env.GATE_BASE_SHA ?? null,
    run: process.env.GITHUB_RUN_ID ?? null,
  })
  try {
    const path = writeGateRecord(record)
    process.stdout.write(`PIPE: not-verified record ${path}\n`)
  } catch (error) {
    process.stderr.write(
      `PIPE: could not write the record: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
  for (const [step, outcome] of Object.entries(result.notVerified)) {
    if (outcome === 'skipped-by-design') {
      process.stdout.write(
        `PIPE: ${step} is skipped by design on ${event ?? 'this event'}, recorded as not-verified\n`,
      )
    } else {
      process.stderr.write(`PIPE: ${step} is ${outcome}, not a pass\n`)
    }
  }
  return 0 // the failed gate already fails the job; this step only records
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = main()
