import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ControlAck,
  EventStorePort,
  RuntimeEvent,
  SelectionPort,
  SelectionRequest,
  SelectionResult,
  SynthesisPort,
} from '../../src/contracts'
import { controlAckSchema } from '../../src/contracts'
import { createMonotonicClock } from '../../src/runtime/clock'
import type { RuntimeCoordinator } from '../../src/runtime/coordinator'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import { createEventStore } from '../../src/storage/event-store'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import { createDeferringSelectionPort, createFixtureSelectionPort } from '../support/correct-ports'
import { openAdoptionSession } from '../support/i1-adoption'
import type { AdoptionSession } from '../support/i1-adoption'
import type { LoopHarness, LoopHarnessOptions } from '../support/i1-harness'
import { createControlledMediaDriver } from '../support/m1-kit'
import { createTestProductionPeers } from '../support/production-kit'

/**
 * Reusable adoption checks for the local I1 loop.
 *
 * Every case runs the real application endpoint, the real M5 coordinator and
 * the real M1 browser-side playback controller over a genuine loopback socket.
 * The peer substitutes are the controlled test kit; this is bounded API
 * evidence, not acoustic playback, a live provider or SQLite restart recovery.
 */

/**
 * The harness module is wrapped only to observe the session it built, so a
 * failed setup can be shown to close the server and performer it started. The
 * wrapper delegates every call to the real harness.
 */
const harnessProbe = vi.hoisted(() => ({
  harness: null as unknown as LoopHarness | null,
  closeStarted: false,
  closeCompleted: false,
}))

vi.mock('../support/i1-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/i1-harness')>()
  return {
    ...actual,
    createLoopHarness: async (options: Parameters<typeof actual.createLoopHarness>[0]) => {
      const harness = await actual.createLoopHarness(options)
      harnessProbe.harness = harness
      harnessProbe.closeStarted = false
      harnessProbe.closeCompleted = false
      const close = harness.close.bind(harness)
      harness.close = async () => {
        harnessProbe.closeStarted = true
        await close()
        harnessProbe.closeCompleted = true
      }
      return harness
    },
  }
})

const sessions: AdoptionSession[] = []

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => {})
})

