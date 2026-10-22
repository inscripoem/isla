import { describe, expect, it } from 'vitest'
import type {
  CallContext,
  DialogueRequest,
  DialogueSink,
  HistoryQueryPort,
} from '../../src/contracts'
import { createDeliveryMemoryStore } from '../../src/dialogue'
import type { DialogueOutcomeReport, DialogueTextSource } from '../../src/dialogue/dialogue-port'
import {
  createDialogueComposition,
  createReconstructedDialogueFromSelection,
} from '../../src/runtime/composition'
import type { DialogueOutcomeEvent, DialogueOutcomeObservation } from '../../src/runtime/dialogue-outcome'
import {
  KNOWN_DISCARD_REASONS,
  UNCLASSIFIED_DISCARD_REASON,
  projectDialogueOutcome,
} from '../../src/runtime/dialogue-outcome'
import { validateArchiveSelection } from '../../src/runtime/session-archives'
import { fixtureCommitDelivery } from '../support/fixture-data'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * M5 outcome-observer projection and wiring. This exercises the safe projection
 * (allow-listed fields, reason-key folding, totals preserved, malformed reports
 * refused) and the forwarding path through the direct and reconstructed dialogue
 * compositions. It also pins the producer's `deadline_exceeded` behaviour that the
 * evaluation mapping relies on: a fulfilled sink write before the expiry is a
 * prefix, not a completed turn.
 *
 * The channel is observational: nothing here writes to the store, and no provider
 * attempt is added. The held-call case is scoped diagnostic evidence for the
 * channel only; it is not a recovery-authority test.
 */

function report(over: Partial<DialogueOutcomeReport> = {}): DialogueOutcomeReport {
  return {
    requestId: 'dialogue-1',
    sessionId: 'session-a',
    epoch: 3,
    turnId: 'turn-7',
    generated: 2,
    emitted: 2,
    discarded: 0,
    discards: {},
    endStatus: 'completed',
    usageStatus: 'ok',
    ...over,
  }
}

function request(over: Partial<DialogueRequest> = {}): DialogueRequest {
  return {
    requestId: 'dialogue-1',
    sessionId: 'session-a',
    epoch: 1,
    turnId: 'turn-1',
    selectedInput: { eventId: 'event-1', text: 'hello there' },
    characterProfileId: 'character-fixture',
    characterProfileVersion: '1',
    responsePlan: {
      selectionRequestId: 'selection-1',
      selectedEventId: 'event-1',
      replyIntent: 'answer',
      policyVersion: 'policy-1',
    },
    confirmedEventRefs: [],
    contextLimits: { maxTurns: 4, maxCharacters: 2000 },
    ...over,
  }
}

const history: HistoryQueryPort = { confirmedHistory: async () => [] }

function context(deadlineMs = 60_000): CallContext {
  return { signal: new AbortController().signal, deadline: { atMs: deadlineMs } }
}

function collectingSink(onSegment?: () => void): { sink: DialogueSink; texts: string[] } {
  const texts: string[] = []
  return {
    texts,
    sink: {
      async segment(segment): Promise<void> {
        texts.push(segment.text)
        onSegment?.()
      },
    },
  }
}

