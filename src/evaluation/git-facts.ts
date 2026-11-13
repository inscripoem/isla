import { execFileSync } from 'node:child_process'

/**
 * M6 / R3 — git facts for the evidence gates (G1 ordering, G6 commit reachability).
 *
 * Every function returns `null` when git cannot answer: a shallow clone, a missing
 * object, a detached worktree without the branch, or a git error. `null` is **not**
 * "no violation" — each caller must fail closed, because a gate that treats an
 * unavailable history as a pass is not a gate.
 *
 * The parsing is deliberately not here: callers receive plain values and pass them
 * into pure functions, so the rules can be tested without a repository.
 */

function git(args: readonly string[], cwd?: string): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd === undefined ? {} : { cwd }),
    })
  } catch {
    return null
  }
}

/**
 * Every commit reachable from HEAD, full SHAs. One call for the whole log, so the
 * AI-use gate does not spawn a process per entry.
 */
export function reachableCommits(cwd?: string): ReadonlySet<string> | null {
  const output = git(['rev-list', 'HEAD'], cwd)
  if (output === null) return null
  const shas = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return new Set(shas)
}

/**
 * The first commit in `base..HEAD` that touches any of `paths`, or `null` when the
 * range is unknown or no commit touches them. An empty base is rejected: a missing
 * base must not silently become "the whole history".
 */
export function firstCommitTouching(
  paths: readonly string[],
  base: string | null,
  cwd?: string,
): string | null {
  if (base === null || base.trim().length === 0 || paths.length === 0) return null
  const output = git(['rev-list', '--reverse', `${base}..HEAD`, '--', ...paths], cwd)
  if (output === null) return null
  const first = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return first ?? null
}

/** `true`/`false` from git, or `null` when the answer is unavailable. */
export function isAncestorOf(
  ancestor: string,
  descendant: string,
  cwd?: string,
): boolean | null {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
      ...(cwd === undefined ? {} : { cwd }),
    })
    return true
  } catch (error) {
    const status = (error as { status?: number }).status
    // git exits 1 for "not an ancestor"; anything else is an unavailable answer.
    return status === 1 ? false : null
  }
}

/** Committer date (ISO 8601) of a commit, or `null` when it cannot be read. */
export function commitTime(sha: string, cwd?: string): string | null {
  const output = git(['show', '-s', '--format=%cI', sha], cwd)
  return output === null ? null : output.trim() || null
}

/**
 * Resolve cited commits against the object database. Returns a map from the cited
 * string to the full object id, or `null` when git cannot answer. A cited commit
 * that does not exist maps to an empty string.
 *
 * Existence, not HEAD ancestry, is the enforceable rule here: this project
 * squash-merges, so the original commits of merged work are orphaned by design
 * (measured 2026-11-13: 54 of 58 cited commits exist, 0 are reachable from HEAD).
 * Reachability is reported as advice, never as a failure.
 */
export function existingCommits(
  shas: readonly string[],
  cwd?: string,
): ReadonlyMap<string, string> | null {
  if (shas.length === 0) return new Map()
  try {
    const output = execFileSync(
      'git',
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      {
        encoding: 'utf8',
        input: `${shas.join('\n')}\n`,
        stdio: ['pipe', 'pipe', 'ignore'],
        ...(cwd === undefined ? {} : { cwd }),
      },
    )
    const map = new Map<string, string>()
    const lines = output.split('\n').filter((line) => line.trim().length > 0)
    shas.forEach((sha, index) => {
      const line = lines[index] ?? ''
      const [objectId, type] = line.split(' ')
      map.set(sha, type === 'commit' ? (objectId ?? '') : '')
    })
    return map
  } catch {
    return null
  }
}

/** Merge base of `ref` and HEAD, or `null` when it cannot be resolved. */
export function mergeBase(ref: string, cwd?: string): string | null {
  const output = git(['merge-base', ref, 'HEAD'], cwd)
  return output === null ? null : output.trim() || null
}
