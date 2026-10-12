import { describe, expect, it } from 'vitest'
import { collectStorageViolations } from '../conformance/storage.conformance'
import * as faulty from '../support/faulty-ports'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'
import {
  createEventStore,
  createHistoryQuery,
  createInMemoryBackend,
  createMemoryProjection,
  createReplayReader,
} from '../../src/storage'
import type { StorageBackend, StorageMutation } from '../../src/storage'

/**
 * Test-only fault injection (READINESS-KITS: keep fault-injection controls in the
 * test adapter). Wraps the in-memory backend so the next commit throws once;
 * production code exposes no failure switch.
 */
function createFailingBackend(): { backend: StorageBackend; failNextCommit: () => void } {
  const base = createInMemoryBackend()
  let shouldFail = false
  return {
    backend: {
      ...base,
      commit: (mutations: readonly StorageMutation[]) => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('simulated storage failure')
        }
        base.commit(mutations)
      },
    },
    failNextCommit: () => {
      shouldFail = true
    },
  }
}

describe('M6 storage conformance', () => {
  it('accepts the M6 event store and projection', async () => {
    const violations = await collectStorageViolations(() => {
      const { backend, failNextCommit } = createFailingBackend()
      const store = createEventStore(backend)
      return {
        store,
        projection: createMemoryProjection(),
        history: createHistoryQuery(store.deliveries),
        setFailNextCommit: failNextCommit,
      }
    })
    expect(violations).toEqual([])
  })

  it('rejects a faulty store and projection', async () => {
    const violations = await collectStorageViolations(() => {
      const store = faulty.createFaultyEventStore()
      return {
        store: store.store,
        projection: faulty.createFaultyMemoryProjection(),
        history: faulty.createFaultyHistoryQuery(store),
        setFailNextCommit: () => {
          store.failNextCommit = true
        },
      }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('append-duplicate')
    expect(codes).toContain('append-seq-unique')
    expect(codes).toContain('delivery-changed-content-conflict')
    expect(codes).toContain('atomic-failure-reported')
    expect(codes).toContain('projection-no-gap-claim')
    expect(codes).toContain('history-fully-delivered-only')
  })
})

describe('M6 replay reader (C-12 isolation)', () => {
  it('reads committed events without mutating live state', async () => {
    const store = createEventStore()
    await store.append(fixtureRuntimeEvent({ eventId: 'evt-r1', seq: 1 }))
    await store.append(fixtureRuntimeEvent({ eventId: 'evt-r2', seq: 2 }))

    const replay = createReplayReader(store)
    const before = await store.readSession(FIXTURE_SESSION_ID)

    const archive = await replay.load(FIXTURE_SESSION_ID)
    expect(archive.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(archive.events.map((event) => event.eventId)).toEqual(['evt-r1', 'evt-r2'])

    // Replay must not mutate live state.
    const after = await store.readSession(FIXTURE_SESSION_ID)
    expect(after).toEqual(before)

    // Repeated loads are idempotent.
    const again = await replay.load(FIXTURE_SESSION_ID)
    expect(again.events).toEqual(archive.events)
  })

  it('returns an empty archive for a session with no committed events', async () => {
    const replay = createReplayReader(createEventStore())
    const archive = await replay.load('session-unknown')
    expect(archive).toEqual({ sessionId: 'session-unknown', events: [] })
  })
})

describe('M6 confirmed history (C6/C7)', () => {
  it('returns only fully-delivered records for the requesting session', async () => {
    const store = createEventStore()
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 't1', segmentId: 's1', textHash: 'h1', text: 'spoken' }),
      fixtureRuntimeEvent({ eventId: 'e1', seq: 1, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't2',
        segmentId: 's2',
        textHash: 'h2',
        text: 'partial',
        classification: 'partial-unknown',
      }),
      fixtureRuntimeEvent({ eventId: 'e2', seq: 2, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't3',
        segmentId: 's3',
        textHash: 'h3',
        text: 'unspoken',
        classification: 'not-delivered',
      }),
      fixtureRuntimeEvent({ eventId: 'e3', seq: 3, type: 'delivery.committed' }),
    )
    // A fully-delivered record in a different session must not leak into this one.
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        sessionId: 'session-other',
        turnId: 't4',
        segmentId: 's4',
        textHash: 'h4',
        text: 'other-session',
      }),
      fixtureRuntimeEvent({
        sessionId: 'session-other',
        eventId: 'e4',
        seq: 1,
        type: 'delivery.committed',
      }),
    )

    const history = createHistoryQuery(store.deliveries)
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.text)).toEqual(['spoken'])
  })

  it('does not duplicate history when an identical delivery is committed twice', async () => {
    const store = createEventStore()
    const delivery = fixtureCommitDelivery({ turnId: 't1', segmentId: 's1', textHash: 'h1', text: 'spoken' })
    await store.commitDeliveryWithEvent(
      delivery,
      fixtureRuntimeEvent({ eventId: 'e1', seq: 1, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      delivery,
      fixtureRuntimeEvent({ eventId: 'e2', seq: 2, type: 'delivery.committed' }),
    )

    const history = createHistoryQuery(store.deliveries)
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed).toHaveLength(1)
  })
})

