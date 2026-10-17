import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ChangeBaseInput,
  resolveChangeBase,
  resolveFromEnvironment,
} from '../../src/evaluation/change-range'

const ZERO = '0'.repeat(40)
const directories: string[] = []
const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

function repo(): string {
  const directory = mkdtempSync(join(tmpdir(), 'm6-range-'))
  directories.push(directory)
  git(directory, ['init', '-q', '-b', 'main'])
  git(directory, ['config', 'user.name', 'Range Test'])
  git(directory, ['config', 'user.email', 'range@example.com'])
  git(directory, ['config', 'commit.gpgsign', 'false'])
  return directory
}

function commit(directory: string, file: string, body: string, message: string): string {
  mkdirSync(dirname(join(directory, file)), { recursive: true })
  writeFileSync(join(directory, file), body)
  git(directory, ['add', file])
  git(directory, ['commit', '-q', '-m', message])
  return git(directory, ['rev-parse', 'HEAD'])
}

const facts = (overrides: Partial<ChangeBaseInput> = {}): ChangeBaseInput => ({
  event: 'push',
  before: ZERO,
  mergeBase: null,
  parent: null,
  emptyTree: EMPTY,
  ...overrides,
})

describe('change range resolution (the diff the gates review)', () => {
  it('uses the pull request base for a pull request, and refuses a PR without one', () => {
    expect(resolveChangeBase(facts({ event: 'pull_request', pullRequestBase: 'a'.repeat(40) }))).toEqual({
      kind: 'range',
      base: 'a'.repeat(40),
      source: 'pull-request',
    })
    expect(resolveChangeBase(facts({ event: 'pull_request', pullRequestBase: null })).kind).toBe('unavailable')
  })

  it('uses `before` for an ordinary push', () => {
    expect(resolveChangeBase(facts({ before: 'b'.repeat(40), mergeBase: 'c'.repeat(40) }))).toEqual({
      kind: 'range',
      base: 'b'.repeat(40),
      source: 'push',
    })
  })

  it('never falls back to the tip parent for a branch-creation push', () => {
    // The regression: all-zero `before` with a resolvable merge base must use the
    // merge base, not HEAD^.
    expect(resolveChangeBase(facts({ mergeBase: 'c'.repeat(40), parent: 'd'.repeat(40) }))).toEqual({
      kind: 'range',
      base: 'c'.repeat(40),
      source: 'merge-base',
    })
    // And when no merge base exists, the answer is "unavailable" — not the parent.
    expect(resolveChangeBase(facts({ mergeBase: null, parent: 'd'.repeat(40) }))).toEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('merge base'),
    })
  })

  it('uses the empty tree when the push creates the root commit', () => {
    expect(resolveChangeBase(facts({ mergeBase: null, parent: null }))).toEqual({
      kind: 'range',
      base: EMPTY,
      source: 'empty-tree',
    })
  })

  it('reviews a manual run against the tip parent, and its root commit against the empty tree', () => {
    expect(resolveChangeBase(facts({ event: 'workflow_dispatch', before: null, parent: 'e'.repeat(40) }))).toEqual({
      kind: 'range',
      base: 'e'.repeat(40),
      source: 'head-parent',
    })
    expect(resolveChangeBase(facts({ event: 'workflow_dispatch', before: null, parent: null }))).toEqual({
      kind: 'range',
      base: EMPTY,
      source: 'empty-tree',
    })
  })
})

describe('change range resolution against a real repository', () => {
  it('covers every commit of a multi-commit branch-creation push', () => {
    const directory = repo()
    const baseCommit = commit(directory, 'README.md', 'main\n', 'main commit')

    git(directory, ['switch', '-q', '-c', 'feature'])
    commit(directory, 'src/a.ts', 'export const a = 1\n', 'feat: code') // the commit a tip-parent diff drops
    commit(directory, 'README.md', 'main\nnotes\n', 'docs: notes')
    commit(directory, 'README.md', 'main\nnotes\nmore\n', 'docs: more notes')

    git(directory, ['update-ref', 'refs/remotes/origin/main', baseCommit])

    const resolved = resolveFromEnvironment({ EVENT_NAME: 'push', PUSH_BEFORE: ZERO }, directory)
    expect(resolved).toEqual({ kind: 'range', base: baseCommit, source: 'merge-base' })

    const wholeRange = git(directory, ['diff', '--name-only', baseCommit, 'HEAD'])
    expect(wholeRange.split('\n')).toContain('src/a.ts')

    // The behaviour this replaces reviewed only the tip's parent, which cannot see
    // the code commit at all.
    const tipParent = git(directory, ['diff', '--name-only', 'HEAD^', 'HEAD'])
    expect(tipParent.split('\n')).not.toContain('src/a.ts')
  })

  it('reviews a repository first push as every path being new', () => {
    const directory = repo()
    commit(directory, 'src/root.ts', 'export const root = true\n', 'root commit')

    const resolved = resolveFromEnvironment({ EVENT_NAME: 'push', PUSH_BEFORE: ZERO }, directory)
    expect(resolved.kind).toBe('range')
    if (resolved.kind !== 'range') throw new Error('unreachable')
    expect(resolved.source).toBe('empty-tree')

    const wholeRange = git(directory, ['diff', '--name-only', resolved.base, 'HEAD'])
    expect(wholeRange.split('\n')).toContain('src/root.ts')
  })

  it('falls back to the merge base when a force-push names a commit the checkout does not have', () => {
    const directory = repo()
    const baseCommit = commit(directory, 'README.md', 'main\n', 'main commit')
    git(directory, ['switch', '-q', '-c', 'feature'])
    commit(directory, 'src/a.ts', 'export const a = 1\n', 'feat')
    git(directory, ['update-ref', 'refs/remotes/origin/main', baseCommit])

    // A force-push records the old tip in `before`; that commit is unreachable and a
    // fresh checkout may not have it, so the range must fall back to the branch point.
    const resolved = resolveFromEnvironment(
      { EVENT_NAME: 'push', PUSH_BEFORE: 'f'.repeat(40) },
      directory,
    )
    expect(resolved).toEqual({ kind: 'range', base: baseCommit, source: 'merge-base' })
  })

  it('still uses `before` when that commit exists', () => {
    const directory = repo()
    const first = commit(directory, 'README.md', 'one\n', 'first')
    commit(directory, 'README.md', 'two\n', 'second')
    expect(resolveFromEnvironment({ EVENT_NAME: 'push', PUSH_BEFORE: first }, directory)).toEqual({
      kind: 'range',
      base: first,
      source: 'push',
    })
  })

  it('does not use a missing `before` when no merge base exists either', () => {
    const directory = repo()
    commit(directory, 'src/a.ts', 'a\n', 'first')
    commit(directory, 'src/a.ts', 'ab\n', 'second')
    expect(
      resolveFromEnvironment({ EVENT_NAME: 'push', PUSH_BEFORE: 'f'.repeat(40) }, directory).kind,
    ).toBe('unavailable')
  })

  it('fails closed when a branch-creation push has no merge base but does have a parent', () => {
    const directory = repo()
    commit(directory, 'src/a.ts', 'a\n', 'first')
    commit(directory, 'src/a.ts', 'ab\n', 'second')

    // No `origin/main` ref: the merge base cannot be resolved, and the parent exists.
    const resolved = resolveFromEnvironment(
      { EVENT_NAME: 'push', PUSH_BEFORE: ZERO },
      directory,
    )
    expect(resolved).toEqual({
      kind: 'unavailable',
      reason: expect.stringContaining('merge base'),
    })
  })
})
