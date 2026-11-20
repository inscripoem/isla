import { describe, expect, it } from 'vitest'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  MAX_PINNED_TURNS,
  SALIENCE_PIN_THRESHOLD,
  assembleDialogueContext,
  createDeliveryMemoryStore,
  resolveCharacterProfile,
  scoreSalience,
} from '../../src/dialogue'
import type { AssembledDialogueContext } from '../../src/dialogue'

/**
 * Salience v2 tests (M4-A03): role-aware scoring, normalization, decay and
 * listener-side pinning features. Every changed expectation is annotated with the
 * v2 rule that changed it.
 */
function signalsOfListener(text: string): readonly string[] {
  return scoreSalience({ role: 'listener', text }).signals
}

describe('M4 concrete-detail signal', () => {
  it('does not fire on a bare single digit', () => {
    // v2: concrete-detail stays in both catalogs; bare single digit still excluded.
    expect(signalsOfListener('Part 3 is easier.')).toEqual([])
    expect(signalsOfListener('I ate 2 of them.')).toEqual([])
  })

  it('fires on a digit with a unit', () => {
    expect(signalsOfListener('我有2只猫。')).toContain('concrete-detail')
    expect(signalsOfListener('I have 3 cats.')).toContain('concrete-detail')
  })

  it('fires on a multi-digit identifier such as a date', () => {
    expect(signalsOfListener('我的生日是0603。')).toContain('concrete-detail')
    expect(signalsOfListener('The order is 2024-11-03.')).toContain('concrete-detail')
  })

  it('fires on a clock time', () => {
    expect(signalsOfListener('Meeting at 3:30.')).toContain('concrete-detail')
  })

  it('does not fire on a bare time word', () => {
    expect(signalsOfListener('明天见。')).toEqual([])
    expect(signalsOfListener('晚上再聊。')).toEqual([])
    expect(signalsOfListener('周末再聊。')).toEqual([])
  })

  it('fires on a CJK weekday, which names a specific day', () => {
    expect(signalsOfListener('周五晚上连麦。')).toContain('concrete-detail')
    expect(signalsOfListener('星期三见。')).toContain('concrete-detail')
  })
})

