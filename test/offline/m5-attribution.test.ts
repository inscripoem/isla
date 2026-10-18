import { describe, expect, it } from 'vitest'
import type {
  CommitDelivery,
  ConfirmedDelivery,
  DialoguePort,
  DialogueRequest,
  EventStorePort,
  MemoryCommitPort,
  PlayerPort,
} from '../../src/contracts'
import {
  commitDeliverySchema,
  confirmedDeliverySchema,
  dialogueEndSchema,
  dialogueSegmentSchema,
} from '../../src/contracts'
import { createRuntimeCoordinator } from '../../src/runtime/coordinator'
import type { SessionProfileConfig } from '../../src/runtime/coordinator'
import { orderTurnDeliveries } from '../../src/runtime/delivery-order'
import { createEventStore, createHistoryQuery, createInMemoryBackend } from '../../src/storage'
import * as correct from '../support/correct-ports'
import { createCancelTerminalPlayer, createScriptedReceiptPlayer } from '../support/gated-ports'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureOperatorContext,
  fixturePerformanceReceipt,
  fixtureRuntimeEvent,
  fixtureUsage,
  fixtureViewerContext,
} from '../support/fixture-data'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * Storage-contract revision 2026-10-14.1 behavioural acceptance.
 *
 * The production M5 coordinator captures the original `segmentIndex`,
 * `personaProfileId` and `personaProfileVersion` and M6 round-trips them. This
 * focused file covers the capture path (before M4 can mutate the request, on a
 * normal completion, on a Stop and on a late terminal receipt), two sessions
 * sharing the real in-memory backend, the supporting event's separate version
 * keys, reverse-looking segment identifiers with explicit indices, legacy null
 * versus omitted-field validation, and changed-attribution conflicts. It keeps
 * the original real-adapter regression coverage in `m6-storage.test.ts`.
 */

interface HarnessOptions {
  store: EventStorePort
  sessionId?: string
  profile?: Partial<SessionProfileConfig>
  dialogue?: DialoguePort
  player?: PlayerPort
  commit?: MemoryCommitPort
}

function createHarness(options: HarnessOptions) {
  const sessionId = options.sessionId ?? FIXTURE_SESSION_ID
  const clock = createVirtualClock()
  let messageCounter = 0
  const nextId = (prefix: string): string => `${prefix}-${++messageCounter}`
  const coordinator = createRuntimeCoordinator({
    clock,
    authorizer: correct.createFixtureControlAuthorizer(),
    selection: correct.createFixtureSelectionPort(),
    reaction: correct.createFixtureReactionPort(),
    dialogue: options.dialogue ?? correct.createFixtureDialoguePort(),
    synthesis: correct.createFixtureSynthesisPort(),
    renderer: correct.createFixtureRendererPort(),
    player: options.player ?? correct.createFixturePlayer(),
    commit: options.commit ?? correct.createFixtureMemoryCommit(),
    store: options.store,
    sessionId,
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
  })
  return {
    sessionId,
    coordinator,
    resume: () =>
      coordinator.endpoint.control(
        {
          protocolVersion: '0.2',
          kind: 'control.resume',
          messageId: nextId('msg'),
          sessionId,
          epoch: coordinator.epoch(),
          payload: { requestId: nextId('control') },
        },
        fixtureOperatorContext(),
      ),
    stop: () =>
      coordinator.endpoint.control(
        {
          protocolVersion: '0.2',
          kind: 'control.stop',
          messageId: nextId('msg'),
          sessionId,
          epoch: coordinator.epoch(),
          payload: { requestId: nextId('control') },
        },
        fixtureOperatorContext(),
      ),
    accept: (text: string) =>
      coordinator.endpoint.submitInput(
        {
          protocolVersion: '0.2',
          messageId: nextId('msg'),
          sessionId,
          epoch: coordinator.epoch(),
          kind: 'input.submit',
          payload: { source: 'local-audience', text },
        },
        fixtureViewerContext(),
      ),
  }
}

