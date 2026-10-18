import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  MAX_PINNED_TURNS,
  MAX_RECALLED_TURNS,
  MIN_RECALL_SCORE,
  SALIENCE_PIN_THRESHOLD,
  createDeliveryMemoryStore,
  createDialoguePort,
  createKeywordDeliveryRecall,
  renderDialoguePrompt,
  scoreSalience,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DeliveryMemoryStore,
  DialogueTextSource,
  PersonaRecallPort,
} from '../../src/dialogue'
import type {
  CallContext,
  ClockPort,
  DialogueEnd,
  DialoguePort,
  DialogueRequest,
  DialogueSegment,
  HistoryQueryPort,
} from '../../src/contracts'

/**
 * Tests for the retention extras: salience pinning, the rollup line and
 * delivery-memory recall. Fixture deadlines live in the injected clock's
 * domain, so every port under test shares this clock (see m4-dialogue.test).
 */
const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

function captureView(): { view: AssembledDialogueContext | null } {
  return { view: null }
}

function capturingTextSource(capture: { view: AssembledDialogueContext | null }): DialogueTextSource {
  return {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(view, _maxSegments) {
      capture.view = view
      return ['Captured reply.']
    },
  }
}

async function generate(
  port: DialoguePort,
  request: DialogueRequest = fixtureDialogueRequest(),
  context: CallContext = createCallContext(),
): Promise<{ segments: DialogueSegment[]; end: DialogueEnd }> {
  const segments: DialogueSegment[] = []
  const end = await port.generate(request, context, {
    segment: async (segment) => {
      segments.push(segment)
    },
  })
  return { segments, end }
}

/** Commit one fully-delivered single-segment turn into the store. */
async function commitTurn(
  memory: DeliveryMemoryStore,
  turnId: string,
  text: string,
  sessionId: string = FIXTURE_SESSION_ID,
): Promise<void> {
  await memory.commit(
    fixtureCommitDelivery({
      sessionId,
      turnId,
      segmentId: `${turnId}-seg-0`,
      textHash: `hash-${turnId}`,
      text,
    }),
  )
}

async function assembleWith(
  memory: DeliveryMemoryStore,
  options: {
    request?: DialogueRequest
    history?: HistoryQueryPort
    deliveryRecall?: ReturnType<typeof createKeywordDeliveryRecall>
    personaRecall?: PersonaRecallPort
  } = {},
): Promise<AssembledDialogueContext> {
  const capture = captureView()
  const port = createDialoguePort({
    clock: FIXTURE_CLOCK,
    history: options.history ?? memory,
    textSource: capturingTextSource(capture),
    ...(options.deliveryRecall === undefined ? {} : { deliveryRecall: options.deliveryRecall }),
    ...(options.personaRecall === undefined ? {} : { personaRecall: options.personaRecall }),
  })
  await generate(port, options.request ?? fixtureDialogueRequest())
  const view = capture.view
  if (view === null) throw new Error('context was not assembled')
  return view
}

describe('M4 salience pinning', () => {
  it('keeps a pinned old turn over an unpinned newer one under budget pressure', async () => {
    const memory = createDeliveryMemoryStore()
    // '- Remember this: my birthday is 0603.' renders at 37, pinned (promise+digit).
    await commitTurn(memory, 'turn-old', 'Remember this: my birthday is 0603.')
    await commitTurn(memory, 'turn-mid', 'A plain line about nothing much.')
    await commitTurn(memory, 'turn-new', 'Another plain reply for today.')

    // 37 + 32 = 69 fits the pinned turn and the newest one; adding the plain
    // middle turn (34) would exceed it. Only the budget forces a choice.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 69 } }),
    })

    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-old', 'turn-new'])
    expect(view.turns[0]?.pinned).toBe(true)
    expect(view.turns[0]?.salienceSignals).toContain('promise')
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-mid' && entry.reason === 'character-budget',
      ),
    ).toBe(true)
    expect(view.truncatedByCharacterLimit).toBe(true)
  })

  it('caps the number of pinned turns and keeps the oldest on ties', async () => {
    const memory = createDeliveryMemoryStore()
    for (const n of [1, 2, 3, 4]) {
      await commitTurn(memory, `turn-${n}`, `Remember this: fact ${n} about us.`)
    }

    const view = await assembleWith(memory)
    expect(view.turns).toHaveLength(4)
    expect(view.turns.every((turn) => turn.salienceScore >= SALIENCE_PIN_THRESHOLD)).toBe(true)
    // Equal scores: the pin exists to protect early memories, so the newest of
    // the four is the one that loses its pin.
    expect(view.turns.map((turn) => turn.pinned)).toEqual([
      ...Array<boolean>(MAX_PINNED_TURNS).fill(true),
      false,
    ])
  })

  it('still drops a pinned turn when nothing fits, and reports the loss', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-pinned', 'Remember this: my birthday is 0603.')

    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 10 } }),
    })

    // A pin is trim-order only, never a budget exemption.
    expect(view.turns).toEqual([])
    expect(view.rollup).toBeNull()
    expect(view.estimatedCharacters).toBe(0)
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-pinned' && entry.reason === 'character-budget',
      ),
    ).toBe(true)
    expect(view.warnings.some((warning) => warning.includes('does not fit'))).toBe(true)
  })

  it('scores no signal for empty or plain text', () => {
    expect(scoreSalience('...!?').score).toBe(0)
    expect(scoreSalience('We talked about the concert.').score).toBe(0)
    expect(scoreSalience('记住我们的约定').score).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
  })

  it('is deterministic: the same history pins the same turns twice', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-pin', 'Remember this: my birthday is 0603.')
    await commitTurn(memory, 'turn-plain', 'A plain line about nothing much.')

    const first = await assembleWith(memory)
    const second = await assembleWith(memory)
    expect(first.turns.map((turn) => turn.pinned)).toEqual(second.turns.map((turn) => turn.pinned))
    expect(scoreSalience('Remember this: my birthday is 0603.')).toEqual(
      scoreSalience('Remember this: my birthday is 0603.'),
    )
  })
})

