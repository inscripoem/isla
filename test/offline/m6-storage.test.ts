import { describe, expect, it } from 'vitest'
import {
  collectAtomicFailureViolations,
  collectStorageViolations,
} from '../conformance/storage.conformance'
import type { StorageKit } from '../conformance/storage.conformance'
import { runtimeEventSchema } from '../../src/contracts'
import type { CommitDelivery, MemoryProjectionPort, RuntimeEvent } from '../../src/contracts'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureRuntimeEvent,
} from '../support/fixture-data'
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

const uncopyableEvent = (overrides: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  fixtureRuntimeEvent({
    eventId: 'evt-uncopyable',
    seq: 50,
    type: 'delivery.committed',
    payload: { uncopyable: () => 1 },
    ...overrides,
  })

function inspectionOf(store: correct.FixtureEventStore) {
  return {
    events: () => store.events,
    deliveries: () => store.deliveries,
    storedDeliveries: () => store.storedDeliveries(),
  }
}

/** Fixture kit for the conformance suite; one port can be swapped per focused test. */
function correctKit(options: { store?: correct.FixtureEventStore } = {}): StorageKit {
  const store = options.store ?? correct.createFixtureEventStore()
  return {
    store,
    projection: correct.createFixtureMemoryProjection(),
    history: correct.createFixtureHistoryQuery(store),
    replay: correct.createFixtureReplayReader(store),
    inspection: inspectionOf(store),
    setFailNextCommit: () => {
      store.failNextCommit = true
    },
  }
}

/** Kit backed by the real M6 in-memory store through its persistence seam. */
function actualM6Kit(): StorageKit {
  const { backend, failNextCommit } = createFailingBackend()
  const store = createEventStore(backend)
  return {
    store,
    projection: createMemoryProjection(),
    history: createHistoryQuery(backend),
    replay: createReplayReader(store),
    setFailNextCommit: failNextCommit,
  }
}

describe('M6 storage conformance', () => {
  it('accepts the real M6 in-memory store, projection, history and replay', async () => {
    const violations = await collectStorageViolations(() => actualM6Kit())
    expect(violations).toEqual([])
  })

  it('accepts the correct store, projection, history, replay and detached views', async () => {
    const violations = await collectStorageViolations(() => correctKit())
    expect(violations).toEqual([])
  })

  it('rejects a faulty store and projection', async () => {
    const violations = await collectStorageViolations(() => {
      const store = faulty.createFaultyEventStore()
      return {
        store: store.store,
        projection: faulty.createFaultyMemoryProjection(),
        history: faulty.createFaultyHistoryQuery(store),
        replay: faulty.createFaultyReplayReader(store.store),
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
    expect(codes).toContain('read-isolation')
    expect(codes).toContain('history-ordered')
  })

  it('detects session-blind, mutable and unordered storage faults', async () => {
    const violations = await collectStorageViolations(() => faulty.createFaultySharedStorageKit())
    const codes = violations.map((violation) => violation.code)
    for (const code of [
      'append-session-independent',
      'read-session-independent',
      'export-session-independent',
      'commit-session-independent',
      'append-input-detached',
      'commit-event-input-detached',
      'read-result-detached',
      'replay-result-detached',
      'commit-input-detached',
      'history-result-detached',
      'history-ordered-by-event-seq',
      'history-dedup',
      'history-excludes-unconfirmed',
      'history-session-independent',
    ]) {
      expect(codes).toContain(code)
    }
  })

  it('detects a non-live confirmed-history snapshot', async () => {
    const violations = await collectStorageViolations(() =>
      faulty.createFaultySharedStorageKit({ snapshotHistory: true }),
    )
    expect(violations.map((violation) => violation.code)).toContain('history-live')
  })
})

describe('M6 focused negative adapters', () => {
  it('detects an empty replay archive', async () => {
    const violations = await collectStorageViolations(() => {
      const kit = correctKit()
      return { ...kit, replay: faulty.createEmptyReplayReader() }
    })
    expect(violations.map((violation) => violation.code)).toContain('replay-contains-committed')
  })

  it('detects a JSONL export with the wrong session content', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createWrongExportEventStore(store, 'session-elsewhere') }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('export-session-independent')
    expect(codes).toContain('export-read-consistent')
  })

  it('detects insertion-ordered confirmed history', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, history: faulty.createInsertionOrderedHistoryQuery(store) }
    })
    expect(violations.map((violation) => violation.code)).toContain('history-ordered-by-event-seq')
  })
})

