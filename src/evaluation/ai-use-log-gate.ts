import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { readChangedFiles } from './changed-files'

/**
 * M6 / R3 — gate G6: a code or prompt change must update the AI-use log
 * (ADR-006, INV-14; docs/ai-use-log.yaml).
 *
 * Two checks, both fail-closed:
 *  1. **Rule** — `src/` or `prompts/` changed without a change to `docs/ai-use-log.yaml`.
 *  2. **Shape** — every entry in the log is well formed. Checking only that the file
 *     changed would let a one-line edit satisfy the gate.
 *
 * The changed-file list comes from explicit arguments, or from the list CI writes to
 * `CHANGED_FILES_FILE` (a file, so a filename containing a space is not split). The
 * functions are pure so tests can prove every outcome.
 */

export const AI_USE_LOG_PATH = 'docs/ai-use-log.yaml'

const CODE_OR_PROMPT_PREFIXES = ['src/', 'prompts/']

/** Fields every entry must carry as a non-empty string. */
const REQUIRED_TEXT_FIELDS = ['date', 'task', 'change', 'agent'] as const
/** Fields every entry must carry as a list. */
const REQUIRED_LIST_FIELDS = ['requirements', 'invariants', 'commits'] as const
const DATE_FORM = /^\d{4}-\d{2}-\d{2}$/

export function collectAiUseLogViolations(changedFiles: readonly string[]): string[] {
  const touchesCodeOrPrompt = changedFiles.some((file) =>
    CODE_OR_PROMPT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  if (!touchesCodeOrPrompt) return []
  if (changedFiles.includes(AI_USE_LOG_PATH)) return []
  return [`a code or prompt change must also update ${AI_USE_LOG_PATH} (gate G6)`]
}

/**
 * Every entry must be well formed, not merely present. `branch` is *not* required:
 * one historical entry predates it, so requiring it would fail every run for a change
 * nobody can date accurately.
 */
export function collectAiUseLogShapeViolations(text: string): string[] {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return [`${AI_USE_LOG_PATH} is not valid YAML: ${reason}`]
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries) || entries.length === 0) {
    return [`${AI_USE_LOG_PATH} has no non-empty "entries" list`]
  }

  const violations: string[] = []
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      violations.push(`entry ${index} is not a mapping`)
      return
    }
    const record = entry as Record<string, unknown>
    const label = typeof record.task === 'string' ? record.task : `entry ${index}`
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = record[field]
      if (typeof value !== 'string' || value.trim().length === 0) {
        violations.push(`${label} (entry ${index}) has no non-empty "${field}"`)
      }
    }
    const date = record.date
    if (typeof date === 'string' && !DATE_FORM.test(date)) {
      violations.push(`${label} (entry ${index}) date "${date}" is not YYYY-MM-DD`)
    }
    for (const field of REQUIRED_LIST_FIELDS) {
      if (!Array.isArray(record[field])) {
        violations.push(`${label} (entry ${index}) "${field}" must be a list`)
      }
    }
  })
  return violations
}

/** Read the log, or report its absence as a violation: the log is a required artifact. */
function collectLogFileViolations(): string[] {
  if (!existsSync(AI_USE_LOG_PATH)) return [`${AI_USE_LOG_PATH} is missing (gate G6)`]
  return collectAiUseLogShapeViolations(readFileSync(AI_USE_LOG_PATH, 'utf8'))
}

function runCli(changedFiles: readonly string[]): number {
  const violations = [...collectLogFileViolations()]
  if (changedFiles.length === 0) {
    process.stderr.write('G6: no changed files provided; the log-update rule is not verified\n')
  } else {
    violations.push(...collectAiUseLogViolations(changedFiles))
  }
  if (violations.length === 0) {
    process.stdout.write('G6: AI-use log gate passed\n')
    return 0
  }
  for (const violation of violations) process.stderr.write(`G6: ${violation}\n`)
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  // Explicit arguments win; otherwise read the list CI wrote to CHANGED_FILES_FILE,
  // so a filename containing a space cannot be split by the shell.
  const fromArgv = process.argv.slice(2)
  process.exitCode = runCli(fromArgv.length > 0 ? fromArgv : readChangedFiles())
}