describe('projectDialogueOutcome projection', () => {
  it('observes a well-formed report and copies its identity verbatim', () => {
    const event = projectDialogueOutcome(
      report({ sessionId: 'session-earlier', epoch: 9, turnId: 'turn-earlier' }),
    )
    expect(event).toEqual({
      kind: 'observed',
      observation: {
        requestId: 'dialogue-1',
        sessionId: 'session-earlier',
        epoch: 9,
        turnId: 'turn-earlier',
        generated: 2,
        emitted: 2,
        discarded: 0,
        discards: {},
        endStatus: 'completed',
        usageStatus: 'ok',
      },
    })
  })

  it('folds an unknown reason key into the fixed label while preserving totals', () => {
    const event = projectDialogueOutcome(
      report({
        generated: 5,
        emitted: 1,
        discarded: 4,
        discards: { deadline: 2, 'operator-note-that-must-not-leak': 2 },
      }),
    )
    expect(event.kind).toBe('observed')
    if (event.kind !== 'observed') return
    expect(event.observation.discards).toEqual({
      deadline: 2,
      [UNCLASSIFIED_DISCARD_REASON]: 2,
    })
    const total = Object.values(event.observation.discards).reduce((sum, n) => sum + n, 0)
    expect(total).toBe(event.observation.discarded)
    expect(Object.keys(event.observation.discards)).not.toContain(
      'operator-note-that-must-not-leak',
    )
  })

  it('drops extra fields a raw report might carry', () => {
    const raw = { ...report(), leakedText: 'hidden words', isRecorded: true }
    const event = projectDialogueOutcome(raw as DialogueOutcomeReport)
    expect(event.kind).toBe('observed')
    if (event.kind !== 'observed') return
    expect(Object.keys(event.observation).sort()).toEqual(
      [
        'discarded',
        'discards',
        'emitted',
        'endStatus',
        'epoch',
        'generated',
        'requestId',
        'sessionId',
        'turnId',
        'usageStatus',
      ].sort(),
    )
    expect(JSON.stringify(event.observation)).not.toContain('hidden words')
  })

  it('knows the documented producer reason keys', () => {
    for (const reason of KNOWN_DISCARD_REASONS) {
      const event = projectDialogueOutcome(
        report({ generated: 1, emitted: 0, discarded: 1, discards: { [reason]: 1 } }),
      )
      expect(event.kind).toBe('observed')
      if (event.kind === 'observed') {
        expect(Object.keys(event.observation.discards)).toEqual([reason])
      }
    }
  })

  it('refuses a report whose own accounting is inconsistent, never repairing a total', () => {
    const bad = [
      report({ generated: 2, emitted: 2, discarded: 3, discards: { deadline: 3 } }),
      report({ generated: 2, emitted: 1, discarded: 1, discards: { deadline: 2 } }),
      report({ generated: 2, emitted: 3, discarded: 0, discards: {} }),
      report({ discards: { deadline: -1 }, generated: 1, emitted: 0, discarded: 1 }),
      report({ discards: { deadline: 1.5 }, generated: 1, emitted: 0, discarded: 1 }),
      report({ endStatus: 'mystery' as DialogueOutcomeReport['endStatus'] }),
      report({ usageStatus: 'mystery' as DialogueOutcomeReport['usageStatus'] }),
      report({ requestId: '' }),
      report({ epoch: -1 }),
      // Counts beyond the safe-integer range are refused, not rounded.
      report({
        generated: Number.MAX_SAFE_INTEGER + 1,
        emitted: 1,
        discarded: Number.MAX_SAFE_INTEGER,
        discards: { deadline: Number.MAX_SAFE_INTEGER },
      }),
      report({ generated: 1, emitted: 0, discarded: 1, discards: { deadline: 1.0000001 } }),
    ]
    for (const value of bad) {
      expect(projectDialogueOutcome(value).kind).toBe('refused')
    }
  })

  it('returns a frozen observation that cannot be mutated in place', () => {
    const event = projectDialogueOutcome(
      report({ generated: 3, emitted: 1, discarded: 2, discards: { deadline: 2 } }),
    )
    expect(event.kind).toBe('observed')
    if (event.kind !== 'observed') return
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.observation)).toBe(true)
    expect(Object.isFrozen(event.observation.discards)).toBe(true)
    // A mutating consumer cannot corrupt the collected diagnostic (strict mode
    // turns the attempt into a contained throw).
    expect(() => {
      ;(event.observation as { emitted: number }).emitted = 0
    }).toThrow()
    expect(() => {
      ;(event.observation as { requestId: string }).requestId = 'tampered'
    }).toThrow()
    expect(() => {
      ;(event.observation.discards as Record<string, number>).injected = 5
    }).toThrow()
    expect(event.observation.emitted).toBe(1)
    expect(event.observation.requestId).toBe('dialogue-1')
    expect(event.observation.discards).toEqual({ deadline: 2 })
  })

  it('names the refusal without echoing producer-provided content', () => {
    const event = projectDialogueOutcome(
      report({ discards: { 'secret reason text': 1.5 }, discarded: 1, emitted: 1 }),
    )
    expect(event.kind).toBe('refused')
    if (event.kind === 'refused') {
      expect(event.reason).not.toContain('secret reason text')
    }
  })
})

