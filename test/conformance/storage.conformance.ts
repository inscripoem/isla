import type {
  AtomicCommitAck,
  ConfirmedDelivery,
  EventStorePort,
  HistoryQueryPort,
  MemoryProjectionPort,
  ReplayReaderPort,
  RuntimeEvent,
} from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'

/** A committed delivery with its supporting-event sequence. */
export interface StoredDeliveryView {
  record: ConfirmedDelivery
  eventSeq: number
}

/**
 * Optional fixture inspection views. They must return detached copies, so a
 * caller mutating the returned array or records cannot change committed state.
 */
export interface StorageInspection {
  events(): RuntimeEvent[]
  deliveries(): ConfirmedDelivery[]
  storedDeliveries(): readonly StoredDeliveryView[]
}

export interface StorageKit {
  store: EventStorePort
  projection: MemoryProjectionPort
  /** Confirmed-history port (M4's only M6 consumer). Checked when supplied. */
  history?: HistoryQueryPort
  /** Replay reader. Checked when supplied. */
  replay?: ReplayReaderPort
  /** Detached fixture views. Checked when supplied. */
  inspection?: StorageInspection
  setFailNextCommit?: () => void
  /**
   * Adapter-specific failure injection for the atomic-failure probe. Supply it
   * when the store accepts arbitrary payloads and the default uncopyable-event
   * reproduction would not exercise a failure path.
   */
  induceFailure?: () => void | Promise<void>
}

function parseJsonl(text: string): RuntimeEvent[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RuntimeEvent)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function nestedValue(event: RuntimeEvent | undefined): string | undefined {
  const payload = event?.payload as { nested?: { value?: string } } | undefined
  return payload?.nested?.value
}

export interface AtomicFailureProbeKit {
  store: EventStorePort
  /** Confirmed-history port; checked when supplied. */
  history?: HistoryQueryPort
  /** Detached fixture views; checked when supplied. */
  inspection?: StorageInspection
  /** Session used for the probe; a dedicated default keeps it self-contained. */
  sessionId?: string
  /**
   * Adapter-specific failure injection, awaited immediately before the probe
   * commit. The reproduction default is a supporting event whose payload holds
   * a function, which a store that copies or serializes cannot commit. A
   * backend that accepts arbitrary payloads can arm its own failure here so the
   * failure path is exercised without mandating a particular copying technique.
   */
  induceFailure?: () => void | Promise<void>
}

