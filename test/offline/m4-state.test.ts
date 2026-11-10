import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  APPRAISAL_WEIGHTS,
  DEFAULT_STATE_PROFILE,
  appraiseTurn,
  createDeliveryMemoryStore,
  createDialoguePort,
  projectState,
  renderDialoguePrompt,
  renderStateBlock,
} from '../../src/dialogue'
import type {
  Appraisal,
  AssembledDialogueContext,
  CharacterState,
  DeliveryMemoryStore,
  DialogueTextSource,
  StateProfile,
} from '../../src/dialogue'

/**
 * State block and state dynamics (A08).
 *
 * What is being locked:
 *   - `projectState` obeys its four invariants: one step never exceeds
 *     `maxDelta`, silence regresses towards the baseline, the deadzone holds a
 *     dimension still, and `prev` is never mutated. An invalid profile is a
 *     no-op, not an exception.
 *   - `appraiseTurn` is the exact rule table, including the cases where the
 *     keyword tables deliberately do NOT fire.
 *   - `renderStateBlock` is exact in numeric form and free of digits in verbal
 *     form.
 *   - Without state input the assembled view and the prompt are exactly what
 *     they were: no block, no budget, no text.
 *   - With state input the block is charged to the shared character budget and
 *     the cap stays a hard upper bound: a block that does not fit is dropped
 *     and reported, never rendered past the cap.
 *
 * Quality claims are out of scope here: these are deterministic checks of the
 * formulas and of the budget arithmetic, not an assessment of how natural a
 * trajectory looks.
 */
const FIXTURE_CLOCK = { nowMs: () => 1_000 }

const ALL_HALF: CharacterState = {
  mood: 0.5,
  stress: 0.5,
  energy: 0.5,
  attachment: 0.5,
  confidence: 0.5,
}

/** The state whose numeric and verbal renders are pinned below. */
const SAMPLE_STATE: CharacterState = {
  mood: 0.6,
  stress: 0.7,
  energy: 0.4,
  attachment: 0.5,
  confidence: 0.5,
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

async function commitTurn(
  memory: DeliveryMemoryStore,
  turnId: string,
  text: string,
): Promise<void> {
  await memory.commit(
    fixtureCommitDelivery({
      sessionId: FIXTURE_SESSION_ID,
      turnId,
      segmentId: `${turnId}-seg-0`,
      textHash: `hash-${turnId}`,
      text,
    }),
  )
}

/** Three confirmed turns of the default text, each rendering at 30 characters. */
async function seededMemory(): Promise<DeliveryMemoryStore> {
  const memory = createDeliveryMemoryStore()
  for (const turnId of ['turn-a', 'turn-b', 'turn-c']) {
    await commitTurn(memory, turnId, 'We talked about the concert.')
  }
  return memory
}

async function assemble(
  memory: DeliveryMemoryStore,
  options: {
    state?: CharacterState
    stateBaseline?: CharacterState
    stateProfile?: StateProfile
    maxCharacters?: number
  } = {},
): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const port = createDialoguePort({
    clock: FIXTURE_CLOCK,
    history: memory,
    textSource: capturingTextSource(capture),
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.stateBaseline === undefined ? {} : { stateBaseline: options.stateBaseline }),
    ...(options.stateProfile === undefined ? {} : { stateProfile: options.stateProfile }),
  })
  await port.generate(
    fixtureDialogueRequest({
      contextLimits: { maxTurns: 8, maxCharacters: options.maxCharacters ?? 2000 },
    }),
    createCallContext(),
    { segment: async () => {} },
  )
  if (capture.view === null) throw new Error('context was not assembled')
  return capture.view
}

/** Neutral appraisal the rule table produces for `'你好讨厌。'` from a listener. */
const LISTENER_NEGATIVE: Appraisal = {
  goalRelevance: 0.6,
  goalCongruence: -0.6,
  agency: 'other',
  certainty: 0.5,
  control: 0.2,
  normCompatibility: 0,
}

/** Appraisal that pushes every dimension towards its maximum. */
const EXTREME_MAX: Appraisal = {
  goalRelevance: 1,
  goalCongruence: 1,
  agency: 'self',
  certainty: 1,
  control: 1,
  normCompatibility: 1,
}

/** Appraisal that pushes every dimension towards its minimum. */
const EXTREME_MIN: Appraisal = {
  goalRelevance: 1,
  goalCongruence: -1,
  agency: 'circumstance',
  certainty: 0,
  control: 0,
  normCompatibility: -1,
}

