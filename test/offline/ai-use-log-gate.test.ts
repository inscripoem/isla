import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_USE_LOG_PATH,
  collectAiUseLogEntryViolations,
  collectAiUseLogShapeViolations,
  collectAiUseLogViolations,
} from '../../src/evaluation/ai-use-log-gate'
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

describe('the log change must add a complete entry (not just touch the file)', () => {
  const COMPLETE = [
    'diff --git a/docs/ai-use-log.yaml b/docs/ai-use-log.yaml',
    '+++ b/docs/ai-use-log.yaml',
    '+  - date: 2026-10-16',
    '+    task: R3',
    '+    branch: m6-r3-gates',
    '+    change: A real change.',
    '+    agent: opencode/deepseek-v4-flash',
  ].join('\n')

  it('accepts a patch that adds a complete entry', () => {
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], COMPLETE)).toEqual([])
  })

  it('rejects a patch that only edits the file', () => {
    const trivial = '+++ b/docs/ai-use-log.yaml\n+\n'
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], trivial).join(' ')).toContain(
      'must add a complete entry',
    )
  })

  it('does not apply when no code or prompt changed (a documentation fix is free)', () => {
    expect(collectAiUseLogEntryViolations(['docs/readme.md', AI_USE_LOG_PATH], '+++ x\n+\n')).toEqual([])
  })

  it('is not verified without a patch (a local run)', () => {
    expect(collectAiUseLogEntryViolations(['src/x.ts', AI_USE_LOG_PATH], null)).toEqual([])
  })
})