describe('M4 rollup line', () => {
  const OLD_TEXT = `${'x'.repeat(30)}.`

  it('renders a counted rollup for trimmed turns when room remains', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-old-1', OLD_TEXT)
    await commitTurn(memory, 'turn-old-2', OLD_TEXT)
    await commitTurn(memory, 'turn-old-3', OLD_TEXT)
    await commitTurn(memory, 'turn-new', 'Newest reply for today.')

    // Each old line renders at 33, the newest at 25. Budget 88 forces exactly
    // two drops (124 -> 91 -> 58) and leaves 30 characters of slack, which the
    // 27-character rollup line fits.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 88 } }),
    })

    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-old-3', 'turn-new'])
    expect(view.rollup).toEqual({ omittedTurns: 2, characters: 27 })
    expect(view.estimatedCharacters).toBe(58 + 27)
    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('(2 earlier turns omitted)')
  })

  it('survives non-contiguous trimming when a pinned middle turn holds its place', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-old-1', OLD_TEXT)
    await commitTurn(memory, 'turn-pinned', 'Remember this: my birthday is 0603.')
    await commitTurn(memory, 'turn-old-3', `${'y'.repeat(30)}.`)
    await commitTurn(memory, 'turn-new', 'Newest reply for today.')

    // 33 + 37 + 33 + 25 = 128; budget 89 drops the two plain old turns and
    // leaves the pinned middle one in place. The rollup reports both omissions.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 89 } }),
    })

    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-pinned', 'turn-new'])
    expect(view.rollup?.omittedTurns).toBe(2)
  })

  it('omits the rollup when even the line itself does not fit', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-old-1', OLD_TEXT)
    await commitTurn(memory, 'turn-old-2', OLD_TEXT)
    await commitTurn(memory, 'turn-old-3', OLD_TEXT)
    await commitTurn(memory, 'turn-new', 'Newest reply for today.')

    // Budget 70 drops two turns but leaves only 12 characters of slack, which
    // the rollup line does not fit. The rollup never costs an extra turn.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 70 } }),
    })

    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-old-3', 'turn-new'])
    expect(view.rollup).toBeNull()
    expect(view.truncatedByCharacterLimit).toBe(true)
    expect(view.estimatedCharacters).toBe(58)
  })

  it('has no rollup when nothing was trimmed', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-only', 'We talked about the concert.')

    const view = await assembleWith(memory)
    expect(view.rollup).toBeNull()
    expect(renderDialoguePrompt(view)).not.toContain('omitted')
  })
})

