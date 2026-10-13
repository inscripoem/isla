import type { EventStorePort, HistoryQueryPort, MemoryProjectionPort } from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'

export interface StorageKit {
  store: EventStorePort
  projection: MemoryProjectionPort
  /** Confirmed-history port (M4's only M6 consumer). Checked when supplied. */
  history?: HistoryQueryPort
  setFailNextCommit?: () => void
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

  // Event identity is session-scoped (INTERFACES C7): the same event id in two
  // sessions must be stored independently.
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

  return violations()
}