/** Deterministic dialogue port emitting the given segments in explicit index order. */
function scriptedDialogue(
  segments: ReadonlyArray<{ segmentId: string; text: string }>,
  hooks: { beforeEmit?: (request: DialogueRequest) => void } = {},
): DialoguePort {
  return {
    async generate(request, context, sink) {
      hooks.beforeEmit?.(request)
      let index = 0
      for (const segment of segments) {
        if (context.signal.aborted) break
        await sink.segment(
          dialogueSegmentSchema.parse({
            requestId: request.requestId,
            sessionId: request.sessionId,
            epoch: request.epoch,
            turnId: request.turnId,
            segmentId: segment.segmentId,
            index,
            text: segment.text,
            model: 'fixture',
            modelVersion: 'fixture-v1',
          }),
        )
        index += 1
      }
      return dialogueEndSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        status: 'completed',
        segmentCount: segments.length,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

describe('M5 delivery attribution capture (C-47)', () => {
  it('captures the original index and persona on a normal delivery and its event versions', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const harness = createHarness({
      store,
      profile: { characterProfileId: 'persona-normal', characterProfileVersion: '7' },
    })
    await harness.resume()
    await harness.accept('normal attribution')
    expect((await harness.coordinator.runTurn()).status).toBe('completed')

    const [delivery] = harness.coordinator.deliveries()
    expect(delivery?.segmentIndex).toBe(0)
    expect(delivery?.personaProfileId).toBe('persona-normal')
    expect(delivery?.personaProfileVersion).toBe('7')

    const committed = harness.coordinator
      .events()
      .find((event) => event.type === 'delivery.committed')
    // Identity and version use separate keys; they are never concatenated.
    expect(committed?.versions).toEqual({
      personaProfileId: 'persona-normal',
      personaProfileVersion: '7',
    })
    expect(Object.keys(committed?.versions ?? {}).sort()).toEqual([
      'personaProfileId',
      'personaProfileVersion',
    ])

    const [record] = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(record?.segmentIndex).toBe(0)
    expect(record?.personaProfileId).toBe('persona-normal')
    expect(record?.personaProfileVersion).toBe('7')
  })

  it('captures the persona before M4 can mutate the original dialogue request', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const seen: DialogueRequest[] = []
    const dialogue = scriptedDialogue(
      [{ segmentId: 'segment-mutate', text: 'original persona speech' }],
      {
        beforeEmit: (request) => {
          seen.push(request)
          request.characterProfileId = 'mutated-persona'
          request.characterProfileVersion = '999'
        },
      },
    )
    const harness = createHarness({
      store,
      dialogue,
      profile: { characterProfileId: 'persona-original', characterProfileVersion: '3' },
    })
    await harness.resume()
    await harness.accept('mutation attribution')
    expect((await harness.coordinator.runTurn()).status).toBe('completed')

    // The peer really did mutate the request it received...
    expect(seen[0]?.characterProfileId).toBe('mutated-persona')
    expect(seen[0]?.characterProfileVersion).toBe('999')
    // ...but the recorded attribution stays the captured original persona.
    const [delivery] = harness.coordinator.deliveries()
    expect(delivery?.personaProfileId).toBe('persona-original')
    expect(delivery?.personaProfileVersion).toBe('3')
    const [record] = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(record?.personaProfileId).toBe('persona-original')
    expect(record?.personaProfileVersion).toBe('3')
  })

  it('keeps the original attribution when a Stop finalizes a later segment', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const basePlayer = createCancelTerminalPlayer()
    let requestStop: () => Promise<void> = async () => {}
    let executeIndex = 0
    const player: PlayerPort = {
      async execute(command, context) {
        const result = basePlayer.execute(command, context)
        const index = executeIndex
        executeIndex += 1
        if (index === 1) await requestStop()
        return result
      },
      cancel: (request, context) => basePlayer.cancel(request, context),
      status: () => basePlayer.status(),
    }
    const harness = createHarness({
      store,
      player,
      dialogue: scriptedDialogue([
        { segmentId: 'segment-stop-0', text: 'first stop segment' },
        { segmentId: 'segment-stop-1', text: 'second stop segment' },
      ]),
      profile: { characterProfileId: 'persona-stop', characterProfileVersion: '4' },
    })
    requestStop = async () => {
      await harness.stop()
    }
    await harness.resume()
    await harness.accept('stop attribution')
    expect((await harness.coordinator.runTurn()).status).toBe('cancelled')

    const deliveries = harness.coordinator.deliveries()
    expect(deliveries).toHaveLength(2)
    expect(deliveries.map((delivery) => delivery.segmentIndex)).toEqual([0, 1])
    expect(deliveries.every((delivery) => delivery.personaProfileId === 'persona-stop')).toBe(true)
    expect(deliveries.every((delivery) => delivery.personaProfileVersion === '4')).toBe(true)
    expect(deliveries[1]?.classification).toBe('partial-unknown')

    // Only the completed first segment enters fully-delivered spoken history.
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]?.segmentIndex).toBe(0)
    expect(confirmed[0]?.personaProfileId).toBe('persona-stop')
  })

  it('finalizes a late terminal receipt with the original attribution', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const player = createScriptedReceiptPlayer((_command, call) => ({
      stage: call === 0 ? 'unknown' : 'completed',
    }))
    const harness = createHarness({
      store,
      player,
      profile: { characterProfileId: 'persona-late', characterProfileVersion: '5' },
    })
    await harness.resume()
    await harness.accept('late receipt attribution')
    const turnEpoch = harness.coordinator.epoch()
    expect((await harness.coordinator.runTurn()).status).toBe('cancelled')
    expect(harness.coordinator.deliveries()).toHaveLength(0)

    // Stop after the unknown outcome, before the old-epoch terminal evidence
    // arrives: the historical delivery must keep its original epoch and persona.
    expect((await harness.stop()).status).toBe('applied')
    expect(harness.coordinator.epoch()).toBe(turnEpoch + 1)
    expect(harness.coordinator.lifecycle()).toBe('stopped')

    const command = player.commands()[0]!
    await harness.coordinator.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-late-receipt',
      sessionId: harness.sessionId,
      epoch: command.epoch,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({
        receiptId: `receipt-terminal-${command.outputId}`,
        outputId: command.outputId,
        sessionId: harness.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'completed',
      }),
    })

    const [delivery] = harness.coordinator.deliveries()
    expect(delivery?.classification).toBe('fully-delivered')
    expect(delivery?.segmentIndex).toBe(0)
    expect(delivery?.personaProfileId).toBe('persona-late')
    expect(delivery?.personaProfileVersion).toBe('5')

    const committed = harness.coordinator
      .events()
      .filter((event) => event.type === 'delivery.committed')
    const latest = committed[committed.length - 1]!
    // The late evidence finalizes the historical record under its original epoch,
    // not the epoch advanced by Stop.
    expect(latest.epoch).toBe(command.epoch)
    expect(latest.epoch).toBe(turnEpoch)
    expect(latest.versions).toEqual({
      personaProfileId: 'persona-late',
      personaProfileVersion: '5',
    })
    expect(harness.coordinator.lifecycle()).toBe('stopped')

    const [record] = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(record?.segmentIndex).toBe(0)
    expect(record?.personaProfileId).toBe('persona-late')
  })

  it('keeps per-session attribution when two sessions share the real store', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const alpha = createHarness({
      store,
      sessionId: 'session-alpha',
      profile: { characterProfileId: 'persona-alpha', characterProfileVersion: '1' },
    })
    const beta = createHarness({
      store,
      sessionId: 'session-beta',
      profile: { characterProfileId: 'persona-beta', characterProfileVersion: '2' },
    })
    await alpha.resume()
    await beta.resume()
    await alpha.accept('alpha input')
    await beta.accept('beta input')
    expect((await alpha.coordinator.runTurn()).status).toBe('completed')
    expect((await beta.coordinator.runTurn()).status).toBe('completed')

    const historyAlpha = await history.confirmedHistory('session-alpha')
    const historyBeta = await history.confirmedHistory('session-beta')
    expect(historyAlpha).toHaveLength(1)
    expect(historyBeta).toHaveLength(1)
    expect(
      historyAlpha.every(
        (record) =>
          record.sessionId === 'session-alpha' &&
          record.personaProfileId === 'persona-alpha' &&
          record.personaProfileVersion === '1',
      ),
    ).toBe(true)
    expect(
      historyBeta.every(
        (record) =>
          record.sessionId === 'session-beta' &&
          record.personaProfileId === 'persona-beta' &&
          record.personaProfileVersion === '2',
      ),
    ).toBe(true)

    const readAlpha = await store.readSession('session-alpha')
    const readBeta = await store.readSession('session-beta')
    expect(readAlpha.length).toBeGreaterThan(0)
    expect(readAlpha.every((event) => event.sessionId === 'session-alpha')).toBe(true)
    expect(readBeta.every((event) => event.sessionId === 'session-beta')).toBe(true)
    expect(JSON.stringify(readAlpha)).not.toContain('session-beta')
    expect(JSON.stringify(readBeta)).not.toContain('session-alpha')
    expect(readAlpha.find((event) => event.type === 'delivery.committed')?.versions).toEqual({
      personaProfileId: 'persona-alpha',
      personaProfileVersion: '1',
    })
  })

  it('records explicit indices for reverse-looking identifiers and reconstructs by index', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const harness = createHarness({
      store,
      dialogue: scriptedDialogue([
        { segmentId: 'segment-9', text: 'first spoken segment' },
        { segmentId: 'segment-1', text: 'second spoken segment' },
      ]),
      profile: { characterProfileId: 'persona-order', characterProfileVersion: '6' },
    })
    await harness.resume()
    await harness.accept('reverse identifiers')
    expect((await harness.coordinator.runTurn()).status).toBe('completed')

    const deliveries = harness.coordinator.deliveries()
    expect(deliveries.map((delivery) => delivery.segmentId)).toEqual(['segment-9', 'segment-1'])
    // 'segment-9' was emitted first, so its index is 0; the index is never parsed
    // from the identifier text.
    expect(deliveries.map((delivery) => delivery.segmentIndex)).toEqual([0, 1])

    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.segmentId)).toEqual(['segment-9', 'segment-1'])
    const reconstructed = [...confirmed].sort(
      (a, b) => (a.segmentIndex ?? -1) - (b.segmentIndex ?? -1),
    )
    expect(reconstructed.map((record) => record.segmentId)).toEqual(['segment-9', 'segment-1'])
    const byIdentifier = [...confirmed]
      .sort((a, b) => a.segmentId.localeCompare(b.segmentId))
      .map((record) => record.segmentId)
    expect(byIdentifier).toEqual(['segment-1', 'segment-9'])
    expect(reconstructed.map((record) => record.segmentId)).not.toEqual(byIdentifier)
  })
})