const DIMENSIONS = ['mood', 'stress', 'energy', 'attachment', 'confidence'] as const

describe('M4 state projection: projectState', () => {
  it('limits a single change to maxDelta on every dimension', () => {
    const profile = { tauMs: 1000, maxDelta: 0.15, deadzone: 0 }
    const next = projectState(ALL_HALF, [EXTREME_MAX], 60_000, ALL_HALF, profile)

    for (const dimension of DIMENSIONS) {
      expect(Math.abs(next[dimension] - ALL_HALF[dimension])).toBeLessThanOrEqual(0.15 + 1e-12)
    }
    // energy's drive is 0.5 + 0.1 + 0.1 + 0.2 = 0.9, so its target is far above
    // the reachable range and the step lands exactly on the cap.
    expect(next.energy - ALL_HALF.energy).toBeCloseTo(0.15, 10)
  })

  it('regresses towards the baseline during silence', () => {
    const baseline: CharacterState = {
      mood: 0.5,
      stress: 0.5,
      energy: 0.5,
      attachment: 0.5,
      confidence: 0.5,
    }
    // Every dimension starts at least 0.3 away from its baseline, well outside
    // the 0.02 deadzone, so the deadzone never blocks the regression.
    const prev: CharacterState = {
      mood: 0.9,
      stress: 0.1,
      energy: 0.8,
      attachment: 0.2,
      confidence: 0.95,
    }
    // maxDelta 0.5 keeps the cap from binding: the largest step is about 0.2845.
    const profile = { tauMs: 60_000, maxDelta: 0.5, deadzone: 0.02 }

    const oneStep = projectState(prev, [], 60_000, baseline, profile)
    for (const dimension of DIMENSIONS) {
      const before = prev[dimension] - baseline[dimension]
      const after = oneStep[dimension] - baseline[dimension]
      // Monotone approach: strictly closer, and never overshooting the baseline.
      expect(Math.abs(after)).toBeLessThan(Math.abs(before))
      expect(after * before).toBeGreaterThanOrEqual(0)
    }

    const afterTenMinutes = projectState(prev, [], 600_000, baseline, profile)
    for (const dimension of DIMENSIONS) {
      expect(Math.abs(afterTenMinutes[dimension] - baseline[dimension])).toBeLessThan(1e-4)
    }
  })

  it('does not update inside the deadzone', () => {
    const prev: CharacterState = { ...ALL_HALF }
    const inside: CharacterState = {
      mood: 0.51,
      stress: 0.51,
      energy: 0.51,
      attachment: 0.51,
      confidence: 0.51,
    }
    const profile = { tauMs: 60_000, maxDelta: 0.15, deadzone: 0.05 }
    // Every target sits 0.01 from prev, strictly inside the deadzone.
    expect(projectState(prev, [], 60_000, inside, profile)).toEqual(prev)

    // Boundary: a target exactly one deadzone away still updates (strict `<`).
    const boundary: CharacterState = {
      mood: 0.55,
      stress: 0.55,
      energy: 0.55,
      attachment: 0.55,
      confidence: 0.55,
    }
    const moved = projectState(prev, [], 60_000, boundary, profile)
    expect(moved).not.toEqual(prev)
    for (const dimension of DIMENSIONS) {
      // alpha * 0.05 = 0.0316... at dtMs = tauMs, below maxDelta.
      expect(moved[dimension]).toBeGreaterThan(prev[dimension])
      expect(moved[dimension] - prev[dimension]).toBeLessThanOrEqual(0.05)
    }
  })

  it('defends against an invalid profile and never mutates prev', () => {
    const prev: CharacterState = {
      mood: 0.2,
      stress: 0.8,
      energy: 0.4,
      attachment: 0.6,
      confidence: 0.3,
    }
    const snapshot = { ...prev }
    const baseline: CharacterState = { ...ALL_HALF }

    for (const tauMs of [0, Number.NaN]) {
      const next = projectState(prev, [EXTREME_MAX], 60_000, baseline, {
        tauMs,
        maxDelta: 0.15,
        deadzone: 0,
      })
      expect(next).toEqual(prev)
      // A copy, not the caller's object.
      expect(next).not.toBe(prev)
    }

    const next = projectState(prev, [EXTREME_MAX, EXTREME_MIN], 60_000, baseline, {
      tauMs: 60_000,
      maxDelta: 0.5,
      deadzone: 0,
    })
    expect(prev).toEqual(snapshot)
    for (const dimension of DIMENSIONS) {
      expect(next[dimension]).toBeGreaterThanOrEqual(0)
      expect(next[dimension]).toBeLessThanOrEqual(1)
    }
  })

  it('survives a dtMs of 0 and negative dtMs', () => {
    const prev: CharacterState = { ...ALL_HALF }
    const profile = { tauMs: 60_000, maxDelta: 0.15, deadzone: 0 }
    // alpha is 0 either way, so prev + 0 * (target - prev) is prev even outside
    // the deadzone.
    expect(projectState(prev, [EXTREME_MAX], 0, ALL_HALF, profile)).toEqual(prev)
    expect(projectState(prev, [EXTREME_MAX], -5, ALL_HALF, profile)).toEqual(prev)
  })
})

