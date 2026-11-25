import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AI_USE_LOG_BASE_ENV,
  AI_USE_LOG_PATH,
  collectAiUseLogEntryViolations,
  collectAiUseLogReferenceFindings,
  collectAiUseLogReferenceViolations,
  collectAiUseLogShapeViolations,
  collectAiUseLogViolations,
  readLogBase,
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

  it('rejects a valid YAML document whose entries value is not a list', () => {
    for (const document of ['entries: {}\n', 'entries: 5\n']) {
      const violations = collectAiUseLogShapeViolations(document)
      expect(violations.join(' '), document).toContain('cannot be read as an entries list')
      expect(violations.join(' '), document).toContain('the "entries" value is not a list')
      expect(violations.join(' '), document).not.toContain('no top-level')
      expect(violations.join(' '), document).not.toContain('not valid YAML')
    }
  })

  it('rejects a top-level list document', () => {
    const violations = collectAiUseLogShapeViolations('- date: 2026-11-13\n')
    expect(violations.join(' ')).toContain(
      'the document is a list, not a mapping with an "entries" key',
    )
  })

  it('rejects a scalar document with no entries list', () => {
    expect(collectAiUseLogShapeViolations('5\n').join(' ')).toContain(
      'the document has no top-level "entries" list',
    )
  })

  it('leaves a recursive alias to the reference check', () => {
    const cyclic = (tail: string): string =>
      [
        'entries:',
        '  - &a',
        '    date: 2026-11-13',
        '    task: t',
        '    change: c',
        '    agent: a',
        '    requirements: [FR-06]',
        '    invariants: []',
        '    commits: []',
        `    ${tail}`,
        '',
      ].join('\n')
    for (const tail of ['self: *a', 'self: [*a]']) {
      expect(collectAiUseLogShapeViolations(cyclic(tail)), tail).toEqual([])
    }
  })

  it('rejects invalid YAML', () => {
    expect(collectAiUseLogShapeViolations('entries: [\n  - date: 2026').join(' ')).toContain('not valid YAML')
  })
})

