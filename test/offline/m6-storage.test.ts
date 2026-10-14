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
        history: createHistoryQuery(backend),
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
        history: faulty.createFaultyHistoryQuery({
          storedDeliveries: () => store.deliveries.map((record) => ({ record, eventSeq: 0 })),
        }),
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

describe('M6 event identity is session-scoped (C-23)', () => {
  it('stores the same event id in two sessions independently', async () => {
    const store = createEventStore()
    const shared = { eventId: 'evt-shared', seq: 1 }
    const sessionA = 'session-alpha'
    const sessionB = 'session-beta'

    const ackA = await store.append(fixtureRuntimeEvent({ ...shared, sessionId: sessionA }))
    const ackB = await store.append(fixtureRuntimeEvent({ ...shared, sessionId: sessionB }))
    expect(ackA.outcome).toBe('stored')
    expect(ackB.outcome).toBe('stored')

    expect((await store.readSession(sessionA)).map((event) => event.eventId)).toEqual(['evt-shared'])
    expect((await store.readSession(sessionB)).map((event) => event.eventId)).toEqual(['evt-shared'])

    const jsonlA = await store.exportJsonl(sessionA)
    const jsonlB = await store.exportJsonl(sessionB)
    expect(jsonlA).toContain('"sessionId":"session-alpha"')
    expect(jsonlB).toContain('"sessionId":"session-beta"')
    expect(jsonlA).not.toContain('session-beta')
    expect(jsonlB).not.toContain('session-alpha')
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
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
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

    const history = createHistoryQuery(backend)
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.text)).toEqual(['spoken'])
  })

  it('returns supporting-event seq order even when insertion order differs (C-25)', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    // Commit a later supporting-event seq first, then an earlier one.
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 't-late', segmentId: 's-late', textHash: 'h-late', text: 'late' }),
      fixtureRuntimeEvent({ eventId: 'evt-late', seq: 5, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't-early',
        segmentId: 's-early',
        textHash: 'h-early',
        text: 'early',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-early', seq: 2, type: 'delivery.committed' }),
    )

    const history = createHistoryQuery(backend)
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.text)).toEqual(['early', 'late'])
  })

  it('does not duplicate history when an identical delivery is committed twice', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const delivery = fixtureCommitDelivery({ turnId: 't1', segmentId: 's1', textHash: 'h1', text: 'spoken' })
    await store.commitDeliveryWithEvent(
      delivery,
      fixtureRuntimeEvent({ eventId: 'e1', seq: 1, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      delivery,
      fixtureRuntimeEvent({ eventId: 'e2', seq: 2, type: 'delivery.committed' }),
    )

    const history = createHistoryQuery(backend)
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed).toHaveLength(1)
  })
})

describe('M6 record isolation (C-24)', () => {
  it('an input mutation after commit cannot change committed events', async () => {
    const store = createEventStore()
    const event = fixtureRuntimeEvent({ eventId: 'iso-1', seq: 1 })
    await store.append(event)
    // Mutate the original input object after it was committed.
    ;(event.payload as Record<string, unknown>).injected = true

    const [stored] = await store.readSession(FIXTURE_SESSION_ID)
    expect(stored?.payload).toEqual({})
    expect(await store.exportJsonl(FIXTURE_SESSION_ID)).not.toContain('injected')
  })

  it('a returned record mutation cannot change committed state', async () => {
    const store = createEventStore()
    await store.append(fixtureRuntimeEvent({ eventId: 'iso-2', seq: 1 }))

    const [returned] = await store.readSession(FIXTURE_SESSION_ID)
    ;(returned!.payload as Record<string, unknown>).injected = true

    const [again] = await store.readSession(FIXTURE_SESSION_ID)
    expect(again?.payload).toEqual({})
    expect(await store.exportJsonl(FIXTURE_SESSION_ID)).not.toContain('injected')
  })

  it('a replayed record mutation cannot change committed state', async () => {
    const store = createEventStore()
    await store.append(fixtureRuntimeEvent({ eventId: 'iso-4', seq: 1 }))

    const archive = await createReplayReader(store).load(FIXTURE_SESSION_ID)
    ;(archive.events[0]!.payload as Record<string, unknown>).injected = true

    const [again] = await store.readSession(FIXTURE_SESSION_ID)
    expect(again?.payload).toEqual({})
    expect(await store.exportJsonl(FIXTURE_SESSION_ID)).not.toContain('injected')
  })

  it('a returned delivery mutation cannot change confirmed history', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'iso-t', segmentId: 'iso-s', textHash: 'iso-h', text: 'spoken' }),
      fixtureRuntimeEvent({ eventId: 'iso-3', seq: 1, type: 'delivery.committed' }),
    )

    const history = createHistoryQuery(backend)
    const first = await history.confirmedHistory(FIXTURE_SESSION_ID)
    first[0]!.text = 'tampered'

    const second = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(second[0]?.text).toBe('spoken')
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

  it('INV-05: a later mutation that cannot be published leaves no partial state', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)

    // A payload that cannot be structurally cloned makes the *event* mutation
    // unpublishable. The delivery mutation precedes it in the batch, so it must
    // not be published either.
    const uncopyable = fixtureRuntimeEvent({
      eventId: 'inv05-bad',
      seq: 1,
      type: 'delivery.committed',
      payload: { uncopyable: () => 1 },
    })

    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'inv05-t',
        segmentId: 'inv05-s',
        textHash: 'inv05-h',
        text: 'nope',
      }),
      uncopyable,
    )

    expect(ack.delivery.status).toBe('failed')
    expect(ack.event.outcome).toBe('failed')
    // No partial state in any view: no event and no confirmed-history record.
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    // No residue: the failed batch left the backend usable and the sequence free.
    const retry = await store.append(fixtureRuntimeEvent({ eventId: 'inv05-retry', seq: 1 }))
    expect(retry.outcome).toBe('stored')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(1)
  })

  it('INV-05: the backend publishes a batch only when every mutation is prepared', () => {
    const backend = createInMemoryBackend()
    const good: StorageMutation = {
      kind: 'event',
      event: fixtureRuntimeEvent({ eventId: 'ok-1', seq: 1 }),
    }
    const bad: StorageMutation = {
      kind: 'event',
      event: fixtureRuntimeEvent({
        eventId: 'bad-1',
        seq: 2,
        payload: { uncopyable: () => 1 },
      }),
    }

    // The whole batch fails even though the earlier mutation is valid.
    expect(() => backend.commit([good, bad])).toThrow()
    expect(backend.sessionEvents(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(backend.sequenceOwner(FIXTURE_SESSION_ID, 1)).toBeUndefined()
    // Nothing leaked: a later valid commit still works.
    backend.commit([good])
    expect(backend.sessionEvents(FIXTURE_SESSION_ID)).toHaveLength(1)
  })

  it('INV-06: the memory projection does not advance across a gap and is idempotent', async () => {
    const projection = createMemoryProjection()
    expect((await projection.apply(fixtureRuntimeEvent({ eventId: 'inv06-2', seq: 2 }))).appliedSeq).toBe(0)
    expect((await projection.apply(fixtureRuntimeEvent({ eventId: 'inv06-1', seq: 1 }))).appliedSeq).toBe(1)
    expect((await projection.apply(fixtureRuntimeEvent({ eventId: 'inv06-1', seq: 1 }))).appliedSeq).toBe(1)
  })
})