describe('M6 delivery attribution conformance', () => {
  it('detects a store that drops the delivery attribution on write', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createAttributionDroppingEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('attribution-round-trip')
    expect(codes).toContain('attribution-conflict-index')
    expect(codes).toContain('attribution-conflict-version')
    expect(codes).toContain('attribution-conflict-preserves-original')
  })

  it('detects a store that fabricates the delivery attribution on write', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createAttributionFabricatingEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('attribution-round-trip')
    expect(codes).toContain('attribution-null-preserved')
  })

  it('rejects an omitted required attribution field without partial mutation (real M6)', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)

    const omitted: Record<string, unknown> = {
      ...fixtureCommitDelivery({
        turnId: 'turn-invalid-delivery',
        segmentId: 'segment-invalid-delivery',
        textHash: 'hash-invalid-delivery',
        text: 'invalid-delivery-spoken',
      }),
    }
    delete omitted['segmentIndex']

    const ack = await store.commitDeliveryWithEvent(
      omitted as unknown as CommitDelivery,
      fixtureRuntimeEvent({
        eventId: 'evt-invalid-delivery',
        seq: 1,
        type: 'delivery.committed',
      }),
    )

    expect(ack.delivery.status).toBe('failed')
    expect(ack.event.outcome).toBe('failed')
    // The rejected delivery leaves no partial event, record or history behind.
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
  })

  it('detects a store that ignores an omitted required attribution field', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createAttributionDroppingEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('attribution-omitted-rejected:segmentIndex')
    expect(codes).toContain('attribution-omitted-rejected:personaProfileId')
    expect(codes).toContain('attribution-omitted-rejected:personaProfileVersion')
  })

  it('detects state persisted behind a rejected acknowledgement', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      // This adapter persists both the delivery and its supporting event after a
      // rejected acknowledgement; it is not a record-only orphan.
      return { ...kit, store: faulty.createPersistDespiteRejectionEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('attribution-omitted-no-partial:segmentIndex')
    // The published state also consumes the identity, so the retry cannot apply.
    expect(codes).toContain('attribution-omitted-retry:segmentIndex')
  })

  it('detects a partial event left behind a rejected delivery', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createPartialEventOnRejectedDeliveryEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('attribution-omitted-no-partial:segmentIndex')
  })

  it('accepts a valid inspection-only kit', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      return {
        store,
        projection: correct.createFixtureMemoryProjection(),
        // A HistoryQueryPort is deliberately omitted; inspection is the only view.
        inspection: inspectionOf(store),
        replay: correct.createFixtureReplayReader(store),
        setFailNextCommit: () => {
          store.failNextCommit = true
        },
      }
    })
    expect(violations).toEqual([])
  })

  it('detects an attribution fault visible only through the inspection view', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      return {
        store: faulty.createAttributionDroppingEventStore(store),
        projection: correct.createFixtureMemoryProjection(),
        // No HistoryQueryPort: only the inspection view can reveal the fault.
        inspection: inspectionOf(store),
        replay: correct.createFixtureReplayReader(store),
        setFailNextCommit: () => {
          store.failNextCommit = true
        },
      }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('attribution-stored')
    expect(codes).toContain('attribution-omitted-retry-attribution:segmentIndex')
    expect(codes).toContain('attribution-conflict-preserves-original')
  })

  it('reports a missing read view instead of a silent full pass', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      return {
        store,
        projection: correct.createFixtureMemoryProjection(),
        replay: correct.createFixtureReplayReader(store),
        // Deliberately neither a HistoryQueryPort nor an inspection view.
      }
    })
    expect(violations.map((violation) => violation.code)).toEqual([
      'attribution-read-view-missing',
    ])
  })
})

