import { pathToFileURL } from 'node:url'
import { readChangedFiles } from './changed-files'

/**
 * M6 / R3 — gate G6: a code or prompt change must update the AI-use log
 * (ADR-006, INV-14; docs/ai-use-log.yaml).
 *
 * The gate takes the list of changed files — from explicit arguments, or from the
 * list CI writes to `CHANGED_FILES_FILE` — and fails when `src/` or `prompts/`
 * changed without a change to `docs/ai-use-log.yaml`. A file is used in CI so a
 * filename containing a space is not split into two paths. It is a pure function so
 * tests can prove both outcomes.
 */

export const AI_USE_LOG_PATH = 'docs/ai-use-log.yaml'

const CODE_OR_PROMPT_PREFIXES = ['src/', 'prompts/']

export function collectAiUseLogViolations(changedFiles: readonly string[]): string[] {
  const touchesCodeOrPrompt = changedFiles.some((file) =>
    CODE_OR_PROMPT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  if (!touchesCodeOrPrompt) return []
  if (changedFiles.includes(AI_USE_LOG_PATH)) return []
  return [`a code or prompt change must also update ${AI_USE_LOG_PATH} (gate G6)`]
}

function runCli(changedFiles: readonly string[]): number {
  if (changedFiles.length === 0) {
    process.stderr.write('G6: no changed files provided; AI-use-log gate not verified\n')
    return 0
  }
  const violations = collectAiUseLogViolations(changedFiles)
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