describe('M6 atomic commit failure causes (C-39)', () => {
  it('reports a conflict (not a storage failure) when the supporting event id is reused with changed content', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    await store.append(fixtureRuntimeEvent({ eventId: 'cause-1', seq: 1 }))

    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'cause-t',
        segmentId: 'cause-s',
        textHash: 'cause-h',
        text: 'x',
      }),
      fixtureRuntimeEvent({ eventId: 'cause-1', seq: 1, type: 'delivery.committed' }),
    )

    expect(ack.delivery.status).toBe('failed')
    if (ack.delivery.status === 'failed') expect(ack.delivery.reasonCode).toBe('conflict')
    expect(ack.event.outcome).toBe('failed')
    if (ack.event.outcome === 'failed') expect(ack.event.reasonCode).toBe('conflict')
    // A conflicting commit persists nothing and preserves the existing event.
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    const session = await store.readSession(FIXTURE_SESSION_ID)
    expect(session).toHaveLength(1)
    expect(session[0]?.eventId).toBe('cause-1')
    expect(session[0]?.type).toBe('input.accepted')
  })

  it('reports a conflict on both sides when the supporting event reuses a session sequence', async () => {
    const store = createEventStore()
    await store.append(fixtureRuntimeEvent({ eventId: 'cause-seq-a', seq: 1 }))

    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'cause-t2',
        segmentId: 'cause-s2',
        textHash: 'cause-h2',
        text: 'y',
      }),
      fixtureRuntimeEvent({ eventId: 'cause-seq-b', seq: 1, type: 'delivery.committed' }),
    )

    expect(ack.delivery.status).toBe('failed')
    if (ack.delivery.status === 'failed') expect(ack.delivery.reasonCode).toBe('conflict')
    expect(ack.event.outcome).toBe('failed')
    if (ack.event.outcome === 'failed') expect(ack.event.reasonCode).toBe('conflict')
  })
})

describe('M6 content equality is key-order insensitive (C-40, C-41)', () => {
  it('treats an event with the same content in a different key order as a duplicate', async () => {
    const store = createEventStore()
    await store.append(
      fixtureRuntimeEvent({ eventId: 'eq-1', seq: 1, payload: { a: 1, b: { x: 1, y: 2 } } }),
    )

    // Same logical content; payload keys (including nested) written in another order.
    const reordered = fixtureRuntimeEvent({
      eventId: 'eq-1',
      seq: 1,
      payload: { b: { y: 2, x: 1 }, a: 1 },
    })
    expect((await store.append(reordered)).outcome).toBe('duplicate')

    // A genuinely different (nested) payload is still a conflict.
    const changed = fixtureRuntimeEvent({
      eventId: 'eq-1',
      seq: 1,
      payload: { a: 1, b: { x: 1, y: 3 } },
    })
    expect((await store.append(changed)).outcome).toBe('failed')
  })

  it('keeps array order significant and compares non-plain values by content', async () => {
    const store = createEventStore()
    await store.append(
      fixtureRuntimeEvent({
        eventId: 'eq-2',
        seq: 1,
        payload: { at: new Date(0), tags: ['a', 'b'] },
      }),
    )

    // Different key order, same array order, same Date -> duplicate.
    expect(
      (
        await store.append(
          fixtureRuntimeEvent({
            eventId: 'eq-2',
            seq: 1,
            payload: { tags: ['a', 'b'], at: new Date(0) },
          }),
        )
      ).outcome,
    ).toBe('duplicate')

    // Array order is significant -> conflict.
    expect(
      (
        await store.append(
          fixtureRuntimeEvent({
            eventId: 'eq-2',
            seq: 1,
            payload: { at: new Date(0), tags: ['b', 'a'] },
          }),
        )
      ).outcome,
    ).toBe('failed')

    // A different Date must be a conflict, not treated as an empty object.
    expect(
      (
        await store.append(
          fixtureRuntimeEvent({
            eventId: 'eq-2',
            seq: 1,
            payload: { at: new Date(1), tags: ['a', 'b'] },
          }),
        )
      ).outcome,
    ).toBe('failed')
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