describe('M6 delivery boundary conformance', () => {
  it('rejects an inconsistent classification/terminalOutcome pair with no residue (real M6)', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-bad-combination',
        segmentId: 'segment-bad-combination',
        textHash: 'hash-bad-combination',
        text: 'bad-combination',
        classification: 'fully-delivered',
        terminalOutcome: 'failed',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-bad-combination', seq: 1, type: 'delivery.committed' }),
    )
    expect(ack.delivery.status).toBe('failed')
    expect(ack.event.outcome).toBe('failed')
    if (ack.delivery.status === 'failed') expect(ack.delivery.reasonCode).toBe('invalid_delivery')
    if (ack.event.outcome === 'failed') expect(ack.event.reasonCode).toBe('invalid_delivery')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
  })

  it('rejects contradictory known provenance as one paired failure (real M6)', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-bad-provenance',
        segmentId: 'segment-bad-provenance',
        textHash: 'hash-bad-provenance',
        text: 'bad-provenance',
        personaProfileId: 'persona-a',
        personaProfileVersion: '1',
      }),
      fixtureRuntimeEvent({
        eventId: 'evt-bad-provenance',
        seq: 1,
        type: 'delivery.committed',
        versions: { personaProfileId: 'persona-b', personaProfileVersion: '1' },
      }),
    )
    expect(ack.delivery.status).toBe('failed')
    expect(ack.event.outcome).toBe('failed')
    if (ack.delivery.status === 'failed') expect(ack.delivery.reasonCode).toBe('inconsistent_delivery')
    if (ack.event.outcome === 'failed') expect(ack.event.reasonCode).toBe('inconsistent_delivery')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(0)
  })

  it('detects a store that bypasses the classification/outcome combination', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createCombinationNormalizingEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('delivery-invalid-combination:fully-delivered-failed')
    expect(codes).toContain('delivery-invalid-combination:not-delivered-completed')
  })

  it('detects a store that ignores contradictory provenance and correlation', async () => {
    const violations = await collectStorageViolations(() => {
      const store = correct.createFixtureEventStore()
      const kit = correctKit({ store })
      return { ...kit, store: faulty.createProvenanceIgnoringEventStore(store) }
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('delivery-correlation:sessionId:rejected')
    expect(codes).toContain('delivery-correlation:personaProfileId:rejected')
  })
})

