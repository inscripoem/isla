import type {
  AtomicCommitAck,
  CommitDelivery,
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
      terminalOutcome: 'failed',
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

    // Ordering (INV-08): insertion order must not matter — a later supporting
    // event seq committed first must still sort after an earlier one.
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'turn-late', segmentId: 'seg-late', textHash: 'hash-late', text: 'late' }),
      fixtureRuntimeEvent({ eventId: 'evt-late', seq: 70, type: 'delivery.committed' }),
    )
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({ turnId: 'turn-early', segmentId: 'seg-early', textHash: 'hash-early', text: 'early' }),
      fixtureRuntimeEvent({ eventId: 'evt-early', seq: 60, type: 'delivery.committed' }),
    )
    const ordered = (await kit.history.confirmedHistory(FIXTURE_SESSION_ID)).map((record) => record.text)
    check(
      'history-ordered',
      ordered.indexOf('early') < ordered.indexOf('late'),
      'confirmed history must be ordered by supporting event seq, not insertion order',
    )
  }

  // --- Delivery attribution is preserved through writes and history reads ---
  // Storage revision 2026-10-14.1 makes `segmentIndex`, `personaProfileId` and
  // `personaProfileVersion` required nullable fields. These shared checks prove
  // each field independently: the original values round-trip through an actual
  // write and a read view, explicit legacy nulls stay null, an omitted required
  // field is rejected with no orphan or partial state and its identity stays
  // reusable, and a conflicting identity reuse (including explicit-null reuse)
  // keeps the originally recorded attribution.
  //
  // At least one read view is required: a backend that withholds both the
  // HistoryQueryPort and the inspection view cannot demonstrate attribution at
  // all, so the absence of a violation must not be read as a full pass. When
  // there is no read view, only this setup violation is reported; the
  // view-dependent checks below are skipped rather than also failing.
  const hasReadView = kit.history !== undefined || kit.inspection !== undefined
  check(
    'attribution-read-view-missing',
    hasReadView,
    'attribution conformance requires at least one read view: a HistoryQueryPort or an inspection view',
  )

  const attributionSession = 'session-attribution-conformance'

  // Exact read-view snapshot used before and after each rejected write. The
  // HistoryQueryPort and the inspection view are independent optional inputs:
  // a real backend supplies HistoryQueryPort, while the fixture also supplies a
  // detached inspection view, so both paths are exercised when present.
  async function attributionSnapshot(): Promise<{
    events: string
    export: string
    history: string | null
    deliveries: string | null
  }> {
    return {
      events: jsonSnapshot(await store.readSession(attributionSession)),
      export: await store.exportJsonl(attributionSession),
      history:
        kit.history === undefined
          ? null
          : jsonSnapshot(await kit.history.confirmedHistory(attributionSession)),
      deliveries:
        kit.inspection === undefined ? null : jsonSnapshot(kit.inspection.deliveries()),
    }
  }

  // Verifies one turn's attribution through every available read view, so the
  // restored-retry and conflict-preservation guarantees hold for a history-only,
  // inspection-only or dual-view kit. A dual-view kit must agree in both views.
  async function attributionMatchesViews(
    turnId: string,
    expected: {
      segmentIndex: number | null
      personaProfileId: string | null
      personaProfileVersion: string | null
    },
  ): Promise<boolean> {
    const results: boolean[] = []
    if (kit.history !== undefined) {
      const record = (await kit.history.confirmedHistory(attributionSession)).find(
        (candidate) => candidate.turnId === turnId,
      )
      results.push(
        record !== undefined &&
          record.segmentIndex === expected.segmentIndex &&
          record.personaProfileId === expected.personaProfileId &&
          record.personaProfileVersion === expected.personaProfileVersion,
      )
    }
    if (kit.inspection !== undefined) {
      const record = kit.inspection.deliveries().find((candidate) => candidate.turnId === turnId)
      results.push(
        record !== undefined &&
          record.segmentIndex === expected.segmentIndex &&
          record.personaProfileId === expected.personaProfileId &&
          record.personaProfileVersion === expected.personaProfileVersion,
      )
    }
    return results.length > 0 && results.every(Boolean)
  }

  const attributionDelivery = fixtureCommitDelivery({
    sessionId: attributionSession,
    turnId: 'turn-attribution',
    segmentId: 'segment-attribution',
    textHash: 'hash-attribution',
    text: 'attribution-spoken',
    segmentIndex: 3,
    personaProfileId: 'persona-conformance',
    personaProfileVersion: 'v7',
  })
  const attributionAck = await store.commitDeliveryWithEvent(
    attributionDelivery,
    fixtureRuntimeEvent({
      sessionId: attributionSession,
      eventId: 'evt-attribution',
      seq: 1,
      type: 'delivery.committed',
    }),
  )
  check(
    'attribution-applied',
    attributionAck.delivery.status === 'applied' && attributionAck.event.outcome === 'stored',
    'a delivery carrying attribution must apply atomically',
  )
  if (kit.history !== undefined) {
    const attributed = (await kit.history.confirmedHistory(attributionSession)).find(
      (record) => record.turnId === 'turn-attribution',
    )
    check(
      'attribution-round-trip',
      attributed?.segmentIndex === 3 &&
        attributed?.personaProfileId === 'persona-conformance' &&
        attributed?.personaProfileVersion === 'v7',
      'confirmed history must preserve the original segment index and persona attribution',
    )
  }
  if (kit.inspection !== undefined) {
    const stored = kit.inspection
      .deliveries()
      .find((record) => record.turnId === 'turn-attribution')
    check(
      'attribution-stored',
      stored?.segmentIndex === 3 &&
        stored?.personaProfileId === 'persona-conformance' &&
        stored?.personaProfileVersion === 'v7',
      'the stored record must keep the original segment index and persona attribution',
    )
  }

  // An explicit legacy null stays null: it is never inferred from the segment
  // identifier or backfilled from a later persona.
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId: attributionSession,
      turnId: 'turn-null-attribution',
      // A numeric-looking identifier must not become an index.
      segmentId: 'segment-7',
      textHash: 'hash-null-attribution',
      text: 'null-attribution-spoken',
      segmentIndex: null,
      personaProfileId: null,
      personaProfileVersion: null,
    }),
    fixtureRuntimeEvent({
      sessionId: attributionSession,
      eventId: 'evt-null-attribution',
      seq: 2,
      type: 'delivery.committed',
    }),
  )
  if (kit.history !== undefined) {
    const legacyNull = (await kit.history.confirmedHistory(attributionSession)).find(
      (record) => record.turnId === 'turn-null-attribution',
    )
    check(
      'attribution-null-preserved',
      legacyNull !== undefined &&
        legacyNull.segmentIndex === null &&
        legacyNull.personaProfileId === null &&
        legacyNull.personaProfileVersion === null,
      'explicit null attribution must be preserved, never inferred or backfilled',
    )
  }
  if (kit.inspection !== undefined) {
    const legacyNull = kit.inspection
      .deliveries()
      .find((record) => record.turnId === 'turn-null-attribution')
    check(
      'attribution-null-stored',
      legacyNull !== undefined &&
        legacyNull.segmentIndex === null &&
        legacyNull.personaProfileId === null &&
        legacyNull.personaProfileVersion === null,
      'the stored record must keep explicit null attribution',
    )
  }

  // A required attribution field that is omitted (rather than an explicit null)
  // must be rejected at the storage boundary. Each omitted field uses a fresh,
  // complete delivery identity and supporting-event sequence; the exact read
  // views must be byte-identical before and after the rejected attempt (so an
  // orphan record or a partial event cannot hide), and the very same identity
  // and sequence must then apply once the field is restored.
  const attributionFields = [
    'segmentIndex',
    'personaProfileId',
    'personaProfileVersion',
  ] as const
  for (const [index, field] of attributionFields.entries()) {
    const turnId = `turn-omitted-${field}`
    const expectedIndex = 10 + index
    const expectedPersona = `persona-omitted-${field}`
    const expectedVersion = `v-omitted-${field}`
    const delivery = fixtureCommitDelivery({
      sessionId: attributionSession,
      turnId,
      segmentId: `segment-omitted-${field}`,
      textHash: `hash-omitted-${field}`,
      text: `omitted-${field}-spoken`,
      segmentIndex: expectedIndex,
      personaProfileId: expectedPersona,
      personaProfileVersion: expectedVersion,
    })
    const omitted: Record<string, unknown> = { ...delivery }
    delete omitted[field]
    const eventId = `evt-omitted-${field}`
    const seq = 20 + index
    const supportingEvent = (): RuntimeEvent =>
      fixtureRuntimeEvent({ sessionId: attributionSession, eventId, seq, type: 'delivery.committed' })

    const before = await attributionSnapshot()
    const ack = await store.commitDeliveryWithEvent(
      omitted as unknown as CommitDelivery,
      supportingEvent(),
    )
    check(
      `attribution-omitted-rejected:${field}`,
      ack.delivery.status === 'failed' && ack.event.outcome === 'failed',
      `a delivery omitting the required ${field} field must be rejected`,
    )
    const after = await attributionSnapshot()
    check(
      `attribution-omitted-no-partial:${field}`,
      sameJson(before, after),
      `a rejected ${field}-omitted delivery must leave events, export, history and stored records unchanged`,
    )

    const retry = await store.commitDeliveryWithEvent(delivery, supportingEvent())
    check(
      `attribution-omitted-retry:${field}`,
      retry.delivery.status === 'applied' && retry.event.outcome === 'stored',
      `retrying the rejected ${field} identity with the field restored must apply`,
    )
    check(
      `attribution-omitted-retry-attribution:${field}`,
      !hasReadView ||
        (await attributionMatchesViews(turnId, {
          segmentIndex: expectedIndex,
          personaProfileId: expectedPersona,
          personaProfileVersion: expectedVersion,
        })),
      `the retried ${field} delivery must carry its restored attribution in every read view`,
    )
  }

  // Reusing the delivery identity with any single changed attribution field
  // conflicts independently, an explicit-null reuse conflicts too, and every
  // attempt keeps the originally recorded values rather than overwriting them.
  const conflictAttempts: Array<{ code: string; delivery: CommitDelivery; eventId: string; seq: number }> = [
    {
      code: 'attribution-conflict-index',
      delivery: { ...attributionDelivery, segmentIndex: 4 },
      eventId: 'evt-attribution-conflict-index',
      seq: 30,
    },
    {
      code: 'attribution-conflict-persona',
      delivery: { ...attributionDelivery, personaProfileId: 'persona-other' },
      eventId: 'evt-attribution-conflict-persona',
      seq: 31,
    },
    {
      code: 'attribution-conflict-version',
      delivery: { ...attributionDelivery, personaProfileVersion: 'v8' },
      eventId: 'evt-attribution-conflict-version',
      seq: 32,
    },
    {
      code: 'attribution-conflict-null',
      delivery: {
        ...attributionDelivery,
        segmentIndex: null,
        personaProfileId: null,
        personaProfileVersion: null,
      },
      eventId: 'evt-attribution-conflict-null',
      seq: 33,
    },
  ]
  let originalPreserved = true
  for (const attempt of conflictAttempts) {
    const ack = await store.commitDeliveryWithEvent(
      attempt.delivery,
      fixtureRuntimeEvent({
        sessionId: attributionSession,
        eventId: attempt.eventId,
        seq: attempt.seq,
        type: 'delivery.committed',
      }),
    )
    check(
      attempt.code,
      ack.delivery.status === 'conflict',
      'reusing a delivery identity with changed attribution must conflict',
    )
    // Verify the recorded original after each conflicting attempt, not only
    // once at the end, through whichever read view the kit supplies.
    if (hasReadView) {
      const preserved = await attributionMatchesViews('turn-attribution', {
        segmentIndex: 3,
        personaProfileId: 'persona-conformance',
        personaProfileVersion: 'v7',
      })
      originalPreserved = originalPreserved && preserved
    }
  }
  check(
    'attribution-conflict-preserves-original',
    !hasReadView || originalPreserved,
    'every conflicting reuse must keep the originally recorded attribution in every read view',
  )

  // The converse of explicit null: reusing the seeded all-null identity with
  // known attribution must conflict rather than silently backfill it.
  const backfillAck = await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId: attributionSession,
      turnId: 'turn-null-attribution',
      segmentId: 'segment-7',
      textHash: 'hash-null-attribution',
      text: 'null-attribution-spoken',
      segmentIndex: 5,
      personaProfileId: 'persona-backfill',
      personaProfileVersion: 'v9',
    }),
    fixtureRuntimeEvent({
      sessionId: attributionSession,
      eventId: 'evt-null-backfill',
      seq: 34,
      type: 'delivery.committed',
    }),
  )
  check(
    'attribution-null-conflict',
    backfillAck.delivery.status === 'conflict',
    'reusing an all-null identity with known attribution must conflict, never silently backfill',
  )
  check(
    'attribution-null-preserved-after-conflict',
    !hasReadView ||
      (await attributionMatchesViews('turn-null-attribution', {
        segmentIndex: null,
        personaProfileId: null,
        personaProfileVersion: null,
      })),
    'the all-null identity must stay null after a refused backfill in every read view',
  )

  // --- Delivery boundary: classification/terminalOutcome combinations (C6) ---
  // The shape schema validates `classification` and `terminalOutcome`
  // independently; the shared write boundary must reject an inconsistent pair as
  // one paired failure before any mutation, leave every read view unchanged and
  // keep the rejected identity and sequence reusable by a corrected retry.
  const boundarySession = 'session-delivery-boundary'

  async function boundarySnapshot(sessions: readonly string[] = [boundarySession]): Promise<string> {
    // Every session named by a rejected batch is inspected, so an event written
    // into the other side of a session mismatch cannot hide; the delivery
    // inspection view is global, covering every stored record.
    const uniqueSessions = [...new Set(sessions)]
    const perSession = await Promise.all(
      uniqueSessions.map(async (sessionId) => ({
        sessionId,
        events: jsonSnapshot(await store.readSession(sessionId)),
        export: await store.exportJsonl(sessionId),
        history:
          kit.history === undefined
            ? null
            : jsonSnapshot(await kit.history.confirmedHistory(sessionId)),
      })),
    )
    return jsonSnapshot({
      perSession,
      deliveries: kit.inspection === undefined ? null : kit.inspection.deliveries(),
    })
  }

  const invalidCombinationAttempts: ReadonlyArray<{
    code: string
    classification: CommitDelivery['classification']
    terminalOutcome: CommitDelivery['terminalOutcome']
    corrected: CommitDelivery['terminalOutcome']
  }> = [
    { code: 'delivery-invalid-combination:fully-delivered-failed', classification: 'fully-delivered', terminalOutcome: 'failed', corrected: 'completed' },
    { code: 'delivery-invalid-combination:fully-delivered-cancelled', classification: 'fully-delivered', terminalOutcome: 'cancelled', corrected: 'completed' },
    { code: 'delivery-invalid-combination:fully-delivered-unknown', classification: 'fully-delivered', terminalOutcome: 'unknown', corrected: 'completed' },
    { code: 'delivery-invalid-combination:partial-unknown-completed', classification: 'partial-unknown', terminalOutcome: 'completed', corrected: 'cancelled' },
    { code: 'delivery-invalid-combination:not-delivered-completed', classification: 'not-delivered', terminalOutcome: 'completed', corrected: 'failed' },
  ]
  for (const [index, attempt] of invalidCombinationAttempts.entries()) {
    const delivery = fixtureCommitDelivery({
      sessionId: boundarySession,
      turnId: `turn-invalid-combination-${index}`,
      segmentId: `segment-invalid-combination-${index}`,
      textHash: `hash-invalid-combination-${index}`,
      text: `invalid-combination-${index}`,
      classification: attempt.classification,
      terminalOutcome: attempt.terminalOutcome,
    })
    const eventId = `evt-invalid-combination-${index}`
    const seq = 200 + index
    const supportingEvent = (): RuntimeEvent =>
      fixtureRuntimeEvent({ sessionId: boundarySession, eventId, seq, type: 'delivery.committed' })

    const before = await boundarySnapshot()
    const ack = await store.commitDeliveryWithEvent(delivery, supportingEvent())
    check(
      attempt.code,
      ack.delivery.status === 'failed' && ack.event.outcome === 'failed',
      'an inconsistent classification/terminalOutcome pair must be rejected as one paired failure',
    )
    check(
      `${attempt.code}:paired-reason`,
      ack.delivery.status === 'failed' &&
        ack.event.outcome === 'failed' &&
        ack.delivery.reasonCode === ack.event.reasonCode,
      'a rejected pair must report the same reason on both sides',
    )
    check(
      `${attempt.code}:no-residue`,
      (await boundarySnapshot()) === before,
      'a rejected pair must leave events, export, history and stored records unchanged',
    )
    const retry = await store.commitDeliveryWithEvent(
      { ...delivery, terminalOutcome: attempt.corrected },
      supportingEvent(),
    )
    check(
      `${attempt.code}:retry`,
      retry.delivery.status === 'applied' && retry.event.outcome === 'stored',
      'a corrected retry reusing the rejected identity and sequence must apply',
    )
  }

  const acceptedCombinations: ReadonlyArray<{
    code: string
    classification: CommitDelivery['classification']
    terminalOutcome: CommitDelivery['terminalOutcome']
  }> = [
    { code: 'delivery-valid-combination:fully-delivered-completed', classification: 'fully-delivered', terminalOutcome: 'completed' },
    { code: 'delivery-valid-combination:partial-unknown-cancelled', classification: 'partial-unknown', terminalOutcome: 'cancelled' },
    { code: 'delivery-valid-combination:partial-unknown-failed', classification: 'partial-unknown', terminalOutcome: 'failed' },
    { code: 'delivery-valid-combination:partial-unknown-unknown', classification: 'partial-unknown', terminalOutcome: 'unknown' },
    { code: 'delivery-valid-combination:not-delivered-cancelled', classification: 'not-delivered', terminalOutcome: 'cancelled' },
    { code: 'delivery-valid-combination:not-delivered-failed', classification: 'not-delivered', terminalOutcome: 'failed' },
    { code: 'delivery-valid-combination:not-delivered-unknown', classification: 'not-delivered', terminalOutcome: 'unknown' },
  ]
  for (const [index, combination] of acceptedCombinations.entries()) {
    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        sessionId: boundarySession,
        turnId: `turn-valid-combination-${index}`,
        segmentId: `segment-valid-combination-${index}`,
        textHash: `hash-valid-combination-${index}`,
        text: `valid-combination-${index}`,
        classification: combination.classification,
        terminalOutcome: combination.terminalOutcome,
      }),
      fixtureRuntimeEvent({
        sessionId: boundarySession,
        eventId: `evt-valid-combination-${index}`,
        seq: 300 + index,
        type: 'delivery.committed',
      }),
    )
    check(
      combination.code,
      ack.delivery.status === 'applied' && ack.event.outcome === 'stored',
      'a consistent classification/terminalOutcome pair must apply',
    )
  }

  // --- Delivery boundary: delivery/event provenance and correlation (C7) ---
  // Only a known-vs-known disagreement is contradictory: an absent or explicit
  // `null` event component is legacy raw partial knowledge, never inferred. A
  // contradiction is rejected before mutation, leaves the views unchanged and
  // keeps the identity reusable; an unrelated version entry is preserved.
  const correlationMismatches: ReadonlyArray<{ code: string; mismatch: Partial<RuntimeEvent> }> = [
    { code: 'delivery-correlation:sessionId', mismatch: { sessionId: 'session-correlation-other' } },
    { code: 'delivery-correlation:turnId', mismatch: { turnId: 'turn-correlation-other' } },
    { code: 'delivery-correlation:segmentId', mismatch: { segmentId: 'segment-correlation-other' } },
    { code: 'delivery-correlation:outputId', mismatch: { outputId: 'output-correlation-other' } },
    {
      code: 'delivery-correlation:personaProfileId',
      mismatch: { versions: { personaProfileId: 'persona-correlation-other', personaProfileVersion: 'v1' } },
    },
    {
      code: 'delivery-correlation:personaProfileVersion',
      mismatch: { versions: { personaProfileId: 'persona-correlation', personaProfileVersion: 'v9' } },
    },
  ]
  for (const [index, attempt] of correlationMismatches.entries()) {
    const delivery = fixtureCommitDelivery({
      sessionId: boundarySession,
      turnId: `turn-correlation-${index}`,
      segmentId: `segment-correlation-${index}`,
      textHash: `hash-correlation-${index}`,
      text: `correlation-${index}`,
      outputId: `output-correlation-${index}`,
      segmentIndex: index,
      personaProfileId: 'persona-correlation',
      personaProfileVersion: 'v1',
    })
    const eventId = `evt-correlation-${index}`
    const seq = 400 + index
    const baseEvent = (): Partial<RuntimeEvent> => ({
      sessionId: boundarySession,
      eventId,
      seq,
      type: 'delivery.committed',
      turnId: delivery.turnId,
      segmentId: delivery.segmentId,
      outputId: delivery.outputId,
      versions: { personaProfileId: 'persona-correlation', personaProfileVersion: 'v1' },
    })

    // A mismatching session names a second session; inspect it too, so an event
    // the store might wrongly write there is caught as residue.
    const eventSessionId = (attempt.mismatch.sessionId as string | undefined) ?? boundarySession
    const involvedSessions = [boundarySession, eventSessionId]

    const before = await boundarySnapshot(involvedSessions)
    const rejected = await store.commitDeliveryWithEvent(
      delivery,
      fixtureRuntimeEvent({ ...baseEvent(), ...attempt.mismatch }),
    )
    check(
      `${attempt.code}:rejected`,
      rejected.delivery.status === 'failed' && rejected.event.outcome === 'failed',
      'a contradictory known provenance or correlation must be rejected as one paired failure',
    )
    check(
      `${attempt.code}:paired-reason`,
      rejected.delivery.status === 'failed' &&
        rejected.event.outcome === 'failed' &&
        rejected.delivery.reasonCode === rejected.event.reasonCode,
      'a rejected pair must report the same reason on both sides',
    )
    check(
      `${attempt.code}:no-residue`,
      (await boundarySnapshot(involvedSessions)) === before,
      'a rejected pair must leave events, export, history and stored records unchanged in every implicated session',
    )
    const retry = await store.commitDeliveryWithEvent(delivery, fixtureRuntimeEvent(baseEvent()))
    check(
      `${attempt.code}:retry`,
      retry.delivery.status === 'applied' && retry.event.outcome === 'stored',
      'a corrected retry reusing the rejected identity and sequence must apply',
    )
  }

  const validProvenanceCases: ReadonlyArray<{
    code: string
    delivery: Partial<CommitDelivery>
    versions: RuntimeEvent['versions']
    event?: Partial<RuntimeEvent>
  }> = [
    {
      code: 'delivery-provenance:matching-event',
      delivery: {},
      versions: { personaProfileId: 'persona-provenance', personaProfileVersion: 'v3', voiceProfileId: 'voice-x' },
    },
    { code: 'delivery-provenance:event-versions-null', delivery: {}, versions: null },
    { code: 'delivery-provenance:event-missing-persona-key', delivery: {}, versions: { voiceProfileId: 'voice-x' } },
    {
      code: 'delivery-provenance:half-pair-identity-only',
      delivery: { personaProfileId: 'persona-provenance', personaProfileVersion: null },
      versions: { personaProfileId: 'persona-provenance' },
    },
    {
      code: 'delivery-provenance:half-pair-version-only',
      delivery: { personaProfileId: null, personaProfileVersion: 'v3' },
      versions: { personaProfileVersion: 'v3' },
    },
    {
      code: 'delivery-provenance:all-null',
      delivery: { personaProfileId: null, personaProfileVersion: null },
      versions: null,
    },
    {
      // A known event output against an unknown delivery output is partial
      // knowledge, not a contradiction; the missing delivery output must not be
      // inferred from the event.
      code: 'delivery-provenance:output-null-event-known',
      delivery: { outputId: null },
      versions: { personaProfileId: 'persona-provenance', personaProfileVersion: 'v3' },
      event: { outputId: 'output-event-only' },
    },
    {
      // The literal string "null" is a value, never converted into a fabricated
      // unknown marker.
      code: 'delivery-provenance:literal-null-string',
      delivery: { personaProfileId: null, personaProfileVersion: null },
      versions: { personaProfileId: 'null' },
    },
  ]
  for (const [index, testCase] of validProvenanceCases.entries()) {
    const delivery = fixtureCommitDelivery({
      sessionId: boundarySession,
      turnId: `turn-valid-provenance-${index}`,
      segmentId: `segment-valid-provenance-${index}`,
      textHash: `hash-valid-provenance-${index}`,
      text: `valid-provenance-${index}`,
      outputId: `output-valid-provenance-${index}`,
      segmentIndex: index,
      personaProfileId: 'persona-provenance',
      personaProfileVersion: 'v3',
      ...testCase.delivery,
    })
    const ack = await store.commitDeliveryWithEvent(
      delivery,
      fixtureRuntimeEvent({
        sessionId: boundarySession,
        eventId: `evt-valid-provenance-${index}`,
        seq: 500 + index,
        type: 'delivery.committed',
        turnId: delivery.turnId,
        segmentId: delivery.segmentId,
        outputId: delivery.outputId,
        versions: testCase.versions,
        ...testCase.event,
      }),
    )
    check(
      testCase.code,
      ack.delivery.status === 'applied' && ack.event.outcome === 'stored',
      'a delivery with partial or absent known event provenance must be accepted',
    )
  }
  const preservedUnrelated = (await store.readSession(boundarySession)).find(
    (event) => event.eventId === 'evt-valid-provenance-0',
  )
  check(
    'delivery-provenance:unrelated-version-preserved',
    preservedUnrelated?.versions?.['voiceProfileId'] === 'voice-x',
    'an unrelated event version entry must be preserved, never dropped or inferred',
  )
  const literalNullIndex = validProvenanceCases.findIndex(
    (testCase) => testCase.code === 'delivery-provenance:literal-null-string',
  )
  const literalNullEvent = (await store.readSession(boundarySession)).find(
    (event) => event.eventId === `evt-valid-provenance-${literalNullIndex}`,
  )
  check(
    'delivery-provenance:literal-null-string-preserved',
    literalNullEvent?.versions?.['personaProfileId'] === 'null',
    'a literal "null" version string is a value, never converted into a fabricated unknown',
  )
  if (hasReadView) {
    const outputNullIndex = validProvenanceCases.findIndex(
      (testCase) => testCase.code === 'delivery-provenance:output-null-event-known',
    )
    const turnId = `turn-valid-provenance-${outputNullIndex}`
    const record =
      kit.history !== undefined
        ? (await kit.history.confirmedHistory(boundarySession)).find(
            (candidate) => candidate.turnId === turnId,
          )
        : kit.inspection?.deliveries().find((candidate) => candidate.turnId === turnId)
    check(
      'delivery-provenance:output-null-not-inferred',
      record !== undefined && record.outputId === null,
      'a missing delivery output id must not be inferred from the event',
    )
  }

  // --- Delivery boundary: malformed supporting event (C7) ---
  // The supporting event is validated before its fields are read for
  // correlation and before any mutation, so a null/non-string version member or
  // an omitted `versions` key is one paired failure rather than a stored value
  // or a thrown error. `versions: null` and absent persona keys stay legal and no
  // null member is converted into a fabricated unknown.
  const malformedEvents: ReadonlyArray<{ code: string; event: Partial<RuntimeEvent> }> = [
    {
      code: 'delivery-invalid-event:null-version-member',
      event: { versions: { personaProfileId: null } as unknown as RuntimeEvent['versions'] },
    },
    {
      code: 'delivery-invalid-event:non-string-version-member',
      event: { versions: { personaProfileId: 7 } as unknown as RuntimeEvent['versions'] },
    },
    {
      code: 'delivery-invalid-event:omitted-versions',
      event: { versions: undefined as unknown as RuntimeEvent['versions'] },
    },
  ]
  for (const [index, attempt] of malformedEvents.entries()) {
    const delivery = fixtureCommitDelivery({
      sessionId: boundarySession,
      turnId: `turn-invalid-event-${index}`,
      segmentId: `segment-invalid-event-${index}`,
      textHash: `hash-invalid-event-${index}`,
      text: `invalid-event-${index}`,
      // Legacy-null delivery attribution: the malformed event must still be
      // rejected and the nulls must not be replaced with fabricated values.
      personaProfileId: null,
      personaProfileVersion: null,
    })
    const eventId = `evt-invalid-event-${index}`
    const seq = 600 + index
    const malformedEvent = fixtureRuntimeEvent({
      sessionId: boundarySession,
      eventId,
      seq,
      type: 'delivery.committed',
      turnId: delivery.turnId,
      segmentId: delivery.segmentId,
      outputId: delivery.outputId,
      ...attempt.event,
    })
    const validEvent = (): RuntimeEvent =>
      fixtureRuntimeEvent({
        sessionId: boundarySession,
        eventId,
        seq,
        type: 'delivery.committed',
        turnId: delivery.turnId,
        segmentId: delivery.segmentId,
        outputId: delivery.outputId,
        versions: null,
      })

    const before = await boundarySnapshot()
    let ack: AtomicCommitAck
    try {
      ack = await store.commitDeliveryWithEvent(delivery, malformedEvent)
    } catch {
      check(
        attempt.code,
        false,
        'a malformed supporting event must fail as a paired acknowledgement, not throw',
      )
      continue
    }
    check(
      attempt.code,
      ack.delivery.status === 'failed' && ack.event.outcome === 'failed',
      'a malformed supporting event must fail as one paired failure',
    )
    check(
      `${attempt.code}:paired-reason`,
      ack.delivery.status === 'failed' &&
        ack.event.outcome === 'failed' &&
        ack.delivery.reasonCode === ack.event.reasonCode,
      'a rejected pair must report the same reason on both sides',
    )
    check(
      `${attempt.code}:no-residue`,
      (await boundarySnapshot()) === before,
      'a malformed supporting event must leave events, export, history and stored records unchanged',
    )
    const retry = await store.commitDeliveryWithEvent(delivery, validEvent())
    check(
      `${attempt.code}:retry`,
      retry.delivery.status === 'applied' && retry.event.outcome === 'stored',
      'a corrected retry reusing the rejected identity and sequence must apply',
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

  // INV-07: committed records are isolated from caller mutation.
  const inputEvent = fixtureRuntimeEvent({ eventId: 'evt-isolation', seq: 200 })
  await store.append(inputEvent)
  ;(inputEvent.payload as Record<string, unknown>).tampered = true
  const afterInput = (await store.readSession(FIXTURE_SESSION_ID)).find(
    (event) => event.eventId === 'evt-isolation',
  )
  check(
    'input-isolation',
    afterInput !== undefined && afterInput.payload.tampered === undefined,
    'mutating a committed input must not change stored state',
  )

  const readEvent = (await store.readSession(FIXTURE_SESSION_ID)).find(
    (event) => event.eventId === 'evt-isolation',
  )
  if (readEvent !== undefined) (readEvent.payload as Record<string, unknown>).tampered = true
  const afterRead = (await store.readSession(FIXTURE_SESSION_ID)).find(
    (event) => event.eventId === 'evt-isolation',
  )
  check(
    'read-isolation',
    afterRead !== undefined && afterRead.payload.tampered === undefined,
    'mutating a returned record must not change stored state',
  )

  

  return [...violations(), ...atomicFailureViolations]
}