describe('dialogue outcome wiring through the composition', () => {
  it('reports the request identity and accounting from the direct composition', async () => {
    const clock = createVirtualClock()
    const events: DialogueOutcomeEvent[] = []
    const composed = createDialogueComposition({
      clock,
      history,
      textSource: createCatalogDialogueTextSource(['first spoken line', 'second spoken line']),
      onDialogueOutcome: (event) => events.push(event),
    })
    const { sink, texts } = collectingSink()

    const end = await composed.dialogue.generate(
      request({ sessionId: 'session-live', epoch: 4, turnId: 'turn-9' }),
      context(),
      sink,
    )

    expect(end.status).toBe('completed')
    expect(texts).toHaveLength(2)
    expect(events).toEqual([
      {
        kind: 'observed',
        observation: {
          requestId: 'dialogue-1',
          sessionId: 'session-live',
          epoch: 4,
          turnId: 'turn-9',
          generated: 2,
          emitted: 2,
          discarded: 0,
          discards: {},
          endStatus: 'completed',
          usageStatus: 'ok',
        },
      },
    ])
  })

  it('keeps each report on its own request identity, in order', async () => {
    const clock = createVirtualClock()
    const events: DialogueOutcomeEvent[] = []
    const composed = createDialogueComposition({
      clock,
      history,
      textSource: createCatalogDialogueTextSource(['one spoken line']),
      onDialogueOutcome: (event) => events.push(event),
    })

    await composed.dialogue.generate(
      request({ requestId: 'dialogue-old', sessionId: 'session-old', epoch: 1, turnId: 'turn-old' }),
      context(),
      collectingSink().sink,
    )
    await composed.dialogue.generate(
      request({ requestId: 'dialogue-new', sessionId: 'session-new', epoch: 7, turnId: 'turn-new' }),
      context(),
      collectingSink().sink,
    )

    const identities = events.map((event) =>
      event.kind === 'observed'
        ? [event.observation.requestId, event.observation.sessionId, event.observation.epoch, event.observation.turnId]
        : null,
    )
    expect(identities).toEqual([
      ['dialogue-old', 'session-old', 1, 'turn-old'],
      ['dialogue-new', 'session-new', 7, 'turn-new'],
    ])
  })

  it('contains a throwing observer without changing generation or later reports', async () => {
    const clock = createVirtualClock()
    let calls = 0
    const composed = createDialogueComposition({
      clock,
      history,
      textSource: createCatalogDialogueTextSource(['one spoken line', 'another line']),
      onDialogueOutcome: () => {
        calls += 1
        throw new Error('observer fault')
      },
    })

    const first = collectingSink()
    const end = await composed.dialogue.generate(request(), context(), first.sink)
    expect(end.status).toBe('completed')
    expect(first.texts).toHaveLength(2)
    expect(calls).toBe(1)

    const second = collectingSink()
    const again = await composed.dialogue.generate(
      request({ turnId: 'turn-2' }),
      context(),
      second.sink,
    )
    expect(again.status).toBe('completed')
    expect(calls).toBe(2)
  })

  it('contains a rejecting async observer without an unhandled rejection', async () => {
    const clock = createVirtualClock()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const composed = createDialogueComposition({
        clock,
        history,
        textSource: createCatalogDialogueTextSource(['one spoken line']),
        onDialogueOutcome: () => Promise.reject(new Error('async observer fault')),
      })
      const end = await composed.dialogue.generate(request(), context(), collectingSink().sink)
      expect(end.status).toBe('completed')
      // Let any detached rejection surface before the assertion.
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('reports a deadline expiry after a fulfilled sink write as the clock cause, not success', async () => {
    const clock = createVirtualClock()
    const events: DialogueOutcomeEvent[] = []
    const composed = createDialogueComposition({
      clock,
      history,
      textSource: createCatalogDialogueTextSource(['first spoken line', 'second spoken line']),
      onDialogueOutcome: (event) => events.push(event),
    })
    // The first sink write fulfils, then the clock passes the dialogue deadline.
    const { sink, texts } = collectingSink(() => clock.advance(60_001))

    const end = await composed.dialogue.generate(request(), context(60_000), sink)

    expect(end.status).toBe('deadline_exceeded')
    expect(end.segmentCount).toBe(1)
    expect(texts).toHaveLength(1)
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event.kind).toBe('observed')
    if (event.kind !== 'observed') return
    expect(event.observation).toMatchObject({
      generated: 2,
      emitted: 1,
      discarded: 1,
      discards: { deadline: 1 },
      endStatus: 'deadline_exceeded',
      usageStatus: 'timeout',
    })
  })

  it('cannot corrupt collected evidence when a consumer mutates the event it received', async () => {
    const clock = createVirtualClock()
    const captured: DialogueOutcomeObservation[] = []
    const composed = createDialogueComposition({
      clock,
      history,
      textSource: createCatalogDialogueTextSource(['one spoken line']),
      onDialogueOutcome: (event) => {
        if (event.kind !== 'observed') return
        captured.push(event.observation)
        for (const mutate of [
          () => {
            ;(event as { kind: string }).kind = 'refused'
          },
          () => {
            ;(event.observation as { emitted: number }).emitted = 0
          },
          () => {
            ;(event.observation.discards as Record<string, number>).injected = 5
          },
        ]) {
          try {
            mutate()
          } catch {
            // The frozen projection contains the in-place mutation attempt.
          }
        }
      },
    })

    const end = await composed.dialogue.generate(request(), context(), collectingSink().sink)

    expect(end.status).toBe('completed')
    expect(captured).toHaveLength(1)
    expect(captured[0].requestId).toBe('dialogue-1')
    expect(captured[0].emitted).toBe(1)
    expect(captured[0].discards).toEqual({})
    expect(Object.keys(captured[0].discards)).not.toContain('injected')
  })

  it('forwards the observer through the reconstructed dialogue composition', async () => {
    const clock = createVirtualClock()
    const events: DialogueOutcomeEvent[] = []
    const reconstructed = createReconstructedDialogueFromSelection(
      validateArchiveSelection({
        liveSessionId: 'session-live',
        liveProfile: { profileId: 'character-fixture', profileVersion: '1' },
        selectedSources: [{ sessionId: 'archive-a' }],
        catalogue: new Map([
          ['archive-a', { profileId: 'character-fixture', profileVersion: '1' }],
        ]),
      }),
      {
        clock,
        history,
        textSource: createCatalogDialogueTextSource(['one spoken line']),
        onDialogueOutcome: (event) => events.push(event),
      },
    )

    const end = await reconstructed.dialogue.generate(
      request({ sessionId: 'session-live', turnId: 'turn-live' }),
      context(),
      collectingSink().sink,
    )

    expect(end.status).toBe('completed')
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event.kind).toBe('observed')
    if (event.kind !== 'observed') return
    expect(event.observation).toMatchObject({
      sessionId: 'session-live',
      turnId: 'turn-live',
      generated: 1,
      emitted: 1,
    })
  })

  it('attributes a late outcome to its own request identity when a later composition exists', async () => {
    /*
     * Scoped diagnostic evidence for the observer channel only. This is NOT a
     * recovery-authority test: there is no coordinator, no successor adoption and
     * no retired-session fencing here. It pins that a call held across the
     * construction of a second composition keeps its own identity and contributes
     * nothing to the later composition's history view.
     */
    const clock = createVirtualClock()
    /*
     * The shared store is the state a late completion could contaminate: the later
     * composition reads its history through it, while each composition's delivery
     * memory is private. The store starts with the delivered prefix that existed
     * before the later composition was built.
     */
    const store = createDeliveryMemoryStore()
    await store.commit(
      fixtureCommitDelivery({
        sessionId: 'session-earlier',
        turnId: 'turn-earlier',
        segmentId: 'segment-earlier',
        textHash: 'hash-earlier',
        text: 'spoken before the later composition',
        outputId: 'output-earlier',
        receiptId: 'receipt-earlier',
      }),
    )
    const history: HistoryQueryPort = {
      confirmedHistory: (sessionId) => store.confirmedHistory(sessionId),
    }

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    const heldSource: DialogueTextSource = {
      model: 'held-model',
      modelVersion: '1',
      resolvedModel: null,
      async compose() {
        entered()
        await held
        return ['a line from the earlier session']
      },
    }

    const earlierEvents: DialogueOutcomeEvent[] = []
    const earlier = createDialogueComposition({
      clock,
      history,
      textSource: heldSource,
      onDialogueOutcome: (event) => earlierEvents.push(event),
    })
    const earlierSink = collectingSink()
    const pending = earlier.dialogue.generate(
      request({
        requestId: 'dialogue-earlier',
        sessionId: 'session-earlier',
        epoch: 3,
        turnId: 'turn-earlier',
      }),
      context(),
      earlierSink.sink,
    )
    // The earlier call is in flight and held before it produces anything.
    await enteredPromise
    expect(earlierEvents).toEqual([])

    // Build the later composition while the earlier call is still in flight, and
    // read the later composition's own history view before the late completion.
    const laterSession = 'session-later'
    const laterEvents: DialogueOutcomeEvent[] = []
    const later = createReconstructedDialogueFromSelection(
      validateArchiveSelection({
        liveSessionId: laterSession,
        liveProfile: { profileId: 'character-fixture', profileVersion: '1' },
        selectedSources: [{ sessionId: 'session-earlier' }],
        catalogue: new Map([
          ['session-earlier', { profileId: 'character-fixture', profileVersion: '1' }],
        ]),
      }),
      {
        clock,
        history,
        textSource: createCatalogDialogueTextSource(['a line from the later session']),
        onDialogueOutcome: (event) => laterEvents.push(event),
      },
    )
    const laterHistoryBefore = structuredClone(await later.history.confirmedHistory(laterSession))
    expect(laterHistoryBefore.map((record) => record.turnId)).toEqual(['turn-earlier'])

    const laterSink = collectingSink()
    const laterEnd = await later.dialogue.generate(
      request({
        requestId: 'dialogue-later',
        sessionId: laterSession,
        epoch: 1,
        turnId: 'turn-later',
      }),
      context(),
      laterSink.sink,
    )
    expect(laterEnd.status).toBe('completed')

    // Only now does the earlier call complete, after the later composition exists.
    release()
    const earlierEnd = await pending
    expect(earlierEnd.status).toBe('completed')

    // The late report keeps the earlier request's own identity and accounting.
    expect(earlierEvents).toEqual([
      {
        kind: 'observed',
        observation: {
          requestId: 'dialogue-earlier',
          sessionId: 'session-earlier',
          epoch: 3,
          turnId: 'turn-earlier',
          generated: 1,
          emitted: 1,
          discarded: 0,
          discards: {},
          endStatus: 'completed',
          usageStatus: 'ok',
        },
      },
    ])
    // It never reaches the later composition's channel, sink or history.
    expect(laterEvents).toEqual([
      expect.objectContaining({
        kind: 'observed',
        observation: expect.objectContaining({
          requestId: 'dialogue-later',
          sessionId: laterSession,
          epoch: 1,
          turnId: 'turn-later',
        }),
      }),
    ])
    expect(laterSink.texts).toEqual(['a line from the later session'])
    expect(earlierSink.texts).toEqual(['a line from the earlier session'])
    expect(await later.history.confirmedHistory(laterSession)).toEqual(laterHistoryBefore)
    expect(await later.memory.records()).toEqual([])
    expect(JSON.stringify(await later.history.confirmedHistory(laterSession))).not.toContain(
      'a line from the earlier session',
    )
  })
})
