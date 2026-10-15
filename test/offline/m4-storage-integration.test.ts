import { describe, expect, it } from 'vitest'
import { createDeliveryMemoryStore, createDialoguePort, renderDialoguePrompt } from '../../src/dialogue'
import type { AssembledDialogueContext, DialogueMemory, DialogueTextSource } from '../../src/dialogue'
import { createEventStore, createHistoryQuery, createInMemoryBackend } from '../../src/storage'
import type { StorageBackend } from '../../src/storage'
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

/** The supporting event M5 constructs for a delivery commit (see coordinator). */
function deliveryEvent(input: {
  seq: number
  turnId: string
  segmentId: string
  eventId?: string
  sessionId?: string
}): RuntimeEvent {
  return fixtureRuntimeEvent({
    eventId: input.eventId ?? `delivery-event-${input.seq}`,
    seq: input.seq,
    sessionId: input.sessionId ?? FIXTURE_SESSION_ID,
    turnId: input.turnId,
    segmentId: input.segmentId,
    type: 'delivery.committed',
  })
}

/**
 * Persist one spoken segment the way M5 does: one delivery plus its own
 * supporting event, through the single atomic entry point. One event per segment
 * is what gives each record its own `seq`, and therefore its position in
 * confirmed history.
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
  },
): Promise<AtomicCommitAck> {
  return harness.store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId: input.sessionId ?? FIXTURE_SESSION_ID,
      turnId: input.turnId,
      segmentId: input.segmentId,
      text: input.text,
      textHash: `hash-${input.segmentId}`,
      outputId: input.outputId ?? `output-${input.segmentId}`,
      receiptId: input.receiptId === undefined ? `receipt-${input.segmentId}` : input.receiptId,
    }),
    deliveryEvent({
      seq: input.seq,
      turnId: input.turnId,
      segmentId: input.segmentId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    }),
  )
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
  memory?: DialogueMemory
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
    const ack = await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'We talked about the concert.',
      seq: 10,
    })
    expect(ack.delivery).toMatchObject({ status: 'applied' })
    expect(ack.event).toMatchObject({ outcome: 'stored' })

    const committedBefore = harness.backend.storedDeliveries().length
    const view = await assembleOver({ history: harness.history })

    expect(view.historySource).toBe('history-port')
    expect(view.turns.map((turn) => turn.text)).toEqual(['We talked about the concert.'])

    // M4 is a reader of this port. Generating a turn must not append anything:
    // the record set is M5's to write, and only after a durable acknowledgement.
    expect(harness.backend.storedDeliveries()).toHaveLength(committedBefore)
    expect(await harness.store.readSession(FIXTURE_SESSION_ID)).toHaveLength(1)
  })

  it('takes the record set from the durable source and only attribution from the local store', async () => {
    const harness = storeHarness()
    await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'First line.',
      seq: 10,
    })
    await commitSpoken(harness, {
      turnId: 'turn-2',
      segmentId: 'turn-2-seg-0',
      text: 'Second line.',
      seq: 11,
    })

    // The local store only ever saw the second turn. It is a partial view, which
    // is exactly why a non-empty local view must never replace durable history:
    // choosing it would drop the first turn.
    const memory = createDeliveryMemoryStore()
    memory.noteTurnPersona(FIXTURE_SESSION_ID, 'turn-2', 'character-fixture@1')
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-2',
        segmentId: 'turn-2-seg-0',
        text: 'Second line.',
        textHash: 'hash-turn-2-seg-0',
      }),
    )

    const view = await assembleOver({ history: harness.history, memory })

    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
    // Attribution still comes from the local side, matched by delivery key.
    expect(view.turns.map((turn) => turn.personaVersion)).toEqual([null, 'character-fixture@1'])
  })

  it('lists a receiptless delivery as confirmed history while M4 keeps it out of spoken memory', async () => {
    const harness = storeHarness()
    const ack = await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'We talked about the concert.',
      seq: 10,
      receiptId: null,
    })
    expect(ack.delivery).toMatchObject({ status: 'applied' })

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
    await commitSpoken(harness, {
      turnId: 'turn-2',
      segmentId: 'turn-2-seg-0',
      text: 'Second turn.',
      seq: 20,
    })
    await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'First turn.',
      seq: 10,
    })

    const records = await harness.history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(records.map((record) => record.turnId)).toEqual(['turn-1', 'turn-2'])

    // M4 treats the tail of this list as the most recent turn, so the ordering
    // guarantee is what keeps "most recent" from meaning "last to arrive".
    const view = await assembleOver({ history: harness.history })
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
  })

  it('restores within-turn order by reading the segment id, the only signal a record carries', async () => {
    const harness = storeHarness()
    // Both segments of one turn persisted against the same supporting event, as
    // M5 may do when one turn is confirmed in one step: the two records then tie
    // on `eventSeq`, and the query returns them in arrival order.
    const shared = deliveryEvent({
      seq: 10,
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      eventId: 'turn-1-event',
    })
    await harness.store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-1',
        text: 'Second half.',
        textHash: 'hash-turn-1-seg-1',
        outputId: 'output-turn-1-seg-1',
        receiptId: 'receipt-turn-1-seg-1',
      }),
      shared,
    )
    await harness.store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-1',
        segmentId: 'turn-1-seg-0',
        text: 'First half.',
        textHash: 'hash-turn-1-seg-0',
        outputId: 'output-turn-1-seg-0',
        receiptId: 'receipt-turn-1-seg-0',
      }),
      shared,
    )

    const records = await harness.history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(records.map((record) => record.segmentId)).toEqual(['turn-1-seg-1', 'turn-1-seg-0'])

    // The record set carries no ordinal, so the only reason M4 can put these back
    // in speaking order is that it parses the derived segment id. Issue #22 ruled
    // that outcome out: the authoritative carrier is `DialogueSegment.index`, and
    // M5 is coordinating carrying it through delivery persistence and history
    // reconstruction. When that lands, this expectation is expected to change and
    // the id-derived path is to be deleted rather than kept as a fallback.
    const view = await assembleOver({ history: harness.history })
    expect(view.turns[0]?.segments.map((segment) => segment.segmentId)).toEqual([
      'turn-1-seg-0',
      'turn-1-seg-1',
    ])
    expect(view.turns[0]?.text).toBe('First half. Second half.')
  })

  it('keeps sessions apart even when both reuse the same turn id', async () => {
    const harness = storeHarness()
    await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'We talked about the concert.',
      seq: 10,
    })
    // The session-scoped turn counter restarts, so a second session reuses
    // `turn-1`. Identity is `(sessionId, turnId)`, never the turn id alone.
    await commitSpoken(harness, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'A different session.',
      seq: 11,
      sessionId: 'session-other',
    })

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
    await commitSpoken(before, {
      turnId: 'turn-1',
      segmentId: 'turn-1-seg-0',
      text: 'First turn.',
      seq: 10,
    })
    await commitSpoken(before, {
      turnId: 'turn-2',
      segmentId: 'turn-2-seg-0',
      text: 'Second turn.',
      seq: 11,
    })

    const first = await assembleOver({ history: before.history })

    // Restart: a fresh store and query over the durable state, with no carry-over
    // from the previous run.
    const reopened = storeHarness(backend)
    const second = await assembleOver({ history: reopened.history })

    expect(second.turns.map((turn) => turn.text)).toEqual(first.turns.map((turn) => turn.text))
    expect(renderDialoguePrompt(second)).toBe(renderDialoguePrompt(first))
  })
})