describe('M4 promise / preference / identity cues', () => {
  it('recognises Chinese emphasis, not only the 记住 shape', () => {
    expect(signalsOfListener('千万要记得给我打电话。')).toContain('promise')
    expect(signalsOfListener('别再忘了。')).toContain('promise')
    expect(signalsOfListener('说好了的事。')).toContain('promise')
    expect(signalsOfListener('Make sure you call me.')).toContain('promise')
  })

  it('does not read a bare 一定 as a promise', () => {
    expect(signalsOfListener('那一定很好。')).toEqual([])
  })

  it('does not read the polite refusal 下次一定 as a promise', () => {
    expect(signalsOfListener('下次一定。')).toEqual([])
  })

  it('recognises commitment forms beyond the 记住 family', () => {
    // v2 rule: listener catalog keeps this pattern as 'promise'.
    expect(signalsOfListener('我承诺下周玩这个游戏。')).toContain('promise')
    expect(signalsOfListener('一言为定。')).toContain('promise')
    expect(signalsOfListener('说定了，周五见。')).toContain('promise')
    expect(signalsOfListener('包在我身上。')).toContain('promise')
    expect(signalsOfListener('I swear I will be there.')).toContain('promise')
    expect(signalsOfListener('You have my word.')).toContain('promise')
  })

  it('recognises a Chinese preference', () => {
    expect(signalsOfListener('我讨厌下雨天。')).toContain('preference')
    expect(signalsOfListener('我最喜欢这只猫。')).toContain('preference')
  })

  it('recognises preference forms beyond the 喜欢 family', () => {
    expect(signalsOfListener('最爱这个游戏。')).toContain('preference')
    expect(signalsOfListener('我对这首歌着迷。')).toContain('preference')
    expect(signalsOfListener('排队排得烦死了。')).toContain('preference')
    expect(signalsOfListener('I am obsessed with this song.')).toContain('preference')
  })

  it('recognises a name or birthday statement as self-disclosure', () => {
    // v2 rule: listener identity-pattern signal is renamed to 'self-disclosure'.
    expect(signalsOfListener('大家都叫我小艾。')).toContain('self-disclosure')
    expect(signalsOfListener('我的生日在六月。')).toContain('self-disclosure')
  })

  it('recognises naming and origin forms beyond the 我叫 shape', () => {
    // v2 rule: listener self-disclosure (identity pattern) covers these forms.
    expect(signalsOfListener('请叫我小艾。')).toContain('self-disclosure')
    expect(signalsOfListener('观众都叫我阿艾。')).toContain('self-disclosure')
    expect(signalsOfListener('我来自东北。')).toContain('self-disclosure')
    expect(signalsOfListener("I'm called Alex.")).toContain('self-disclosure')
  })

  it('pins a listener preference alone under v2 normalization', () => {
    // v2 rule (inversion): listener preference weight 2 / max 3 ~= 0.667 >= 0.35, so it pins.
    const result = scoreSalience({ role: 'listener', text: '我最喜欢草莓。' })
    expect(result.signals).toContain('preference')
    expect(result.score).toBeCloseTo(2 / 3, 6)
    expect(result.decayed).toBeCloseTo(2 / 3, 6)
    expect(result.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
  })
})

describe('M4 salience constants and determinism', () => {
  it('uses the v2 threshold and keeps the pin cap', () => {
    // v2 rule: threshold repurposed to 0.35 on 0..1 decayed scale; cap stays 3.
    expect(SALIENCE_PIN_THRESHOLD).toBe(0.35)
    expect(MAX_PINNED_TURNS).toBe(3)
  })

  it('still pins the documented promise example', () => {
    // v2 rule: promise alone (listener) normalizes to 1.0 and pins.
    expect(scoreSalience({ role: 'listener', text: '记住我们的约定。' }).decayed).toBeGreaterThanOrEqual(
      SALIENCE_PIN_THRESHOLD,
    )
  })

  it('keeps an unknown question scoring one point and nothing more', () => {
    // v2 rule: lone listener question weight 1 / 3 ~= 0.333, no pin.
    const result = scoreSalience({ role: 'listener', text: '你去不去？' })
    expect(result.signals).toEqual(['unanswered-question'])
    expect(result.score).toBeCloseTo(1 / 3, 6)
    expect(result.decayed).toBeLessThan(SALIENCE_PIN_THRESHOLD)
  })

  it('scores nothing for non-speech', () => {
    // v2 rule: non-speech returns { score: 0, signals: [], decayed: 0 }.
    expect(scoreSalience({ role: 'listener', text: '...!?' })).toEqual({
      score: 0,
      signals: [],
      decayed: 0,
    })
  })

  it('is deterministic', () => {
    // v2 rule: same input twice -> deep-equal results (pure function, no clock).
    const input = { role: 'character' as const, text: 'Remember this: my birthday is 0603.' }
    expect(scoreSalience(input)).toEqual(scoreSalience(input))
  })
})

describe('M4-A03 salience v2 cases', () => {
  it('pins listener self-disclosure', () => {
    // v2: self-disclosure + concrete-detail, base capped at 1, ageMs 0 => decayed ~= score.
    const result = scoreSalience({ role: 'listener', text: '我生日是 3 月 5 日', ageMs: 0 })
    expect(result.signals).toContain('self-disclosure')
    expect(result.signals).toContain('concrete-detail')
    expect(result.signals).not.toContain('preference')
    expect(result.score).toBe(1)
    expect(result.decayed).toBeCloseTo(1, 6)
    expect(result.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
  })

  it('splits role on the same identity text', () => {
    // v2: listener -> 'self-disclosure', character -> 'identity'; both pin.
    const listener = scoreSalience({ role: 'listener', text: '我叫 Elleya' })
    const character = scoreSalience({ role: 'character', text: '我叫 Elleya' })
    expect(listener.signals).toContain('self-disclosure')
    expect(character.signals).toContain('identity')
    expect(listener.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
    expect(character.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
    expect(character.signals).not.toContain('preference')
  })

  it('scores character boundary and commitment', () => {
    // v2: character boundary 2/3 pins, commitment 1.0 pins.
    const boundary = scoreSalience({ role: 'character', text: '抱歉，我做不到哦' })
    expect(boundary.signals).toContain('boundary')
    expect(boundary.score).toBeCloseTo(2 / 3, 6)
    expect(boundary.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
    const commitment = scoreSalience({ role: 'character', text: '我答应你，一定会来' })
    expect(commitment.signals).toContain('commitment')
    expect(commitment.score).toBe(1)
    expect(commitment.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
  })

  it('scores listener relationship and emotion peak', () => {
    // v2: listener-only signals, each weight 2/3 ~= 0.667, pins.
    const relationship = scoreSalience({ role: 'listener', text: '我妈今天住院了' })
    expect(relationship.signals).toContain('relationship')
    expect(relationship.score).toBeCloseTo(2 / 3, 6)
    expect(relationship.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
    const emotion = scoreSalience({ role: 'listener', text: '我今天崩溃了' })
    expect(emotion.signals).toContain('emotion-peak')
    expect(emotion.score).toBeCloseTo(2 / 3, 6)
    expect(emotion.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
  })

  it('scores character preference text as nothing', () => {
    // v2: character has no preference catalog entry.
    const result = scoreSalience({ role: 'character', text: '我最喜欢吃草莓' })
    expect(result.signals).not.toContain('preference')
    expect(result.score).toBe(0)
    expect(result.decayed).toBe(0)
    expect(result.decayed).toBeLessThan(SALIENCE_PIN_THRESHOLD)
  })

  it('applies mention bonus and cap', () => {
    // v2: mention step 0.05, cap 0.2 at 4 mentions.
    const base = scoreSalience({ role: 'listener', text: '我最喜欢草莓' })
    const boosted = scoreSalience({ role: 'listener', text: '我最喜欢草莓', mentionCount: 3 })
    const capped = scoreSalience({ role: 'listener', text: '我最喜欢草莓', mentionCount: 10 })
    expect(boosted.score).toBeCloseTo(base.score + 0.15, 6)
    expect(boosted.score).toBeGreaterThan(base.score)
    expect(capped.score).toBeCloseTo(base.score + 0.2, 6)
  })

  it('decays by age and can fall below threshold', () => {
    // v2: 60 days -> exp(-60/45) ~= 0.264, 0.667 * 0.264 < 0.35.
    const fresh = scoreSalience({ role: 'listener', text: '我今天崩溃了', ageMs: 0 })
    const old = scoreSalience({ role: 'listener', text: '我今天崩溃了', ageMs: 60 * 86_400_000 })
    expect(old.decayed).toBeCloseTo(fresh.decayed * Math.exp(-60 / 45), 6)
    expect(fresh.decayed).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
    expect(old.decayed).toBeLessThan(SALIENCE_PIN_THRESHOLD)
  })

  it('keeps unknown age equal to score for character shape', () => {
    // v2: absent ageMs -> decayed === score exactly.
    const result = scoreSalience({ role: 'character', text: 'Remember this: my birthday is 0603.' })
    expect(result.decayed).toBe(result.score)
  })

  it('is deterministic for the same input', () => {
    // v2: pure function, no clock.
    const input = { role: 'listener' as const, text: '我妈今天住院了', ageMs: 1234 }
    expect(scoreSalience(input)).toEqual(scoreSalience(input))
  })
})

describe('M4-A03 listener salience integration', () => {
  it('attaches listener salience without changing character trimming or rendering', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: FIXTURE_SESSION_ID,
        turnId: 'turn-plain',
        segmentId: 'turn-plain-seg-0',
        textHash: 'hash-plain',
        text: 'A plain line about nothing much.',
      }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: FIXTURE_SESSION_ID,
        turnId: 'turn-pinned',
        segmentId: 'turn-pinned-seg-0',
        textHash: 'hash-pinned',
        text: 'Remember this: my birthday is 0603.',
      }),
    )

    const profile = resolveCharacterProfile('character-fixture', '1')
    if (profile === null) throw new Error('fixture profile missing')

    const base = await assembleDialogueContext({
      request: fixtureDialogueRequest(),
      profile,
      history: memory,
    })

    const listenerTurns = [
      {
        eventId: 'evt-old',
        sessionId: FIXTURE_SESSION_ID,
        text: '我叫 Elleya',
        receivedAtMs: 0,
        actorId: null,
        trust: 'untrusted-content' as const,
      },
      {
        eventId: 'evt-fresh',
        sessionId: FIXTURE_SESSION_ID,
        text: '我叫 Elleya',
        receivedAtMs: 60 * 86_400_000,
        actorId: null,
        trust: 'untrusted-content' as const,
      },
    ]

    const view = await assembleDialogueContext({
      request: fixtureDialogueRequest(),
      profile,
      history: memory,
      listenerTurns,
    })

    const listenerEntries = view.transcript.filter((e) => e.role === 'listener')
    expect(listenerEntries).toHaveLength(2)
    expect(listenerEntries[0]?.salience?.signals).toContain('self-disclosure')
    expect(listenerEntries[1]?.salience?.signals).toContain('self-disclosure')
    const oldDecayed = listenerEntries[0]?.salience?.decayed ?? 1
    const freshDecayed = listenerEntries[1]?.salience?.decayed ?? 0
    expect(oldDecayed).toBeLessThan(freshDecayed)

    // Character trimming/pinning untouched by listener scoring.
    expect(view.turns).toEqual(base.turns)
    expect(view.turns.filter((t) => t.pinned).length).toBeLessThanOrEqual(MAX_PINNED_TURNS)

    // No rendering change: rendered character transcript lines/budget identical.
    const characterLines = (v: AssembledDialogueContext): string[] =>
      v.transcript.filter((e) => e.role === 'character').map((e) => {
        const t = e.turn
        return `${t.text}|${t.pinned}|${t.salienceScore}|${t.conflicting ?? false}`
      })
    expect(characterLines(view)).toEqual(
      base.transcript.length > 0
        ? characterLines(base)
        : base.turns.map((t) => `${t.text}|${t.pinned}|${t.salienceScore}|${t.conflicting ?? false}`),
    )
  })
})

describe('M4-A03 Finding 1: recorded co-occurrence semantics', () => {
  it('character history: the second turn keeps the documented co-occurrence bonus (0.333 + 0.05)', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: FIXTURE_SESSION_ID,
        turnId: 'turn-cats',
        segmentId: 'turn-cats-seg-0',
        textHash: 'hash-cats',
        text: 'I have 3 cats.',
      }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: FIXTURE_SESSION_ID,
        turnId: 'turn-order',
        segmentId: 'turn-order-seg-0',
        textHash: 'hash-order',
        text: 'The order is 2024-11-03.',
      }),
    )
    const profile = resolveCharacterProfile('character-fixture', '1')
    if (profile === null) throw new Error('fixture profile missing')
    const view = await assembleDialogueContext({
      request: fixtureDialogueRequest(),
      profile,
      history: memory,
    })
    const cats = view.turns.find((turn) => turn.text === 'I have 3 cats.')
    const order = view.turns.find((turn) => turn.text === 'The order is 2024-11-03.')
    /*
     * Co-occurrence pin (Finding 1): the character pass counts earlier
     * same-session, same-role turns whose primary signal equals this turn's
     * primary signal, so the second turn is 0.333 (concrete-detail alone) +
     * 0.05 - the bonus IS applied. This is the recorded decision: signal
     * co-occurrence, not entity/topic repetition; an entity/topic key would be
     * a breaking semantic change superseded by A10. The same scenario at the
     * character role is the Finding 3 symmetry note (see the context.ts
     * comments).
     */
    expect(cats?.salienceScore).toBeCloseTo(1 / 3, 6)
    expect(order?.salienceScore).toBeCloseTo((1 / 3) + 0.05, 6)
  })

  it('differentiation negative: an earlier promise turn leaves the preference turn at 0.667', async () => {
    const profile = resolveCharacterProfile('character-fixture', '1')
    if (profile === null) throw new Error('fixture profile missing')
    const view = await assembleDialogueContext({
      request: fixtureDialogueRequest(),
      profile,
      history: createDeliveryMemoryStore(),
      listenerTurns: [
        {
          eventId: 'evt-neg-1',
          sessionId: FIXTURE_SESSION_ID,
          text: '记住我们的约定。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
        {
          eventId: 'evt-neg-2',
          sessionId: FIXTURE_SESSION_ID,
          text: '我最喜欢草莓。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
      ],
    })
    const listenerEntries = view.transcript.filter((entry) => entry.role === 'listener')
    const preferenceTurn = listenerEntries.find((entry) => entry.turn.eventId === 'evt-neg-2')
    // Different primary signals ('promise' then 'preference'): no mention
    // bonus across different signals, so the preference turn stays at 2/3.
    expect(preferenceTurn?.salience?.decayed).toBeCloseTo(2 / 3, 6)
  })
})

