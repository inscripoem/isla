import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { readChangedFiles } from './changed-files'
import { existingCommits, reachableCommits } from './git-facts'
import { caseIdsFromRegistry, invariantIdsFromRegister } from './registers'

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

/** File CI writes the **base** copy of the log to (the log as it was before the change). */
export const AI_USE_LOG_BASE_ENV = 'AI_USE_LOG_BASE_FILE'

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

/**
 * The change must **add an entry**, not merely touch the file or edit an existing
 * entry. Only applied when the update rule applies (a code or prompt change), so a
 * documentation-only fix to the log is not forced to invent an entry.
 *
 * The check compares the number of entries at the base with the head, rather than
 * looking for added field lines: adding or rewording the fields of an existing entry
 * produces exactly such lines, and the gate would pass without any record of the new
 * work. `baseText` is the log at the base revision: `null` means the base was not
 * acquired (a local run, not verified); an empty string means the log did not exist
 * at the base, so every entry is new.
 */
export function collectAiUseLogEntryViolations(
  changedFiles: readonly string[],
  baseText: string | null,
  headText: string,
): string[] {
  const touchesCodeOrPrompt = changedFiles.some((file) =>
    CODE_OR_PROMPT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  if (!touchesCodeOrPrompt || !changedFiles.includes(AI_USE_LOG_PATH)) return []
  if (baseText === null) return []

  const base = countEntries(baseText)
  if ('error' in base) return [`${AI_USE_LOG_PATH} at the base is not valid YAML: ${base.error}`]
  const head = countEntries(headText)
  if ('error' in head) return [] // the shape check reports the head's own problem
  if (head.count > base.count) return []

  return [
    `the ${AI_USE_LOG_PATH} change must add an entry; it has ${head.count} entries at both the base and the head, so an existing entry was edited rather than a new one recorded (gate G6)`,
  ]
}

/** The number of entries in a log text, or the YAML error that prevents counting. */
function countEntries(text: string): { count: number } | { error: string } {
  if (text.trim().length === 0) return { count: 0 }
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries
  if (entries === undefined || entries === null) return { count: 0 }
  if (!Array.isArray(entries)) return { error: 'entries is not a list' }
  return { count: entries.length }
}

/** The log at the base revision, or null when the variable is unset. Set-but-missing throws. */
function readLogBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[AI_USE_LOG_BASE_ENV]
  if (path === undefined || path.trim().length === 0) return null
  if (!existsSync(path)) {
    throw new Error(`${AI_USE_LOG_BASE_ENV} points at ${path}, which does not exist — the base log was not acquired`)
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${AI_USE_LOG_BASE_ENV} (${path}) could not be read: ${reason}`)
  }
}

export const CASE_REGISTRY_PATH = 'docs/req/case-registry.yaml'
export const INVARIANT_REGISTER_PATH = 'docs/architecture/invariants.md'
export const GATE_BASELINE_PATH = 'docs/code-governance/gate-baseline.yaml'

export interface AiUseBaselineItem {
  readonly kind: 'commit' | 'case' | 'invariant'
  readonly value: string
  /** ISO date after which the exemption stops applying. */
  readonly expires: string
  readonly reason?: string
}

export interface AiUseReferenceDeps {
  /**
   * Cited string → full commit id, or '' when the object does not exist. `null`
   * means git could not answer, which fails closed.
   */
  readonly existingCommits: ReadonlyMap<string, string> | null
  /** Every commit reachable from HEAD, for advice only (squash merges orphan them). */
  readonly reachableCommits?: ReadonlySet<string> | null
  /** Called for facts that are reported but do not fail the gate. */
  readonly onAdvisory?: (message: string) => void
  readonly caseIds: ReadonlySet<string> | null
  readonly invariantIds: ReadonlySet<string> | null
  readonly baseline: readonly AiUseBaselineItem[]
  /** Today as YYYY-MM-DD, so an expired exemption can be reported deterministically. */
  readonly today: string
}

/** A short SHA is only identifiable when it can be matched unambiguously. */
const MIN_SHA_LENGTH = 7

function baselineItem(
  deps: AiUseReferenceDeps,
  kind: AiUseBaselineItem['kind'],
  value: string,
): { item: AiUseBaselineItem; expired: boolean } | null {
  const item = deps.baseline.find((entry) => entry.kind === kind && entry.value === value)
  if (item === undefined) return null
  // ISO dates sort lexicographically; no Date parsing, no timezone drift.
  return { item, expired: item.expires < deps.today }
}

/** Every commit string cited by any entry, so one git call can resolve them all. */
export function collectCitedCommits(text: string): string[] {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return []
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) return []
  const shas = new Set<string>()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const commits = (entry as { commits?: unknown }).commits
    if (!Array.isArray(commits)) continue
    for (const raw of commits) {
      if (typeof raw === 'string' && raw.trim().length > 0) shas.add(raw.trim())
    }
  }
  return Array.from(shas)
}

/**
 * Every cited commit and every cited case/invariant id must exist. The two dead
 * commit links found in the memory branch were invisible to the shape check: a
 * string of the right form was accepted even when no commit carried it.
 *
 * `null` dependency values mean "could not read", not "empty", and are reported as
 * violations. A gate that passes because its register failed to load is worse than
 * one that fails loudly.
 */
export function collectAiUseLogReferenceViolations(
  text: string,
  deps: AiUseReferenceDeps,
): string[] {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return [] // the shape check reports the parse error
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) return []

  const violations: string[] = []
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
    const record = entry as Record<string, unknown>
    const label = typeof record.task === 'string' ? record.task : `entry ${index}`

    const commits = Array.isArray(record.commits) ? record.commits : []
    for (const raw of commits) {
      if (typeof raw !== 'string') {
        // A bare number is a YAML integer, not a commit id; silently skipping it
        // would turn a malformed citation into a pass.
        violations.push(`${label} (entry ${index}) has a non-string commit entry`)
        continue
      }
      if (raw.trim().length === 0) continue
      const sha = raw.trim()
      if (sha.length < MIN_SHA_LENGTH) {
        violations.push(`${label} (entry ${index}) cites "${sha}", which is too short to identify a commit`)
        continue
      }
      if (deps.existingCommits === null) {
        violations.push(
          `${label} (entry ${index}) cites ${sha}, but the object database is unavailable; G6 cannot verify it`,
        )
        continue
      }
      if (!deps.existingCommits.has(sha)) {
        violations.push(`${label} (entry ${index}) cites ${sha}, which G6 was not asked to resolve`)
        continue
      }
      const full = deps.existingCommits.get(sha) ?? ''
      if (full.length === 0) {
        const exempt = baselineItem(deps, 'commit', sha)
        if (exempt !== null && !exempt.expired) continue
        if (exempt !== null && exempt.expired) {
          violations.push(
            `${label} (entry ${index}) cites ${sha}, whose exemption expired on ${exempt.item.expires}`,
          )
          continue
        }
        violations.push(
          `${label} (entry ${index}) cites ${sha}, which is not an object in this repository`,
        )
        continue
      }
      if (deps.reachableCommits != null && !deps.reachableCommits.has(full)) {
        deps.onAdvisory?.(
          `${label} (entry ${index}) cites ${sha}, which exists but is not reachable from HEAD (squash-merge history)`,
        )
      }
    }

    const cases = Array.isArray(record.cases) ? record.cases : []
    for (const raw of cases) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const id = raw.trim()
      if (deps.caseIds === null) {
        violations.push(`${label} (entry ${index}) cites ${id}, but the case registry is unavailable`)
        continue
      }
      if (deps.caseIds.has(id)) continue
      const exempt = baselineItem(deps, 'case', id)
      if (exempt !== null && !exempt.expired) continue
      violations.push(`${label} (entry ${index}) cites case ${id}, which is not in the case registry`)
    }

    const invariants = Array.isArray(record.invariants) ? record.invariants : []
    for (const raw of invariants) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const id = raw.trim()
      if (deps.invariantIds === null) {
        violations.push(`${label} (entry ${index}) cites ${id}, but the invariant register is unavailable`)
        continue
      }
      if (deps.invariantIds.has(id)) continue
      const exempt = baselineItem(deps, 'invariant', id)
      if (exempt !== null && !exempt.expired) continue
      violations.push(`${label} (entry ${index}) cites invariant ${id}, which is not in the register`)
    }
  })
  return violations
}

function runCli(changedFiles: readonly string[]): number {
  const violations: string[] = []
  let headText: string | null = null
  if (!existsSync(AI_USE_LOG_PATH)) {
    violations.push(`${AI_USE_LOG_PATH} is missing (gate G6)`)
  } else {
    headText = readFileSync(AI_USE_LOG_PATH, 'utf8')
    violations.push(...collectAiUseLogShapeViolations(headText))
  }

  if (headText !== null) {
    const readRegister = (path: string): string | null =>
      existsSync(path) ? readFileSync(path, 'utf8') : null
    const casesText = readRegister(CASE_REGISTRY_PATH)
    const invariantsText = readRegister(INVARIANT_REGISTER_PATH)
    const baselineText = readRegister(GATE_BASELINE_PATH)
    let baseline: AiUseBaselineItem[] = []
    if (baselineText !== null) {
      try {
        const parsed = parseYaml(baselineText) as { items?: unknown } | null
        const items = parsed?.items
        if (Array.isArray(items)) {
          baseline = items.filter(
            (item): item is AiUseBaselineItem =>
              item !== null &&
              typeof item === 'object' &&
              typeof (item as AiUseBaselineItem).kind === 'string' &&
              typeof (item as AiUseBaselineItem).value === 'string' &&
              typeof (item as AiUseBaselineItem).expires === 'string',
          )
        }
      } catch (error) {
        violations.push(
          `${GATE_BASELINE_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const cited = collectCitedCommits(headText)
    let unreachable = 0
    violations.push(
      ...collectAiUseLogReferenceViolations(headText, {
        existingCommits: existingCommits(cited),
        reachableCommits: reachableCommits(),
        caseIds: casesText === null ? null : caseIdsFromRegistry(casesText),
        invariantIds: invariantsText === null ? null : invariantIdsFromRegister(invariantsText),
        baseline,
        today: new Date().toISOString().slice(0, 10),
        onAdvisory: () => {
          unreachable += 1
        },
      }),
    )
    if (unreachable > 0) {
      process.stdout.write(
        `G6 advisory: ${unreachable} cited commit(s) exist but are not reachable from HEAD (squash-merge history)\n`,
      )
    }
  }

  if (changedFiles.length === 0) {
    process.stderr.write('G6: no changed files provided; the log-update rule is not verified\n')
  } else {
    violations.push(...collectAiUseLogViolations(changedFiles))
    const baseText = readLogBase()
    if (baseText === null) {
      process.stderr.write(`G6: no ${AI_USE_LOG_BASE_ENV}; the entry rule is not verified\n`)
    } else if (headText !== null) {
      violations.push(...collectAiUseLogEntryViolations(changedFiles, baseText, headText))
    }
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