describe('M6 delivery attribution persistence (C-46)', () => {
  it('rejects omitted attribution fields and accepts explicit legacy nulls', () => {
    const complete: Record<string, unknown> = { ...fixtureCommitDelivery() }
    for (const field of ['segmentIndex', 'personaProfileId', 'personaProfileVersion'] as const) {
      const omitted = { ...complete }
      delete omitted[field]
      expect(commitDeliverySchema.safeParse(omitted).success).toBe(false)
    }
    const legacyNull = {
      ...complete,
      segmentIndex: null,
      personaProfileId: null,
      personaProfileVersion: null,
    }
    expect(commitDeliverySchema.safeParse(legacyNull).success).toBe(true)

    const confirmedComplete = {
      sessionId: FIXTURE_SESSION_ID,
      turnId: 'turn-confirmed',
      segmentId: 'segment-confirmed',
      textHash: 'hash-confirmed',
      text: 'confirmed spoken',
      outputId: null,
      receiptId: null,
      classification: 'fully-delivered',
      modality: 'audio',
      segmentIndex: 0,
      personaProfileId: 'persona-confirmed',
      personaProfileVersion: '1',
    } as const
    for (const field of ['segmentIndex', 'personaProfileId', 'personaProfileVersion'] as const) {
      const omitted: Record<string, unknown> = { ...confirmedComplete }
      delete omitted[field]
      expect(confirmedDeliverySchema.safeParse(omitted).success).toBe(false)
    }
    expect(
      confirmedDeliverySchema.safeParse({
        ...confirmedComplete,
        segmentIndex: null,
        personaProfileId: null,
        personaProfileVersion: null,
      }).success,
    ).toBe(true)
  })

  it('round-trips explicit-null legacy attribution without inferring or backfilling', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 'turn-legacy',
        // A numeric-looking identifier must not become an index.
        segmentId: 'segment-7',
        textHash: 'hash-legacy',
        text: 'legacy spoken',
        segmentIndex: null,
        personaProfileId: null,
        personaProfileVersion: null,
      }),
      fixtureRuntimeEvent({ eventId: 'evt-legacy', seq: 1, type: 'delivery.committed' }),
    )

    const first = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(first).toHaveLength(1)
    expect(first[0]?.segmentIndex).toBeNull()
    expect(first[0]?.personaProfileId).toBeNull()
    expect(first[0]?.personaProfileVersion).toBeNull()
    // A later read must not infer an index from the identifier or apply a persona.
    const second = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(second[0]?.segmentIndex).toBeNull()
    expect(second[0]?.personaProfileId).toBeNull()
    expect(second[0]?.personaProfileVersion).toBeNull()
  })

  it('orders confirmed history by supporting-event seq and reconstructs by explicit index', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const commit = (segmentId: string, segmentIndex: number, eventId: string, seq: number) =>
      store.commitDeliveryWithEvent(
        fixtureCommitDelivery({
          turnId: 'turn-order',
          segmentId,
          textHash: `hash-${segmentId}`,
          text: `text-${segmentId}`,
          segmentIndex,
          personaProfileId: 'persona-order',
          personaProfileVersion: '1',
        }),
        fixtureRuntimeEvent({ eventId, seq, type: 'delivery.committed' }),
      )

    // Insertion order, sequence order, explicit-index order and identifier
    // spelling are all deliberately different: the commits are inserted out of
    // sequence order.
    await commit('segment-1', 1, 'evt-order-1', 3)
    await commit('segment-10', 2, 'evt-order-10', 1)
    await commit('segment-2', 0, 'evt-order-2', 2)

    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    // History follows the supporting-event sequence.
    expect(confirmed.map((record) => record.segmentId)).toEqual([
      'segment-10',
      'segment-2',
      'segment-1',
    ])
    // Reconstruction follows the explicit index, not the sequence or identifier.
    const reconstructed = [...confirmed].sort(
      (a, b) => (a.segmentIndex ?? -1) - (b.segmentIndex ?? -1),
    )
    expect(reconstructed.map((record) => record.segmentId)).toEqual([
      'segment-2',
      'segment-1',
      'segment-10',
    ])
    const byIdentifier = [...confirmed]
      .sort((a, b) => a.segmentId.localeCompare(b.segmentId))
      .map((record) => record.segmentId)
    expect(reconstructed.map((record) => record.segmentId)).not.toEqual(byIdentifier)
  })

  it('conflicts changed index or persona and preserves acknowledgement semantics and history', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const history = createHistoryQuery(backend)
    const base = fixtureCommitDelivery({
      turnId: 'turn-conflict',
      segmentId: 'segment-conflict',
      textHash: 'hash-conflict',
      text: 'conflict spoken',
      segmentIndex: 0,
      personaProfileId: 'persona-base',
      personaProfileVersion: '1',
    })
    let seq = 0
    const commit = (overrides: Partial<CommitDelivery>, eventId: string) => {
      seq += 1
      return store.commitDeliveryWithEvent(
        { ...base, ...overrides },
        fixtureRuntimeEvent({ eventId, seq, type: 'delivery.committed' }),
      )
    }

    const first = await commit({}, 'evt-conflict-base')
    expect(first.delivery.status).toBe('applied')
    expect(first.event.outcome).toBe('stored')

    // An identical re-commit stays an idempotent duplicate.
    const duplicate = await commit({}, 'evt-conflict-dup')
    expect(duplicate.delivery).toMatchObject({
      status: 'duplicate',
      effectiveClassification: 'fully-delivered',
      recordId: expect.any(String),
    })

    const changedIndex = await commit({ segmentIndex: 1 }, 'evt-conflict-index')
    expect(changedIndex.delivery).toMatchObject({
      status: 'conflict',
      recordedClassification: 'fully-delivered',
      incomingClassification: 'fully-delivered',
    })

    const changedPersona = await commit(
      { personaProfileId: 'persona-other' },
      'evt-conflict-persona',
    )
    expect(changedPersona.delivery.status).toBe('conflict')

    const changedVersion = await commit({ personaProfileVersion: '2' }, 'evt-conflict-version')
    expect(changedVersion.delivery.status).toBe('conflict')

    // A classification change with unchanged text and attribution still conflicts.
    const changedClassification = await commit(
      { classification: 'not-delivered', terminalOutcome: 'failed' },
      'evt-conflict-class',
    )
    expect(changedClassification.delivery.status).toBe('conflict')

    // Null -> known attribution is a change, never a silent backfill.
    const legacyBase = fixtureCommitDelivery({
      turnId: 'turn-conflict-legacy',
      segmentId: 'segment-conflict-legacy',
      textHash: 'hash-conflict-legacy',
      text: 'legacy conflict',
      segmentIndex: null,
      personaProfileId: null,
      personaProfileVersion: null,
    })
    await store.commitDeliveryWithEvent(
      legacyBase,
      fixtureRuntimeEvent({ eventId: 'evt-conflict-legacy', seq: 50, type: 'delivery.committed' }),
    )
    const knownAfterLegacy = await store.commitDeliveryWithEvent(
      { ...legacyBase, segmentIndex: 0 },
      fixtureRuntimeEvent({ eventId: 'evt-conflict-known', seq: 51, type: 'delivery.committed' }),
    )
    expect(knownAfterLegacy.delivery.status).toBe('conflict')

    const confirmed = (await history.confirmedHistory(FIXTURE_SESSION_ID)).filter(
      (record) => record.turnId === 'turn-conflict',
    )
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]).toMatchObject({
      segmentIndex: 0,
      personaProfileId: 'persona-base',
      personaProfileVersion: '1',
      classification: 'fully-delivered',
    })
  })
})

