import { describe, expect, it } from 'vitest'
import {
  createDeliveryMemoryStore,
  createDialoguePort,
  DEFAULT_CHARACTER_PROFILES,
  renderDialoguePrompt,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DeliveryMemoryStore,
  DialogueTextSource,
  ListenerHistoryPort,
  ListenerTurn,
} from '../../src/dialogue'
import type { BudgetPlan } from '../../src/dialogue/budget'
import { renderStyleAnchorLines, STYLE_ANCHORS_HEADER } from '../../src/dialogue/style-anchors'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'

/**
 * Style anchors share ONE history budget with the listener transcript
 * (issue #146 A11).
 *
 * Listener transcript rows (A01) are charged to the history row's `used`, so an
 * anchor that took its capacity from the pool before those rows were charged
 * spent the same characters twice: `history.used` went past `history.limit`.
 * Anchor capacity must be what the history section has left after confirmed
 * history, the rollup line and the listener rows.
 */

const PROFILE = DEFAULT_CHARACTER_PROFILES[1]!
const SESSION = FIXTURE_SESSION_ID

/** Two confirmed character turns that are eligible anchors under a wide cap. */
const CHARACTER_TEXTS = [
  'Hmph, you were up late again, human, and the stream is over now.',
  'You should sit down before the stream starts.',
] as const

function listenerTurn(eventId: string, text: string, receivedAtMs: number): ListenerTurn {
  return {
    eventId,
    sessionId: SESSION,
    text,
    receivedAtMs,
    actorId: 'actor-local-audience',
    trust: 'untrusted-content',
  }
}

const LISTENER_ROWS: readonly ListenerTurn[] = [
  listenerTurn('listener-1', 'Long day at work, I am half asleep already.', 1_000),
  listenerTurn('listener-2', 'Please tell me a quiet story before I go.', 1_001),
]

function listenerHistory(turns: readonly ListenerTurn[]): ListenerHistoryPort {
  return { recent: async () => ({ turns, unavailable: null }) }
}

function capturingSource(capture: { view: AssembledDialogueContext | null }): DialogueTextSource {
  return {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(view) {
      capture.view = view
      return ['Captured reply.']
    },
  }
}

async function memoryWith(texts: readonly string[]): Promise<DeliveryMemoryStore> {
  const memory = createDeliveryMemoryStore()
  for (const [index, text] of texts.entries()) {
    const turnId = `turn-${index + 1}`
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: SESSION,
        turnId,
        segmentId: `${turnId}-seg-0`,
        textHash: `hash-${turnId}`,
        text,
        personaProfileId: PROFILE.profileId,
        personaProfileVersion: PROFILE.version,
      }),
    )
  }
  return memory
}

async function assemble(options: {
  listenerRows?: readonly ListenerTurn[]
  styleAnchors: boolean
  maxCharacters: number
  /** Section shares for a diagnostic plan; omitted means no plan. */
  plan?: BudgetPlan
}): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const port = createDialoguePort({
    clock: { nowMs: () => 2_000 },
    history: await memoryWith(CHARACTER_TEXTS),
    textSource: capturingSource(capture),
    ...(options.listenerRows === undefined
      ? {}
      : { listenerHistory: listenerHistory(options.listenerRows) }),
    styleAnchors: options.styleAnchors,
    ...(options.plan === undefined ? {} : { budgetPlan: options.plan }),
  })
  await port.generate(
    fixtureDialogueRequest({
      characterProfileId: PROFILE.profileId,
      characterProfileVersion: PROFILE.version,
      // A live input, so the listener rows sit behind it in the transcript.
      selectedInput: { eventId: 'live-1', text: 'Is anyone still awake?' },
      contextLimits: { maxTurns: 8, maxCharacters: options.maxCharacters },
    }),
    createCallContext(),
    { segment: async () => {} },
  )
  if (capture.view === null) throw new Error('context was not assembled')
  return capture.view
}

/** Section shares with no non-history sections, so history takes the remainder. */
const HISTORY_ONLY_PLAN: BudgetPlan = {
  persona: 0,
  state: 0,
  workingMemory: 0,
  recall: 0,
  history: 1,
}

function historyRowOf(view: AssembledDialogueContext) {
  const row = view.budgetBreakdown?.find((entry) => entry.section === 'history')
  if (row === undefined) throw new Error('history row is missing from the breakdown')
  return row
}

/** Rendered entry line of each anchor, in selection order. */
function anchorLines(view: AssembledDialogueContext): readonly string[] {
  return renderStyleAnchorLines(view.styleAnchors)
}

/** The voice-reference section of a rendered prompt, or '' when absent. */
function voiceSectionOf(prompt: string): string {
  const start = prompt.indexOf(STYLE_ANCHORS_HEADER)
  if (start < 0) return ''
  const end = prompt.indexOf('\nAlready said (confirmed spoken):')
  return prompt.slice(start, end < 0 ? undefined : end)
}

