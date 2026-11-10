import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  createDeliveryMemoryStore,
  createDialoguePort,
  createKeywordDeliveryRecall,
  renderDialoguePrompt,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DeliveryMemoryStore,
  DialogueTextSource,
  PersonaRecallPort,
} from '../../src/dialogue'
import {
  DEFAULT_BUDGET_PLAN,
  HISTORY_MIN_SHARE,
  allocateBudget,
  estimateTokensFromLines,
  historyFloorCharacters,
} from '../../src/dialogue/budget'
import type { BudgetPlan } from '../../src/dialogue/budget'
import type { CharacterState } from '../../src/dialogue/state'
import type { ClockPort, DialogueRequest, HistoryQueryPort } from '../../src/contracts'

/**
 * Layered section budget (./budget). Every test here either exercises the pure
 * allocation arithmetic or compares the opt-in assembly path against the
 * unchanged single-pool path, so the default path itself is pinned by a
 * representative scenario below rather than by editing the existing suites.
 */
const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

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
    budgetPlan?: BudgetPlan
    state?: CharacterState
  } = {},
): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const port = createDialoguePort({
    clock: FIXTURE_CLOCK,
    history: options.history ?? memory,
    textSource: capturingTextSource(capture),
    ...(options.deliveryRecall === undefined ? {} : { deliveryRecall: options.deliveryRecall }),
    ...(options.personaRecall === undefined ? {} : { personaRecall: options.personaRecall }),
    ...(options.budgetPlan === undefined ? {} : { budgetPlan: options.budgetPlan }),
    ...(options.state === undefined ? {} : { state: options.state }),
  })
  await port.generate(options.request ?? fixtureDialogueRequest(), createCallContext(), {
    segment: async () => {},
  })
  const view = capture.view
  if (view === null) throw new Error('context was not assembled')
  return view
}

/** One recalled persona fact in the shape the recall port returns. */
function recalledFact(id: string, text: string): ReturnType<PersonaRecallPort['recall']>[number] {
  return { fact: { id, text, keywords: [] }, score: 1 }
}

describe('M4 layered budget: allocation', () => {
  it('allocates floors that never exceed the total and keep history at its floor', () => {
    // floor(0.2 x 2000) = 400, floor(0.1 x 2000) = 200, floor(0.4 x 2000) = 800,
    // max(800, floor(0.35 x 2000) = 700) = 800 - the floor does not bind here.
    const limits = allocateBudget(2000, DEFAULT_BUDGET_PLAN)
    expect(limits).toEqual({
      persona: 400,
      state: 200,
      workingMemory: 200,
      recall: 400,
      history: 800,
    })

    const total =
      limits.persona + limits.state + limits.workingMemory + limits.recall + limits.history
    expect(total).toBeLessThanOrEqual(2000)
    expect(limits.history).toBeGreaterThanOrEqual(Math.floor(HISTORY_MIN_SHARE * 2000))

    expect(allocateBudget(0, DEFAULT_BUDGET_PLAN)).toEqual({
      persona: 0,
      state: 0,
      workingMemory: 0,
      recall: 0,
      history: 0,
    })
  })

  it('raises the history cap to the floor when the plan under-allocates history', () => {
    // Non-history shares total 0.5 <= 0.65 and the whole plan totals 0.8 <= 1, so
    // the plan is valid. The plan asks for floor(0.3 x 2000) = 600 for history,
    // but the floor is floor(0.35 x 2000) = 700; remaining capacity is
    // 2000 - (400 + 100 + 100 + 400) = 1000, so the min() does not bind and
    // history is raised to 700 rather than the plan's 600.
    const plan: BudgetPlan = {
      persona: 0.2,
      state: 0.05,
      workingMemory: 0.05,
      recall: 0.2,
      history: 0.3,
    }
    const limits = allocateBudget(2000, plan)

    expect(limits.history).toBe(700)
    expect(limits).toMatchObject({ persona: 400, state: 100, workingMemory: 100, recall: 400 })
    const total =
      limits.persona + limits.state + limits.workingMemory + limits.recall + limits.history
    expect(total).toBe(1700)
    expect(total).toBeLessThanOrEqual(2000)
    expect(limits.history).toBeGreaterThanOrEqual(Math.floor(HISTORY_MIN_SHARE * 2000))
    // The shared helper states the same floor the clamp uses.
    expect(limits.history).toBeGreaterThanOrEqual(historyFloorCharacters(2000))
    expect(historyFloorCharacters(2000)).toBe(700)
    expect(historyFloorCharacters(200)).toBe(70)
  })

  it('rejects plans that cannot honor the history floor or the total cap', () => {
    // Non-history shares total 0.9 > 1 - 0.35: the 35% floor and the total cap
    // cannot both hold, so the plan is refused rather than silently adjusted.
    expect(() =>
      allocateBudget(2000, {
        persona: 0.3,
        state: 0.3,
        workingMemory: 0.1,
        recall: 0.2,
        history: 0.1,
      }),
    ).toThrow()
    // Shares total 1.1, past the total cap (beyond the float tolerance).
    expect(() =>
      allocateBudget(2000, {
        persona: 0.25,
        state: 0.1,
        workingMemory: 0.1,
        recall: 0.2,
        history: 0.45,
      }),
    ).toThrow()
    expect(() => allocateBudget(2000, { ...DEFAULT_BUDGET_PLAN, persona: -0.1 })).toThrow()
    expect(() => allocateBudget(-1, DEFAULT_BUDGET_PLAN)).toThrow()
  })
})