describe('M6 storage invariants', () => {
  it('INV-04: rejects a reused event id with different content and a reused session sequence', async () => {
    const store = createEventStore()
    const first = fixtureRuntimeEvent({ eventId: 'inv04-a', seq: 1 })
    expect((await store.append(first)).outcome).toBe('stored')
    expect((await store.append(first)).outcome).toBe('duplicate')
    expect(
      (await store.append(fixtureRuntimeEvent({ eventId: 'inv04-a', seq: 1, type: 'input.dropped' })))
        .outcome,
    ).toBe('failed')
    expect((await store.append(fixtureRuntimeEvent({ eventId: 'inv04-b', seq: 1 }))).outcome).toBe(
      'failed',
    )
  })

  it('INV-05: a failed atomic commit persists nothing', async () => {
    const { backend, failNextCommit } = createFailingBackend()
    const store = createEventStore(backend)
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'inv05-ok', segmentId: 's', textHash: 'h', text: 'ok' }),
      fixtureRuntimeEvent({ eventId: 'inv05-1', seq: 1, type: 'delivery.committed' }),
    )
    const before = (await store.readSession(FIXTURE_SESSION_ID)).length

    failNextCommit()
    const failed = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'inv05-fail', segmentId: 's', textHash: 'hf', text: 'fail' }),
      fixtureRuntimeEvent({ eventId: 'inv05-2', seq: 2, type: 'delivery.committed' }),
    )

    expect(failed.event.outcome).toBe('failed')
    expect((await store.readSession(FIXTURE_SESSION_ID)).length).toBe(before)
  })

  it('INV-06: the memory projection does not advance across a gap and is idempotent', async () => {
    const projection = createMemoryProjection()
    expect((await projection.apply(fixtureRuntimeEvent({ eventId: 'inv06-2', seq: 2 }))).appliedSeq).toBe(0)
    expect((await projection.apply(fixtureRuntimeEvent({ eventId: 'inv06-1', seq: 1 }))).appliedSeq).toBe(1)
    expect((await projection.apply(fixtureRuntimeEvent({ eventId: 'inv06-1', seq: 1 }))).appliedSeq).toBe(1)
  })
})

describe('M6 JSONL export (FR-06)', () => {
  it('carries event version attribution', async () => {
    const store = createEventStore()
    await store.append(
      fixtureRuntimeEvent({ eventId: 'evt-version', seq: 1, versions: { persona: 'testvtb@1' } }),
    )
    const jsonl = await store.exportJsonl(FIXTURE_SESSION_ID)
    expect(jsonl).toContain('"persona":"testvtb@1"')
  })
})