describe('M4 style anchors — capacity shared with listener transcript rows', () => {
  it('does not overfill the history section: anchors yield to the listener rows', async () => {
    // Positive control: wide enough for both anchors and both listener rows.
    const wide = { listenerRows: LISTENER_ROWS, styleAnchors: true, maxCharacters: 1_200 }
    const roomy = await assemble({ ...wide, plan: HISTORY_ONLY_PLAN })
    expect(roomy.styleAnchors.map((anchor) => anchor.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(roomy.transcript.filter((entry) => entry.role === 'listener')).toHaveLength(2)
    expect(
      roomy.listenerExclusions.filter((entry) => entry.reason === 'listener-budget'),
    ).toEqual([])
    const roomyHistory = historyRowOf(roomy)
    expect(roomyHistory.used).toBeLessThanOrEqual(roomyHistory.limit)
    expect(voiceSectionOf(renderDialoguePrompt(roomy))).toContain(anchorLines(roomy)[0] as string)

    // Tight: confirmed history and both listener rows nearly fill the section.
    // The anchors may take only the room left over, never the listener's share.
    const tight = await assemble({
      listenerRows: LISTENER_ROWS,
      styleAnchors: true,
      maxCharacters: 320,
      plan: HISTORY_ONLY_PLAN,
    })
    const tightHistory = historyRowOf(tight)
    expect(tightHistory.used).toBeLessThanOrEqual(tightHistory.limit)
    expect(tight.estimatedCharacters).toBeLessThanOrEqual(320)

    // The anchor that does not fit is reported, and the ones before it render.
    expect(tight.styleAnchors.map((anchor) => anchor.turnId)).toEqual(['turn-1'])
    const budgetDrops = tight.styleAnchorExclusions.filter((entry) => entry.reason === 'budget')
    expect(budgetDrops.map((entry) => entry.turnId)).toEqual(['turn-2'])
    // Never rendered half: the dropped line is absent from the section whole.
    const voiceSection = voiceSectionOf(renderDialoguePrompt(tight))
    const keptLine = anchorLines(roomy)[0] as string
    const droppedLine = anchorLines(roomy)[1] as string
    expect(voiceSection).toContain(keptLine)
    expect(voiceSection).not.toContain(droppedLine)
  })

  it('holds the maxCharacters bound with listener rows and anchors when no plan is supplied', async () => {
    // The rendered prompt also carries the persona block, which is not part of
    // the character budget, so the bound is checked on `estimatedCharacters` -
    // the charged set the budget is about - at every cap. At least one cap must
    // actually keep anchors, or the check would be vacuous.
    const wideEntries = (await assemble({
      listenerRows: LISTENER_ROWS,
      styleAnchors: true,
      maxCharacters: 1_200,
    })).styleAnchors.length
    let anchorsKept = 0
    for (const maxCharacters of [320, 340, 360, 380, 400, 460]) {
      const view = await assemble({
        listenerRows: LISTENER_ROWS,
        styleAnchors: true,
        maxCharacters,
      })
      expect(view.budgetBreakdown, `cap ${maxCharacters}`).toBeUndefined()
      expect(view.estimatedCharacters, `cap ${maxCharacters}`).toBeLessThanOrEqual(maxCharacters)
      anchorsKept += view.styleAnchors.length
      // Reported budget drops equal the anchors that did not render, and none
      // of them appears in the voice-reference section.
      const budgetDrops = view.styleAnchorExclusions.filter((entry) => entry.reason === 'budget')
      expect(budgetDrops.length + view.styleAnchors.length).toBe(wideEntries)
    }
    expect(anchorsKept).toBeGreaterThan(0)
  })

  it('keeps the disabled path untouched beside listener rows, with and without a plan', async () => {
    const off = await assemble({
      listenerRows: LISTENER_ROWS,
      styleAnchors: false,
      maxCharacters: 320,
      plan: HISTORY_ONLY_PLAN,
    })
    expect(off.styleAnchors).toEqual([])
    expect(off.styleAnchorExclusions).toEqual([])
    expect(renderDialoguePrompt(off)).not.toContain(STYLE_ANCHORS_HEADER)
    const history = historyRowOf(off)
    expect(history.used).toBeLessThanOrEqual(history.limit)

    // Both listener rows survive at this cap, so the anchors that are present
    // in the enabled assembly are exactly the ones the listener rows left room
    // for.
    expect(off.transcript.filter((entry) => entry.role === 'listener')).toHaveLength(2)

    // The same input with anchors enabled never drops a listener row that the
    // disabled assembly kept: the anchors yield, never the transcript.
    const on = await assemble({
      listenerRows: LISTENER_ROWS,
      styleAnchors: true,
      maxCharacters: 320,
      plan: HISTORY_ONLY_PLAN,
    })
    expect(on.transcript.filter((entry) => entry.role === 'listener')).toEqual(
      off.transcript.filter((entry) => entry.role === 'listener'),
    )
    expect(on.styleAnchors).toHaveLength(1)
  })
})
