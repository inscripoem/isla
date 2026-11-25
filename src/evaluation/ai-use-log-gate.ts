import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { readChangedFiles } from './changed-files'
import { writeFindings, type GateFinding } from './gate-record'
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

type LogReadErrorKind = 'invalid-yaml' | 'no-entry-list' | 'recursive-alias'

/** Why a log text cannot be read as an entry list. */
interface LogReadError {
  readonly kind: LogReadErrorKind
  readonly detail: string
}

type LogRead = { readonly entries: readonly unknown[] } | { readonly error: LogReadError }

/**
 * Read a log text as its entry list, or say why it cannot be read. One reader for
 * shape, counting and classification, so the three cannot drift on the empty,
 * parse-error, missing-`entries` or non-list cases.
 *
 * `invalid-yaml` is a syntax error. `no-entry-list` means the YAML is valid but
 * `entries` is not a list; `recursive-alias` is reported by the identity walker,
 * because a cyclic entry is readable but never comparable.
 */
function readLogEntries(text: string): LogRead {
  if (text.trim().length === 0) return { entries: [] }
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    return {
      error: {
        kind: 'invalid-yaml',
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries
  if (entries === undefined || entries === null) return { entries: [] }
  if (!Array.isArray(entries)) {
    return {
      error: {
        kind: 'no-entry-list',
        detail: Array.isArray(parsed)
          ? 'the document is a list, not a mapping with an "entries" key'
          : 'the document has no top-level "entries" list',
      },
    }
  }
  return { entries }
}

/** The operator-facing phrase for a log text that cannot be read. */
function describeLogReadError(error: LogReadError): string {
  if (error.kind === 'invalid-yaml') return `is not valid YAML: ${error.detail}`
  if (error.kind === 'recursive-alias') {
    return `cannot be read as an entries list: a recursive alias at ${error.detail}`
  }
  return `cannot be read as an entries list: ${error.detail}`
}

/**
 * Every entry must be well formed, not merely present. `branch` is *not* required:
 * one historical entry predates it, so requiring it would fail every run for a change
 * nobody can date accurately.
 *
 * A recursive YAML alias parses into a real cycle, which is not log data: it can
 * never be given an identity, so it is a shape violation here rather than a crash
 * later in the reference check.
 */
export function collectAiUseLogShapeViolations(text: string): string[] {
  const read = readLogEntries(text)
  if ('error' in read) return [`${AI_USE_LOG_PATH} ${describeLogReadError(read.error)}`]
  const entries = read.entries
  if (entries.length === 0) {
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
    try {
      entryIdentity(record)
    } catch (error) {
      if (!(error instanceof RecursiveAliasError)) throw error
      violations.push(
        `${label} (entry ${index}) cannot be read as log data: a recursive alias at ${error.path}`,
      )
      return
    }
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
  if ('error' in base) {
    return [`${AI_USE_LOG_PATH} at the base ${describeLogReadError(base.error)}`]
  }
  const head = countEntries(headText)
  if ('error' in head) return [] // the shape check reports the head's own problem
  if (head.count > base.count) return []

  return [
    `the ${AI_USE_LOG_PATH} change must add an entry; it has ${head.count} entries at both the base and the head, so an existing entry was edited rather than a new one recorded (gate G6)`,
  ]
}

/**
 * A log entry's identity is its content, not its position. Key order inside a
 * mapping is irrelevant, so a merge that reformats an entry still matches; any
 * changed value (a repointed commit, a reworded change) produces a new identity
 * and stays strict. Array order is significant, as it is in the storage
 * contract.
 *
 * A recursive YAML alias parses into a cyclic object graph. `JSON.stringify`'s
 * replacer cannot detect that cycle because it returns a fresh object at every
 * level, so the walk tracks the ancestors it is inside and stops at the first
 * repeated object. A non-cyclic shared anchor is *not* a cycle: it is expanded
 * once per occurrence, exactly as a hand-written duplicate would be.
 */
class RecursiveAliasError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`a recursive alias at ${path}`)
    this.path = path
  }
}

function canonicalForIdentity(value: unknown, ancestors: Set<object>, path: string): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new RecursiveAliasError(path)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => canonicalForIdentity(item, ancestors, `${path}[${index}]`))
    }
    const record = value as Record<string, unknown>
    const canonical: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      // `JSON.stringify` drops an undefined member; do the same before recursing.
      if (item === undefined) continue
      canonical[key] = canonicalForIdentity(item, ancestors, `${path}.${key}`)
    }
    return canonical
  } finally {
    ancestors.delete(value)
  }
}

