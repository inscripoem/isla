import { describe, expect, it } from 'vitest'
import {
  createDeliveryMemoryStore,
  createDialoguePort,
  personaVersionKey,
  renderDialoguePrompt,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DialogueTextSource,
  MemoryEntrySource,
} from '../../src/dialogue'
import { createEventStore, createHistoryQuery, createInMemoryBackend } from '../../src/storage'
import type { StorageBackend } from '../../src/storage'
import { orderTurnDeliveries } from '../../src/runtime/delivery-order'
import type {
  AtomicCommitAck,
  ClockPort,
  DialogueRequest,
  DialogueSink,
  HistoryQueryPort,
  RuntimeEvent,
} from '../../src/contracts'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
  fixtureRuntimeEvent,
} from '../support/fixture-data'

/**
 * M4 consumption tests against the real M6 store.
 *
 * Why this file exists
 * --------------------
 * Everything else that exercises M4 talks to a test-local stand-in: the
 * conformance kit is handed `createDeliveryMemoryStore`, and the composition and
 * regression suites are handed `test/support/correct-ports.ts`. None of them
 * reach `src/storage`, so nothing in the repository checks that M4 and M6 agree
 * once they are actually wired together. Issue #25 asks the consumer for exactly
 * this evidence.
 *
 * What is asserted here is therefore consumer-visible behaviour, not M6's
 * internals: which records M4 reads, how it orders them, what it refuses, and
 * that a failed durable commit leaves no trace in memory.
 *
 * Attribution. The coordinated storage contract persists each delivery's
 * original segment index and generating persona. M4 reads attribution only from
 * a record's own persisted fields; it never consults a process-local note or map,
 * and a partial or absent pair stays unknown. The supporting event therefore
 * mirrors its delivery - same session, turn, segment, output and persona - one
 * event per segment, so a mismatched identity is rejected rather than silently
 * collapsing two records into one.
 *
 * Scope note: the default backend is in-memory, so "restart" below means a fresh
 * store and query over the same durable state. The SQLite backend (M6-01 B1-B3)
 * is the version that survives a process restart; these tests do not cover it.
 */

/** Fixture deadlines live in the injected clock's domain, not the wall clock. */
const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

interface StoreHarness {
  readonly backend: StorageBackend
  readonly store: ReturnType<typeof createEventStore>
  readonly history: HistoryQueryPort
}

function storeHarness(backend: StorageBackend = createInMemoryBackend()): StoreHarness {
  return { backend, store: createEventStore(backend), history: createHistoryQuery(backend) }
}

/**
 * The supporting event M5 constructs for a delivery commit. It carries the same
 * session, turn, segment, output and persona as its delivery: one event per
 * segment, so every record gets its own `seq` and its own position in confirmed
 * history. A persona that is only half-known is deliberately absent from the
 * event's version map, matching the raw-partial-knowledge rule: the event never
 * invents the missing component.
 */
function deliveryEvent(input: {
  seq: number
  turnId: string
  segmentId: string
  sessionId: string
  outputId: string | null
  personaProfileId: string | null
  personaProfileVersion: string | null
}): RuntimeEvent {
  return fixtureRuntimeEvent({
    eventId: `delivery-event-${input.seq}`,
    seq: input.seq,
    sessionId: input.sessionId,
    turnId: input.turnId,
    segmentId: input.segmentId,
    outputId: input.outputId,
    type: 'delivery.committed',
    versions:
      input.personaProfileId !== null && input.personaProfileVersion !== null
        ? {
            personaProfileId: input.personaProfileId,
            personaProfileVersion: input.personaProfileVersion,
          }
        : null,
  })
}

/**
 * Persist one spoken segment the way M5 does: one delivery plus its own matching
 * supporting event, through the single atomic entry point. One event per segment
 * is what gives each record its own `seq`, and therefore its position in
 * confirmed history. Attribution defaults to the fixture persona only when the
 * caller does not name one; an explicit `null` stays unknown.
 */
