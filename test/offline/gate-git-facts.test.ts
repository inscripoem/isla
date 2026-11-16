import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  existingCommits,
  firstCommitTouching,
  isAncestorOf,
  mergeBase,
  reachableCommits,
} from '../../src/evaluation/git-facts'

/**
 * Real git repositories, not injected answers. The G1 ordering rule and the G6
 * existence rule both depend on git semantics (rewrite, shallow clone), and a
 * mock cannot show that a rewritten commit is still an ancestor or that a shallow
 * clone cannot answer.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-git-'))
  roots.push(root)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'gate@example.test')
  git(root, 'config', 'user.name', 'gate')
  return root
}

function commit(root: string, path: string, content: string, message: string): string {
  mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(root, path), content)
  git(root, 'add', path)
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

describe('G1 ordering survives a rewritten history (Tier 1, 1.1)', () => {
  it('keeps the approval record an ancestor after the code commit is amended', () => {
    const root = repo()
    const base = commit(root, 'README.md', 'base\n', 'base')
    const record = commit(root, 'docs/approvals.yaml', 'approvals: []\n', 'record')
    const code = commit(root, 'src/a.ts', 'export const a = 1\n', 'code')

    expect(isAncestorOf(record, code, root)).toBe(true)
    expect(firstCommitTouching(['src'], base, root)).toBe(code)
    expect(mergeBase('HEAD', root)).toBe(code)

    // A rebase/amend rewrites the code commit; the record must stay an ancestor.
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2\n')
    git(root, 'add', 'src/a.ts')
    git(root, 'commit', '-q', '--amend', '-m', 'code rewritten')
    const rewritten = git(root, 'rev-parse', 'HEAD')

    expect(rewritten).not.toBe(code)
    expect(isAncestorOf(record, rewritten, root)).toBe(true)
    expect(firstCommitTouching(['src'], base, root)).toBe(rewritten)
  })

  it('rejects a record committed after the code', () => {
    const root = repo()
    const base = commit(root, 'README.md', 'base\n', 'base')
    const code = commit(root, 'src/a.ts', 'export const a = 1\n', 'code')
    const late = commit(root, 'docs/approvals.yaml', 'approvals: []\n', 'late record')

    expect(firstCommitTouching(['src'], base, root)).toBe(code)
    expect(isAncestorOf(late, code, root)).toBe(false)
  })
})

describe('a shallow clone cannot answer, so the gates fail closed (Tier 1, 1.1/1.3)', () => {
  it('hides the older commit and makes the ancestry answer unavailable', () => {
    const source = repo()
    const base = commit(source, 'README.md', 'base\n', 'base')
    const record = commit(source, 'docs/approvals.yaml', 'approvals: []\n', 'record')
    const code = commit(source, 'src/a.ts', 'export const a = 1\n', 'code')
    expect(isAncestorOf(record, code, source)).toBe(true)

    const clone = join(mkdtempSync(join(tmpdir(), 'gate-clone-')), 'shallow')
    roots.push(clone)
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, clone], {
      stdio: 'ignore',
    })

    // The tip is present; the history behind it is not.
    expect(reachableCommits(clone)?.has(code)).toBe(true)
    expect(reachableCommits(clone)?.has(record)).toBe(false)
    expect(existingCommits([record], clone)?.get(record)).toBe('')
    // git cannot answer whether the record is an ancestor: the gate must deny.
    expect(isAncestorOf(record, code, clone)).toBeNull()
    expect(firstCommitTouching(['src'], base, clone)).toBeNull()
  })
})
