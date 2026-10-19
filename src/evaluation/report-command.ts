import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { EVALUATION_TABLE_PATH } from './artifacts'
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
}

export type ReportCommandParseResult =
  | { readonly ok: true; readonly value: ReportCommandArgs }
  | { readonly ok: false; readonly message: string }

const USAGE =
  'usage: pnpm evaluation:report --input <recorded-run.json> [--output <evaluation-table.md>]'

export function parseReportCommandArgs(argv: readonly string[]): ReportCommandParseResult {
  let input: string | undefined
  let output: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      return { ok: false, message: USAGE }
    }
    if (argument === '--input') {
      const value = argv[index + 1]
      if (value === undefined) return { ok: false, message: `--input requires a path\n${USAGE}` }
      input = value
      index += 1
      continue
    }
    if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined) return { ok: false, message: `--output requires a path\n${USAGE}` }
      output = value
      index += 1
      continue
    }
    return { ok: false, message: `unknown argument "${argument}"\n${USAGE}` }
  }

  if (input === undefined) return { ok: false, message: `--input is required\n${USAGE}` }
  return { ok: true, value: { input, output: output ?? EVALUATION_TABLE_PATH } }
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

  try {
    const written = writeEvaluationReport(recorded.input, parsed.value.output)
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