describe('M6 storage focused follow-up', () => {
  it('scopes event identity, reads and JSONL exports by session', async () => {
    const store = correct.createFixtureEventStore()
    const shared = { eventId: 'evt-shared', seq: 1 }
    const alpha = 'session-alpha'
    const beta = 'session-beta'

    expect((await store.append(fixtureRuntimeEvent({ ...shared, sessionId: alpha }))).outcome).toBe('stored')
    expect((await store.append(fixtureRuntimeEvent({ ...shared, sessionId: beta }))).outcome).toBe('stored')

    const readAlpha = await store.readSession(alpha)
    const readBeta = await store.readSession(beta)
    expect(readAlpha.map((event) => event.sessionId)).toEqual([alpha])
    expect(readBeta.map((event) => event.sessionId)).toEqual([beta])
    expect(await store.exportJsonl(alpha)).not.toContain(beta)
    expect(await store.exportJsonl(beta)).not.toContain(alpha)
  })

  it('detaches nested payloads of appended, atomic, read and replayed events', async () => {
    const store = correct.createFixtureEventStore()
    const input = fixtureRuntimeEvent({
      eventId: 'evt-detach',
      seq: 1,
      payload: { nested: { value: 'original' } },
    })
    await store.append(input)
    ;(input.payload as { nested: { value: string } }).nested.value = 'mutated-input'

    const atomicEvent = fixtureRuntimeEvent({
      eventId: 'evt-atomic',
      seq: 2,
      type: 'delivery.committed',
      payload: { nested: { value: 'original-atomic' } },
    })
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'turn-atomic', segmentId: 'seg-atomic', textHash: 'hash-atomic', text: 'atomic-spoken' }),
      atomicEvent,
    )
    ;(atomicEvent.payload as { nested: { value: string } }).nested.value = 'mutated-atomic'

    const read = (await store.readSession(FIXTURE_SESSION_ID)).find((event) => event.eventId === 'evt-detach')!
    ;(read.payload as { nested: { value: string } }).nested.value = 'mutated-read'

    const archive = await correct.createFixtureReplayReader(store).load(FIXTURE_SESSION_ID)
    ;(archive.events[0]!.payload as { nested: { value: string } }).nested.value = 'mutated-replay'

    const committed = await store.readSession(FIXTURE_SESSION_ID)
    expect((committed.find((event) => event.eventId === 'evt-detach')!.payload as { nested: { value: string } }).nested.value).toBe('original')
    expect((committed.find((event) => event.eventId === 'evt-atomic')!.payload as { nested: { value: string } }).nested.value).toBe('original-atomic')
    expect(await store.exportJsonl(FIXTURE_SESSION_ID)).not.toContain('mutated')
  })

  it('keeps inspection views detached from committed arrays and records', async () => {
    const store = correct.createFixtureEventStore()
    await store.append(fixtureRuntimeEvent({ eventId: 'evt-view', seq: 1 }))

    const eventsView = store.events
    const eventCount = eventsView.length
    eventsView[0]!.type = 'mutated-view'
    eventsView.push(fixtureRuntimeEvent({ eventId: 'evt-view-injected', seq: 99 }))
    expect(store.events.length).toBe(eventCount)
    expect((await store.readSession(FIXTURE_SESSION_ID)).every((event) => event.type !== 'mutated-view')).toBe(true)

    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'turn-view', segmentId: 'seg-view', textHash: 'hash-view', text: 'view-spoken' }),
      fixtureRuntimeEvent({ eventId: 'evt-view-commit', seq: 2, type: 'delivery.committed' }),
    )
    const deliveriesView = store.deliveries
    deliveriesView[0]!.text = 'mutated-view-delivery'
    expect(store.deliveries.every((delivery) => delivery.text !== 'mutated-view-delivery')).toBe(true)

    const storedView = store.storedDeliveries()
    storedView[0]!.record.text = 'mutated-stored'
    storedView[0]!.eventSeq = -1
    expect(store.storedDeliveries()).toEqual([
      expect.objectContaining({ eventSeq: 2, record: expect.objectContaining({ text: 'view-spoken' }) }),
    ])
  })

  it('returns live confirmed history ordered by supporting-event seq without duplicates', async () => {
    const store = correct.createFixtureEventStore()
    const history = correct.createFixtureHistoryQuery(store)
    const commit = (turnId: string, eventId: string, seq: number, overrides = {}) =>
      store.commitDeliveryWithEvent(
        fixtureCommitDelivery({ turnId, segmentId: `${turnId}-seg`, textHash: `hash-${turnId}`, text: `${turnId}-text`, ...overrides }),
        fixtureRuntimeEvent({ eventId, seq, type: 'delivery.committed' }),
      )

    await commit('late', 'evt-late', 5)
    await commit('early', 'evt-early', 2)
    expect((await history.confirmedHistory(FIXTURE_SESSION_ID)).map((record) => record.turnId)).toEqual(['early', 'late'])

    const first = await commit('dup', 'evt-dup-1', 6)
    const second = await commit('dup', 'evt-dup-2', 7)
    expect(first.delivery.status).toBe('applied')
    expect(second.delivery.status).toBe('duplicate')

    await commit('unspoken', 'evt-unspoken', 8, { classification: 'not-delivered', terminalOutcome: 'failed' })
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.turnId)).toEqual(['early', 'late', 'dup'])
    expect(confirmed.filter((record) => record.turnId === 'dup')).toHaveLength(1)
    expect(confirmed.every((record) => record.classification === 'fully-delivered')).toBe(true)

    const before = confirmed.length
    await commit('live', 'evt-live', 9)
    expect((await history.confirmedHistory(FIXTURE_SESSION_ID))).toHaveLength(before + 1)
  })
})