async function commitSpoken(
  harness: StoreHarness,
  input: {
    turnId: string
    segmentId: string
    text: string
    seq: number
    sessionId?: string
    outputId?: string
    receiptId?: string | null
    segmentIndex?: number | null
    personaProfileId?: string | null
    personaProfileVersion?: string | null
  },
): Promise<AtomicCommitAck> {
  const sessionId = input.sessionId ?? FIXTURE_SESSION_ID
  const outputId = input.outputId ?? `output-${input.segmentId}`
  const segmentIndex = input.segmentIndex === undefined ? 0 : input.segmentIndex
  const personaProfileId =
    input.personaProfileId === undefined ? 'character-fixture' : input.personaProfileId
  const personaProfileVersion =
    input.personaProfileVersion === undefined ? '1' : input.personaProfileVersion
  return harness.store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId,
      turnId: input.turnId,
      segmentId: input.segmentId,
      text: input.text,
      textHash: `hash-${input.segmentId}`,
      outputId,
      receiptId: input.receiptId === undefined ? `receipt-${input.segmentId}` : input.receiptId,
      segmentIndex,
      personaProfileId,
      personaProfileVersion,
    }),
    deliveryEvent({
      seq: input.seq,
      turnId: input.turnId,
      segmentId: input.segmentId,
      sessionId,
      outputId,
      personaProfileId,
      personaProfileVersion,
    }),
  )
}

/**
 * Assert that an atomic write actually landed. Without this, a silently rejected
 * commit would leave the later assertions passing over empty history and the test
 * would report coverage it never exercised.
 */
function expectApplied(ack: AtomicCommitAck): void {
  expect(ack.delivery).toMatchObject({ status: 'applied' })
  expect(ack.event).toMatchObject({ outcome: 'stored' })
}

function capturingTextSource(capture: { view: AssembledDialogueContext | null }): DialogueTextSource {
  return {
    model: 'integration-source',
    modelVersion: 'integration-v1',
    resolvedModel: null,
    async compose(view) {
      capture.view = view
      return ['Understood.']
    },
  }
}

/**
 * Runs the real dialogue port over the supplied sources and returns the context
 * it assembled. The generation itself is incidental; the view is the subject.
 */
async function assembleOver(input: {
  history?: HistoryQueryPort
  memory?: MemoryEntrySource
  request?: DialogueRequest
}): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const sink: DialogueSink = { segment: async () => {} }
  const port = createDialoguePort({
    clock: FIXTURE_CLOCK,
    textSource: capturingTextSource(capture),
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(input.memory === undefined ? {} : { memory: input.memory }),
  })

  await port.generate(input.request ?? fixtureDialogueRequest(), createCallContext(), sink)
  if (capture.view === null) throw new Error('the dialogue port never assembled a context')
  return capture.view
}