describe('the base log file is read as a result, not a throw', () => {
  it('returns a null text when the variable is unset', () => {
    expect(readLogBase({})).toEqual({ text: null })
  })

  it('returns the text of a readable base file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g6-base-'))
    const file = join(dir, 'base.yaml')
    writeFileSync(file, 'entries: []\n')
    try {
      expect(readLogBase({ [AI_USE_LOG_BASE_ENV]: file })).toEqual({ text: 'entries: []\n' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a missing base file with the variable, path and reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g6-base-'))
    const path = join(dir, 'not-written.yaml')
    try {
      const result = readLogBase({ [AI_USE_LOG_BASE_ENV]: path })
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error.detail).toContain(AI_USE_LOG_BASE_ENV)
        expect(result.error.detail).toContain(path)
        expect(result.error.detail).toContain('does not exist')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports an unreadable base path with the variable, path and reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g6-base-'))
    try {
      const result = readLogBase({ [AI_USE_LOG_BASE_ENV]: dir })
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error.detail).toContain(AI_USE_LOG_BASE_ENV)
        expect(result.error.detail).toContain(dir)
        expect(result.error.detail).toContain('could not be read')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the gate CLI fails closed on a missing base log (finding 2, subprocess)', () => {
  const log = `version: "1"
entries:
  - date: 2026-11-25
    task: probe
    change: A real change.
    requirements: [FR-06]
    invariants: []
    commits: []
    agent: opencode/build
`

  it('names the base-log finding and skips identity classification when the base file is missing', () => {
    // The unit tests read the base log directly; this runs the documented entry
    // point (`tsx src/evaluation/ai-use-log-gate.ts`) so a throw in the CLI path
    // cannot hide behind an assertion that only inspects `readLogBase`.
    const tsxLoader = createRequire(import.meta.url).resolve('tsx')
    const entry = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'src/evaluation/ai-use-log-gate.ts')
    const dir = mkdtempSync(join(tmpdir(), 'g6-cli-'))
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'ai-use-log.yaml'), log)
      writeFileSync(join(dir, 'changed.txt'), 'src/x.ts\0docs/ai-use-log.yaml\0')
      const missing = join(dir, 'not-written.yaml')
      const result = spawnSync(process.execPath, ['--import', tsxLoader, entry], {
        cwd: dir,
        env: {
          ...process.env,
          [CHANGED_FILES_ENV]: join(dir, 'changed.txt'),
          [AI_USE_LOG_BASE_ENV]: missing,
        },
        encoding: 'utf8',
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      expect(result.status).toBe(1)
      expect(output).toContain(AI_USE_LOG_BASE_ENV)
      expect(output).toContain('does not exist')
      expect(output).toContain('cannot classify entries')
      expect(output).not.toContain('RangeError')
      expect(output).not.toContain('Maximum call stack')
      expect(output).not.toContain('not reachable from HEAD')

      const recordDir = join(dir, '.cache', 'gate-failures')
      const records = readdirSync(recordDir).filter((name) => name.endsWith('.json'))
      expect(records).toHaveLength(1)
      const record = JSON.parse(readFileSync(join(recordDir, records[0] as string), 'utf8')) as {
        policy: string
        trigger: string
        evidence: unknown
      }
      expect(record.policy).toBe('POL-G6-03')
      expect(record.trigger).toBe('log-unreadable')
      expect(record.evidence).toEqual({ register: 'base-log' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    expect(violations[0]).toContain('it has 1 entries at the head and 1 at the base')
    expect(violations[0]).toContain('(gate G6)')
  })

  it('rejects a change that adds one entry and removes another', () => {
    const replaced = log(entry('2026-10-16', 'Replacement.'))
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], BASE, replaced)).not.toEqual([])
  })

  it('rejects a head with fewer entries than the base and names both counts', () => {
    const violations = collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], ADDED, BASE)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('it has 1 entries at the head and 2 at the base')
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

  it('reports a base that cannot be read as an entries list', () => {
    const violations = collectAiUseLogEntryViolations(
      ['src/x.ts', AI_USE_LOG_PATH],
      'entries: {}\n',
      ADDED,
    ).join(' ')
    expect(violations).toContain('cannot be read as an entries list')
    expect(violations).toContain('the "entries" value is not a list')
    expect(violations).not.toContain('not valid YAML')
  })

  it('does not crash on a cyclic base (the reference check reports it)', () => {
    expect(() =>
      collectAiUseLogEntryViolations(
        ['src/x.ts', AI_USE_LOG_PATH],
        'entries: [&a { task: t, self: *a }]\n',
        ADDED,
      ),
    ).not.toThrow()
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

  it('reports a historical entry\'s absent commit as advice, not a failure', () => {
    const advisories: string[] = []
    const text = log('[fedcba9]')
    const violations = collectAiUseLogReferenceViolations(
      text,
      deps({
        baseLogText: text,
        onAdvisory: (message) => advisories.push(message),
      }),
    )
    expect(violations).toEqual([])
    expect(advisories.join(' ')).toContain('historical entry')
  })

  it('ignores a historical entry\'s non-string commit value', () => {
    const text = log('[4273673]')
    expect(
      collectAiUseLogReferenceViolations(text, deps({ baseLogText: text })),
    ).toEqual([])
  })

  it('rejects a new entry\'s non-string commit value', () => {
    const violations = collectAiUseLogReferenceViolations(log('[4273673]'), deps())
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('non-string commit entry')
  })

  it('rejects a new entry whose commit is not reachable from HEAD', () => {
    const violations = collectAiUseLogReferenceViolations(log('[fedcba9]'), deps())
    expect(violations.join(' ')).toContain('not reachable from HEAD')
  })

  it('does not fail an unreachable commit when every entry is historical (a push integration)', () => {
    // A push to main supplies no base copy, so the gate marks every entry historical.
    // `fedcba9` exists in this clone but is not reachable from HEAD — exactly the state
    // a squash merge leaves the branch commits in.
    const text = log('[fedcba9]')
    expect(
      collectAiUseLogReferenceViolations(text, deps({ baseLogText: null })),
    ).toEqual([])
    // The default stays strict, so the pull request still rejects the same citation.
    expect(collectAiUseLogReferenceViolations(text, deps()).join(' ')).toContain(
      'not reachable from HEAD',
    )
  })

  it('fails closed when commit history is unavailable for a new entry', () => {
    const violations = collectAiUseLogReferenceViolations(
      log('[abcdef1]'),
      deps({ reachableCommits: null }),
    )
    expect(violations.join(' ')).toContain('commit history is unavailable')
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

describe('G6 historical classification follows entry identity, not position (mid-insertion)', () => {
  const entry = (task: string, change: string, commits: string): string =>
    [
      '  - date: 2026-11-13',
      `    task: ${task}`,
      '    requirements: [FR-06]',
      '    invariants: []',
      '    cases: []',
      `    change: ${change}`,
      `    commits: ${commits}`,
      '    agent: opencode/build',
      '',
    ].join('\n')
  const log = (...entries: string[]): string => `version: "1"\nentries:\n${entries.join('')}`

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

  const A = entry('entry-a', 'Base change A.', '[abcdef1]')
  // B was accepted at the base; fedcba9 exists in this clone but is not reachable
  // from HEAD, the state a squash merge leaves the branch commits in.
  const B = entry('entry-b', 'Base change B.', '[fedcba9]')
  const BASE = log(A, B)

  it('treats an entry present in the base as historical after a mid-insertion', () => {
    // The reported case: a merge inserts NEW between A and B, so B moves from index
    // 1 to 2 — at or past the base count — but B is the same entry the base accepted.
    const NEW = entry('entry-new', 'New change.', '[abcdef1]')
    const advisories: string[] = []
    const violations = collectAiUseLogReferenceViolations(
      log(A, NEW, B),
      deps({ baseLogText: BASE, onAdvisory: (message) => advisories.push(message) }),
    )
    expect(violations).toEqual([])
    expect(advisories.join(' ')).toContain('entry-b')
    expect(advisories.join(' ')).toContain('historical entry')
  })

  it('still fails a new entry that cites an unreachable commit', () => {
    const NEW = entry('entry-new', 'New change.', '[fedcba9]')
    const violations = collectAiUseLogReferenceViolations(
      log(A, NEW, B),
      deps({ baseLogText: BASE }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('entry-new')
    expect(violations[0]).toContain('not reachable from HEAD')
  })

  it('still fails an entry whose citation was repointed', () => {
    const base = log(A, entry('entry-b', 'Base change B.', '[abcdef1]'))
    const head = log(A, entry('entry-b', 'Base change B.', '[fedcba9]'))
    const violations = collectAiUseLogReferenceViolations(head, deps({ baseLogText: base }))
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('entry-b')
    expect(violations[0]).toContain('not reachable from HEAD')
  })

  it('still fails an entry whose text was edited', () => {
    const head = log(A, entry('entry-b', 'Base change B, reworded.', '[fedcba9]'))
    const violations = collectAiUseLogReferenceViolations(head, deps({ baseLogText: BASE }))
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('entry-b')
    expect(violations[0]).toContain('new or edited')
  })

  it('does not treat a field reorder as an edit', () => {
    const reordered = [
      '  - task: entry-b',
      '    date: 2026-11-13',
      '    requirements: [FR-06]',
      '    invariants: []',
      '    cases: []',
      '    change: Base change B.',
      '    commits: [fedcba9]',
      '    agent: opencode/build',
      '',
    ].join('\n')
    expect(
      collectAiUseLogReferenceViolations(log(A, reordered), deps({ baseLogText: BASE })),
    ).toEqual([])
  })

  it('does not treat a nested field reorder as an edit', () => {
    const nested = (baseFirst: boolean): string =>
      [
        '  - date: 2026-11-13',
        '    task: entry-nested',
        '    requirements: [FR-06]',
        '    invariants: []',
        '    cases: []',
        '    change: Nested detail.',
        '    commits: []',
        '    agent: opencode/build',
        '    verification:',
        ...(baseFirst
          ? ['      base: abc1234', '      results: ok']
          : ['      results: ok', '      base: abc1234']),
        '',
      ].join('\n')
    expect(
      collectAiUseLogReferenceViolations(log(nested(true)), deps({ baseLogText: log(nested(false)) })),
    ).toEqual([])
  })

  it('fails a base entry repeated in the head once as historical and once as new', () => {
    const violations = collectAiUseLogReferenceViolations(
      log(A, B, B),
      deps({ baseLogText: BASE }),
    )
    expect(violations).toHaveLength(1)
    // The first copy is the base entry and stays historical; the second is new.
    expect(violations[0]).toContain('entry 2')
    expect(violations[0]).toContain('not reachable from HEAD')
  })

  it('does not treat an acyclic shared anchor as a cycle', () => {
    const anchored = [
      '  - &shared',
      '    date: 2026-11-13',
      '    task: entry-a',
      '    requirements: [FR-06]',
      '    invariants: []',
      '    cases: []',
      '    change: Base change A.',
      '    commits: [abcdef1]',
      '    agent: opencode/build',
      '  - *shared',
      '',
    ].join('\n')
    const base = log(anchored)
    const head = log(anchored, entry('entry-new', 'New change.', '[abcdef1]'))
    expect(collectAiUseLogReferenceFindings(head, deps({ baseLogText: base }))).toEqual([])
  })

  it('reads a base with no entries key as zero entries', () => {
    for (const base of ['version: "1"\n', 'entries: null\n']) {
      // B cites fedcba9, so every entry is strict: a silent historical
      // classification would hide the violation.
      expect(
        collectAiUseLogReferenceViolations(log(B), deps({ baseLogText: base })),
        base,
      ).toHaveLength(1)
    }
  })

  it('fails closed when the base log is not valid YAML', () => {
    const findings = collectAiUseLogReferenceFindings(log(A), deps({ baseLogText: 'entries: [\n' }))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.policy).toBe('POL-G6-03')
    expect(findings[0]?.evidence).toEqual({ register: 'base-log' })
    expect(findings[0]?.message).toContain('base is not valid YAML')
    expect(findings[0]?.message).toContain('cannot classify entries')
  })

  it('fails closed when the base cannot be read as an entries list', () => {
    const findings = collectAiUseLogReferenceFindings(log(A), deps({ baseLogText: 'entries: {}\n' }))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.policy).toBe('POL-G6-03')
    expect(findings[0]?.evidence).toEqual({ register: 'base-log' })
    expect(findings[0]?.message).toContain('cannot be read as an entries list')
    expect(findings[0]?.message).toContain('the "entries" value is not a list')
    expect(findings[0]?.message).not.toContain('not valid YAML')
  })

  it('fails closed on a recursive alias in the base log', () => {
    for (const base of [
      'entries: [&a { task: t, self: *a }]\n',
      'entries: [&a { task: t, self: [*a] }]\n',
    ]) {
      const findings = collectAiUseLogReferenceFindings(log(A), deps({ baseLogText: base }))
      expect(findings, base).toHaveLength(1)
      expect(findings[0]?.policy, base).toBe('POL-G6-03')
      expect(findings[0]?.evidence, base).toEqual({ register: 'base-log' })
      expect(findings[0]?.message, base).toContain('recursive alias')
    }
  })

  it('fails closed on a recursive alias in the head log', () => {
    const cyclic = (tail: string): string =>
      [
        '  - &a',
        '    date: 2026-11-13',
        '    task: entry-cyclic',
        '    requirements: [FR-06]',
        '    invariants: []',
        '    cases: []',
        '    change: Cyclic detail.',
        '    commits: [abcdef1]',
        '    agent: opencode/build',
        `    ${tail}`,
        '',
      ].join('\n')
    for (const tail of ['self: *a', 'self: [*a]']) {
      const head = log(A, cyclic(tail))
      const findings = collectAiUseLogReferenceFindings(head, deps({ baseLogText: BASE }))
      expect(findings, tail).toHaveLength(1)
      expect(findings[0]?.policy, tail).toBe('POL-G6-03')
      expect(findings[0]?.evidence, tail).toEqual({ register: 'head-log' })
      expect(findings[0]?.message, tail).toContain('entry-cyclic')
      expect(findings[0]?.message, tail).toContain('recursive alias')
    }
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