describe('M6 atomic preparation failure regression', () => {
  it('reports a failed acknowledgement and publishes nothing when a batch cannot prepare', async () => {
    const store = correct.createFixtureEventStore()
    const history = correct.createFixtureHistoryQuery(store)
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-preserved',
        segmentId: 'seg-preserved',
        textHash: 'hash-preserved',
        text: 'preserved-spoken',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-preserved', seq: 10, type: 'delivery.committed' }),
    )

    const eventsBefore = await store.readSession(FIXTURE_SESSION_ID)
    const deliveriesBefore = store.deliveries
    const historyBefore = await history.confirmedHistory(FIXTURE_SESSION_ID)
    const exportBefore = await store.exportJsonl(FIXTURE_SESSION_ID)
    expect(historyBefore.some((record) => record.turnId === 'turn-preserved')).toBe(true)

    // The reproduction input is schema-valid; only its function payload cannot
    // be structurally copied. The invariant under test is that a batch which
    // cannot fully commit leaves no partial state behind.
    const failedEvent = uncopyableEvent()
    expect(runtimeEventSchema.safeParse(failedEvent).success).toBe(true)

    const failed = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-failed',
        segmentId: 'seg-failed',
        textHash: 'hash-failed',
        text: 'failed-spoken',
      }),
      failedEvent,
    )

    expect(failed.delivery.status).toBe('failed')
    expect(failed.event.outcome).toBe('failed')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toEqual(eventsBefore)
    expect(store.deliveries).toEqual(deliveriesBefore)
    expect(await history.confirmedHistory(FIXTURE_SESSION_ID)).toEqual(historyBefore)
    expect(await store.exportJsonl(FIXTURE_SESSION_ID)).toBe(exportBefore)
  })

  it('applies a later valid retry with the same identity and sequence without orphaning or duplicating', async () => {
    const store = correct.createFixtureEventStore()
    const history = correct.createFixtureHistoryQuery(store)
    const delivery = fixtureCommitDelivery({
      turnId: 'turn-retry',
      segmentId: 'seg-retry',
      textHash: 'hash-retry',
      text: 'retry-spoken',
    })
    const identity = { eventId: 'evt-retry', seq: 60, type: 'delivery.committed' } as const

    const failed = await store.commitDeliveryWithEvent(delivery, uncopyableEvent(identity))
    expect(failed.delivery.status).toBe('failed')
    expect(failed.event.outcome).toBe('failed')

    const applied = await store.commitDeliveryWithEvent(delivery, fixtureRuntimeEvent(identity))
    expect(applied.delivery.status).toBe('applied')
    expect(applied.event.outcome).toBe('stored')
    expect((await store.readSession(FIXTURE_SESSION_ID)).filter((event) => event.eventId === 'evt-retry')).toHaveLength(1)
    expect((await history.confirmedHistory(FIXTURE_SESSION_ID)).filter((record) => record.turnId === 'turn-retry')).toHaveLength(1)
  })

  it('reports an append preparation failure without publishing or throwing', async () => {
    const store = correct.createFixtureEventStore()
    const before = await store.readSession(FIXTURE_SESSION_ID)
    const ack = await store.append(uncopyableEvent())
    expect(ack.outcome).toBe('failed')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toEqual(before)
  })

  it('keeps explicit throw controls throwing before publication', async () => {
    const store = correct.createFixtureEventStore()
    store.throwNextAppend = true
    await expect(store.append(fixtureRuntimeEvent())).rejects.toThrow('fixture append throw')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toEqual([])

    store.throwNextCommit = true
    await expect(
      store.commitDeliveryWithEvent(
        fixtureCommitDelivery(),
        fixtureRuntimeEvent({ eventId: 'evt-throw', seq: 2, type: 'delivery.committed' }),
      ),
    ).rejects.toThrow('fixture commit throw')
    expect(await store.readSession(FIXTURE_SESSION_ID)).toEqual([])
    expect(store.deliveries).toEqual([])
  })

  it('still applies acknowledgement mutators to a preparation-failure ack', async () => {
    const store = correct.createFixtureEventStore()
    store.mutateCommitAck = (ack) => ({ ...ack, event: { ...ack.event, message: 'mutated-commit-prep' } })
    const failed = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery(),
      uncopyableEvent({ eventId: 'evt-mutate', seq: 70 }),
    )
    expect(failed.event.outcome).toBe('failed')
    expect(failed.event).toMatchObject({ message: 'mutated-commit-prep' })

    store.mutateAppendAck = (ack) => ({ ...ack, message: 'mutated-append-prep' })
    const ack = await store.append(uncopyableEvent({ eventId: 'evt-mutate-append', seq: 71 }))
    expect(ack).toMatchObject({ outcome: 'failed', message: 'mutated-append-prep' })
  })

  it('contains a partial-publish adapter even with live inspection arrays', async () => {
    const kit = faulty.createThrowAfterDeliveryEventStore()
    const violations = await collectAtomicFailureViolations({
      store: kit.store,
      history: faulty.createFaultyHistoryQuery(kit),
      // Deliberately live views: the probe must snapshot baselines itself, so a
      // faulty adapter cannot rewrite the expected pre-failure state.
      inspection: {
        events: () => kit.events,
        deliveries: () => kit.deliveries,
        storedDeliveries: () => kit.storedDeliveries(),
      },
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('atomic-failure-no-partial-history')
    expect(codes).toContain('atomic-failure-no-partial-delivery')
    expect(codes).toContain('atomic-retry-no-orphan')
  })

  it('reports an accepted commit as a failure not induced', async () => {
    const store = faulty.createFaultyEventStore()
    const violations = await collectAtomicFailureViolations({ store: store.store })
    expect(violations.map((violation) => violation.code)).toContain('atomic-failure-not-induced')
  })

  it('accepts a clean failure that throws before publishing anything', async () => {
    const store = correct.createFixtureEventStore()
    const violations = await collectAtomicFailureViolations({
      store,
      induceFailure: () => {
        store.throwNextCommit = true
      },
    })
    expect(violations).toEqual([])
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
        terminalOutcome: 'cancelled',
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
        terminalOutcome: 'failed',
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
    expect(projection.appliedSeq()).toBe(1)
  })

  it('C-66: keeps the projection bookmark independent per session', async () => {
    const projection = createMemoryProjection()
    const sessionA = 'session-c66-a'
    const sessionB = 'session-c66-b'
    const apply = (sessionId: string, seq: number, eventId: string) =>
      projection.apply(fixtureRuntimeEvent({ sessionId, seq, eventId }))

    expect((await apply(sessionA, 1, 'c66-a-1')).appliedSeq).toBe(1)
    expect((await apply(sessionA, 2, 'c66-a-2')).appliedSeq).toBe(2)

    // B starts from 0: its own seq 2 is a gap, then seq 1 applies normally.
    expect((await apply(sessionB, 2, 'c66-b-2')).appliedSeq).toBe(0)
    expect((await apply(sessionB, 1, 'c66-b-1')).appliedSeq).toBe(1)

    // A remains at 2; B is not changed by A's later idempotent event.
    expect((await apply(sessionA, 1, 'c66-a-1')).appliedSeq).toBe(2)
    expect((await apply(sessionB, 1, 'c66-b-1')).appliedSeq).toBe(1)
  })

  it('C-66 P3: production and fixture scalar getters agree on last attempted session', async () => {
    const runSequence = async (
      projection: MemoryProjectionPort,
      entries: readonly [string, number, string][],
    ): Promise<number> => {
      for (const [sessionId, seq, eventId] of entries) {
        await projection.apply(fixtureRuntimeEvent({ sessionId, seq, eventId }))
      }
      return projection.appliedSeq()
    }

    const gapThenOtherSession: [string, number, string][] = [
      ['session-p3-a', 1, 'p3-a-1'],
      ['session-p3-b', 2, 'p3-b-2'],
    ]
    const lastAttemptedA: [string, number, string][] = [
      ['session-p3-a', 1, 'p3-a-1'],
      ['session-p3-a', 2, 'p3-a-2'],
      ['session-p3-b', 1, 'p3-b-1'],
      ['session-p3-a', 1, 'p3-a-1'],
    ]

    expect(await runSequence(createMemoryProjection(), gapThenOtherSession)).toBe(0)
    expect(await runSequence(correct.createFixtureMemoryProjection(), gapThenOtherSession)).toBe(0)
    expect(await runSequence(createMemoryProjection(), lastAttemptedA)).toBe(2)
    expect(await runSequence(correct.createFixtureMemoryProjection(), lastAttemptedA)).toBe(2)
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
        terminalOutcome: 'failed',
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

describe('M6 delivery attribution and ordering (Step A)', () => {
  it('persists segment index and persona attribution and returns them in confirmed history', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 't-attr', segmentId: 's-attr', textHash: 'h-attr', text: 'attributed', segmentIndex: 1, personaProfileId: 'persona-x', personaProfileVersion: '9' }),
      fixtureRuntimeEvent({ eventId: 'evt-attr', seq: 1, type: 'delivery.committed' }),
    )
    const [record] = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(record?.segmentIndex).toBe(1)
    expect(record?.personaProfileId).toBe('persona-x')
    expect(record?.personaProfileVersion).toBe('9')
  })

  it('conflicts a reused delivery identity with a changed segment index or persona and keeps the original history', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const base = fixtureCommitDelivery({ turnId: 't-conflict', segmentId: 's-conflict', textHash: 'h-conflict', text: 'original', segmentIndex: 0, personaProfileId: 'persona-base', personaProfileVersion: '1' })
    const first = await store.commitDeliveryWithEvent(
      base,
      fixtureRuntimeEvent({ eventId: 'evt-c1', seq: 1, type: 'delivery.committed' }),
    )
    expect(first.delivery.status).toBe('applied')

    const changedIndex = await store.commitDeliveryWithEvent(
      { ...base, segmentIndex: 1 },
      fixtureRuntimeEvent({ eventId: 'evt-c2', seq: 2, type: 'delivery.committed' }),
    )
    expect(changedIndex.delivery.status).toBe('conflict')

    const changedPersona = await store.commitDeliveryWithEvent(
      { ...base, personaProfileId: 'persona-other' },
      fixtureRuntimeEvent({ eventId: 'evt-c3', seq: 3, type: 'delivery.committed' }),
    )
    expect(changedPersona.delivery.status).toBe('conflict')

    const changedVersion = await store.commitDeliveryWithEvent(
      { ...base, personaProfileVersion: '2' },
      fixtureRuntimeEvent({ eventId: 'evt-c4', seq: 4, type: 'delivery.committed' }),
    )
    expect(changedVersion.delivery.status).toBe('conflict')

    // The identical delivery is still an idempotent duplicate, not a rewrite.
    const duplicate = await store.commitDeliveryWithEvent(
      base,
      fixtureRuntimeEvent({ eventId: 'evt-c5', seq: 5, type: 'delivery.committed' }),
    )
    expect(duplicate.delivery.status).toBe('duplicate')

    const confirmed = (await history.confirmedHistory(FIXTURE_SESSION_ID)).filter((record) => record.turnId === 't-conflict')
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]?.segmentIndex).toBe(0)
    expect(confirmed[0]?.personaProfileId).toBe('persona-base')
    expect(confirmed[0]?.personaProfileVersion).toBe('1')
  })

  it('round-trips explicit legacy null attribution without substituting the current persona', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 't-legacy', segmentId: 's-legacy', textHash: 'h-legacy', text: 'legacy', segmentIndex: null, personaProfileId: null, personaProfileVersion: null }),
      fixtureRuntimeEvent({ eventId: 'evt-legacy', seq: 1, type: 'delivery.committed' }),
    )
    const [first] = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(first?.segmentIndex).toBeNull()
    expect(first?.personaProfileId).toBeNull()
    expect(first?.personaProfileVersion).toBeNull()
    // A later query must not backfill the current persona or a fabricated index.
    const [second] = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(second?.segmentIndex).toBeNull()
    expect(second?.personaProfileId).toBeNull()
    expect(second?.personaProfileVersion).toBeNull()
  })

  it('keeps history ordered by supporting-event seq and enables turn reconstruction by explicit segment index', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const commit = (segmentId: string, segmentIndex: number, eventId: string, seq: number) =>
      store.commitDeliveryWithEvent(
        fixtureCommitDelivery({ turnId: 'turn-recon', segmentId, textHash: `hash-${segmentId}`, text: `text-${segmentId}`, segmentIndex }),
        fixtureRuntimeEvent({ eventId, seq, type: 'delivery.committed' }),
      )
    // Reverse-looking identifiers must not change emitted order: ordering follows
    // the supporting-event sequence, and a turn is reconstructed by segmentIndex.
    await commit('segment-9', 1, 'evt-recon-1', 2)
    await commit('segment-1', 0, 'evt-recon-2', 3)

    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.segmentId)).toEqual(['segment-9', 'segment-1'])
    const reconstructed = [...confirmed]
      .filter((record) => record.turnId === 'turn-recon')
      .sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0))
    expect(reconstructed.map((record) => record.segmentId)).toEqual(['segment-1', 'segment-9'])
  })
})