function entryIdentity(entry: unknown): string {
  return JSON.stringify(canonicalForIdentity(entry, new Set(), '$'))
}

/**
 * How many times each entry identity occurs in a log text, or why the text cannot
 * be read as entries. Counts rather than a set: a head that repeats a base entry
 * twice contains one historical entry and one new one.
 */
function countIdentities(
  text: string,
): { counts: Map<string, number> } | { error: LogReadError } {
  const read = readLogEntries(text)
  if ('error' in read) return { error: read.error }
  const counts = new Map<string, number>()
  for (const entry of read.entries) {
    let identity: string
    try {
      identity = entryIdentity(entry)
    } catch (error) {
      if (!(error instanceof RecursiveAliasError)) throw error
      return { error: { kind: 'recursive-alias', detail: error.path } }
    }
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return { counts }
}

/** The number of entries in a log text, or why the text cannot be read as entries. */
function countEntries(text: string): { count: number } | { error: LogReadError } {
  const read = readLogEntries(text)
  return 'error' in read ? { error: read.error } : { count: read.entries.length }
}

/**
 * The log at the base revision, or null when the variable is unset or empty.
 * Set-but-missing throws.
 *
 * A null result is the push-integration scope: the run has no base copy, so the
 * caller treats every entry as historical and checks only entry shape and the
 * log-update rule. A pull request supplies the base and remains strict for the
 * entries it adds; see `baseLogText`.
 */
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
  /**
   * The log at the base revision, used to classify entries by identity.
   *
   * An entry is historical when an identical entry is present in this text,
   * wherever a merge placed it: its commit values are checked only as advice,
   * because a fresh clone does not carry the orphaned commits of squash-merged
   * work. A new or edited entry is strict and must cite string commits reachable
   * from HEAD; moving an accepted entry past a fixed index must not change that.
   *
   * - a string with base entries: matching entries are historical, the rest are
   *   new or edited;
   * - `null`: no base copy was offered. A push to main is an integration event
   *   whose squash orphans the branch commits, so every entry is historical and
   *   main re-adjudicates no ancestry;
   * - omitted: no classification is available, so every entry is new. The
   *   default keeps a caller from weakening the rule accidentally.
   */
  readonly baseLogText?: string | null
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
export function collectAiUseLogReferenceFindings(
  text: string,
  deps: AiUseReferenceDeps,
): GateFinding[] {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return [] // the shape check reports the parse error
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) return []

  let historicalCounts: Map<string, number> | null = null
  let everyEntryHistorical = false
  if (deps.baseLogText === null) {
    everyEntryHistorical = true
  } else if (deps.baseLogText !== undefined) {
    const base = countIdentities(deps.baseLogText)
    if ('error' in base) {
      return [
        {
          policy: 'POL-G6-03',
          trigger: 'log-unreadable',
          message: `${AI_USE_LOG_PATH} at the base ${describeLogReadError(base.error)}, so G6 cannot classify entries`,
          evidence: { register: 'base-log' },
        },
      ]
    }
    historicalCounts = base.counts
  }
  // Consuming a base match per head entry makes a duplicated historical entry
  // count once as historical; its copy is new and stays strict.
  const remaining = historicalCounts === null ? null : new Map(historicalCounts)

  const findings: GateFinding[] = []
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
    const record = entry as Record<string, unknown>
    const label = typeof record.task === 'string' ? record.task : `entry ${index}`

    let identity: string
    try {
      identity = entryIdentity(record)
    } catch (error) {
      if (!(error instanceof RecursiveAliasError)) throw error
      // A cyclic entry cannot be compared with the base, so it can be neither
      // historical nor new. Failing closed is the only answer that does not
      // silently excuse its citations.
      findings.push({
        policy: 'POL-G6-03',
        trigger: 'log-unreadable',
        message: `${label} (entry ${index}) cannot be read as log data: a recursive alias at ${error.path}; G6 cannot classify it`,
        evidence: { register: 'head-log' },
      })
      return
    }
    const matches = remaining?.get(identity) ?? 0
    const historical = everyEntryHistorical || matches > 0
    if (remaining !== null && matches > 0) remaining.set(identity, matches - 1)
    const commits = Array.isArray(record.commits) ? record.commits : []
    for (const raw of commits) {
      if (typeof raw !== 'string') {
        // A historical entry may cite a bare number that YAML parsed as an
        // integer, and a reviewer's clone cannot repair it. Treat it like an
        // unresolved historical commit rather than a failure. New entries must
        // still use a string so the commit reference stays identifiable.
        if (!historical) {
          findings.push({
            policy: 'POL-G6-02',
            trigger: 'commit-not-a-string',
            message: `${label} (entry ${index}) has a non-string commit entry`,
            evidence: { entry: label, field: 'commits', value: String(raw) },
          })
        }
        continue
      }
      if (raw.trim().length === 0) continue
      const sha = raw.trim()
      if (sha.length < MIN_SHA_LENGTH) {
        findings.push({
          policy: 'POL-G6-02',
          trigger: 'commit-too-short',
          message: `${label} (entry ${index}) cites "${sha}", which is too short to identify a commit`,
          evidence: { entry: label, field: 'commits', value: sha },
        })
        continue
      }
      if (deps.existingCommits === null) {
        findings.push({
          policy: 'POL-G6-03',
          trigger: 'register-unreadable',
          message: `${label} (entry ${index}) cites ${sha}, but the object database is unavailable; G6 cannot verify it`,
          evidence: { register: 'object-database' },
        })
        continue
      }
      if (!deps.existingCommits.has(sha)) {
        findings.push({
          policy: 'POL-G6-02',
          trigger: 'commit-unresolved',
          message: `${label} (entry ${index}) cites ${sha}, which G6 was not asked to resolve`,
          evidence: { entry: label, field: 'commits', value: sha },
        })
        continue
      }
      const full = deps.existingCommits.get(sha) ?? ''
      if (historical) {
        // A fresh clone cannot see the orphaned commits of squash-merged work;
        // failing on that would make the gate depend on the reviewer's clone.
        deps.onAdvisory?.(
          `${label} (entry ${index}) cites ${sha}, which is not present in this clone (historical entry)`,
        )
        continue
      }
      if (full.length === 0) {
        const exempt = baselineItem(deps, 'commit', sha)
        if (exempt !== null && !exempt.expired) continue
        if (exempt !== null && exempt.expired) {
          findings.push({
            policy: 'POL-G6-04',
            trigger: 'baseline-expired',
            message: `${label} (entry ${index}) cites ${sha}, whose exemption expired on ${exempt.item.expires}`,
            evidence: { value: sha, expires: exempt.item.expires },
          })
          continue
        }
        findings.push({
          policy: 'POL-G6-02',
          trigger: 'commit-missing',
          message: `${label} (entry ${index}) cites ${sha}, which is not an object in this repository`,
          evidence: { entry: label, field: 'commits', value: sha },
        })
        continue
      }
      const reachableSet = deps.reachableCommits
      if (reachableSet === null || reachableSet === undefined) {
        findings.push({
          policy: 'POL-G6-03',
          trigger: 'register-unreadable',
          message: `${label} (entry ${index}) cites ${sha}, but commit history is unavailable; G6 cannot verify it`,
          evidence: { register: 'commit-history' },
        })
        continue
      }
      if (!reachableSet.has(full)) {
        findings.push({
          policy: 'POL-G6-02',
          trigger: 'commit-unreachable',
          message: `${label} (entry ${index}) is new or edited and cites ${sha}, which is not reachable from HEAD`,
          evidence: { entry: label, field: 'commits', value: sha },
        })
      }
    }

    const cases = Array.isArray(record.cases) ? record.cases : []
    for (const raw of cases) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const id = raw.trim()
      if (deps.caseIds === null) {
        findings.push({
          policy: 'POL-G6-03',
          trigger: 'register-unreadable',
          message: `${label} (entry ${index}) cites ${id}, but the case registry is unavailable`,
          evidence: { register: 'case-registry' },
        })
        continue
      }
      if (deps.caseIds.has(id)) continue
      const exempt = baselineItem(deps, 'case', id)
      if (exempt !== null && !exempt.expired) continue
      if (exempt !== null && exempt.expired) {
        findings.push({
          policy: 'POL-G6-04',
          trigger: 'baseline-expired',
          message: `${label} (entry ${index}) cites case ${id}, whose exemption expired on ${exempt.item.expires}`,
          evidence: { value: id, expires: exempt.item.expires },
        })
        continue
      }
      findings.push({
        policy: 'POL-G6-02',
        trigger: 'case-unknown',
        message: `${label} (entry ${index}) cites case ${id}, which is not in the case registry`,
        evidence: { entry: label, field: 'cases', value: id },
      })
    }

    const invariants = Array.isArray(record.invariants) ? record.invariants : []
    for (const raw of invariants) {
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const id = raw.trim()
      if (deps.invariantIds === null) {
        findings.push({
          policy: 'POL-G6-03',
          trigger: 'register-unreadable',
          message: `${label} (entry ${index}) cites ${id}, but the invariant register is unavailable`,
          evidence: { register: 'invariant-register' },
        })
        continue
      }
      if (deps.invariantIds.has(id)) continue
      const exempt = baselineItem(deps, 'invariant', id)
      if (exempt !== null && !exempt.expired) continue
      if (exempt !== null && exempt.expired) {
        findings.push({
          policy: 'POL-G6-04',
          trigger: 'baseline-expired',
          message: `${label} (entry ${index}) cites invariant ${id}, whose exemption expired on ${exempt.item.expires}`,
          evidence: { value: id, expires: exempt.item.expires },
        })
        continue
      }
      findings.push({
        policy: 'POL-G6-02',
        trigger: 'invariant-unknown',
        message: `${label} (entry ${index}) cites invariant ${id}, which is not in the register`,
        evidence: { entry: label, field: 'invariants', value: id },
      })
    }
  })
  return findings
}