/** Serialized baseline: a live read/history/inspection array cannot rewrite it. */
function jsonSnapshot(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Reusable failure probe for one EventStorePort. It seeds one valid record,
 * forces a single atomic delivery commit that must fail, and checks the
 * invariant that a batch which does not fully commit leaves no partial event,
 * delivery, confirmed history or JSONL export behind, while the seeded record is
 * preserved and a later valid retry reusing the failed identity and sequence is
 * applied rather than orphaned or duplicated. The probe requires evidence that
 * the failure was actually induced, so an accepted commit is reported instead of
 * being mistaken for successful failure coverage. It does not mandate a copying
 * technique: the reproduction input defaults to an uncopyable function payload,
 * and an adapter may instead supply `induceFailure`. A clean failure that throws
 * before publishing is accepted; only partial publication is reported.
 */
export async function collectAtomicFailureViolations(
  options: AtomicFailureProbeKit,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const { store, history, inspection } = options
  const sessionId = options.sessionId ?? 'session-atomic-failure-probe'
  const failedEventId = 'evt-atomic-failure'
  const failedSeq = 900

  // Seed one valid record so preservation and identity reuse are checked
  // against real committed state rather than an empty session.
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId,
      turnId: 'turn-preserved',
      segmentId: 'seg-preserved',
      textHash: 'hash-preserved',
      text: 'preserved-spoken',
    }),
    fixtureRuntimeEvent({ sessionId, eventId: 'evt-preserved', seq: 10, type: 'delivery.committed' }),
  )

  const beforeEvents = jsonSnapshot(await store.readSession(sessionId))
  const beforeExport = await store.exportJsonl(sessionId)
  const beforeHistory =
    history === undefined ? undefined : jsonSnapshot(await history.confirmedHistory(sessionId))
  const beforeDeliveries =
    inspection === undefined ? undefined : jsonSnapshot(inspection.deliveries())

  const failedDelivery = fixtureCommitDelivery({
    sessionId,
    turnId: 'turn-atomic-failure',
    segmentId: 'seg-atomic-failure',
    textHash: 'hash-atomic-failure',
    text: 'atomic-failure-spoken',
  })
  const uncopyableEvent = fixtureRuntimeEvent({
    sessionId,
    eventId: failedEventId,
    seq: failedSeq,
    type: 'delivery.committed',
    payload: { uncopyable: () => 1 },
  })

  if (options.induceFailure !== undefined) await options.induceFailure()
  let ack: AtomicCommitAck | undefined
  let threw = false
  try {
    ack = await store.commitDeliveryWithEvent(failedDelivery, uncopyableEvent)
  } catch {
    threw = true
  }

  const failureInduced =
    threw ||
    (ack !== undefined && (ack.delivery.status === 'failed' || ack.event.outcome === 'failed'))
  check(
    'atomic-failure-not-induced',
    failureInduced,
    'the failure probe must actually exercise a failed atomic commit, not an accepted one',
  )

  check(
    'atomic-failure-no-partial-event',
    !failureInduced || jsonSnapshot(await store.readSession(sessionId)) === beforeEvents,
    'a batch that does not fully commit must not leave a partial event',
  )
  check(
    'atomic-failure-no-partial-export',
    !failureInduced || (await store.exportJsonl(sessionId)) === beforeExport,
    'a batch that does not fully commit must not leave a partial JSONL export',
  )
  if (history !== undefined) {
    check(
      'atomic-failure-no-partial-history',
      !failureInduced || jsonSnapshot(await history.confirmedHistory(sessionId)) === beforeHistory,
      'a batch that does not fully commit must not leave partial confirmed history',
    )
  }
  if (inspection !== undefined) {
    check(
      'atomic-failure-no-partial-delivery',
      !failureInduced || jsonSnapshot(inspection.deliveries()) === beforeDeliveries,
      'a batch that does not fully commit must not leave a partial delivery record',
    )
  }

  // A valid retry reusing the failed commit's identity and sequence must be
  // applied: the failed attempt must neither orphan nor duplicate it.
  if (failureInduced) {
    const retry = await store.commitDeliveryWithEvent(
      failedDelivery,
      fixtureRuntimeEvent({ sessionId, eventId: failedEventId, seq: failedSeq, type: 'delivery.committed' }),
    )
    check(
      'atomic-retry-applied',
      retry.delivery.status === 'applied' && retry.event.outcome === 'stored',
      'a valid retry with the failed commit identity must be applied',
    )
    const retriedHistory =
      history === undefined
        ? undefined
        : (await history.confirmedHistory(sessionId)).filter((record) => record.turnId === 'turn-atomic-failure')
            .length
    check(
      'atomic-retry-no-orphan',
      (await store.readSession(sessionId)).filter((event) => event.eventId === failedEventId).length === 1 &&
        (retriedHistory === undefined || retriedHistory === 1),
      'identity reuse must leave exactly one committed event and delivery, not an orphan or duplicate',
    )
  }

  return violations()
}