describe('M4 delivery-memory recall', () => {
  async function memoryWithOldAndNew(): Promise<DeliveryMemoryStore> {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-old', 'The concert was loud and bright tonight.')
    await commitTurn(memory, 'turn-mid', 'A plain remark about the weather today.')
    await commitTurn(memory, 'turn-new', 'A plain reply for today.')
    return memory
  }

  const RECALLING_REQUEST = fixtureDialogueRequest({
    selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
    contextLimits: { maxTurns: 2, maxCharacters: 2000 },
  })

  it('recalls a turn-limit-dropped turn that matches the listener message', async () => {
    const memory = await memoryWithOldAndNew()
    const view = await assembleWith(memory, {
      request: RECALLING_REQUEST,
      deliveryRecall: createKeywordDeliveryRecall(),
    })

    // The old turn aged out of the window (maxTurns: 2) but shares two content
    // tokens with the message, which clears MIN_RECALL_SCORE. It displaces the
    // oldest recent turn rather than adding to the window, so the prompt still
    // carries maxTurns turns in total.
    expect(MIN_RECALL_SCORE).toBe(2)
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-new'])
    expect(view.recalledTurns.map((entry) => entry.turn.turnId)).toEqual(['turn-old'])
    expect(view.exclusions.some((entry) => entry.turnId === 'turn-mid')).toBe(true)

    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('Earlier, confirmed:')
    expect(prompt).toContain(`(turn: ${FIXTURE_SESSION_ID}:turn-old)`)
    // Recalled evidence renders before the recent chronology, in its own section.
    expect(prompt.indexOf('Earlier, confirmed:')).toBeLessThan(
      prompt.indexOf('Already said (confirmed spoken):'),
    )
  })

  it('shares one budget: persona recall consuming the cap starves delivery recall', async () => {
    const memory = await memoryWithOldAndNew()
    const personaRecall: PersonaRecallPort = {
      recall: () => [{ fact: { id: 'fact-1', text: 'x'.repeat(100), keywords: [] }, score: 1 }],
    }

    // The persona fact renders at 118 of the 120-character budget; the recalled
    // turn does not fit the remainder and is dropped with an auditable exclusion.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        contextLimits: { maxTurns: 1, maxCharacters: 120 },
      }),
      deliveryRecall: createKeywordDeliveryRecall(),
      personaRecall,
    })

    expect(view.recalledFacts).toHaveLength(1)
    expect(view.recalledTurns).toEqual([])
    expect(view.deliveryRecallExclusions).toEqual([
      { sessionId: FIXTURE_SESSION_ID, turnId: 'turn-old', reason: 'recall-budget' },
    ])
    expect(view.warnings.some((warning) => warning.includes('recalled older turns'))).toBe(true)
  })

  // Opt-in equivalence, not a byte-for-byte claim against a previous
  // implementation: both paths below run this implementation, and what the
  // assertion establishes is that a caller who does not opt in - no port, or a
  // port that returns nothing - gets a prompt that recall did not touch. The
  // pre-recall behaviour itself is asserted against its own oracle in the next
  // test rather than by comparing two current paths to each other.
  it('leaves the prompt untouched when recall is not opted in', async () => {
    const memory = await memoryWithOldAndNew()
    const withoutPort = await assembleWith(memory, { request: RECALLING_REQUEST })
    const withEmptyPort = await assembleWith(memory, {
      request: RECALLING_REQUEST,
      deliveryRecall: { recall: () => [] },
    })

    expect(withoutPort.recalledTurns).toEqual([])
    expect(withEmptyPort.recalledTurns).toEqual([])
    expect(renderDialoguePrompt(withoutPort)).toBe(renderDialoguePrompt(withEmptyPort))
    expect(renderDialoguePrompt(withoutPort)).not.toContain('Earlier, confirmed:')
  })

  // The previous-behaviour oracle. Before delivery recall existed, `maxTurns`
  // bounded the recency window and nothing else: a caller asking for two turns
  // got the two newest delivered turns, nothing was resurrected from outside
  // the window, and no recall section was rendered. That contract is stated
  // here as an expected record set instead of a captured prompt string, so it
  // stays true through unrelated prompt edits but still fails if recall starts
  // leaking into a caller that never opted in.
  it('reproduces the pre-recall window semantics when no recall port is supplied', async () => {
    const memory = await memoryWithOldAndNew()
    const view = await assembleWith(memory, { request: RECALLING_REQUEST })

    expect(RECALLING_REQUEST.contextLimits.maxTurns).toBe(2)
    // The two newest delivered turns, in order - the window is not displaced,
    // because nothing was recalled to displace it.
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-mid', 'turn-new'])
    expect(view.recalledTurns).toEqual([])
    expect(view.deliveryRecallExclusions).toEqual([])
    // The window is the only thing that drops a turn here; no recall reason appears.
    expect(new Set(view.exclusions.map((entry) => entry.reason))).toEqual(new Set(['turn-limit']))
    expect(renderDialoguePrompt(view)).not.toContain('Earlier, confirmed:')
  })

  it('never exceeds the per-assembly cap on recalled turns', async () => {
    const memory = createDeliveryMemoryStore()
    for (const n of [1, 2, 3, 4, 5]) {
      await commitTurn(memory, `turn-old-${n}`, `The loud concert number ${n} was bright.`)
    }
    await commitTurn(memory, 'turn-new', 'A plain reply for today.')

    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        // maxTurns is also the recall allowance ceiling, so it has to leave room
        // for MAX_RECALLED_TURNS candidates to reach the cap at all.
        contextLimits: { maxTurns: MAX_RECALLED_TURNS, maxCharacters: 2000 },
      }),
      deliveryRecall: createKeywordDeliveryRecall(),
    })
    expect(view.recalledTurns.length).toBeLessThanOrEqual(MAX_RECALLED_TURNS)
    expect(view.recalledTurns.length).toBe(MAX_RECALLED_TURNS)
  })

  it('keeps maxTurns a combined bound: recall displaces recent turns instead of adding', async () => {
    const memory = await memoryWithOldAndNew()
    const requestWith = (maxTurns: number) =>
      fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        contextLimits: { maxTurns, maxCharacters: 2000 },
      })

    // maxTurns: 0 admits nothing at all - no recency window and no recalled turns.
    const none = await assembleWith(memory, {
      request: requestWith(0),
      deliveryRecall: createKeywordDeliveryRecall(),
    })
    expect(none.turns).toEqual([])
    expect(none.recalledTurns).toEqual([])

    // Whatever the limit, the turns that reach the prompt never exceed it.
    for (const maxTurns of [1, 2, 3]) {
      const view = await assembleWith(memory, {
        request: requestWith(maxTurns),
        deliveryRecall: createKeywordDeliveryRecall(),
      })
      expect(view.turns.length + view.recalledTurns.length).toBeLessThanOrEqual(maxTurns)
    }
  })

  // The turn counter is session-scoped, so a restored session reuses turn ids
  // that earlier sessions already used. Displacement has to count, filter and
  // record by the session-and-turn pair: keyed by the bare id, dropping one
  // turn also dropped every same-id turn in another session - and took the
  // pinned one with it, which is the record the pin exists to keep.
  it('displaces by the session-and-turn pair, not by the turn id alone', async () => {
    const memory = createDeliveryMemoryStore()
    // Dropped by the window and recalled back: it shares 'loud' and 'concert'.
    await commitTurn(memory, 'old-concert', 'The loud concert was bright tonight.', 'archive-old')
    await commitTurn(memory, 'shared', 'A plain remark about the weather today.', 'archive-a')
    // Pinned - the promise and the digits clear SALIENCE_PIN_THRESHOLD.
    await commitTurn(memory, 'shared', 'Remember this: my birthday is 0603.', 'archive-b')
    await commitTurn(memory, 'new', 'A plain reply for today.', 'live')

    // A history port that spans restored sessions, which is where the reuse
    // comes from: the durable source is read for one session, but a session
    // restored from an earlier archive carries ids the live session also uses.
    const history: HistoryQueryPort = {
      confirmedHistory: async () => [
        ...(await memory.confirmedHistory('archive-old')),
        ...(await memory.confirmedHistory('archive-a')),
        ...(await memory.confirmedHistory('archive-b')),
        ...(await memory.confirmedHistory('live')),
      ],
    }

    const view = await assembleWith(memory, {
      history,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        contextLimits: { maxTurns: 3, maxCharacters: 2000 },
      }),
      deliveryRecall: createKeywordDeliveryRecall(),
    })

    expect(view.recalledTurns.map((entry) => [entry.turn.sessionId, entry.turn.turnId])).toEqual([
      ['archive-old', 'old-concert'],
    ])
    // One recalled turn leaves room for two recent ones, and the only turn
    // displaced is the unpinned archive-a record - not its pinned namesake.
    expect(view.turns.map((turn) => [turn.sessionId, turn.turnId])).toEqual([
      ['archive-b', 'shared'],
      ['live', 'new'],
    ])
    expect(view.turns.find((turn) => turn.sessionId === 'archive-b')?.pinned).toBe(true)
    expect(view.turns.length + view.recalledTurns.length).toBe(3)

    const displacedExclusions = view.exclusions.filter((entry) => entry.reason === 'turn-limit')
    expect(
      displacedExclusions.some(
        (entry) => entry.sessionId === 'archive-a' && entry.turnId === 'shared',
      ),
    ).toBe(true)
    expect(
      displacedExclusions.some(
        (entry) => entry.sessionId === 'archive-b' && entry.turnId === 'shared',
      ),
    ).toBe(false)
  })
})