describe('M4 state appraisal rules: appraiseTurn', () => {
  it('fires once on positive affect and reports agency by directedness', () => {
    const plain = appraiseTurn('今天好开心。', 'listener')
    expect(plain).toHaveLength(1)
    expect(plain[0]).toMatchObject({
      goalCongruence: 0.6,
      goalRelevance: 0.6,
      // No second-person marker, so the listener's mood is circumstance.
      agency: 'circumstance',
    })

    // A bare 真 is not in the intensifier table (only 真的 is), so this stays at
    // the unamplified magnitude; the amplification is covered below.
    const directed = appraiseTurn('你真厉害。', 'listener')
    expect(directed).toHaveLength(1)
    expect(directed[0]).toMatchObject({ agency: 'other', goalCongruence: 0.6 })
  })

  it('fires on negative affect with negativity winning ties', () => {
    const negative = appraiseTurn('你好讨厌。', 'listener')
    expect(negative).toHaveLength(1)
    expect(negative[0]).toMatchObject({ goalCongruence: -0.6, agency: 'other' })

    const intense = appraiseTurn('真的非常讨厌。', 'listener')[0]
    const plain = appraiseTurn('讨厌。', 'listener')[0]
    expect(intense?.goalCongruence).toBe(-0.8)
    expect(plain?.goalCongruence).toBe(-0.6)
    expect(Math.abs(intense?.goalCongruence ?? 0)).toBeGreaterThan(
      Math.abs(plain?.goalCongruence ?? 0),
    )
  })

  it('recognises a promise and a boundary violation through normCompatibility', () => {
    expect(appraiseTurn('你答应过我周五上线。', 'listener')[0]).toMatchObject({
      normCompatibility: 0.5,
      goalCongruence: 0.4,
      goalRelevance: 0.4,
      agency: 'other',
    })
    expect(appraiseTurn('你就是个骗子。', 'listener')[0]).toMatchObject({
      normCompatibility: -0.8,
      goalCongruence: -0.6,
      agency: 'other',
    })
  })

  it('maps role to agency', () => {
    const self = appraiseTurn('今天很开心。', 'character')
    expect(self[0]?.agency).toBe('self')
    // The same text from a listener carries no second-person marker.
    const other = appraiseTurn('今天很开心。', 'listener')
    expect(other[0]?.agency).toBe('circumstance')
  })

  it('returns nothing when no rule fires and for non-speech', () => {
    expect(appraiseTurn('我们明天再聊吧。', 'listener')).toEqual([])
    // Punctuation only is not speech (see the shared substantive-speech test).
    expect(appraiseTurn('...!?', 'listener')).toEqual([])
    // Deterministic: the same input produces the same appraisal.
    expect(appraiseTurn('你好讨厌。', 'listener')).toEqual(appraiseTurn('你好讨厌。', 'listener'))
  })
})

