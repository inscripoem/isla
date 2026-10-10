import { describe, expect, it } from 'vitest'
import { collectDialogueViolations } from '../conformance/dialogue.conformance'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureRuntimeEvent,
} from '../support/fixture-data'

describe('M4 dialogue conformance', () => {
  it('accepts the correct dialogue and memory commit adapters', async () => {
    const violations = await collectDialogueViolations(() => ({
      dialogue: correct.createFixtureDialoguePort({ segmentCount: 2 }),
      commit: correct.createFixtureMemoryCommit(),
    }))
    expect(violations).toEqual([])
  })

  it('rejects inconsistent and mutable dialogue output', async () => {
    const violations = await collectDialogueViolations(() => ({
      dialogue: faulty.createFaultyDialoguePort(),
      commit: correct.createFixtureMemoryCommit(),
    }))
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('dialogue-valid')
    expect(codes).toContain('dialogue-immutable')
  })

  it('rejects punctuation-only output treated as substantive', async () => {
    const violations = await collectDialogueViolations(() => ({
      dialogue: faulty.createFaultyPunctuationDialoguePort(),
      commit: correct.createFixtureMemoryCommit(),
    }))
    expect(violations.map((violation) => violation.code)).toContain('dialogue-substantive')
  })

  it('retrieves confirmed spoken text and excludes partial records', async () => {
    const store = correct.createFixtureEventStore()
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery(),
      fixtureRuntimeEvent({ eventId: 'evt-spoken', seq: 1 }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-partial',
        segmentId: 'seg-partial',
        textHash: 'hash-partial',
        text: 'half a sentence',
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-partial', seq: 2 }),
    )
    const history = await correct
      .createFixtureHistoryQuery(store)
      .confirmedHistory(FIXTURE_SESSION_ID)
    expect(history).toHaveLength(1)
    expect(history[0]?.text).toBe('We talked about the concert.')
  })
})
