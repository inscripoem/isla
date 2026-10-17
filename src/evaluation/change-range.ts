import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * M6 / R3 — the diff range the gates run against.
 *
 * A push event carries `before`: the commit the branch pointed at before the push. A
 * **branch-creation push** carries all zeros instead, because the new branch had no
 * previous commit. The range for that push must still cover everything the push
 * introduced. Diffing the tip against its parent would review **only the last
 * commit**: a push whose first commit changes code and whose last commit only touches
 * documentation would satisfy the trace and AI-use-log gates without either of them
 * ever looking at the code.
 *
 * So a branch-creation push is reviewed as the **whole branch**:
 * `merge-base(origin/main, HEAD)..HEAD`. When that cannot be resolved the range is
 * reported **unavailable** and the caller fails; a gate is never silently narrower
 * than the push. The one exception is a repository whose first push creates the root
 * commit: there is no parent and no merge base, so every path is new and the empty
 * tree is the honest base.
 *
 * Git is consulted only when the range actually needs it: a pull request and an
 * ordinary push are answered from the event payload alone.
 */

export type ChangeBaseSource =
  | 'pull-request'
  | 'push'
  | 'merge-base'
  | 'empty-tree'
  | 'head-parent'

export interface ChangeBaseInput {
  /** `github.event_name`: `pull_request`, `push`, or a manual/scheduled event. */
  readonly event: string
  /** `github.event.pull_request.base.sha`. */
  readonly pullRequestBase?: string | null
  /** `github.event.before`. */
  readonly before?: string | null
  /** `merge-base origin/main HEAD`, or null when git could not resolve it. */
  readonly mergeBase?: string | null
  /** The parent commit of HEAD, or null when HEAD is a root commit. */
  readonly parent?: string | null
  /** Git's empty tree, used as the base of a repository's root commit. */
  readonly emptyTree: string
}

export type ChangeBase =
  | { readonly kind: 'range'; readonly base: string; readonly source: ChangeBaseSource }
  | { readonly kind: 'unavailable'; readonly reason: string }

const ALL_ZEROS = /^0+$/

/** A commit id that is present and not the all-zero sentinel. */
function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !ALL_ZEROS.test(value.trim())
}

export function resolveChangeBase(input: ChangeBaseInput): ChangeBase {
  if (input.event === 'pull_request') {
    if (!present(input.pullRequestBase)) {
      return { kind: 'unavailable', reason: 'the pull request carried no base commit' }
    }
    return { kind: 'range', base: input.pullRequestBase.trim(), source: 'pull-request' }
  }

  if (input.event === 'push') {
    if (present(input.before)) {
      return { kind: 'range', base: input.before.trim(), source: 'push' }
    }
    // All-zero `before`: a branch-creation push, reviewed as the whole branch.
    if (present(input.mergeBase)) {
      return { kind: 'range', base: input.mergeBase.trim(), source: 'merge-base' }
    }
    if (!present(input.parent)) {
      // The push created the repository's first commit: every path is new.
      return { kind: 'range', base: input.emptyTree, source: 'empty-tree' }
    }
    return {
      kind: 'unavailable',
      reason:
        'a branch-creation push has no merge base with origin/main, so the full range cannot be resolved',
    }
  }

  // A manual or scheduled run has no push range of its own. Review the tip against its
  // parent and say so, rather than inventing a branch range the run did not ask for.
  if (present(input.parent)) {
    return { kind: 'range', base: input.parent.trim(), source: 'head-parent' }
  }
  return { kind: 'range', base: input.emptyTree, source: 'empty-tree' }
}

/** Run git, returning trimmed stdout or null when it fails. */
function git(cwd: string | undefined, args: readonly string[], input?: string): string | null {
  try {
    const output = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'],
      input,
    })
    return output.trim()
  } catch {
    return null
  }
}

function emptyTree(cwd: string | undefined): string {
  const tree = git(cwd, ['hash-object', '-t', 'tree', '--stdin'], '')
  if (tree === null || tree.length === 0) {
    throw new Error('git could not compute the empty tree for a root-commit range')
  }
  return tree
}

export function resolveFromEnvironment(env: NodeJS.ProcessEnv = process.env, cwd?: string): ChangeBase {
  const event = env.EVENT_NAME ?? ''
  const pullRequestBase = env.PR_BASE_SHA ?? null
  const before = env.PUSH_BEFORE ?? null

  // The common cases need no git at all.
  if (event === 'pull_request' || (event === 'push' && present(before))) {
    return resolveChangeBase({ event, pullRequestBase, before, emptyTree: '' })
  }

  if (event === 'push') {
    const mergeBase = git(cwd, ['merge-base', 'origin/main', 'HEAD'])
    if (mergeBase !== null) {
      return resolveChangeBase({ event, pullRequestBase, before, mergeBase, emptyTree: '' })
    }
    // No merge base: either the repository's first push (no parent) or a range that
    // cannot be established — never the tip's parent.
    const parent = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^'])
    return resolveChangeBase({
      event,
      pullRequestBase,
      before,
      mergeBase: null,
      parent,
      emptyTree: parent === null ? emptyTree(cwd) : '',
    })
  }

  const parent = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^'])
  return resolveChangeBase({
    event,
    pullRequestBase,
    before,
    parent,
    emptyTree: parent === null ? emptyTree(cwd) : '',
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const resolved = resolveFromEnvironment()
  if (resolved.kind === 'unavailable') {
    process.stderr.write(`::error::${resolved.reason}; the diff gates are not verified\n`)
    process.exitCode = 1
  } else {
    process.stderr.write(`change range: ${resolved.source} ${resolved.base}..HEAD\n`)
    process.stdout.write(`${resolved.base}\n`)
  }
}