describe('M4 consumes the durable M6 store', () => {
  it('renders committed deliveries as confirmed history and writes nothing itself', async () => {
    const harness = storeHarness()
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'We talked about the concert.',
        seq: 10,
      }),
    )

    const committedBefore = harness.backend.storedDeliveries().length
    const view = await assembleOver({ history: harness.history })

    expect(view.historySource).toBe('history-port')
    expect(view.turns.map((turn) => turn.text)).toEqual(['We talked about the concert.'])

    // M4 is a reader of this port. Generating a turn must not append anything:
    // the record set is M5's to write, and only after a durable acknowledgement.
    expect(harness.backend.storedDeliveries()).toHaveLength(committedBefore)
    expect(await harness.store.readSession(FIXTURE_SESSION_ID)).toHaveLength(1)
  })

  it('takes both the record set and attribution from the durable source, not the local store', async () => {
    const harness = storeHarness()
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'First line.',
        seq: 10,
        personaProfileId: 'persona-a',
        personaProfileVersion: '1',
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-2',
        segmentId: 'turn-2-seg-0',
        text: 'Second line.',
        seq: 11,
        personaProfileId: 'persona-b',
        personaProfileVersion: '2',
      }),
    )

    // The local store only ever saw the second turn, under a contradictory
    // persona. It is a partial view, which is exactly why a non-empty local view
    // must never replace durable history, and why its persona map must never
    // override the durable record's own attribution.
    const memory = createDeliveryMemoryStore()
    expect(
      (
        await memory.commit(
          fixtureCommitDelivery({
            turnId: 'turn-2',
            segmentId: 'turn-2-seg-0',
            text: 'Second line.',
            textHash: 'hash-turn-2-seg-0',
            personaProfileId: 'persona-local',
            personaProfileVersion: '9',
          }),
        )
      ).status,
    ).toBe('applied')

    const view = await assembleOver({ history: harness.history, memory })

    expect(view.historySource).toBe('history-port')
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
    // Attribution is each durable record's own persisted pair, matched to no local
    // entry and borrowed from no local map.
    expect(view.turns.map((turn) => turn.personaVersion)).toEqual([
      personaVersionKey('persona-a', '1'),
      personaVersionKey('persona-b', '2'),
    ])
  })

  it('lists a receiptless delivery as confirmed history while M4 keeps it out of spoken memory', async () => {
    const harness = storeHarness()
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'We talked about the concert.',
        seq: 10,
        receiptId: null,
      }),
    )

    // M6 filters on the classification alone, so this record is confirmed
    // history from the storage layer's point of view.
    const records = await harness.history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(records.map((record) => record.segmentId)).toEqual(['turn-1-seg-0'])

    // M4 adds a second, narrower layer: speech without playback evidence was not
    // heard, so it must not be recalled as something she said.
    const view = await assembleOver({ history: harness.history })
    expect(view.turns).toEqual([])
    expect(view.exclusions.map((exclusion) => exclusion.reason)).toContain(
      'delivered-without-receipt',
    )
  })

  it('records nothing when the supporting event cannot be committed', async () => {
    const harness = storeHarness()
    // Session sequence 7 already belongs to another event, so the atomic commit
    // must fail as a whole rather than store the delivery without its event.
    await harness.store.append(
      fixtureRuntimeEvent({ eventId: 'other-event', seq: 7, sourceModule: 'M5' }),
    )

    const ack = await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'We talked about the concert.',
      seq: 7,
    })

    expect(ack.delivery).toMatchObject({ status: 'failed', reasonCode: 'conflict' })
    expect(ack.event).toMatchObject({ outcome: 'failed' })
    expect(await harness.history.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])

    // No durable acknowledgement means no memory: the seller's rule is that
    // memory is updated only after the commit is confirmed.
    const view = await assembleOver({ history: harness.history })
    expect(view.turns).toEqual([])
  })

  it('orders history by supporting event sequence, not by arrival order', async () => {
    const harness = storeHarness()
    // Arrival order is deliberately the reverse of the speaking order, so an
    // implementation that returned insertion order would fail here.
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-2',
        segmentId: 'turn-2-seg-0',
        text: 'Second turn.',
        seq: 20,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'First turn.',
        seq: 10,
      }),
    )

    const records = await harness.history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(records.map((record) => record.turnId)).toEqual(['turn-1', 'turn-2'])

    // M4 treats the tail of this list as the most recent turn, so the ordering
    // guarantee is what keeps "most recent" from meaning "last to arrive".
    const view = await assembleOver({ history: harness.history })
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
  })

  it('restores within-turn order from the explicit segment index, not the identifier', async () => {
    const harness = storeHarness()
    // The spelling of these ids disagrees with the speaking order (`alpha` would
    // sort before `omega`), and the second segment arrives first. Only the
    // persisted index can put the turn back together correctly.
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-alpha',
        text: 'Second half.',
        seq: 10,
        segmentIndex: 1,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-omega',
        text: 'First half.',
        seq: 20,
        segmentIndex: 0,
      }),
    )

    // The read order is the supporting event sequence, independent of the index.
    const records = await harness.history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(records.map((record) => record.segmentId)).toEqual(['turn-1-alpha', 'turn-1-omega'])
    expect(records.map((record) => record.segmentIndex)).toEqual([1, 0])

    // Within the turn, the persisted index - never the identifier spelling or the
    // arrival order - restores the speaking order.
    const view = await assembleOver({ history: harness.history })
    expect(view.turns[0]?.segments.map((segment) => segment.segmentId)).toEqual([
      'turn-1-omega',
      'turn-1-alpha',
    ])
    expect(view.turns[0]?.text).toBe('First half. Second half.')
  })

  it('orders known indices ascending, unknown last, and ties in source order', async () => {
    const harness = storeHarness()
    // Committed in an order that disagrees with both the index order and the id
    // spelling; the unknown index carries an id that would sort first. Ties on
    // index 2 are broken by the supporting event sequence, so the result is
    // stable rather than accidental.
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-aaa',
        text: 'Unknown position.',
        seq: 10,
        segmentIndex: null,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-zzz',
        text: 'Second position.',
        seq: 11,
        segmentIndex: 2,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-yyy',
        text: 'First position.',
        seq: 12,
        segmentIndex: 0,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-xxx',
        text: 'Second position tie.',
        seq: 13,
        segmentIndex: 2,
      }),
    )

    const view = await assembleOver({ history: harness.history })
    const segments = view.turns[0]?.segments ?? []
    expect(segments.map((segment) => segment.segmentId)).toEqual([
      'turn-1-yyy',
      'turn-1-zzz',
      'turn-1-xxx',
      'turn-1-aaa',
    ])
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([0, 2, 2, null])
  })

  it('keeps unknown and half-known persisted attribution unknown without local inference', async () => {
    const harness = storeHarness()
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-known',
        segmentId: 'turn-known-seg-0',
        text: 'Known persona line.',
        seq: 10,
        personaProfileId: 'persona-known',
        personaProfileVersion: '1',
      }),
    )
    const legacy: ReadonlyArray<{
      turnId: string
      personaProfileId: string | null
      personaProfileVersion: string | null
    }> = [
      { turnId: 'turn-half-id', personaProfileId: 'persona-known', personaProfileVersion: null },
      { turnId: 'turn-half-version', personaProfileId: null, personaProfileVersion: '1' },
      { turnId: 'turn-all-null', personaProfileId: null, personaProfileVersion: null },
    ]
    for (const [offset, entry] of legacy.entries()) {
      expectApplied(
        await commitSpoken(harness, {
          turnId: entry.turnId,
          segmentId: `${entry.turnId}-seg-0`,
          text: `${entry.turnId} line.`,
          seq: 11 + offset,
          personaProfileId: entry.personaProfileId,
          personaProfileVersion: entry.personaProfileVersion,
        }),
      )
    }

    // A local store holds a complete, contradictory pair for every key. It must
    // not fill in a missing durable component, nor override a complete one.
    const memory = createDeliveryMemoryStore()
    for (const entry of legacy) {
      expect(
        (
          await memory.commit(
            fixtureCommitDelivery({
              turnId: entry.turnId,
              segmentId: `${entry.turnId}-seg-0`,
              text: `${entry.turnId} line.`,
              textHash: `hash-${entry.turnId}-seg-0`,
              personaProfileId: 'persona-local',
              personaProfileVersion: '9',
            }),
          )
        ).status,
      ).toBe('applied')
    }

    const view = await assembleOver({ history: harness.history, memory })

    expect(view.historySource).toBe('history-port')
    // The raw persisted fields survive exactly as written.
    expect(
      view.history.map((record) => [
        record.turnId,
        record.personaProfileId,
        record.personaProfileVersion,
      ]),
    ).toEqual([
      ['turn-known', 'persona-known', '1'],
      ['turn-half-id', 'persona-known', null],
      ['turn-half-version', null, '1'],
      ['turn-all-null', null, null],
    ])
    // Only the complete pair is comparable; half-known and all-null stay unknown
    // rather than borrowing the local pair.
    expect(view.turns.map((turn) => turn.personaVersion)).toEqual([
      personaVersionKey('persona-known', '1'),
      null,
      null,
      null,
    ])
  })

  it('keeps sessions apart even when both reuse the same turn id', async () => {
    const harness = storeHarness()
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'We talked about the concert.',
        seq: 10,
      }),
    )
    // The session-scoped turn counter restarts, so a second session reuses
    // `turn-1`. Identity is `(sessionId, turnId)`, never the turn id alone.
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'A different session.',
        seq: 11,
        sessionId: 'session-other',
      }),
    )

    const archived = await assembleOver({ history: harness.history })
    expect(archived.turns.map((turn) => turn.text)).toEqual(['We talked about the concert.'])

    // A new session starts with no memory of the archived one. Remembering an
    // earlier session needs a source-session list from M5, not a wider query.
    expect(await harness.history.confirmedHistory('session-later')).toEqual([])
    const later = await assembleOver({
      history: harness.history,
      request: fixtureDialogueRequest({ sessionId: 'session-later' }),
    })
    expect(later.turns).toEqual([])
    expect(later.historySource).toBe('history-port')
  })

  it('rebuilds the same context after a restart over the same durable state', async () => {
    const backend = createInMemoryBackend()
    const before = storeHarness(backend)
    expectApplied(
      await commitSpoken(before, {
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'First turn.',
        seq: 10,
      }),
    )
    expectApplied(
      await commitSpoken(before, {
        turnId: 'turn-2',
        segmentId: 'turn-2-seg-0',
        text: 'Second turn.',
        seq: 11,
      }),
    )

    const first = await assembleOver({ history: before.history })

    // Restart: a fresh store and query over the durable state, with no carry-over
    // from the previous run.
    const reopened = storeHarness(backend)
    const second = await assembleOver({ history: reopened.history })

    expect(second.turns.map((turn) => turn.text)).toEqual(first.turns.map((turn) => turn.text))
    expect(renderDialoguePrompt(second)).toBe(renderDialoguePrompt(first))
  })
})

