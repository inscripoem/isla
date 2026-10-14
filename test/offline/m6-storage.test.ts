import { describe, expect, it } from 'vitest'
import { collectStorageViolations } from '../conformance/storage.conformance'
import * as faulty from '../support/faulty-ports'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'
import {
  canonicalJson,
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

    // A payload that is not a JSON value is rejected before publication. The
    // delivery mutation is in the same batch, so it must not be published either.
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
    if (ack.delivery.status === 'failed') {
      expect(ack.delivery.reasonCode).toBe('unsupported_payload')
    }
    expect(ack.event.outcome).toBe('failed')
    if (ack.event.outcome === 'failed') expect(ack.event.reasonCode).toBe('unsupported_payload')
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

  it('keeps array order significant', async () => {
    const store = createEventStore()
    await store.append(
      fixtureRuntimeEvent({ eventId: 'eq-2', seq: 1, payload: { tags: ['a', 'b'], n: 1 } }),
    )

    // Different key order, same array order -> duplicate.
    expect(
      (
        await store.append(
          fixtureRuntimeEvent({ eventId: 'eq-2', seq: 1, payload: { n: 1, tags: ['a', 'b'] } }),
        )
      ).outcome,
    ).toBe('duplicate')

    // Array order is significant -> conflict.
    expect(
      (
        await store.append(
          fixtureRuntimeEvent({ eventId: 'eq-2', seq: 1, payload: { tags: ['b', 'a'], n: 1 } }),
        )
      ).outcome,
    ).toBe('failed')

    // A different array length is a conflict too.
    expect(
      (
        await store.append(
          fixtureRuntimeEvent({ eventId: 'eq-2', seq: 1, payload: { tags: ['a'], n: 1 } }),
        )
      ).outcome,
    ).toBe('failed')
  })
})

describe('M6 event payload contract (C-43, C-44)', () => {
  it('rejects an event whose payload is not a JSON value before publication', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)

    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const unsupported: Record<string, unknown>[] = [
      { value: undefined },
      { value: () => 1 },
      { value: Symbol('x') },
      { value: 10n },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date(0) },
      { value: new Map() },
      { value: new Set() },
      { value: { nested: () => 1 } },
      cyclic,
    ]

    for (const [index, payload] of unsupported.entries()) {
      const ack = await store.append(
        fixtureRuntimeEvent({ eventId: `unsup-${index}`, seq: index + 1, payload }),
      )
      expect(ack.outcome).toBe('failed')
      if (ack.outcome === 'failed') expect(ack.reasonCode).toBe('unsupported_payload')
    }
    // Nothing was persisted.
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)

    // The same rule applies to the delivery path, and stays atomic.
    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'unsup-t',
        segmentId: 'unsup-s',
        textHash: 'unsup-h',
        text: 'x',
      }),
      fixtureRuntimeEvent({
        eventId: 'unsup-del',
        seq: 50,
        type: 'delivery.committed',
        payload: { value: () => 1 },
      }),
    )
    expect(ack.delivery.status).toBe('failed')
    if (ack.delivery.status === 'failed') expect(ack.delivery.reasonCode).toBe('unsupported_payload')
    expect(ack.event.outcome).toBe('failed')
    if (ack.event.outcome === 'failed') expect(ack.event.reasonCode).toBe('unsupported_payload')
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
  })

  it('does not treat a sparse array payload as an empty array', async () => {
    const store = createEventStore()

    // A one-hole array has no JSON representation of its hole, so it is rejected
    // (it must not be stored, and must not be confused with `[]`).
    const sparse = await store.append(
      fixtureRuntimeEvent({ eventId: 'hole-1', seq: 1, payload: { value: Array(1) } }),
    )
    expect(sparse.outcome).toBe('failed')
    if (sparse.outcome === 'failed') expect(sparse.reasonCode).toBe('unsupported_payload')

    // Reusing the identity with an empty array is therefore stored, not a duplicate.
    const empty = await store.append(
      fixtureRuntimeEvent({ eventId: 'hole-1', seq: 1, payload: { value: [] } }),
    )
    expect(empty.outcome).toBe('stored')

    // An explicit array of nulls is a JSON value and stays distinct from `[]`.
    const nulls = await store.append(
      fixtureRuntimeEvent({ eventId: 'hole-2', seq: 2, payload: { value: [null] } }),
    )
    expect(nulls.outcome).toBe('stored')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(2)

    // Defence in depth: the comparator itself never conflates a hole with `[]`.
    expect(canonicalJson({ value: Array(1) })).not.toBe(canonicalJson({ value: [] }))
    expect(canonicalJson({ value: [null] })).not.toBe(canonicalJson({ value: [] }))
  })
})

describe('M6 storage integration (through the ports)', () => {
  it('drives a session end-to-end and stays consistent across every view', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const replay = createReplayReader(store)
    const projection = createMemoryProjection()

    // Accepted payloads, including equal content in a different key order.
    await store.append(
      fixtureRuntimeEvent({ eventId: 'i-1', seq: 1, payload: { a: 1, b: [1, 2] } }),
    )
    await store.append(
      fixtureRuntimeEvent({ eventId: 'i-2', seq: 2, payload: { b: [1, 2], a: 1 } }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 't1', segmentId: 's1', textHash: 'h1', text: 'spoken' }),
      fixtureRuntimeEvent({ eventId: 'i-3', seq: 3, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't2',
        segmentId: 's2',
        textHash: 'h2',
        text: 'unspoken',
        classification: 'not-delivered',
      }),
      fixtureRuntimeEvent({ eventId: 'i-4', seq: 4, type: 'delivery.committed' }),
    )

    // A rejected payload must leave every view unchanged.
    const before = await store.readSession(FIXTURE_SESSION_ID)
    await store.append(
      fixtureRuntimeEvent({ eventId: 'i-bad', seq: 99, payload: { bad: () => 1 } }),
    )

    const events = await store.readSession(FIXTURE_SESSION_ID)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(events).toEqual(before)

    // Export agrees with the committed events, one JSON object per line.
    const lines = (await store.exportJsonl(FIXTURE_SESSION_ID)).split('\n')
    expect(lines).toHaveLength(events.length)
    expect(lines[0]).toBe(JSON.stringify(events[0]))

    // Replay is an isolated view that matches committed state and does not mutate it.
    const archive = await replay.load(FIXTURE_SESSION_ID)
    expect(archive.events).toEqual(events)
    expect(await store.readSession(FIXTURE_SESSION_ID)).toEqual(events)

    // Confirmed history excludes non-delivered records.
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.text)).toEqual(['spoken'])

    // The projection advances one event at a time and refuses a gap.
    expect((await projection.apply(events[0]!)).appliedSeq).toBe(1)
    expect((await projection.apply(events[2]!)).appliedSeq).toBe(1)
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