async function adopt(options: LoopHarnessOptions = {}): Promise<AdoptionSession> {
  const session = await openAdoptionSession(options)
  sessions.push(session)
  return session
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function selectionWentStale(events: readonly RuntimeEvent[]): boolean {
  return events.some((event) => event.type === 'result.stale' && event.payload.stage === 'selection')
}

interface PlanEvidence {
  readonly turnId: string | null
  readonly requestId: unknown
  readonly disposition: unknown
  readonly selectedEventIds: readonly string[]
}

function planEvidence(events: readonly RuntimeEvent[]): PlanEvidence[] {
  // A selection plan carries no turn id. Each `respond` plan is persisted
  // immediately before the `turn.started` it opens, so the plans and started
  // turns pair in order; a `defer` plan opens no turn.
  const startedTurnIds = events
    .filter((event) => event.type === 'turn.started')
    .map((event) => event.turnId)
  const plans: PlanEvidence[] = []
  let nextStarted = 0
  for (const event of events) {
    if (event.type !== 'selection.plan') continue
    const plan = (event.payload as { plan?: Record<string, unknown> }).plan ?? {}
    const ids = plan.selectedEventIds
    const responds = plan.disposition === 'respond'
    plans.push({
      turnId: responds ? (startedTurnIds[nextStarted] ?? null) : null,
      requestId: plan.requestId,
      disposition: plan.disposition,
      selectedEventIds: Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string')
        : [],
    })
    if (responds) nextStarted += 1
  }
  return plans
}

function firstSelectionRequestId(events: readonly RuntimeEvent[]): string | null {
  const call = events.find(
    (event) => event.type === 'provider.call' && event.payload.call === 'selection',
  )
  const requestId = call?.payload.requestId
  return typeof requestId === 'string' ? requestId : null
}

function completedTurns(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  return events.filter(
    (event) => event.type === 'turn.ended' && event.payload.status === 'completed',
  )
}

function deliveriesFor(events: readonly RuntimeEvent[], turnId: string | null): RuntimeEvent[] {
  return events.filter((event) => event.type === 'delivery.committed' && event.turnId === turnId)
}

function performanceOffers(session: AdoptionSession): number {
  return session.harness.client
    .messages()
    .filter((message) => message.kind === 'performance.offer').length
}

function turnEndStatuses(events: readonly RuntimeEvent[]): unknown[] {
  return events.filter((event) => event.type === 'turn.ended').map((event) => event.payload.status)
}

/**
 * Selection whose first call is held until the test releases it, and whose later
 * calls answer each request with the newest offered candidate. The base fixture
 * supplies the valid result shape and usage record.
 */
function createLateSelectingPort(): {
  readonly port: SelectionPort
  calls(): number
  releaseLate(): Promise<void>
} {
  const base = createFixtureSelectionPort()
  let calls = 0
  let held: {
    request: SelectionRequest
    context: Parameters<SelectionPort['select']>[1]
    resolve: (result: SelectionResult) => void
  } | null = null
  return {
    port: {
      select(request, context) {
        calls += 1
        if (calls === 1) {
          return new Promise<SelectionResult>((resolve) => {
            held = { request, context, resolve }
          })
        }
        return base.select(request, context).then((result) => {
          const newest = request.candidates[request.candidates.length - 1]
          return newest === undefined ? result : { ...result, selectedEventIds: [newest.eventId] }
        })
      },
    },
    calls: () => calls,
    async releaseLate() {
      if (held === null) throw new Error('no held selection to release')
      const late = await base.select(held.request, held.context)
      held.resolve(late)
    },
  }
}

describe('M5 I1 adoption checks', () => {
  it('times out a held selection, ignores its late result and completes a later candidate', async () => {
    const selection = createLateSelectingPort()
    const session = await adopt({
      clock: createMonotonicClock(),
      selection: selection.port,
      timings: { selectionMs: 80 },
    })

    const firstAck = await session.harness.client.input('first, held selection')
    expect((firstAck.payload as { status: string }).status).toBe('accepted')
    const firstId = (firstAck.payload as { eventId: string }).eventId

    const stale = await session.until(() => session.events(), selectionWentStale)
    expect(stale.some((event) => event.type === 'turn.started')).toBe(false)
    expect(stale.some((event) => event.type === 'dialogue.result')).toBe(false)
    // The timed-out invocation's own request id must never appear in a plan:
    // that is what makes the late result inadopted rather than merely delayed.
    const lateRequestId = firstSelectionRequestId(stale)
    expect(lateRequestId).not.toBeNull()

    await selection.releaseLate()
    // Bounded observation, not a proof of absence: after the release there is no
    // dialogue, no playback offer and no retry for the unchanged candidate set.
    await delay(150)
    const afterLate = await session.events()
    expect(afterLate.some((event) => event.type === 'turn.started')).toBe(false)
    expect(session.harness.composition.coordinator.deliveries()).toHaveLength(0)
    expect(
      session.harness.client
        .messages()
        .some((message) => message.kind === 'performance.offer' || message.kind === 'performance.grant'),
    ).toBe(false)
    expect(selection.calls()).toBe(1)

    const secondAck = await session.harness.client.input('second candidate')
    const secondId = (secondAck.payload as { eventId: string }).eventId
    expect(secondId).not.toBe(firstId)
    const events = await session.until(() => session.events(), (all) => completedTurns(all).length > 0)

    const plans = planEvidence(events)
    const completed = completedTurns(events)[0]
    // The completed turn is the one whose plan selected the accepted second
    // input, not merely the first turn that happened to finish.
    expect(plans[0]?.selectedEventIds).toEqual([secondId])
    expect(completed?.turnId).toBe(plans[0]?.turnId)
    expect(deliveriesFor(events, plans[0]?.turnId ?? null)).toHaveLength(1)
    expect(plans.every((plan) => plan.requestId !== lateRequestId)).toBe(true)

    const history = await session.harness.confirmedHistory()
    expect(history.some((delivery) => delivery.turnId === completed?.turnId)).toBe(true)
  })

  it('does not poll an unchanged deferred selection and selects a new candidate', async () => {
    const deferring = createDeferringSelectionPort()
    const base = createFixtureSelectionPort()
    let calls = 0
    const port: SelectionPort = {
      async select(request, context) {
        calls += 1
        if (calls === 1) return deferring.select(request, context)
        const result = await base.select(request, context)
        const newest = request.candidates[request.candidates.length - 1]
        return newest === undefined ? result : { ...result, selectedEventIds: [newest.eventId] }
      },
    }
    const session = await adopt({ clock: createMonotonicClock(), selection: port })

    const deferredAck = await session.harness.client.input('deferred input')
    const deferredId = (deferredAck.payload as { eventId: string }).eventId
    const deferred = await session.until(
      () => session.events(),
      (events) =>
        planEvidence(events).some((plan) => plan.disposition === 'defer'),
    )
    expect(deferred.some((event) => event.type === 'turn.started')).toBe(false)

    // The deferred candidate set is unchanged, so no cycle wakes to poll it.
    // The wait is a bounded observation, not a proof of no future polling.
    await delay(150)
    expect(calls).toBe(1)
    expect(session.harness.composition.coordinator.deliveries()).toHaveLength(0)

    const newAck = await session.harness.client.input('new candidate after defer')
    const newId = (newAck.payload as { eventId: string }).eventId
    // Delivery persistence can precede the turn terminal record, so wait for the
    // completed turn itself before correlating plans, deliveries and history.
    const events = await session.until(
      () => session.events(),
      (all) => completedTurns(all).length > 0,
    )
    const history = await session.harness.confirmedHistory()
    const plans = planEvidence(events)
    expect(plans[0]?.disposition).toBe('defer')
    const firstRespond = plans.find((plan) => plan.disposition === 'respond')
    // The completed turn selected the newly accepted input, not the deferred
    // one, and its delivery is the confirmed history record.
    expect(firstRespond?.selectedEventIds).toEqual([newId])
    expect(firstRespond?.selectedEventIds).not.toContain(deferredId)
    const completed = completedTurns(events)[0]
    expect(completed?.turnId).toBe(firstRespond?.turnId)
    expect(deliveriesFor(events, firstRespond?.turnId ?? null)).toHaveLength(1)
    expect(history.some((delivery) => delivery.turnId === completed?.turnId)).toBe(true)
  })

  it('fails before any output and then completes fresh input without replaying the failed work', async () => {
    const clock = createMonotonicClock()
    const peers = createTestProductionPeers({ clock })
    let failPreparations = true
    let preparations = 0
    const createSynthesis: NonNullable<LoopHarnessOptions['createSynthesis']> = (
      gate: RuntimeDeadlineGate,
    ): SynthesisPort => {
      const base = peers.createSynthesis(gate)
      return {
        async prepare(request, context) {
          preparations += 1
          if (failPreparations) throw new Error('adoption synthesis failure before output')
          return base.prepare(request, context)
        },
      }
    }
    const session = await adopt({ clock, createSynthesis, timings: { synthesisMs: 1000 } })

    const firstAck = await session.harness.client.input('first turn fails in synthesis')
    const firstId = (firstAck.payload as { eventId: string }).eventId
    const failedEvents = await session.until(
      () => session.events(),
      (events) => turnEndStatuses(events).length > 0,
    )

    expect(preparations).toBe(1)
    expect(turnEndStatuses(failedEvents)).toEqual(['failed'])
    expect(planEvidence(failedEvents)[0]?.selectedEventIds).toEqual([firstId])
    expect(failedEvents.filter((event) => event.type === 'delivery.committed')).toHaveLength(0)
    expect(
      failedEvents.some(
        (event) => event.type === 'dependency.failed' && event.payload.stage === 'synthesis',
      ),
    ).toBe(true)
    const failedDialogue = failedEvents.find((event) => event.type === 'dialogue.result')
    expect((failedDialogue?.payload.end as { status?: unknown } | undefined)?.status).toBe(
      'completed',
    )
    expect(performanceOffers(session)).toBe(0)
    expect(await session.harness.confirmedHistory()).toHaveLength(0)

    failPreparations = false
    const secondAck = await session.harness.client.input('second turn after the fault is cleared')
    const secondId = (secondAck.payload as { eventId: string }).eventId
    const events = await session.until(
      () => session.events(),
      (all) => completedTurns(all).length > 0,
    )

    const plans = planEvidence(events)
    expect(plans).toHaveLength(2)
    expect(plans[1]?.selectedEventIds).toEqual([secondId])
    expect(plans[1]?.selectedEventIds).not.toContain(firstId)
    expect(turnEndStatuses(events)).toEqual(['failed', 'completed'])
    // Only the successful turn commits a delivery; the failed turn is not
    // retried or replayed and its input is never dispatched again.
    const committed = events.filter((event) => event.type === 'delivery.committed')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.turnId).toBe(plans[1]?.turnId)
    expect(performanceOffers(session)).toBe(1)
    const history = await session.harness.confirmedHistory()
    expect(history).toHaveLength(1)
    expect(history[0]?.turnId).toBe(plans[1]?.turnId)
  })

  it('keeps a completed prefix when a later synthesis fails and records a failed turn end', async () => {
    const clock = createMonotonicClock()
    const peers = createTestProductionPeers({ clock })
    let preparations = 0
    const createSynthesis: NonNullable<LoopHarnessOptions['createSynthesis']> = (
      gate: RuntimeDeadlineGate,
    ): SynthesisPort => {
      const base = peers.createSynthesis(gate)
      return {
        async prepare(request, context) {
          preparations += 1
          if (preparations === 2) throw new Error('adoption synthesis failure')
          return base.prepare(request, context)
        },
      }
    }
    const session = await adopt({
      clock,
      realM4: true,
      createSynthesis,
      timings: { synthesisMs: 1000 },
    })

    await session.harness.client.input('two segments, the second synthesis fails')
    const events = await session.until(
      () => session.events(),
      (all) => all.some((event) => event.type === 'turn.ended'),
    )

    expect(preparations).toBe(2)
    const dialogue = events.find((event) => event.type === 'dialogue.result')
    expect((dialogue?.payload.end as { status?: unknown } | undefined)?.status).toBe('completed')
    expect(turnEndStatuses(events)).toEqual(['failed'])
    expect(
      events.some(
        (event) => event.type === 'dependency.failed' && event.payload.stage === 'synthesis',
      ),
    ).toBe(true)

    // The first segment was delivered before the second failed: the prefix stays
    // in confirmed history and the failed segment commits no delivery.
    const committed = events.filter((event) => event.type === 'delivery.committed')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.payload.classification).toBe('fully-delivered')
    const history = await session.harness.confirmedHistory()
    expect(history).toHaveLength(1)
    expect(history[0]?.segmentIndex).toBe(0)
    expect(session.harness.composition.coordinator.deliveries()).toHaveLength(1)
  })

  it('accepts fresh input after an unconfirmed reconnect but blocks before selection or playback', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    media.holdEndedFrom(0)
    // A short playback budget lets the disconnected turn reach its bounded
    // terminal bookkeeping instead of holding the scheduler for the default
    // 30-second window.
    const session = await adopt({ media, timings: { playbackMs: 300 } })

    await session.harness.client.input('held for reconnect')
    await session.until(
      () => session.harness.client.receipts(),
      (receipts) => receipts.some((receipt) => receipt.stage === 'started'),
    )
    await session.harness.client.disconnect()
    await session.until(
      async () => (await session.harness.composition.coordinator.endpoint.snapshot()).outputConfirmation,
      (confirmation) => confirmation !== 'confirmed',
    )
    // Wait for the disconnected output to finalize, so the scheduler is free to
    // admit the next cycle instead of reporting it busy.
    await session.until(
      () => session.events(),
      (events) => events.some((event) => event.type === 'turn.ended'),
    )

    const reconnected = session.harness.newClient()
    try {
      await reconnected.snapshot
      const token = await session.harness.bootstrapOperator()
      await reconnected.bootstrapOperator(token)
      expect((await reconnected.attach()).kind).toBe('session.attach.ack')
      const resume = await reconnected.resume()
      expect((resume.payload as { status: string }).status).toBe('refused')

      const beforeFresh = session.harness.composition.coordinator.metrics().selectionAttempts
      const startedBefore = (await session.events()).filter(
        (event) => event.type === 'turn.started',
      ).length
      const ack = await reconnected.input('fresh input after reconnect')
      expect((ack.payload as { status: string }).status).toBe('accepted')
      // Bounded observation: the accepted input reaches a blocked cycle because
      // playback evidence is unconfirmed, so it never selects or plays.
      await delay(150)
      expect(session.harness.composition.coordinator.metrics().selectionAttempts).toBe(beforeFresh)
      const afterFresh = await session.events()
      expect(afterFresh.filter((event) => event.type === 'turn.started')).toHaveLength(startedBefore)
      expect(
        reconnected.messages().some(
          (message) => message.kind === 'performance.offer' || message.kind === 'performance.grant',
        ),
      ).toBe(false)
      expect(
        (await session.harness.composition.coordinator.endpoint.snapshot()).outputConfirmation,
      ).not.toBe('confirmed')
    } finally {
      await reconnected.close().catch(() => {})
    }
  })

  it('reads an explicitly supplied store instead of the harness backend', async () => {
    const base = createEventStore(createInMemoryBackend())
    let reads = 0
    const store: EventStorePort = {
      append: (event) => base.append(event),
      commitDeliveryWithEvent: (delivery, event) => base.commitDeliveryWithEvent(delivery, event),
      readSession: (sessionId) => {
        reads += 1
        return base.readSession(sessionId)
      },
      exportJsonl: (sessionId) => base.exportJsonl(sessionId),
    }

    const session = await adopt({ clock: createMonotonicClock(), store })
    const events = await session.events()

    expect(reads).toBeGreaterThan(0)
    // The harness backend is a different, empty store; these events exist only
    // in the supplied store, so returning them proves which store was read.
    expect(events.some((event) => event.type === 'session.resumed')).toBe(true)
  })

  it('closes the harness and preserves the error when setup is refused', async () => {
    const wrapCoordinator = (coordinator: RuntimeCoordinator): RuntimeCoordinator => ({
      ...coordinator,
      endpoint: {
        ...coordinator.endpoint,
        control: (message, context): Promise<ControlAck> => {
          if (message.kind !== 'control.resume') {
            return coordinator.endpoint.control(message, context)
          }
          return Promise.resolve(
            controlAckSchema.parse({
              sessionId: message.sessionId,
              requestId: message.payload.requestId,
              requestMessageId: message.messageId,
              action: 'resume',
              status: 'refused',
              previousEpoch: coordinator.epoch(),
              epoch: coordinator.epoch(),
              lifecycle: coordinator.lifecycle(),
              outputConfirmation: coordinator.outputConfirmation(),
              reasonCode: 'storage_unavailable',
              message: 'injected setup refusal',
            }),
          )
        },
      },
    })

    const failure = await openAdoptionSession({ clock: createMonotonicClock(), wrapCoordinator }).catch(
      (error: unknown) => error,
    )

    // The setup error is the original refusal, not a cleanup fault.
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('adoption session: performer resume was refused')
    expect(harnessProbe.closeStarted).toBe(true)
    expect(harnessProbe.closeCompleted).toBe(true)
  })
})
