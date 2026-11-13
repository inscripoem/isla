import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_USE_LOG_PATH,
  collectAiUseLogEntryViolations,
  collectAiUseLogReferenceViolations,
  collectAiUseLogShapeViolations,
  collectAiUseLogViolations,
  type AiUseReferenceDeps,
} from '../../src/evaluation/ai-use-log-gate'
import { caseIdsFromRegistry, invariantIdsFromRegister } from '../../src/evaluation/registers'
import { CHANGED_FILES_ENV, readChangedFiles } from '../../src/evaluation/changed-files'

/** Write a changed-file list the way CI does, and read it back as the gate would. */
function changedFilesFrom(list: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'g6-changed-'))
  const file = join(dir, 'changed.txt')
  writeFileSync(file, list)
  const previous = process.env[CHANGED_FILES_ENV]
  process.env[CHANGED_FILES_ENV] = file
  try {
    return readChangedFiles()
  } finally {
    if (previous === undefined) delete process.env[CHANGED_FILES_ENV]
    else process.env[CHANGED_FILES_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('AI-use log gate (G6, C-36)', () => {
  it('requires the log when a code file changes', () => {
    expect(collectAiUseLogViolations(['src/storage/event-store.ts'])).toHaveLength(1)
  })

  it('requires the log when a prompt changes', () => {
    expect(collectAiUseLogViolations(['prompts/dialogue/character.md'])).toHaveLength(1)
  })

  it('passes when the log is updated alongside code', () => {
    expect(
      collectAiUseLogViolations(['src/storage/event-store.ts', 'docs/ai-use-log.yaml']),
    ).toEqual([])
  })

  it('ignores documentation-only changes', () => {
    expect(collectAiUseLogViolations(['docs/architecture/invariants.md'])).toEqual([])
  })
})

describe('AI-use log gate reads the CI change set (finding 2)', () => {
  it('reads the list from CHANGED_FILES_FILE', () => {
    expect(collectAiUseLogViolations(changedFilesFrom('src/storage/event-store.ts\0'))).toHaveLength(1)
  })

  it('keeps a filename containing a space as one path', () => {
    // An argv list would split this into two entries and change what the gate sees.
    expect(changedFilesFrom('src/storage/my file.ts\0')).toEqual(['src/storage/my file.ts'])
  })

  it('passes when only documentation changed', () => {
    expect(collectAiUseLogViolations(changedFilesFrom('docs/readme.md\0'))).toHaveLength(0)
  })
})

describe('the change set acquisition is strict (finding 2)', () => {
  it('keeps a path containing a newline as one entry', () => {
    // A newline-separated list would split this into two paths and change what the
    // gate sees; the list is NUL-separated for exactly this reason.
    expect(changedFilesFrom('src/a\nb.ts\0')).toEqual(['src/a\nb.ts'])
  })

  it('throws when the variable is set but the change set was never written', () => {
    // A change set that was expected and did not arrive must fail the run, not read
    // as "nothing changed": that would turn a broken pipeline into a passing gate.
    const previous = process.env[CHANGED_FILES_ENV]
    process.env[CHANGED_FILES_ENV] = join(tmpdir(), 'definitely-not-written.txt')
    try {
      expect(() => readChangedFiles()).toThrow(/not acquired/)
    } finally {
      if (previous === undefined) delete process.env[CHANGED_FILES_ENV]
      else process.env[CHANGED_FILES_ENV] = previous
    }
  })

  it('returns an empty list when the variable is unset (a local run)', () => {
    const previous = process.env[CHANGED_FILES_ENV]
    delete process.env[CHANGED_FILES_ENV]
    try {
      expect(readChangedFiles()).toEqual([])
    } finally {
      if (previous !== undefined) process.env[CHANGED_FILES_ENV] = previous
    }
  })
})

describe('AI-use log entry shape (finding: a one-line edit must not satisfy G6)', () => {
  const valid = `version: "1"
entries:
  - date: 2026-10-16
    task: R3
    branch: m6-r3-gates
    change: A real change.
    requirements: [FR-06]
    invariants: [INV-13]
    commits: []
    agent: opencode/deepseek-v4-flash
`

  it('accepts the committed log (the rule must not break the real file)', () => {
    expect(collectAiUseLogShapeViolations(readFileSync(AI_USE_LOG_PATH, 'utf8'))).toEqual([])
  })

  it('accepts a well-formed entry', () => {
    expect(collectAiUseLogShapeViolations(valid)).toEqual([])
  })

  it('rejects an entry with no agent', () => {
    const broken = valid.replace('    agent: opencode/deepseek-v4-flash\n', '')
    expect(collectAiUseLogShapeViolations(broken).join(' ')).toContain('"agent"')
  })

  it('rejects an entry whose date is not YYYY-MM-DD', () => {
    expect(collectAiUseLogShapeViolations(valid.replace('date: 2026-10-16', 'date: yesterday')).join(' ')).toContain(
      'YYYY-MM-DD',
    )
  })

  it('rejects an entry whose requirement list is not a list', () => {
    expect(collectAiUseLogShapeViolations(valid.replace('requirements: [FR-06]', 'requirements: FR-06')).join(' ')).toContain(
      '"requirements" must be a list',
    )
  })

  it('rejects a log with no entries list', () => {
    expect(collectAiUseLogShapeViolations('version: "1"\n').join(' ')).toContain('entries')
  })

  it('rejects invalid YAML', () => {
    expect(collectAiUseLogShapeViolations('entries: [\n  - date: 2026').join(' ')).toContain('not valid YAML')
  })
})

describe('the log change must add an entry (not merely touch or edit one)', () => {
  const entry = (date: string, change: string): string =>
    [
      `  - date: ${date}`,
      '    task: R3',
      '    branch: m6-r3-gates',
      `    change: ${change}`,
      '    requirements: [FR-06]',
      '    invariants: [INV-13]',
      '    commits: []',
      '    agent: opencode/deepseek-v4-flash',
      '',
    ].join('\n')
  const log = (...entries: string[]): string => `version: "1"\nentries:\n${entries.join('')}`

  const BASE = log(entry('2026-10-15', 'First change.'))
  const ADDED = log(entry('2026-10-15', 'First change.'), entry('2026-10-16', 'Second change.'))

  it('accepts a change that adds an entry', () => {
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], BASE, ADDED)).toEqual([])
  })

  it('rejects a change that only edits an existing entry (the review reproduction)', () => {
    const edited = log(entry('2026-10-16', 'First change, reworded.'))
    const violations = collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], BASE, edited)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('edited rather than a new one recorded')
    expect(violations[0]).toContain('1 entries at both')
  })

  it('rejects a change that adds one entry and removes another', () => {
    const replaced = log(entry('2026-10-16', 'Replacement.'))
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], BASE, replaced)).not.toEqual([])
  })

  it('rejects a head with fewer entries than the base', () => {
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], ADDED, BASE)).not.toEqual([])
  })

  it('treats an absent base log as a log with no entries', () => {
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], '', BASE)).toEqual([])
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], '   \n', BASE)).toEqual([])
  })

  it('reports a base that is not valid YAML', () => {
    expect(
      collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], 'entries: [\n', ADDED).join(' '),
    ).toContain('base is not valid YAML')
  })

  it('does not apply when no code or prompt changed (a documentation fix is free)', () => {
    expect(collectAiUseLogEntryViolations(['docs/readme.md', AI_USE_LOG_PATH], BASE, BASE)).toEqual([])
  })

  it('is not verified without a base copy (a local run)', () => {
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], null, BASE)).toEqual([])
  })
})

