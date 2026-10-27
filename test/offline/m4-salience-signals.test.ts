import { describe, expect, it } from 'vitest'
import {
  MAX_PINNED_TURNS,
  SALIENCE_PIN_THRESHOLD,
  scoreSalience,
} from '../../src/dialogue'
import type { SalienceSignal } from '../../src/dialogue'

/**
 * Signal tests for salience scoring.
 *
 * The pin is a retention hint, so a signal that fires too easily is not a
 * cosmetic problem: it pins ordinary turns, and pinned turns are trimmed last.
 * The previous `concrete-detail` signal was `/\d/`, which scored ANY digit - a
 * list index pinned a turn as firmly as a birthday. These cases lock the
 * refined meaning, and the threshold and cap that were deliberately NOT touched.
 */
function signalsOf(text: string): readonly SalienceSignal[] {
  return scoreSalience(text).signals
}

describe('M4 concrete-detail signal', () => {
  it('does not fire on a bare single digit', () => {
    // The regression this refinement exists for: a list index is not a detail.
    expect(signalsOf('Part 3 is easier.')).toEqual([])
    expect(signalsOf('I ate 2 of them.')).toEqual([])
  })

  it('fires on a digit with a unit', () => {
    expect(signalsOf('我有2只猫。')).toContain('concrete-detail')
    expect(signalsOf('I have 3 cats.')).toContain('concrete-detail')
  })

  it('fires on a multi-digit identifier such as a date', () => {
    expect(signalsOf('我的生日是0603。')).toContain('concrete-detail')
    expect(signalsOf('The order is 2024-11-03.')).toContain('concrete-detail')
  })

  it('fires on a clock time', () => {
    expect(signalsOf('Meeting at 3:30.').length).toBeGreaterThanOrEqual(0)
    expect(signalsOf('Meeting at 3:30.')).toContain('concrete-detail')
  })

  it('does not fire on a bare time word', () => {
    // A time word carries no number and appears in ordinary chatter; scoring it
    // would re-create the noise the digit rule was supposed to remove. 周末
    // names no day at all, so it stays in this company.
    expect(signalsOf('明天见。')).toEqual([])
    expect(signalsOf('晚上再聊。')).toEqual([])
    expect(signalsOf('周末再聊。')).toEqual([])
  })

  it('fires on a CJK weekday, which names a specific day', () => {
    expect(signalsOf('周五晚上连麦。')).toContain('concrete-detail')
    expect(signalsOf('星期三见。')).toContain('concrete-detail')
  })
})

describe('M4 promise / preference / identity cues', () => {
  it('recognises Chinese emphasis, not only the 记住 shape', () => {
    expect(signalsOf('千万要记得给我打电话。')).toContain('promise')
    expect(signalsOf('别再忘了。')).toContain('promise')
    expect(signalsOf('说好了的事。')).toContain('promise')
    expect(signalsOf('Make sure you call me.')).toContain('promise')
  })

  it('does not read a bare 一定 as a promise', () => {
    // 那一定很好 asserts a likelihood, not a commitment.
    expect(signalsOf('那一定很好。')).toEqual([])
  })

  it('does not read the polite refusal 下次一定 as a promise', () => {
    // A common livestream deflection: the literal 一定 is present, but the
    // sentence dodges the commitment instead of making one.
    expect(signalsOf('下次一定。')).toEqual([])
  })

  it('recognises commitment forms beyond the 记住 family', () => {
    expect(signalsOf('我承诺下周玩这个游戏。')).toContain('promise')
    expect(signalsOf('一言为定。')).toContain('promise')
    expect(signalsOf('说定了，周五见。')).toContain('promise')
    expect(signalsOf('包在我身上。')).toContain('promise')
    expect(signalsOf('I swear I will be there.')).toContain('promise')
    expect(signalsOf('You have my word.')).toContain('promise')
  })

  it('recognises a Chinese preference', () => {
    expect(signalsOf('我讨厌下雨天。')).toContain('preference')
    expect(signalsOf('我最喜欢这只猫。')).toContain('preference')
  })

  it('recognises preference forms beyond the 喜欢 family', () => {
    expect(signalsOf('最爱这个游戏。')).toContain('preference')
    expect(signalsOf('我对这首歌着迷。')).toContain('preference')
    expect(signalsOf('排队排得烦死了。')).toContain('preference')
    expect(signalsOf('I am obsessed with this song.')).toContain('preference')
  })

  it('recognises a name or birthday statement as identity', () => {
    expect(signalsOf('大家都叫我小艾。')).toContain('identity')
    expect(signalsOf('我的生日在六月。')).toContain('identity')
  })

  it('recognises naming and origin forms beyond the 我叫 shape', () => {
    expect(signalsOf('请叫我小艾。')).toContain('identity')
    expect(signalsOf('观众都叫我阿艾。')).toContain('identity')
    expect(signalsOf('我来自东北。')).toContain('identity')
    expect(signalsOf("I'm called Alex.")).toContain('identity')
  })

  it('keeps a preference plus nothing else below the pin threshold', () => {
    // Identity alone is 2 points: the threshold was not lowered to make the new
    // cues pin more often.
    expect(scoreSalience('我的生日在六月。').score).toBeLessThan(SALIENCE_PIN_THRESHOLD)
  })
})

describe('M4 salience constants and determinism', () => {
  it('leaves the threshold and the pin cap untouched', () => {
    expect(SALIENCE_PIN_THRESHOLD).toBe(3)
    expect(MAX_PINNED_TURNS).toBe(3)
  })

  it('still pins the documented promise example', () => {
    expect(scoreSalience('记住我们的约定。').score).toBeGreaterThanOrEqual(SALIENCE_PIN_THRESHOLD)
  })

  it('keeps an unknown question scoring one point and nothing more', () => {
    expect(scoreSalience('你去不去？')).toEqual({ score: 1, signals: ['unanswered-question'] })
  })

  it('scores nothing for non-speech', () => {
    expect(scoreSalience('...!?')).toEqual({ score: 0, signals: [] })
  })

  it('is deterministic', () => {
    const text = 'Remember this: my birthday is 0603.'
    expect(scoreSalience(text)).toEqual(scoreSalience(text))
  })
})