describe('M4-A03 Finding 2: assembly-level mention cases', () => {
  it('session isolation / per-(sessionId, role) keying: identical preference listener turns in two sessions score 0.667 each; second turn in the first session scores 0.717', async () => {
    const profile = resolveCharacterProfile('character-fixture', '1')
    if (profile === null) throw new Error('fixture profile missing')
    const view = await assembleDialogueContext({
      request: fixtureDialogueRequest(),
      profile,
      history: createDeliveryMemoryStore(),
      listenerTurns: [
        {
          eventId: 'evt-iso-01',
          sessionId: 'session-fixture-a',
          text: '我最喜欢草莓。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
        {
          eventId: 'evt-iso-02',
          sessionId: 'session-fixture-b',
          text: '我最喜欢草莓。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
        {
          eventId: 'evt-iso-03',
          sessionId: 'session-fixture-a',
          text: '我最喜欢草莓。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
      ],
    })
    const listenerEntries = view.transcript.filter((entry) => entry.role === 'listener')
    const salienceOf = (eventId: string) =>
      listenerEntries.find((entry) => entry.turn.eventId === eventId)?.salience
    // Per-(sessionId, role) keying: session B's turn gets no bonus despite
    // session A's earlier preference turn; session A's second turn gets it.
    expect(salienceOf('evt-iso-01')?.decayed).toBeCloseTo(2 / 3, 6)
    expect(salienceOf('evt-iso-02')?.decayed).toBeCloseTo(2 / 3, 6)
    expect(salienceOf('evt-iso-03')?.decayed).toBeCloseTo(2 / 3 + 0.05, 6)
  })

  it('repeated preference turn at assembly level: first 0.667, second 0.717', async () => {
    const profile = resolveCharacterProfile('character-fixture', '1')
    if (profile === null) throw new Error('fixture profile missing')
    const view = await assembleDialogueContext({
      request: fixtureDialogueRequest(),
      profile,
      history: createDeliveryMemoryStore(),
      listenerTurns: [
        {
          eventId: 'evt-repeat-1',
          sessionId: FIXTURE_SESSION_ID,
          text: '我最喜欢草莓。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
        {
          eventId: 'evt-repeat-2',
          sessionId: FIXTURE_SESSION_ID,
          text: '我最喜欢草莓。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
      ],
    })
    const listenerEntries = view.transcript.filter((entry) => entry.role === 'listener')
    const salienceOf = (eventId: string) =>
      listenerEntries.find((entry) => entry.turn.eventId === eventId)?.salience
    // The bonus survives the assembler path, unlike the clamped
    // '我叫 Elleya' case in the existing integration test.
    expect(salienceOf('evt-repeat-1')?.decayed).toBeCloseTo(2 / 3, 6)
    expect(salienceOf('evt-repeat-2')?.decayed).toBeCloseTo(2 / 3 + 0.05, 6)
  })
})

describe('M4-A03 Finding 3: pre-trim listener counting (budget-independent)', () => {
  it('budget-70 drop: the budget-dropped older turn still contributes its mention; the survivor keeps 0.717', async () => {
    const profile = resolveCharacterProfile('character-fixture', '1')
    if (profile === null) throw new Error('fixture profile missing')
    const view = await assembleDialogueContext({
      request: fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 70 } }),
      profile,
      history: createDeliveryMemoryStore(),
      listenerTurns: [
        {
          eventId: 'evt-drop-1',
          sessionId: FIXTURE_SESSION_ID,
          text: '我最喜欢草莓，也喜欢猫。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
        {
          eventId: 'evt-drop-2',
          sessionId: FIXTURE_SESSION_ID,
          text: '我最喜欢草莓，也喜欢猫。',
          receivedAtMs: 0,
          actorId: null,
          trust: 'untrusted-content',
        },
      ],
    })
    /*
     * Each listener line renders at 36 characters, so the two lines are 72
     * and the budget-70 loop drops the OLDER turn (evt-drop-1) by budget.
     * Counting is pre-trim, so the dropped turn still counts: the survivor
     * keeps scoring 0.717 instead of the 0.667 that surviving-only counting
     * would give.
     */
    expect(
      view.listenerExclusions.some(
        (entry) => entry.eventId === 'evt-drop-1' && entry.reason === 'listener-budget',
      ),
    ).toBe(true)
    const listenerEntries = view.transcript.filter((entry) => entry.role === 'listener')
    expect(listenerEntries).toHaveLength(1)
    expect(listenerEntries[0]?.turn.eventId).toBe('evt-drop-2')
    expect(listenerEntries[0]?.salience?.decayed).toBeCloseTo(2 / 3 + 0.05, 6)
  })
})

describe('M4-A03 Low 1: boundary pattern precision', () => {
  it('no longer fires boundary on the bare CJK hedges; keeps the first-person forms and the rest of the family', () => {
    // Bare CJK forms mark hedges (这不能说明问题。): no boundary signal fires
    // (the boundary signal is a character-catalog entry, so character role).
    expect(scoreSalience({ role: 'character', text: '这不能说明问题。' }).signals).not.toContain(
      'boundary',
    )
    expect(scoreSalience({ role: 'character', text: '不能这样。' }).signals).not.toContain(
      'boundary',
    )
    expect(
      scoreSalience({ role: 'character', text: '我不知道，不能确定。' }).signals,
    ).not.toContain('boundary')
    // The first-person anchored form still fires.
    expect(scoreSalience({ role: 'character', text: '我不能答应你。' }).signals).toContain(
      'boundary',
    )
  })
})

describe('M4-A03 Low 2: input clamping (mentionCount and ageMs)', () => {
  it('mentionCount: -3 scores identically to mentionCount: 0', () => {
    const negative = scoreSalience({ role: 'listener', text: '我最喜欢草莓。', mentionCount: -3 })
    const zero = scoreSalience({ role: 'listener', text: '我最喜欢草莓。', mentionCount: 0 })
    expect(negative.score).toBeCloseTo(zero.score, 6)
    expect(negative.decayed).toBeCloseTo(zero.decayed, 6)
    expect(negative.score).toBeCloseTo(2 / 3, 6)
  })

  it('ageMs: NaN yields decayed === score', () => {
    const result = scoreSalience({
      role: 'character',
      text: 'Remember this: my birthday is 0603.',
      ageMs: Number.NaN,
    })
    expect(result.decayed).toBe(result.score)
  })
})
