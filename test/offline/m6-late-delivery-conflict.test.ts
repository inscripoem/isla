import { describe, expect, it } from 'vitest'
import {
  createEventStore,
  createHistoryQuery,
  createInMemoryBackend,
} from '../../src/storage'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureRuntimeEvent,
} from '../support/fixture-data'

describe('M6 late-delivery storage boundary (C-67)', () => {
  it('refuses a later fully-delivered claim for an already-cancelled delivery and preserves the original evidence', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)

    const cancelled = fixtureCommitDelivery({
      turnId: 'turn-c67',
      segmentId: 'segment-c67',
      textHash: 'hash-c67',
      text: 'cancelled before delivery',
      outputId: 'output-c67',
      receiptId: 'receipt-c67',
      classification: 'partial-unknown',
      terminalOutcome: 'cancelled',
    })
    const first = await store.commitDeliveryWithEvent(
      cancelled,
      fixtureRuntimeEvent({
        eventId: 'c67-event-1',
        seq: 1,
        type: 'delivery.committed',
        turnId: 'turn-c67',
        segmentId: 'segment-c67',
      }),
    )

    expect(first.delivery.status).toBe('applied')
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(backend.storedDeliveries()).toEqual([
      expect.objectContaining({
        eventSeq: 1,
        terminalOutcome: 'cancelled',
        record: expect.objectContaining({
          classification: 'partial-unknown',
          textHash: 'hash-c67',
        }),
      }),
    ])

    const lateClaim = fixtureCommitDelivery({
      turnId: 'turn-c67',
      segmentId: 'segment-c67',
      // Same immutable text identity; only the later classification/outcome
      // claims completion. It is internally schema-valid but contradicts the
      // already-recorded cancelled delivery.
      textHash: 'hash-c67',
      text: 'cancelled before delivery',
      outputId: 'output-c67',
      receiptId: 'receipt-c67',
      classification: 'fully-delivered',
      terminalOutcome: 'completed',
    })
    const late = await store.commitDeliveryWithEvent(
      lateClaim,
      fixtureRuntimeEvent({
        eventId: 'c67-event-2',
        seq: 2,
        type: 'delivery.committed',
        turnId: 'turn-c67',
        segmentId: 'segment-c67',
      }),
    )

    expect(late.delivery.status).toBe('conflict')
    if (late.delivery.status === 'conflict') {
      expect(late.delivery.recordedClassification).toBe('partial-unknown')
      expect(late.delivery.incomingClassification).toBe('fully-delivered')
    }
    // The contradictory supporting event is retained as audit evidence, but
    // the original delivery record is not upgraded or overwritten.
    expect(late.event.outcome).toBe('stored')
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(backend.storedDeliveries()).toEqual([
      expect.objectContaining({
        eventSeq: 1,
        terminalOutcome: 'cancelled',
        record: expect.objectContaining({
          classification: 'partial-unknown',
          textHash: 'hash-c67',
        }),
      }),
    ])
    expect((await store.readSession(FIXTURE_SESSION_ID)).map((event) => event.eventId)).toEqual([
      'c67-event-1',
      'c67-event-2',
    ])
  })
})