/**
 * The within-turn ordering rule is implemented twice: once as M5's
 * `orderTurnDeliveries` helper, which is the statement of the rule in
 * INTERFACES, and once as the comparison inline in `assembleDialogueContext`,
 * which is what actually reconstructs a turn. The shared conformance kit covers
 * the storage layer only, so nothing mechanically prevents the two from drifting
 * apart on the same data.
 *
 * This guard runs both over the same persisted records and fails if they
 * disagree. It reaches across the module boundary on purpose: the dependency
 * direction (a port implementation depending on the runtime layer) is
 * uncomfortable, so the options are either to move the helper somewhere both
 * modules can depend on, in which case this test is replaced by a direct call
 * and the local comparison is deleted, or to keep two implementations and keep
 * this guard.
 */
describe('M4 turn reconstruction agrees with the shared ordering helper', () => {
  it('produces the same segment order for known, tied and unknown indices', async () => {
    const harness = storeHarness()
    // Committed so that arrival order, identifier spelling and index order all
    // disagree, and covering every branch of the rule: a known index, a tie on
    // that index, a lower index, and an unknown index.
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-order',
        segmentId: 'seg-zzz',
        text: 'Unknown position.',
        seq: 10,
        segmentIndex: null,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-order',
        segmentId: 'seg-aaa',
        text: 'Second position, later event.',
        seq: 20,
        segmentIndex: 2,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-order',
        segmentId: 'seg-mmm',
        text: 'Second position, earlier event.',
        seq: 30,
        segmentIndex: 2,
      }),
    )
    expectApplied(
      await commitSpoken(harness, {
        turnId: 'turn-order',
        segmentId: 'seg-bbb',
        text: 'First position.',
        seq: 40,
        segmentIndex: 0,
      }),
    )

    const records = await harness.history.confirmedHistory(FIXTURE_SESSION_ID)
    const shared = orderTurnDeliveries(records, FIXTURE_SESSION_ID, 'turn-order').map(
      (record) => record.segmentId,
    )

    // The rule stated once, so the test cannot pass vacuously when both sides are
    // wrong in the same way: index 0, then the index-2 tie in supporting-event
    // order, then the unknown index last.
    expect(shared).toEqual(['seg-bbb', 'seg-aaa', 'seg-mmm', 'seg-zzz'])

    const view = await assembleOver({ history: harness.history })
    expect(view.turns[0]?.turnId).toBe('turn-order')
    expect(view.turns[0]?.segments.map((segment) => segment.segmentId)).toEqual(shared)
  })
})