describe('M6 event validation on append (C-51)', () => {
  it('rejects a malformed event before mutation and lets a corrected retry apply', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)

    // A `versions` member that is null passes the loose object type but not the
    // RuntimeEvent schema, so the durable boundary must reject it.
    const malformed = fixtureRuntimeEvent({
      eventId: 'v-1',
      seq: 1,
      versions: { persona: null } as unknown as Record<string, string>,
    })
    const ack = await store.append(malformed)
    expect(ack.outcome).toBe('failed')
    if (ack.outcome === 'failed') expect(ack.reasonCode).toBe('invalid_event')

    // No residue: no record, and the identity/sequence are still free.
    expect(await store.readSession(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(backend.sequenceOwner(FIXTURE_SESSION_ID, 1)).toBeUndefined()

    // A corrected retry reusing the same identity/sequence applies.
    const corrected = fixtureRuntimeEvent({ eventId: 'v-1', seq: 1, versions: { persona: 'p@1' } })
    expect((await store.append(corrected)).outcome).toBe('stored')
  })

  it('rejects a non-string versions member', async () => {
    const store = createEventStore()
    const ack = await store.append(
      fixtureRuntimeEvent({
        eventId: 'v-2',
        seq: 1,
        versions: { persona: 123 } as unknown as Record<string, string>,
      }),
    )
    expect(ack.outcome).toBe('failed')
    if (ack.outcome === 'failed') expect(ack.reasonCode).toBe('invalid_event')
  })

  it('accepts legacy versions: null and absent persona keys', async () => {
    const store = createEventStore()
    expect(
      (await store.append(fixtureRuntimeEvent({ eventId: 'v-3', seq: 1, versions: null }))).outcome,
    ).toBe('stored')
    expect(
      (await store.append(fixtureRuntimeEvent({ eventId: 'v-4', seq: 2, versions: { other: 'x@1' } })))
        .outcome,
    ).toBe('stored')
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
