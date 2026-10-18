import { execFileSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

/**
 * M6 / R3 — the verified main-baseline restoration exception for the frozen-path
 * check (ADR-006 D1.7, INV-13; `docs/architecture/frozen.yaml`).
 *
 * A feature-branch push is reviewed over `before..HEAD`. When the branch restored a
 * frozen path to the content it already carries on the default branch — a legitimate
 * reconciliation of an earlier divergence, not a change to the shared boundary — the
 * path still appears in that push diff. The trace gate must not fail the restore, but
 * it must keep failing a real change, so the exemption is narrow and is proven per path:
 *
 *  - the event is a push to a feature branch (never the default branch itself, a tag, a
 *    pull request or a manual run);
 *  - the pinned baseline is a **canonical full commit id** that resolves to itself (an
 *    alias, an abbreviated ref or a malformed value is denied), is an **ancestor** of
 *    the checked head, and is never the head itself;
 *  - the path is frozen in the manifest **at that pinned revision**;
 *  - the **committed** checked head carries the baseline's own **blob and mode** (so a
 *    committed change fails even if the working tree happens to look restored); and
 *  - the **actual checked file** — read through the injected `RestorationFileView` — is
 *    a regular, readable entry whose **contents and filesystem mode** equal the
 *    baseline's. A dirty edit, an executable-mode-only change, a symlink, a deletion, an
 *    unreadable path, or text that is not valid UTF-8 all deny.
 *
 * The content comparison is byte-exact: both production inputs (`nodeTraceFs` and
 * `nodeRestorationGit`) decode UTF-8 **strictly**, so malformed bytes throw and deny
 * rather than being silently replaced with U+FFFD and comparing equal to other text.
 *
 * Every git fact and the checked-file view are injected so a test can prove each
 * negative without creating or mutating a repository.
 */

/** The commit CI pins for this run; only a feature-branch push may set it. */
export const TRUSTED_BASELINE_ENV = 'TRUSTED_BASELINE_SHA'

/** The frozen-path manifest the proof reads, at the head and at the baseline. */
export const FROZEN_MANIFEST = 'docs/architecture/frozen.yaml'

/** A full, immutable commit id: 40 hex (SHA-1) or 64 hex (SHA-256). */
const FULL_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
const ALL_ZEROS = /^0+$/

/**
 * Decode UTF-8 strictly: a malformed byte sequence throws instead of being replaced with
 * U+FFFD, so two different byte sequences can never compare equal. `ignoreBOM` keeps a
 * leading byte-order mark in the text so the comparison stays byte-exact.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** The blob identity of one path at one revision. */
export interface PathEntry {
  readonly mode: string
  readonly oid: string
}

/** The on-disk identity of a checked file. */
export interface FileStat {
  /** Git-canonical mode for a regular file (`100644` / `100755`), else a non-file mode. */
  readonly mode: string
  /** False for a symlink, a directory or any other non-regular entry. */
  readonly regular: boolean
}

/** The working-tree view the proof reads the actual checked file through. */
export interface RestorationFileView {
  /**
   * The exact file text, decoded strictly; throws when the path is missing, unreadable
   * or not valid UTF-8.
   */
  read(relative: string): string
  /** The on-disk mode/regularity, or null when the path cannot be inspected. */
  stat?(relative: string): FileStat | null
}

/** The git facts a restoration proof needs. */
export interface RestorationGit {
  /** The checked head commit, or null when it cannot be resolved. */
  head(): string | null
  /** The canonical full commit id `rev` resolves to, or null. */
  resolve(rev: string): string | null
  /** Whether `ancestor` is an ancestor of `descendant`. */
  isAncestor(ancestor: string, descendant: string): boolean
  /** The entry at `rev:path`, or null when the path is absent (or not a blob). */
  entry(rev: string, path: string): PathEntry | null
  /** The exact text at `rev:path`, or null when absent or not valid UTF-8. */
  file(rev: string, path: string): string | null
}

/** A pinned default-branch baseline whose restoration is trusted for this run. */
export interface RestorationContext {
  readonly baseline: string
  readonly git: RestorationGit
}

export type RestorationVerdict =
  | { readonly restored: true; readonly proof: string }
  | { readonly restored: false; readonly reason: string }

/**
 * The paths a frozen manifest lists. Throws when the text is not valid YAML, matching
 * the head check: a broken manifest must fail loudly, not silently look unfrozen.
 */
export function parseFrozenPaths(manifestText: string): string[] {
  const manifest = parseYaml(manifestText) as { frozen?: unknown } | null
  const frozen = Array.isArray(manifest?.frozen) ? manifest.frozen : []
  return frozen.filter((entry): entry is string => typeof entry === 'string')
}

/** The frozen list at the pinned baseline, or the reason it cannot be trusted. */
function baselineFrozen(context: RestorationContext): { frozen: string[] } | { reason: string } {
  const text = context.git.file(context.baseline, FROZEN_MANIFEST)
  if (text === null) return { reason: `baseline ${context.baseline} has no ${FROZEN_MANIFEST}` }
  try {
    return { frozen: parseFrozenPaths(text) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { reason: `${FROZEN_MANIFEST} at baseline ${context.baseline} is not valid YAML: ${reason}` }
  }
}

/** Prove (or deny) that a changed frozen path is a verbatim restoration of the baseline. */
export function verifyFrozenRestoration(
  context: RestorationContext,
  path: string,
  file: RestorationFileView,
): RestorationVerdict {
  const deny = (reason: string): RestorationVerdict => ({ restored: false, reason })

  const head = context.git.head()
  if (head === null) return deny('the checked head could not be resolved')

  // A canonical, immutable commit only: an alias or an abbreviated ref must not be able
  // to name a different commit than the one CI pinned, and a run must not approve its
  // own head.
  const baseline = context.git.resolve(context.baseline)
  if (baseline === null) return deny(`baseline ${context.baseline} does not resolve to a commit`)
  if (baseline !== context.baseline) {
    return deny(
      `baseline ${context.baseline} is not a canonical full commit id (resolves to ${baseline})`,
    )
  }
  if (baseline === head) {
    return deny('the baseline is the checked head itself; a run cannot approve its own head')
  }
  if (!context.git.isAncestor(baseline, head)) {
    return deny(`baseline ${baseline} is not an ancestor of the checked head`)
  }

  const frozen = baselineFrozen(context)
  if ('reason' in frozen) return deny(frozen.reason)
  if (!frozen.frozen.includes(path)) {
    return deny(`${path} is not frozen at baseline ${baseline}`)
  }

  const baselineEntry = context.git.entry(baseline, path)
  if (baselineEntry === null) return deny(`${path} is absent at baseline ${baseline}`)

  // The committed head must carry the baseline's own blob and mode: a committed change
  // fails even when the working tree happens to look restored.
  const headEntry = context.git.entry(head, path)
  if (headEntry === null) return deny(`${path} is absent at the checked head (deleted)`)
  if (headEntry.mode !== baselineEntry.mode) {
    return deny(`${path} committed mode ${headEntry.mode} differs from baseline ${baselineEntry.mode}`)
  }
  if (headEntry.oid !== baselineEntry.oid) {
    return deny(`${path} committed blob ${headEntry.oid} differs from baseline ${baselineEntry.oid}`)
  }

  // The actual checked file must also be the restored one.
  const stat = readStat(file, path)
  if (stat === null) return deny(`${path} is absent or cannot be inspected in the checked tree`)
  if (!stat.regular) return deny(`${path} is not a regular file in the checked tree`)
  if (stat.mode !== baselineEntry.mode) {
    return deny(`${path} checked mode ${stat.mode} differs from baseline ${baselineEntry.mode}`)
  }
  const baselineContent = context.git.file(baseline, path)
  if (baselineContent === null) return deny(`the baseline content of ${path} is unavailable`)
  let checkedContent: string
  try {
    checkedContent = file.read(path)
  } catch {
    return deny(`${path} cannot be read in the checked tree`)
  }
  if (checkedContent !== baselineContent) {
    return deny(`${path} checked content differs from baseline ${baseline}`)
  }

  return {
    restored: true,
    proof: `blob ${baselineEntry.oid}, mode ${baselineEntry.mode} at baseline ${baseline}, matched by the checked file`,
  }
}

function readStat(file: RestorationFileView, path: string): FileStat | null {
  if (file.stat === undefined) return null
  try {
    return file.stat(path)
  } catch {
    return null
  }
}

/**
 * The pinned baseline for a feature-branch push, or null for every other event — the
 * default-branch push itself, a tag, a pull request or a manual run. A null context
 * leaves the frozen check strict. `DEFAULT_BRANCH` is required (without it a feature
 * push cannot be told apart from a default-branch push), and the value must already be
 * a full commit id; the proof resolves it again before trusting it.
 */
export function readRestorationContext(
  env: NodeJS.ProcessEnv = process.env,
  git: RestorationGit = nodeRestorationGit(),
): RestorationContext | null {
  if (env.GITHUB_EVENT_NAME !== 'push') return null
  if (env.GITHUB_REF_TYPE !== 'branch') return null
  const refName = env.GITHUB_REF_NAME?.trim()
  const defaultBranch = env.DEFAULT_BRANCH?.trim()
  if (refName === undefined || refName.length === 0) return null
  if (defaultBranch === undefined || defaultBranch.length === 0) return null
  if (refName === defaultBranch) return null
  const baseline = env[TRUSTED_BASELINE_ENV]?.trim()
  if (baseline === undefined || !FULL_COMMIT.test(baseline) || ALL_ZEROS.test(baseline)) return null
  return { baseline, git }
}

/** The raw stdout bytes of one git command, and whether it exited zero. */
export type GitCommandResult = { readonly ok: boolean; readonly stdout: Uint8Array }
export type GitCommand = (args: readonly string[]) => GitCommandResult

function nodeGitCommand(cwd: string): GitCommand {
  return (args) => {
    try {
      const stdout = execFileSync('git', [...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return { ok: true, stdout }
    } catch {
      return { ok: false, stdout: new Uint8Array() }
    }
  }
}

/** The production git view; every command is read-only, so no repository state changes. */
export function nodeRestorationGit(
  cwd: string = process.cwd(),
  command: GitCommand = nodeGitCommand(cwd),
): RestorationGit {
  // Strictly decoded: a command whose output is not valid UTF-8 is unavailable, not text.
  const text = (args: readonly string[]): string | null => {
    const result = command(args)
    if (!result.ok) return null
    try {
      return decodeUtf8(result.stdout)
    } catch {
      return null
    }
  }

  const commit = (rev: string): string | null => {
    const out = text(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    if (out === null) return null
    const sha = out.trim()
    return sha.length === 0 ? null : sha
  }

  return {
    head: () => commit('HEAD'),
    resolve: (rev) => commit(rev),
    isAncestor: (ancestor, descendant) =>
      command(['merge-base', '--is-ancestor', ancestor, descendant]).ok,
    entry: (rev, path) => {
      const out = text(['ls-tree', rev, '--', path])
      if (out === null) return null
      const line = out.trim()
      if (line.length === 0) return null
      const [mode, type, oid] = line.split(/\s+/)
      if (mode === undefined || type === undefined || oid === undefined) return null
      if (type !== 'blob') return null
      return { mode, oid }
    },
    file: (rev, path) => text(['show', `${rev}:${path}`]),
  }
}
