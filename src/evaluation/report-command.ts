import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseProvenance } from './provenance'
import { parseRecordedRun } from './recorded-run'
import { writeEvaluationReport } from './report'

/**
 * M6-02 R1 — the recorded-run to report command.
 *
 * This is a thin imperative shell around the pure parser and the report writer.
 * It does not call a provider and does not compose M3/M4/M1/M5. A valid recorded
 * run is written through the existing atomic writer; an invalid or unpublishable
 * run writes nothing.
 */

export interface ReportCommandArgs {
  readonly input: string
  readonly output: string
  /**
   * Optional ADR-008 companion. When present it is validated against the exact
   * run artifact and refused on any mismatch; absent means the report carries
   * the `no-provenance-record` note and no join is claimed.
   */
  readonly provenance?: string
}

export type ReportCommandParseResult =
  | { readonly ok: true; readonly value: ReportCommandArgs }
  | { readonly ok: false; readonly message: string }

const USAGE =
  'usage: pnpm evaluation:report --input <recorded-run.json> --output <evaluation-table.md> [--provenance <provenance.json>]'

export function parseReportCommandArgs(argv: readonly string[]): ReportCommandParseResult {
  let input: string | undefined
  let output: string | undefined
  let provenance: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      return { ok: false, message: USAGE }
    }
    if (argument === '--input') {
      if (input !== undefined) return { ok: false, message: `--input may be specified only once\n${USAGE}` }
      const value = argv[index + 1]
      if (value === undefined) return { ok: false, message: `--input requires a path\n${USAGE}` }
      input = value
      index += 1
      continue
    }
    if (argument === '--output') {
      if (output !== undefined) return { ok: false, message: `--output may be specified only once\n${USAGE}` }
      const value = argv[index + 1]
      if (value === undefined) return { ok: false, message: `--output requires a path\n${USAGE}` }
      output = value
      index += 1
      continue
    }
    if (argument === '--provenance') {
      if (provenance !== undefined) {
        return { ok: false, message: `--provenance may be specified only once\n${USAGE}` }
      }
      const value = argv[index + 1]
      if (value === undefined) {
        return { ok: false, message: `--provenance requires a path\n${USAGE}` }
      }
      provenance = value
      index += 1
      continue
    }
    return { ok: false, message: `unknown argument "${argument}"\n${USAGE}` }
  }

  if (input === undefined) return { ok: false, message: `--input is required\n${USAGE}` }
  if (output === undefined) return { ok: false, message: `--output is required\n${USAGE}` }
  return { ok: true, value: { input, output, provenance } }
}

/**
 * Run the command and return a process-style exit code.
 *
 * 0 = written, 1 = refused/unpublishable, 2 = argument or I/O error.
 */
export function runReportCommand(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const parsed = parseReportCommandArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`)
    return 2
  }

  let text: string
  try {
    text = readFileSync(parsed.value.input, 'utf8')
  } catch (error) {
    process.stderr.write(
      `evaluation:report: cannot read ${parsed.value.input}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }

  const recorded = parseRecordedRun(text)
  if (!recorded.ok) {
    process.stderr.write(`evaluation:report: refused ${parsed.value.input}\n`)
    for (const violation of recorded.violations) process.stderr.write(`- ${violation}\n`)
    return 1
  }

  let input = recorded.input
  if (parsed.value.provenance !== undefined) {
    let companionText: string
    try {
      companionText = readFileSync(parsed.value.provenance, 'utf8')
    } catch (error) {
      process.stderr.write(
        `evaluation:report: cannot read ${parsed.value.provenance}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 2
    }

    let companionJson: unknown
    try {
      companionJson = JSON.parse(companionText)
    } catch (error) {
      process.stderr.write(
        `evaluation:report: refused ${parsed.value.provenance}: not valid JSON (${error instanceof Error ? error.message : String(error)})\n`,
      )
      return 1
    }

    // The digest is computed from `text`, the exact bytes the run was parsed from,
    // so the join is to this artifact and not to a re-serialised object.
    const companion = parseProvenance(
      companionJson,
      { runId: recorded.input.meta.runId, records: recorded.input.run.records },
      text,
    )
    if (!companion.ok) {
      process.stderr.write(`evaluation:report: refused ${parsed.value.provenance}\n`)
      for (const violation of companion.violations) process.stderr.write(`- ${violation}\n`)
      return 1
    }
    input = { ...recorded.input, provenance: companion.companion }
  }

  try {
    const written = writeEvaluationReport(input, parsed.value.output)
    if (!written.ok) {
      process.stderr.write(`evaluation:report: refused ${parsed.value.input}\n`)
      for (const violation of written.violations) process.stderr.write(`- ${violation}\n`)
      return 1
    }
    process.stdout.write(`evaluation:report: wrote ${written.path}\n`)
    return 0
  } catch (error) {
    process.stderr.write(
      `evaluation:report: cannot write ${parsed.value.output}: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 2
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = runReportCommand(process.argv.slice(2))
}