describe('M5 delivery attribution capture (C-47) turn reconstruction ordering (INV-15)', () => {
  const record = (
    overrides: Partial<ConfirmedDelivery> & { segmentId: string; segmentIndex: number | null },
  ): ConfirmedDelivery =>
    confirmedDeliverySchema.parse({
      sessionId: FIXTURE_SESSION_ID,
      turnId: 'turn-order',
      textHash: `hash-${overrides.segmentId}`,
      text: `text-${overrides.segmentId}`,
      outputId: null,
      receiptId: null,
      classification: 'fully-delivered',
      modality: 'audio',
      personaProfileId: null,
      personaProfileVersion: null,
      ...overrides,
    })

  it('orders known indices ascending, unknowns last, ties and unknowns in supporting-event order', () => {
    // Input order is the HistoryQueryPort order (supporting-event seq ascending).
    // It deliberately disagrees with index order, and unknown indices carry no
    // original position. Other sessions and turns are excluded.
    const input: ConfirmedDelivery[] = [
      record({ segmentId: 'segment-unknown-a', segmentIndex: null }),
      record({ segmentId: 'segment-two', segmentIndex: 2 }),
      record({ segmentId: 'segment-unknown-b', segmentIndex: null }),
      record({ segmentId: 'segment-zero', segmentIndex: 0 }),
      record({ segmentId: 'segment-two-tie', segmentIndex: 2 }),
      record({ segmentId: 'other-session', segmentIndex: 1, sessionId: 'session-elsewhere' }),
      record({ segmentId: 'other-turn', segmentIndex: 1, turnId: 'turn-other' }),
    ]

    const ordered = orderTurnDeliveries(input, FIXTURE_SESSION_ID, 'turn-order')
    expect(ordered.map((entry) => entry.segmentId)).toEqual([
      'segment-zero',
      'segment-two',
      'segment-two-tie',
      'segment-unknown-a',
      'segment-unknown-b',
    ])
    // Unknown indices remain unknown and are never given a claimed position.
    expect(ordered.slice(-2).every((entry) => entry.segmentIndex === null)).toBe(true)
    // The helper is pure and does not mutate its input or the read order.
    expect(input[0]?.segmentId).toBe('segment-unknown-a')
    expect(input.map((entry) => entry.segmentId)).toContain('other-session')
  })
})
