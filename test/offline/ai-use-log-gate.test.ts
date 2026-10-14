import { describe, expect, it } from 'vitest'
import { collectAiUseLogViolations } from '../../src/evaluation/ai-use-log-gate'

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