describe('M4 state block rendering: renderStateBlock', () => {
  it('renders the exact numeric block', () => {
    expect(renderStateBlock(SAMPLE_STATE, { ...DEFAULT_STATE_PROFILE, renderMode: 'numeric' })).toBe(
      'Current inner state (0-1, do not quote numbers):\n' +
        'mood=0.6 stress=0.7 energy=0.4 attachment=0.5 confidence=0.5',
    )
  })

  it('renders the verbal block without any digit', () => {
    const block = renderStateBlock(SAMPLE_STATE, { ...DEFAULT_STATE_PROFILE, renderMode: 'verbal' })
    expect(block).toContain('Current inner state (qualitative, do not quote numbers):')
    expect(/\d/.test(block)).toBe(false)

    // Band boundaries belong to the higher band.
    const boundary = renderStateBlock(
      { mood: 0.25, stress: 0.5, energy: 0.75, attachment: 0.24, confidence: 0.49 },
      { ...DEFAULT_STATE_PROFILE, renderMode: 'verbal' },
    )
    expect(boundary).toContain('mood: somewhat low')
    expect(boundary).toContain('stress: somewhat high')
    expect(boundary).toContain('energy: high')
    expect(boundary).toContain('attachment: low')
    expect(boundary).toContain('confidence: somewhat low')
  })

  it('clamps out-of-range values before formatting', () => {
    const numeric = renderStateBlock(
      { mood: 1.5, stress: -0.3, energy: 0.5, attachment: 0.5, confidence: 0.5 },
      { ...DEFAULT_STATE_PROFILE, renderMode: 'numeric' },
    )
    expect(numeric).toContain('mood=1.0')
    expect(numeric).toContain('stress=0.0')

    const verbal = renderStateBlock(
      { mood: 1.5, stress: -0.3, energy: 0.5, attachment: 0.5, confidence: 0.5 },
      { ...DEFAULT_STATE_PROFILE, renderMode: 'verbal' },
    )
    expect(verbal).toContain('mood: high')
    expect(verbal).toContain('stress: low')
  })

  it('is deterministic', () => {
    const profile = { ...DEFAULT_STATE_PROFILE }
    expect(renderStateBlock(SAMPLE_STATE, profile)).toBe(renderStateBlock(SAMPLE_STATE, profile))
  })
})

describe('M4 state block in context (default off)', () => {
  it('renders nothing and keeps the prompt unchanged without state', async () => {
    const memory = await seededMemory()
    const omitted = await assemble(memory)
    const explicit = await assemble(memory, {
      state: undefined,
      stateBaseline: undefined,
      stateProfile: undefined,
    })

    expect(omitted.stateBlock).toBeNull()
    expect(explicit.stateBlock).toBeNull()
    expect(renderDialoguePrompt(omitted)).not.toContain('Current inner state')
    expect(renderDialoguePrompt(explicit)).not.toContain('Current inner state')
    // Byte-identical: omitting the key and passing undefined are the same path.
    expect(renderDialoguePrompt(explicit)).toBe(renderDialoguePrompt(omitted))

    // The default path still charges exactly the rendered turn lines.
    expect(omitted.estimatedCharacters).toBe(
      omitted.turns.reduce((total, turn) => total + turn.characters, 0),
    )
  })

  it('inserts the state block after the persona block and before recall', async () => {
    const memory = await seededMemory()
    const view = await assemble(memory, {
      state: SAMPLE_STATE,
      stateProfile: { ...DEFAULT_STATE_PROFILE, renderMode: 'numeric' },
    })
    expect(view.stateBlock).not.toBeNull()
    const prompt = renderDialoguePrompt(view)
    const stateIndex = prompt.indexOf('Current inner state')
    expect(stateIndex).toBeGreaterThan(prompt.indexOf('Persona:'))
    expect(stateIndex).toBeLessThan(prompt.indexOf('Listener said:'))
    expect(prompt).toContain(view.stateBlock ?? '')
  })
})