/** String view for callers that only need messages (existing tests and logs). */
export function collectAiUseLogReferenceViolations(
  text: string,
  deps: AiUseReferenceDeps,
): string[] {
  return collectAiUseLogReferenceFindings(text, deps).map((finding) => finding.message)
}

/** The rule violation as a finding, so the failure record names POL-G6-01. */
function collectAiUseLogFindings(changedFiles: readonly string[]): GateFinding[] {
  const messages = collectAiUseLogViolations(changedFiles)
  if (messages.length === 0) return []
  const codeFiles = changedFiles.filter((file) =>
    CODE_OR_PROMPT_PREFIXES.some((prefix) => file.startsWith(prefix)),
  )
  return messages.map((message) => ({
    policy: 'POL-G6-01',
    trigger: 'log-not-updated',
    message,
    evidence: { changed_files: codeFiles, log_changed: changedFiles.includes(AI_USE_LOG_PATH) },
  }))
}

/** Build the reference deps once, for both the check and the failure record. */
function buildReferenceDeps(
  text: string,
  onAdvisory?: (message: string) => void,
  baseLogText?: string | null,
): AiUseReferenceDeps {
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
    } catch {
      baseline = []
    }
  }
  return {
    existingCommits: existingCommits(collectCitedCommits(text)),
    reachableCommits: reachableCommits(),
    caseIds: casesText === null ? null : caseIdsFromRegistry(casesText),
    invariantIds: invariantsText === null ? null : invariantIdsFromRegister(invariantsText),
    baseline,
    today: new Date().toISOString().slice(0, 10),
    onAdvisory,
    baseLogText,
  }
}