/** M6 conformance: identity/sequence uniqueness, atomic writes and projection integrity. */
export async function collectStorageViolations(create: () => StorageKit): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const kit = create()
  const { store, projection } = kit

  const event1 = fixtureRuntimeEvent({ eventId: 'evt-1', seq: 1 })
  const ack1 = await store.append(event1)
  check('append-stored', ack1.outcome === 'stored' && ack1.eventId === event1.eventId && ack1.seq === event1.seq, 'a first append must be stored with matching identity')
  const ackDuplicate = await store.append(event1)
  check('append-duplicate', ackDuplicate.outcome === 'duplicate', 're-appending the identical event must be idempotent')
  const changed = fixtureRuntimeEvent({ eventId: 'evt-1', seq: 1, type: 'input.dropped' })
  const ackChanged = await store.append(changed)
  check('append-changed-content', ackChanged.outcome === 'failed', 'reusing an event id with different content must be rejected')
  const seqConflict = fixtureRuntimeEvent({ eventId: 'evt-2', seq: 1 })
  const ackSeq = await store.append(seqConflict)
  check('append-seq-unique', ackSeq.outcome === 'failed', 'a different event reusing a session sequence must be rejected')

  const atomic = await store.commitDeliveryWithEvent(
    fixtureCommitDelivery(),
    fixtureRuntimeEvent({ eventId: 'evt-3', seq: 2, type: 'delivery.committed' }),
  )
  check('atomic-commits-both', atomic.delivery.status === 'applied' && atomic.event.outcome === 'stored', 'delivery and its supporting event must commit together')

  const delivery1 = fixtureCommitDelivery({ turnId: 'turn-u', segmentId: 'seg-u', textHash: 'hash-u1', text: 'one' })
  await store.commitDeliveryWithEvent(delivery1, fixtureRuntimeEvent({ eventId: 'evt-u1', seq: 50, type: 'delivery.committed' }))
  const changedDelivery = fixtureCommitDelivery({ turnId: 'turn-u', segmentId: 'seg-u', textHash: 'hash-u2', text: 'two' })
  const ackChangedDelivery = await store.commitDeliveryWithEvent(changedDelivery, fixtureRuntimeEvent({ eventId: 'evt-u2', seq: 51, type: 'delivery.committed' }))
  check('delivery-changed-content-conflict', ackChangedDelivery.delivery.status === 'conflict', 'a reused delivery id with changed content must conflict')
  const repeatDelivery = await store.commitDeliveryWithEvent(delivery1, fixtureRuntimeEvent({ eventId: 'evt-u3', seq: 52, type: 'delivery.committed' }))
  check('delivery-duplicate', repeatDelivery.delivery.status === 'duplicate', 'an identical repeated delivery must be a duplicate')

  const committed = await store.readSession(FIXTURE_SESSION_ID)
  check('read-ordered', committed.every((event, index) => index === 0 || event.seq > committed[index - 1].seq), 'session events must be returned in strictly increasing sequence order')
  const jsonl = await store.exportJsonl(FIXTURE_SESSION_ID)
  const lines = jsonl.split('\n').filter((line) => line.length > 0)
  check('export-matches', lines.length === committed.length, 'the JSONL export must match committed session events')

  const applied1 = await projection.apply(event1)
  const appliedAgain = await projection.apply(event1)
  check('projection-idempotent', applied1.appliedSeq === appliedAgain.appliedSeq, 'reapplying an event must not advance the projection')
  const gap = await projection.apply(
    fixtureRuntimeEvent({ eventId: 'evt-gap', seq: appliedAgain.appliedSeq + 5 }),
  )
  check('projection-no-gap-claim', gap.appliedSeq === appliedAgain.appliedSeq, 'a projection gap must not claim current history')

  if (kit.setFailNextCommit !== undefined) {
    kit.setFailNextCommit()
    const before = (await store.readSession(FIXTURE_SESSION_ID)).length
    const failed = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'turn-fail', segmentId: 'seg-fail', textHash: 'hash-fail', text: 'fail' }),
      fixtureRuntimeEvent({ eventId: 'evt-fail', seq: 90, type: 'delivery.committed' }),
    )
    check('atomic-failure-reported', failed.event.outcome === 'failed', 'a failed atomic write must report failure')
    const after = (await store.readSession(FIXTURE_SESSION_ID)).length
    check('atomic-no-partial-mutation', after === before, 'a failed atomic write must not persist a partial event')
  }

  // Follow-up coverage (2026-10-13, PR #9 review): cross-session identity,
  // record isolation and live confirmed history, extending the C7 event-store
  // and FR-06 replay/history contracts. Distinct session ids keep these checks
  // independent from the PR #9 `append-session-scoped-identity`/
  // `read-session-isolated` block so both can coexist after merge.
  const sessionAppend = 'session-followup-append'
  const sessionCommit = 'session-followup-commit'

  // --- Event identity/reads/exports are session-scoped (C7) ---
  const sharedIdentity = await store.append(
    fixtureRuntimeEvent({ sessionId: sessionAppend, eventId: 'evt-1', seq: 1 }),
  )
  check(
    'append-session-independent',
    sharedIdentity.outcome === 'stored',
    'the same event identity in a different session must be stored independently',
  )
  const readAppend = await store.readSession(sessionAppend)
  const readFixture = await store.readSession(FIXTURE_SESSION_ID)
  check(
    'read-session-independent',
    readAppend.length === 1 && readAppend[0]?.sessionId === sessionAppend && readAppend[0]?.eventId === 'evt-1',
    'a session must read only its own events',
  )
  check(
    'read-session-independent',
    readFixture.every((event) => event.sessionId === FIXTURE_SESSION_ID),
    'reads must not leak events across sessions',
  )
  const exportAppend = parseJsonl(await store.exportJsonl(sessionAppend))
  check(
    'export-session-independent',
    exportAppend.every((event) => event.sessionId === sessionAppend) && exportAppend.length === readAppend.length,
    'a JSONL export must contain only its own session events',
  )
  check(
    'export-read-consistent',
    sameJson(exportAppend, readAppend) && sameJson(parseJsonl(await store.exportJsonl(FIXTURE_SESSION_ID)), readFixture),
    'a JSONL export must match the committed session read',
  )

  // --- Atomic commit identity is session-scoped (C7) ---
  const deliveryCommit = fixtureCommitDelivery({
    sessionId: sessionCommit,
    turnId: 'turn-shared',
    segmentId: 'seg-shared',
    textHash: 'hash-shared',
    text: 'session-commit-spoken',
  })
  const atomicSession = await store.commitDeliveryWithEvent(
    deliveryCommit,
    fixtureRuntimeEvent({
      sessionId: sessionCommit,
      eventId: 'evt-1',
      seq: 1,
      type: 'delivery.committed',
    }),
  )
  check(
    'commit-session-independent',
    atomicSession.event.outcome === 'stored' && atomicSession.delivery.status === 'applied',
    'an atomic commit must apply independently in its own session even when another session shares the event id',
  )

  // --- Atomic supporting-event input and nested payloads are detached ---
  const atomicNestedEvent = fixtureRuntimeEvent({
    sessionId: sessionCommit,
    eventId: 'evt-atomic-nested',
    seq: 70,
    type: 'delivery.committed',
    payload: { nested: { value: 'original-atomic' } },
  })
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId: sessionCommit,
      turnId: 'turn-atomic-nested',
      segmentId: 'seg-atomic-nested',
      textHash: 'hash-atomic-nested',
      text: 'atomic-nested-spoken',
    }),
    atomicNestedEvent,
  )
  ;(atomicNestedEvent.payload as { nested: { value: string } }).nested.value = 'mutated-atomic'
  check(
    'commit-event-input-detached',
    nestedValue((await store.readSession(sessionCommit)).find((event) => event.eventId === 'evt-atomic-nested')) === 'original-atomic' &&
      (await store.exportJsonl(sessionCommit)).includes('original-atomic') &&
      !(await store.exportJsonl(sessionCommit)).includes('mutated-atomic'),
    'mutating an atomic supporting-event input must not change committed state or its JSONL export',
  )

  // --- Appended input and nested payloads are detached ---
  const detachEvent = fixtureRuntimeEvent({
    sessionId: sessionAppend,
    eventId: 'evt-detach',
    seq: 7,
    payload: { nested: { value: 'original' } },
  })
  await store.append(detachEvent)
  ;(detachEvent.payload as { nested: { value: string } }).nested.value = 'mutated-input'
  check(
    'append-input-detached',
    nestedValue((await store.readSession(sessionAppend)).find((event) => event.eventId === 'evt-detach')) === 'original' &&
      (await store.exportJsonl(sessionAppend)).includes('original') &&
      !(await store.exportJsonl(sessionAppend)).includes('mutated-input'),
    'mutating an appended event input must not change committed state or its JSONL export',
  )
  const returnedEvent = (await store.readSession(sessionAppend)).find((event) => event.eventId === 'evt-detach')
  ;(returnedEvent!.payload as { nested: { value: string } }).nested.value = 'mutated-read'
  check(
    'read-result-detached',
    nestedValue((await store.readSession(sessionAppend)).find((event) => event.eventId === 'evt-detach')) === 'original' &&
      !(await store.exportJsonl(sessionAppend)).includes('mutated-read'),
    'mutating a read event must not change committed state or its JSONL export',
  )

  if (kit.replay !== undefined) {
    const archive = await kit.replay.load(sessionAppend)
    const replayEvent = archive.events.find((event) => event.eventId === 'evt-detach')
    check(
      'replay-contains-committed',
      replayEvent !== undefined,
      'replay must contain the committed session events before they are inspected',
    )
    if (replayEvent !== undefined) {
      ;(replayEvent.payload as { nested: { value: string } }).nested.value = 'mutated-replay'
    }
    check(
      'replay-result-detached',
      nestedValue((await store.readSession(sessionAppend)).find((event) => event.eventId === 'evt-detach')) === 'original' &&
        !(await store.exportJsonl(sessionAppend)).includes('mutated-replay'),
      'mutating a replayed event must not change committed state or its JSONL export',
    )
  }

  if (kit.inspection !== undefined) {
    const view = kit.inspection

    const eventsBefore = view.events()
    const eventCount = eventsBefore.length
    if (eventsBefore[0] !== undefined) eventsBefore[0].type = 'mutated-view-event'
    eventsBefore.push(fixtureRuntimeEvent({ sessionId: FIXTURE_SESSION_ID, eventId: 'evt-view-injected', seq: 999 }))
    check(
      'events-view-detached',
      view.events().length === eventCount &&
        (await store.readSession(FIXTURE_SESSION_ID)).every(
          (event) => event.type !== 'mutated-view-event' && event.eventId !== 'evt-view-injected',
        ) &&
        !(await store.exportJsonl(FIXTURE_SESSION_ID)).includes('mutated-view-event'),
      'the events inspection view must be detached from committed state',
    )

    const deliveriesBefore = view.deliveries()
    if (deliveriesBefore[0] !== undefined) deliveriesBefore[0].text = 'mutated-view-delivery'
    check(
      'deliveries-view-detached',
      view.deliveries().every((delivery) => delivery.text !== 'mutated-view-delivery'),
      'the deliveries inspection view must be detached from committed state',
    )

    const storedBefore = view.storedDeliveries()
    const firstStored = storedBefore[0]
    if (firstStored !== undefined) {
      firstStored.record.text = 'mutated-stored-delivery'
      firstStored.eventSeq = -1
    }
    check(
      'stored-deliveries-detached',
      view
        .storedDeliveries()
        .every((entry) => entry.record.text !== 'mutated-stored-delivery' && entry.eventSeq >= 0),
      'storedDeliveries must return detached records and sequence metadata',
    )
  }

  if (kit.history !== undefined) {
    const history = kit.history

    // A committed delivery input must not be mutable through the caller.
    const detachDelivery = fixtureCommitDelivery({
      sessionId: sessionAppend,
      turnId: 'turn-detach',
      segmentId: 'seg-detach',
      textHash: 'hash-detach',
      text: 'spoken-detach',
    })
    await store.commitDeliveryWithEvent(
      detachDelivery,
      fixtureRuntimeEvent({ sessionId: sessionAppend, eventId: 'evt-detach-commit', seq: 8, type: 'delivery.committed' }),
    )
    detachDelivery.text = 'mutated-delivery'
    check(
      'commit-input-detached',
      (await history.confirmedHistory(sessionAppend)).some(
        (record) => record.turnId === 'turn-detach' && record.text === 'spoken-detach',
      ),
      'mutating a committed delivery input must not change confirmed history',
    )
    const firstHistory = await history.confirmedHistory(sessionAppend)
    if (firstHistory[0] !== undefined) firstHistory[0].text = 'mutated-history'
    check(
      'history-result-detached',
      (await history.confirmedHistory(sessionAppend)).every((record) => record.text !== 'mutated-history'),
      'mutating returned history must not change later queries',
    )

    // A delivery committed after a query must be visible on the next query.
    const beforeLive = (await history.confirmedHistory(sessionCommit)).length
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ sessionId: sessionCommit, turnId: 'turn-live', segmentId: 'seg-live', textHash: 'hash-live', text: 'live-spoken' }),
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-live', seq: 20, type: 'delivery.committed' }),
    )
    const afterLive = await history.confirmedHistory(sessionCommit)
    check(
      'history-live',
      afterLive.length === beforeLive + 1 && afterLive.some((record) => record.turnId === 'turn-live'),
      'confirmed history must reflect a delivery committed after an earlier query',
    )

    // Ordering follows the supporting-event sequence, not insertion order.
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ sessionId: sessionCommit, turnId: 'turn-order-late', segmentId: 'seg-order-late', textHash: 'hash-ol', text: 'order-late' }),
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-order-late', seq: 40, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ sessionId: sessionCommit, turnId: 'turn-order-early', segmentId: 'seg-order-early', textHash: 'hash-oe', text: 'order-early' }),
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-order-early', seq: 30, type: 'delivery.committed' }),
    )
    const ordered = (await history.confirmedHistory(sessionCommit)).filter((record) => record.turnId.startsWith('turn-order-'))
    check(
      'history-ordered-by-event-seq',
      ordered[0]?.turnId === 'turn-order-early' && ordered[1]?.turnId === 'turn-order-late',
      'confirmed history must follow supporting-event sequence, not insertion order',
    )

    // An identical repeated delivery must not duplicate history.
    const duplicateDelivery = fixtureCommitDelivery({ sessionId: sessionCommit, turnId: 'turn-dup', segmentId: 'seg-dup', textHash: 'hash-dup', text: 'dup-spoken' })
    await store.commitDeliveryWithEvent(
      duplicateDelivery,
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-dup-1', seq: 50, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      duplicateDelivery,
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-dup-2', seq: 51, type: 'delivery.committed' }),
    )
    check(
      'history-dedup',
      (await history.confirmedHistory(sessionCommit)).filter((record) => record.turnId === 'turn-dup').length === 1,
      'an identical repeated delivery must not duplicate confirmed history',
    )

    // Only fully-delivered records are confirmed spoken history.
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ sessionId: sessionCommit, turnId: 'turn-not-delivered', segmentId: 'seg-nd', textHash: 'hash-nd', text: 'unspoken', classification: 'not-delivered', terminalOutcome: 'failed' }),
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-nd', seq: 60, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ sessionId: sessionCommit, turnId: 'turn-partial', segmentId: 'seg-p', textHash: 'hash-p', text: 'half', classification: 'partial-unknown', terminalOutcome: 'cancelled' }),
      fixtureRuntimeEvent({ sessionId: sessionCommit, eventId: 'evt-p', seq: 61, type: 'delivery.committed' }),
    )
    const confirmedCommit = await history.confirmedHistory(sessionCommit)
    check(
      'history-excludes-unconfirmed',
      confirmedCommit.every((record) => record.classification === 'fully-delivered') &&
        !confirmedCommit.some((record) => record.turnId === 'turn-not-delivered' || record.turnId === 'turn-partial'),
      'confirmed history must exclude not-delivered and partial records',
    )

    // Confirmed history is scoped to the requesting session.
    const confirmedAppend = await history.confirmedHistory(sessionAppend)
    check(
      'history-session-independent',
      confirmedCommit.every((record) => record.sessionId === sessionCommit) &&
        confirmedAppend.every((record) => record.sessionId === sessionAppend) &&
        confirmedAppend.some((record) => record.turnId === 'turn-detach') &&
        !confirmedCommit.some((record) => record.turnId === 'turn-detach'),
      'confirmed history must be scoped to its own session',
    )
  }

  // PR #9 session-scoped identity and live confirmed-history checks, retained
  // alongside the follow-up coverage above so both assertion families coexist.
  const otherSessionId = 'session-conformance-other'
  const otherSessionEvent = fixtureRuntimeEvent({
    sessionId: otherSessionId,
    eventId: 'evt-1',
    seq: 1,
  })
  const otherAck = await store.append(otherSessionEvent)
  check(
    'append-session-scoped-identity',
    otherAck.outcome === 'stored',
    'the same event id in a different session must be stored independently',
  )
  const otherEvents = await store.readSession(otherSessionId)
  check(
    'read-session-isolated',
    otherEvents.length === 1 && otherEvents[0]?.eventId === 'evt-1',
    'each session must read its own events independently',
  )

  if (kit.history !== undefined) {
    // A not-delivered record must never appear in confirmed spoken history.
    const notDelivered = fixtureCommitDelivery({
      turnId: 'turn-hist',
      segmentId: 'seg-hist',
      textHash: 'hash-hist',
      text: 'unspoken',
      classification: 'not-delivered',
    })
    await store.commitDeliveryWithEvent(
      notDelivered,
      fixtureRuntimeEvent({ eventId: 'evt-hist', seq: 100, type: 'delivery.committed' }),
    )
    const confirmed = await kit.history.confirmedHistory(FIXTURE_SESSION_ID)
    check(
      'history-fully-delivered-only',
      confirmed.length > 0 && confirmed.every((record) => record.classification === 'fully-delivered'),
      'confirmed history must include only fully-delivered records',
    )
    check(
      'history-excludes-not-delivered',
      confirmed.every((record) => record.turnId !== 'turn-hist'),
      'a not-delivered record must not appear in confirmed history',
    )
  }

  // Reusable atomic-failure probe: a batch that cannot fully commit must leave
  // no partial event, delivery, history or export behind.
  const atomicFailureViolations = await collectAtomicFailureViolations({
    store,
    history: kit.history,
    inspection: kit.inspection,
    induceFailure: kit.induceFailure,
    sessionId: 'session-followup-atomic-failure',
  })

  return [...violations(), ...atomicFailureViolations]
}