describe('G6 references: commit and id existence (Tier 1, 1.3)', () => {
  const log = (commits: string, cases = '[]', invariants = '[]'): string => `version: "1"
entries:
  - date: 2026-11-13
    task: slice
    change: A real change.
    requirements: [FR-06]
    invariants: ${invariants}
    cases: ${cases}
    commits: ${commits}
    agent: opencode/build
`

  const deps = (overrides: Partial<AiUseReferenceDeps> = {}): AiUseReferenceDeps => ({
    existingCommits: new Map([
      ['abcdef1', 'abcdef1234567890'],
      ['fedcba9', 'fedcba9876543210'],
    ]),
    reachableCommits: new Set(['abcdef1234567890']),
    caseIds: new Set(['C-36']),
    invariantIds: new Set(['INV-14']),
    baseline: [],
    today: '2026-11-13',
    ...overrides,
  })

  it('accepts a cited commit that exists', () => {
    expect(collectAiUseLogReferenceViolations(log('[abcdef1]'), deps())).toEqual([])
  })

  it('rejects a cited commit that is not an object in the repository', () => {
    const violations = collectAiUseLogReferenceViolations(
      log('[deadbee]'),
      deps({ existingCommits: new Map([['deadbee', '']]) }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('deadbee')
    expect(violations[0]).toContain('not an object in this repository')
  })

  it('rejects a SHA too short to identify a commit', () => {
    expect(collectAiUseLogReferenceViolations(log('[abc]'), deps()).join(' ')).toContain(
      'too short to identify',
    )
  })

  it('fails closed when the object database is unavailable', () => {
    const violations = collectAiUseLogReferenceViolations(
      log('[abcdef1]'),
      deps({ existingCommits: null }),
    )
    expect(violations.join(' ')).toContain('object database is unavailable')
  })

  it('reports an existing but unreachable commit as advice, not a failure', () => {
    const advisories: string[] = []
    const violations = collectAiUseLogReferenceViolations(
      log('[fedcba9]'),
      deps({ onAdvisory: (message) => advisories.push(message) }),
    )
    expect(violations).toEqual([])
    expect(advisories.join(' ')).toContain('not reachable from HEAD')
  })

  it('rejects an unknown case id', () => {
    expect(collectAiUseLogReferenceViolations(log('[]', '[C-99]'), deps()).join(' ')).toContain(
      'C-99',
    )
  })

  it('rejects an unknown invariant id', () => {
    expect(
      collectAiUseLogReferenceViolations(log('[]', '[]', '[INV-99]'), deps()).join(' '),
    ).toContain('INV-99')
  })

  it('fails closed when a register is unavailable and ids are cited', () => {
    expect(
      collectAiUseLogReferenceViolations(log('[]', '[C-36]'), deps({ caseIds: null })).join(' '),
    ).toContain('case registry is unavailable')
  })

  it('accepts a baselined missing commit before its expiry', () => {
    const baseline = [{ kind: 'commit' as const, value: 'deadbee', expires: '2026-12-31' }]
    expect(
      collectAiUseLogReferenceViolations(
        log('[deadbee]'),
        deps({ existingCommits: new Map([['deadbee', '']]), baseline }),
      ),
    ).toEqual([])
  })

  it('rejects a baselined missing commit after its expiry', () => {
    const baseline = [{ kind: 'commit' as const, value: 'deadbee', expires: '2026-01-01' }]
    const violations = collectAiUseLogReferenceViolations(
      log('[deadbee]'),
      deps({ existingCommits: new Map([['deadbee', '']]), baseline }),
    )
    expect(violations.join(' ')).toContain('expired')
  })

  it('does not let a baseline entry hide a different missing commit', () => {
    const baseline = [{ kind: 'commit' as const, value: 'deadbee', expires: '2026-12-31' }]
    const violations = collectAiUseLogReferenceViolations(
      log('[0badbad]'),
      deps({ existingCommits: new Map([['0badbad', '']]), baseline }),
    )
    expect(violations.join(' ')).toContain('0badbad')
  })
})

describe('register loaders agree with the committed registers (T0)', () => {
  it('sees the committed case ids', () => {
    const ids = caseIdsFromRegistry(readFileSync('docs/req/case-registry.yaml', 'utf8'))
    expect(ids).not.toBeNull()
    expect(ids?.has('C-36')).toBe(true)
  })

  it('sees the committed invariant ids', () => {
    const ids = invariantIdsFromRegister(readFileSync('docs/architecture/invariants.md', 'utf8'))
    expect(ids).not.toBeNull()
    expect(ids?.has('INV-14')).toBe(true)
    expect(ids?.has('INV-13')).toBe(true)
  })

  it('returns null rather than an empty set for an unparsable register', () => {
    expect(caseIdsFromRegistry('not: [valid')).toBeNull()
    expect(invariantIdsFromRegister('# no table here')).toBeNull()
  })
})