function runCli(changedFiles: readonly string[]): number {
  const violations: string[] = []
  const findings: GateFinding[] = []
  let headText: string | null = null
  if (!existsSync(AI_USE_LOG_PATH)) {
    violations.push(`${AI_USE_LOG_PATH} is missing (gate G6)`)
  } else {
    headText = readFileSync(AI_USE_LOG_PATH, 'utf8')
    violations.push(...collectAiUseLogShapeViolations(headText))
  }

  // Read the base once. The printed violations and the failure record must come
  // from deps that saw it: rebuilding deps without the base dropped the
  // POL-G6-03 `base-log` record and repeated the git lookups.
  const baseText = readLogBase()

  if (headText !== null) {
    let unreachable = 0
    const referenceFindings = collectAiUseLogReferenceFindings(
      headText,
      buildReferenceDeps(
        headText,
        () => {
          unreachable += 1
        },
        baseText,
      ),
    )
    violations.push(...referenceFindings.map((finding) => finding.message))
    findings.push(...referenceFindings)
    if (unreachable > 0) {
      process.stdout.write(
        `G6 advisory: ${unreachable} historical citation(s) were not verified in this clone (squash-merge history)\n`,
      )
    }
  }

  if (changedFiles.length === 0) {
    process.stderr.write('G6: no changed files provided; the log-update rule is not verified\n')
  } else {
    violations.push(...collectAiUseLogViolations(changedFiles))
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
  if (changedFiles.length > 0) {
    findings.push(...collectAiUseLogFindings(changedFiles))
  }
  try {
    for (const path of writeFindings(findings)) {
      process.stdout.write(`G6: failure record ${path}\n`)
    }
  } catch (error) {
    process.stderr.write(
      `G6: could not write the failure record: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
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