describe('M4 layered budget: assembly', () => {
  it('flows unused recall quota back to history', async () => {
    const memory = createDeliveryMemoryStore()
    // '- Remember this: my birthday is 0603.' renders at 37 (prefix + text +
    // marker); it is pinned, so trimming would protect it last anyway.
    await commitTurn(memory, 'turn-old', 'Remember this: my birthday is 0603.')
    await commitTurn(memory, 'turn-mid', 'A plain line about nothing much.') // 34
    await commitTurn(memory, 'turn-new', 'Another plain reply for today.') // 32
    const personaRecall: PersonaRecallPort = { recall: () => [recalledFact('fact-1', 'x'.repeat(100))] }
    // The fact renders at 2 + 100 + ' (bible: fact-1)'.length (16) = 118.

    const request = (maxCharacters: number): DialogueRequest =>
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters } })

    // With a plan, the recall cap is floor(0.2 x 200) = 40 < 118, so the fact is
    // excluded. Nothing else is charged to recall, and the whole 200 allowance
    // flows back to history: 37 + 34 + 32 = 103 <= 200, so all three turns stay.
    const layered = await assembleWith(memory, {
      request: request(200),
      personaRecall,
      budgetPlan: DEFAULT_BUDGET_PLAN,
    })

    expect(layered.recalledFacts).toEqual([])
    expect(layered.recallExclusions).toEqual([{ factId: 'fact-1', reason: 'recall-budget' }])
    expect(layered.turns.map((turn) => turn.turnId)).toEqual(['turn-old', 'turn-mid', 'turn-new'])
    expect(layered.rollup).toBeNull()
    expect(layered.estimatedCharacters).toBe(103)
    expect(layered.budgetBreakdown).toEqual([
      { section: 'persona', limit: 40, used: 0, dropped: 0 },
      { section: 'state', limit: 20, used: 0, dropped: 0 },
      { section: 'workingMemory', limit: 20, used: 0, dropped: 0 },
      { section: 'recall', limit: 40, used: 0, dropped: 1 },
      { section: 'history', limit: 200, used: 103, dropped: 0 },
    ])

    // Control: the single-pool rule accepts the 118-character fact (118 <= 200)
    // and then keeps only the pinned oldest turn (37) plus the newest (32),
    // because 118 + 69 leaves 13 characters, short of the 26-character rollup.
    const singlePool = await assembleWith(memory, { request: request(200), personaRecall })
    expect(singlePool.recalledFacts).toHaveLength(1)
    expect(singlePool.estimatedCharacters).toBe(118 + 37 + 32)
    expect(singlePool.rollup).toBeNull()
  })

  it('produces no sections at all when maxCharacters is 0', async () => {
    const memory = createDeliveryMemoryStore()
    // '- The concert was loud and bright tonight.' renders at 42; '- A plain
    // remark about the weather today.' at 41; '- A plain reply for today.' at 26.
    await commitTurn(memory, 'turn-old', 'The concert was loud and bright tonight.')
    await commitTurn(memory, 'turn-mid', 'A plain remark about the weather today.')
    await commitTurn(memory, 'turn-new', 'A plain reply for today.')
    const personaRecall: PersonaRecallPort = { recall: () => [recalledFact('fact-1', 'x'.repeat(100))] }

    // maxTurns: 1 leaves the two oldest turns outside the window, so the
    // delivery-recall candidate is the old turn (75 characters with provenance)
    // and its 0-character recall cap excludes it.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 1, maxCharacters: 0 } }),
      deliveryRecall: createKeywordDeliveryRecall(),
      personaRecall,
      budgetPlan: DEFAULT_BUDGET_PLAN,
    })

    const limits = allocateBudget(0, DEFAULT_BUDGET_PLAN)
    expect(limits).toEqual({ persona: 0, state: 0, workingMemory: 0, recall: 0, history: 0 })
    expect(view.turns).toEqual([])
    expect(view.recalledFacts).toEqual([])
    expect(view.recalledTurns).toEqual([])
    expect(view.estimatedCharacters).toBe(0)
    expect(view.estimatedTokens).toBe(0)
    expect(view.rollup).toBeNull()
    expect(view.budgetBreakdown).toEqual([
      { section: 'persona', limit: 0, used: 0, dropped: 0 },
      { section: 'state', limit: 0, used: 0, dropped: 0 },
      { section: 'workingMemory', limit: 0, used: 0, dropped: 0 },
      // One persona fact plus one recalled older turn refused for a zero cap.
      { section: 'recall', limit: 0, used: 0, dropped: 2 },
      { section: 'history', limit: 0, used: 0, dropped: 1 },
    ])
  })

  it('keeps every section within its own cap and the total within maxCharacters', async () => {
    const memory = createDeliveryMemoryStore()
    for (const n of [1, 2, 3]) {
      // '- The loud concert number N was bright.' renders at 38 each; all three
      // share 'loud' and 'concert' with the listener message below.
      await commitTurn(memory, `turn-old-${n}`, `The loud concert number ${n} was bright.`)
    }
    for (let n = 1; n <= 6; n += 1) {
      await commitTurn(memory, `turn-late-${n}`, `${'x'.repeat(30)}.`) // 33 each
    }
    const personaRecall: PersonaRecallPort = {
      recall: () =>
        ['1', '2', '3', '4', '5'].map((n) => recalledFact(`fact-${n}`, 'x'.repeat(40))),
    }

    const maxCharacters = 2000
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        contextLimits: { maxTurns: 6, maxCharacters },
      }),
      deliveryRecall: createKeywordDeliveryRecall(),
      personaRecall,
      budgetPlan: DEFAULT_BUDGET_PLAN,
    })

    const limits = allocateBudget(maxCharacters, DEFAULT_BUDGET_PLAN)
    const limitTotal =
      limits.persona + limits.state + limits.workingMemory + limits.recall + limits.history
    expect(limitTotal).toBe(2000)

    // Five facts render at 2 + 40 + 16 = 58 each, 290 <= 400, so none is excluded.
    expect(view.recalledFacts).toHaveLength(5)
    // The oldest turn renders at 2 + 36 + ' (turn: session-fixture:turn-old-1)'
    // (36) = 74. 290 + 74 = 364 <= 400, so exactly one is recalled; the next
    // would need 438.
    expect(view.recalledTurns.map((entry) => entry.turn.turnId)).toEqual(['turn-old-1'])
    // Recall takes one slot of the six, so the window displaces the oldest
    // unpinned turn: a total of six turns still reaches the prompt.
    expect(view.turns).toHaveLength(5)
    expect(view.turns.length + view.recalledTurns.length).toBe(6)

    const recallRow = view.budgetBreakdown?.find((row) => row.section === 'recall')
    expect(recallRow).toEqual({ section: 'recall', limit: 400, used: 364, dropped: 2 })
    // The recall remainder flows back: history sees 2000 - 290 - 74 = 1636 and
    // charges five 33-character turn lines.
    const historyRow = view.budgetBreakdown?.find((row) => row.section === 'history')
    expect(historyRow).toEqual({ section: 'history', limit: 1636, used: 165, dropped: 0 })

    // The structural invariants the plan exists to give.
    expect(recallRow?.used).toBeLessThanOrEqual(limits.recall)
    expect(historyRow?.used).toBeLessThanOrEqual(historyRow?.limit ?? 0)
    expect(historyRow?.limit).toBeGreaterThanOrEqual(Math.floor(HISTORY_MIN_SHARE * maxCharacters))
    expect(view.estimatedCharacters).toBe(529)
    expect(view.estimatedCharacters).toBeLessThanOrEqual(maxCharacters)
  })

  it('reports estimatedTokens as the pinned approximation of the charged lines', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-ascii', 'Hi.')
    // CJK text with a full stop: the terminator is in SENTENCE_TERMINATORS, so no
    // interrupted marker is added. '- 今晚的音乐会真热闹。' is 3 latin code points
    // (prefix, space, U+3002) and 9 CJK code points.
    await commitTurn(memory, 'turn-cjk', '今晚的音乐会真热闹。')

    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 2000 } }),
      budgetPlan: DEFAULT_BUDGET_PLAN,
    })

    const lines = view.turns.map((turn) => `- ${turn.text}`)
    expect(view.estimatedCharacters).toBe(17)
    // Aggregate scope: latin 5 + 3 = 8, cjk 9, ONE ceil of 8/4 + 9/1.5 = 8.
    // Rounding each line first and summing would give 2 + 7 = 9, a different
    // contract that this batch does not use.
    expect(view.estimatedTokens).toBe(8)

    // Independent recomputation with the pinned rule, not the implementation.
    let latin = 0
    let cjk = 0
    for (const line of lines) {
      for (const character of line) {
        const codePoint = character.codePointAt(0) ?? 0
        const isCjk =
          (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
          (codePoint >= 0x4e00 && codePoint <= 0x9fff)
        if (isCjk) cjk += 1
        else latin += 1
      }
    }
    expect(latin).toBe(8)
    expect(cjk).toBe(9)
    expect(view.estimatedTokens).toBe(Math.ceil(latin / 4 + cjk / 1.5))
    // Same inputs through the exported helper agree with the assembled view.
    expect(estimateTokensFromLines(lines)).toBe(view.estimatedTokens)
  })

  it('changes nothing when no budgetPlan is supplied', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-old', 'The concert was loud and bright tonight.')
    await commitTurn(memory, 'turn-mid', 'A plain remark about the weather today.')
    await commitTurn(memory, 'turn-new', 'A plain reply for today.')
    const personaRecall: PersonaRecallPort = { recall: () => [recalledFact('fact-1', 'x'.repeat(100))] }

    // The pre-plan scenario: one shared pool of 120 accepts the 118-character
    // fact, excludes the 75-character recalled turn, and leaves 2 characters for
    // history, so even the 26-character turn and the 26-character rollup are cut.
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
    expect(view.estimatedCharacters).toBe(118)
    expect(view.estimatedTokens).toBeUndefined()
    expect(view.budgetBreakdown).toBeUndefined()
    expect(view.warnings.some((warning) => warning.includes('some recalled older turns were dropped'))).toBe(
      true,
    )
    expect(renderDialoguePrompt(view)).not.toContain('omitted)')
  })

  it('keeps history at its floor when the turn limit reclaims recalled content', async () => {
    const memory = createDeliveryMemoryStore()
    // '- The loud concert number N was bright.'; all n share 'loud' and
    // 'concert' with the listener message below.
    for (const n of [1, 2]) {
      await commitTurn(memory, `turn-old-${n}`, `The loud concert number ${n} was bright.`)
    }
    // 'Another plain reply for today.' renders at 32 each.
    for (const n of [1, 2, 3]) {
      await commitTurn(memory, `turn-new-${n}`, 'Another plain reply for today.')
    }
    // A 118-character fact never fits the 104-character recall cap, so recall
    // holds only the 74-character recalled turn. The port only returns a fact
    // from a MATCHING KEYWORD, at least PERSONA_RECALL_MIN_KEYWORD_HITS (2) of
    // them, so every fact repeats 'loud' and 'concert', the two informative
    // words of the listener message.
    const personaRecall: PersonaRecallPort = {
      recall: () =>
        Array.from({ length: 5 }, (_unused, index) => ({
          fact: { id: `fact-${index + 1}`, text: 'x'.repeat(100), keywords: ['loud', 'concert'] },
          score: 2,
        })),
    }

    // 520: recall 104, plan history floor(0.4 x 520) = 208, plan floor
    // floor(0.35 x 520) = 182.
    const maxCharacters = 520
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        contextLimits: { maxTurns: 3, maxCharacters },
      }),
      deliveryRecall: createKeywordDeliveryRecall(),
      personaRecall,
      budgetPlan: DEFAULT_BUDGET_PLAN,
    })

    // Both old turns are the delivery-recall candidates behind the recency
    // window of the three newest turns. Exactly one joins the prompt, so the
    // window is displaced down to two turns under the three-turn limit; the
    // candidate that did not fit is a turn-limit loss, and every fact is a
    // recall-budget loss, so neither is a history drop.
    expect(view.recalledFacts).toHaveLength(0)
    expect(view.recalledTurns).toHaveLength(1)
    expect(view.turns).toHaveLength(2)
    expect(view.turns.length + view.recalledTurns.length).toBe(3)

    const limits = allocateBudget(maxCharacters, DEFAULT_BUDGET_PLAN)
    const floor = historyFloorCharacters(maxCharacters)
    expect(floor).toBe(182)
    expect(limits.history).toBe(208)
    const recallRow = view.budgetBreakdown?.find((row) => row.section === 'recall')
    expect(recallRow).toEqual({ section: 'recall', limit: 104, used: 74, dropped: 6 })
    const historyRow = view.budgetBreakdown?.find((row) => row.section === 'history')
    // The confirmed history row is the pool the kept turns were trimmed
    // against: the shared remainder 520 - 74 = 446, well above the plan's own
    // 208 share and the 182 floor. The floor is a lower bound, never a ceiling.
    expect(historyRow).toEqual({ section: 'history', limit: 446, used: 64, dropped: 0 })
    expect(historyRow?.limit).toBeGreaterThanOrEqual(floor)
    expect(historyRow?.limit).toBeGreaterThanOrEqual(limits.history)
    expect(historyRow?.used).toBeLessThanOrEqual(historyRow?.limit ?? 0)
    // The charged lines are the two kept turns plus the recalled turn, which
    // the module header and the `estimatedCharacters` contract both charge to
    // this pool: 32 + 32 + 74 = 138.
    expect(view.estimatedCharacters).toBe(32 + 32 + 74)
    expect(view.estimatedTokens).toBe(
      estimateTokensFromLines([
        ...view.turns.map((turn) => `- ${turn.text}`),
        ...view.recalledTurns.map(
          (entry) => `- ${entry.turn.text} (turn: ${entry.turn.sessionId}:${entry.turn.turnId})`,
        ),
      ]),
    )
  })

  it('counts heard-prefix lines in estimatedTokens exactly as estimatedCharacters charges them', async () => {
    const memory = createDeliveryMemoryStore()
    // A partial delivery that carries a receipt (A02): the listener may have
    // heard a prefix, so it renders as '- <text> [cut off after start]'.
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: FIXTURE_SESSION_ID,
        turnId: 'turn-partial',
        segmentId: 'turn-partial-seg-0',
        textHash: 'hash-turn-partial',
        text: 'I was thinking maybe we could',
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
        receiptId: 'receipt-partial-0',
      }),
    )
    // The local store's own confirmedHistory is spoken-only; feeding the full
    // record set stands in for a widened query that returns heard-prefix rows.
    const history: HistoryQueryPort = { confirmedHistory: async () => [...memory.records()] }

    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 200 } }),
      history,
      budgetPlan: DEFAULT_BUDGET_PLAN,
    })

    // '- I was thinking maybe we could [cut off after start]' is 2 + 31 + 20 = 53.
    expect(view.turns).toEqual([])
    expect(view.heardPrefixTurns).toHaveLength(1)
    expect(view.estimatedCharacters).toBe(53)
    // The heard-prefix line is charged to the same pool as the history row, so
    // the token
    // approximation must cover it too: 53 latin code points -> ceil(53 / 4) = 14.
    // Dropping the line made this 0 while estimatedCharacters stayed 53.
    expect(view.estimatedTokens).toBe(14)
    expect(view.estimatedTokens).toBe(estimateTokensFromLines(['- I was thinking maybe we could [cut off after start]']))

    // It has no row of its own: the pool it took appears as unused history, so
    // the used total is short of estimatedCharacters by exactly that line.
    const historyRow = view.budgetBreakdown?.find((row) => row.section === 'history')
    expect(historyRow).toEqual({ section: 'history', limit: 200, used: 0, dropped: 0 })
    const usedTotal = (view.budgetBreakdown ?? []).reduce((sum, row) => sum + row.used, 0)
    expect(view.estimatedCharacters - usedTotal).toBe(53)
  })

  it('keeps the empty-history warning tied to the default turn window, not to recall', async () => {
    const memory = createDeliveryMemoryStore()
    // Two fully delivered turns, neither of which matches the listener message,
    // so recall has no candidate at all and the default two-turn window holds
    // both of them.
    await commitTurn(memory, 'turn-a', 'The quiet library stayed open very late.')
    await commitTurn(memory, 'turn-b', 'A plain reply for today.')

    // 26 characters fit the newest turn exactly, so a confirmed turn is kept. The
    // budget message must not claim that recalled content consumed the pool when
    // recall returned nothing at all.
    const view = await assembleWith(memory, {
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'evt-recall', text: 'Tell me about the loud concert' },
        contextLimits: { maxTurns: 2, maxCharacters: 26 },
      }),
    })
    expect(view.recalledTurns).toEqual([])
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-b'])
    expect(
      view.warnings.some((warning) =>
        warning.includes('recalled content consumes the whole character budget'),
      ),
    ).toBe(false)
  })

  it('refuses a budgetPlan combined with a state block', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-new', 'A plain reply for today.')
    // renderStateBlock at DEFAULT_STATE_PROFILE (numeric) is exactly this block,
    // so no arithmetic here depends on the state module's own formatting.
    const state: CharacterState = {
      mood: 0.5,
      stress: 0.5,
      energy: 0.5,
      attachment: 1,
      confidence: 1,
    }
    const request = fixtureDialogueRequest({
      contextLimits: { maxTurns: 8, maxCharacters: 200 },
    })

    // The state block is charged to the shared pool while the plan's state
    // section has no charging point: assembling both would take history below
    // its plan floor and report state as unused. It is refused instead, and the
    // message names the reason so the caller is not left guessing.
    await expect(
      assembleWith(memory, { request, state, budgetPlan: DEFAULT_BUDGET_PLAN }),
    ).rejects.toThrow(/budgetPlan cannot be combined with a state block/)

    // Without a plan the state block still assembles, unchanged.
    const singlePool = await assembleWith(memory, { request, state })
    expect(singlePool.stateBlock).not.toBeNull()
    expect(singlePool.budgetBreakdown).toBeUndefined()
    expect(singlePool.estimatedTokens).toBeUndefined()
    // Plan without state input is unaffected by the guard.
    const layered = await assembleWith(memory, { request, budgetPlan: DEFAULT_BUDGET_PLAN })
    expect(layered.stateBlock).toBeNull()
    expect(layered.turns.map((turn) => turn.turnId)).toEqual(['turn-new'])
  })
})