describe('M4 state block budget', () => {
  it('charges the state block to the shared character budget', async () => {
    const memory = await seededMemory()
    // Each default turn renders at 30 characters: 90 <= 150 keeps all three.
    const without = await assemble(memory, { maxCharacters: 150 })
    expect(without.turns).toHaveLength(3)

    const withState = await assemble(memory, { state: SAMPLE_STATE, maxCharacters: 150 })
    // The block takes shared budget, so fewer confirmed turns fit.
    expect(withState.turns.length).toBeLessThan(without.turns.length)

    expect(withState.stateBlock).not.toBeNull()
    expect(withState.estimatedCharacters).toBe(
      withState.turns.reduce((total, turn) => total + turn.characters, 0) +
        (withState.stateBlock?.length ?? 0) +
        (withState.rollup?.characters ?? 0),
    )
    expect(withState.estimatedCharacters).toBeLessThanOrEqual(150)
  })

  it('the state block never pushes the assembly past the cap', async () => {
    const memory = await seededMemory()
    const roomy = await assemble(memory, { state: SAMPLE_STATE })
    const blockLength = roomy.stateBlock?.length ?? 0
    expect(blockLength).toBeGreaterThan(0)

    const noStateAtTinyCap = await assemble(memory, { maxCharacters: blockLength - 1 })

    // Exactly the block length: `<=` keeps the block, and nothing else fits.
    const exact = await assemble(memory, { state: SAMPLE_STATE, maxCharacters: blockLength })
    expect(exact.stateBlock?.length).toBe(blockLength)
    expect(exact.turns).toHaveLength(0)
    expect(exact.estimatedCharacters).toBe(blockLength)

    // One character short: the block is dropped and recorded, and the budget
    // path returns to what the assembly without state produces.
    const dropped = await assemble(memory, { state: SAMPLE_STATE, maxCharacters: blockLength - 1 })
    expect(dropped.stateBlock).toBeNull()
    expect(dropped.estimatedCharacters).toBe(noStateAtTinyCap.estimatedCharacters)
    expect(dropped.estimatedCharacters).toBeLessThanOrEqual(blockLength - 1)
    expect(dropped.warnings.some((warning) => warning.includes('state block'))).toBe(true)
    expect(renderDialoguePrompt(dropped)).not.toContain('Current inner state')
    expect(dropped.turns).toHaveLength(noStateAtTinyCap.turns.length)
  })
})

describe('M4 state trajectory invariants', () => {
  it('a 10-turn trajectory has no 0→1→0 jumps', () => {
    const baseline: CharacterState = { ...ALL_HALF }
    const profile = { tauMs: 60_000, maxDelta: 0.15, deadzone: 0 }
    let prev: CharacterState = { ...baseline }
    for (let step = 0; step < 10; step += 1) {
      const appraisal = step % 2 === 0 ? EXTREME_MAX : EXTREME_MIN
      const next = projectState(prev, [appraisal], 60_000, baseline, profile)
      for (const dimension of DIMENSIONS) {
        expect(Math.abs(next[dimension] - prev[dimension])).toBeLessThanOrEqual(0.15 + 1e-12)
        const before = prev[dimension]
        const after = next[dimension]
        expect(before <= 0.05 && after >= 0.95).toBe(false)
        expect(before >= 0.95 && after <= 0.05).toBe(false)
        expect(after).toBeGreaterThanOrEqual(0)
        expect(after).toBeLessThanOrEqual(1)
      }
      prev = next
    }
  })

  it('the same event reacts differently on different baselines', () => {
    const profile = { tauMs: 60_000, maxDelta: 0.3, deadzone: 0.02 }
    const calm: CharacterState = { ...ALL_HALF }
    const tense: CharacterState = {
      mood: 0.5,
      stress: 0.9,
      energy: 0.5,
      attachment: 0.5,
      confidence: 0.5,
    }

    /*
     * stress drive for LISTENER_NEGATIVE, recomputed from APPRAISAL_WEIGHTS:
     * 0.4 * 0.6 + (-0.3) * (-0.6) + 0.1 * 1 - 0.1 * 0.5 - 0.4 * 0.2 = 0.39
     *   - calm  target = 0.5 + 0.39  = 0.89 -> next  = 0.5 + 0.6321 * 0.39 = 0.7465
     *   - tense target = 0.9 + 0.39  = 1.00 (clamped) -> next = 0.9632
     * Neither side is pinned to a clamp, so the comparison stays meaningful.
     */
    const weightSum =
      APPRAISAL_WEIGHTS.stress.goalRelevance * LISTENER_NEGATIVE.goalRelevance +
      APPRAISAL_WEIGHTS.stress.goalCongruence * LISTENER_NEGATIVE.goalCongruence +
      APPRAISAL_WEIGHTS.stress.agencyOther * 1 +
      APPRAISAL_WEIGHTS.stress.certainty * LISTENER_NEGATIVE.certainty +
      APPRAISAL_WEIGHTS.stress.control * LISTENER_NEGATIVE.control
    expect(weightSum).toBeCloseTo(0.39, 10)

    const nextCalm = projectState(calm, [LISTENER_NEGATIVE], 60_000, calm, profile)
    const nextTense = projectState(tense, [LISTENER_NEGATIVE], 60_000, tense, profile)
    expect(nextCalm.stress).toBeCloseTo(0.7465, 3)
    expect(nextTense.stress).toBeCloseTo(0.9632, 3)
    expect(nextCalm.stress).toBeLessThan(nextTense.stress)
    expect(nextCalm).not.toEqual(nextTense)
  })
})
