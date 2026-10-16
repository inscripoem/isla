import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectAiUseLogViolations } from '../../src/evaluation/ai-use-log-gate'
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
    expect(collectAiUseLogViolations(changedFilesFrom('src/storage/event-store.ts\n'))).toHaveLength(1)
  })

  it('keeps a filename containing a space as one path', () => {
    // An argv list would split this into two entries and change what the gate sees.
    expect(changedFilesFrom('src/storage/my file.ts\n')).toEqual(['src/storage/my file.ts'])
  })

  it('passes when only documentation changed', () => {
    expect(collectAiUseLogViolations(changedFilesFrom('docs/readme.md\n'))).toHaveLength(0)
  })
})
