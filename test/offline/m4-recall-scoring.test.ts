import { describe, expect, it } from 'vitest'
import {
  INFORMATIVE_TOKEN_WEIGHT,
  MIN_RECALL_SCORE,
  contentTokensOf,
  createKeywordDeliveryRecall,
} from '../../src/dialogue'
import type { AssembledTurn } from '../../src/dialogue'

/**
 * Scoring tests for delivery-memory recall.
 *
 * Two properties are under test, and both are about precision rather than recall
 * volume, because a false recall costs budget and drags an unrelated old turn
 * into the prompt:
 *   1. glue words of a subtitled, file-less conversation score nothing;
 *   2. informative tokens score double, and a candidate must share at least one
 *      of them - two thin matches cannot reach the bar on their own.
 */
function turn(text: string): AssembledTurn {
  return {
    sessionId: 's1',
    turnId: `t-${text.length}`,
    segments: [],
    text,
    interrupted: false,
    personaVersion: null,
    pinned: false,
    salienceScore: 0,
    scope: 'session-only',
    kind: 'utterance',
    salienceSignals: [],
    characters: 0,
  }
}

function recall(inputText: string, candidates: readonly string[]): readonly string[] {
  const port = createKeywordDeliveryRecall()
  return port
    .recall({
      inputText,
      replyIntent: 'answer',
      sessionId: 's1',
      candidates: candidates.map(turn),
    })
    .map((entry) => entry.turn.text)
}

describe('M4 recall tokenization', () => {
  it('drops Latin function words and conversational verbs', () => {
    const tokens = contentTokensOf('What did you say about the weather, and what did I tell you')
    expect([...tokens.keys()]).toEqual(['weather'])
  })

  it('drops CJK glue bigrams and closed-class words', () => {
    // 我们 is a pronoun, 什么 is interrogative, 这个 is demonstrative: none can
    // establish a topic. 生日 is a content word and survives.
    const tokens = contentTokensOf('我们什么这个生日')
    expect(tokens.has('我们')).toBe(false)
    expect(tokens.has('什么')).toBe(false)
    expect(tokens.has('这个')).toBe(false)
    expect(tokens.get('生日')).toBe(INFORMATIVE_TOKEN_WEIGHT)
  })

  it('produces no token at all from a one-character run', () => {
    // The length floor: a solitary 我 must never become a matching key.
    expect(contentTokensOf('我').size).toBe(0)
    expect(contentTokensOf('我，你。他').size).toBe(0)
  })

  it('weights a long word or a number above a short word', () => {
    expect(contentTokensOf('concert').get('concert')).toBe(INFORMATIVE_TOKEN_WEIGHT)
    expect(contentTokensOf('cat').get('cat')).toBe(1)
    expect(contentTokensOf('0603').get('0603')).toBe(INFORMATIVE_TOKEN_WEIGHT)
  })

  it('weights a bigram of two content characters above a bigram of glue', () => {
    expect(contentTokensOf('生日').get('生日')).toBe(INFORMATIVE_TOKEN_WEIGHT)
    // 说了 contains 了, a glue character: still a token, but a thin one.
    expect(contentTokensOf('说了').get('说了')).toBe(1)
  })

  it('drops the CJK filler bigrams 感觉/自己/其实/以后', () => {
    // Each word standalone IS the bigram, so a clean drop leaves no token at
    // all. 自己/其实/以后 sit outside the glue-character table, so before they
    // were listed the tokenizer scored them as informative.
    expect(contentTokensOf('感觉').size).toBe(0)
    expect(contentTokensOf('自己').size).toBe(0)
    expect(contentTokensOf('其实').size).toBe(0)
    expect(contentTokensOf('以后').size).toBe(0)
  })

  it('drops Latin filler that used to clear the informative bar', () => {
    // "maybe"/"perhaps"/"gonna" are 5+ characters: before they were listed they
    // scored as informative and could carry a recall on their own.
    expect(contentTokensOf('maybe gonna wanna lol lmao perhaps').size).toBe(0)
  })
})

describe('M4 recall admission rule', () => {
  it('keeps MIN_RECALL_SCORE at two points', () => {
    expect(MIN_RECALL_SCORE).toBe(2)
  })

  it('does not recall on two thin tokens alone', () => {
    // Both tokens are three-character Latin words, so the weighted score is 2 -
    // the old implementation recalled here. One informative token is required.
    expect(recall('cat dog', ['The cat and the dog were here.'])).toEqual([])
  })

  it('recalls on a single informative token', () => {
    expect(recall('the garden', ['The garden was quiet.'])).toEqual(['The garden was quiet.'])
  })

  it('does not recall when only the query glue words match', () => {
    const onlyGlue = ['You said that about it.', 'The concert was loud.']
    expect(recall('What did you say about the concert', onlyGlue)).toEqual(['The concert was loud.'])
  })

  it('does not recall on shared filler alone', () => {
    // Both sides carry only filler tokens, so the query tokenizes to nothing
    // and no candidate can score.
    expect(recall('maybe 感觉', ['Maybe 感觉 was all.'])).toEqual([])
  })

  it('still recalls on the informative token beside the filler', () => {
    expect(recall('maybe the garden', ['Maybe the garden was quiet.'])).toEqual([
      'Maybe the garden was quiet.',
    ])
  })

  it('does not recall a CJK turn on shared glue bigrams', () => {
    // Three shared bigrams clear the score on their own, and every one of them
    // contains a glue character: the informative-token rule is what refuses it.
    expect(recall('说了是有', ['你说了是有。'])).toEqual([])
  })

  it('recalls a CJK turn on a shared content bigram', () => {
    expect(recall('生日是哪天', ['我的生日是六月三号。'])).toEqual(['我的生日是六月三号。'])
  })

  it('recalls on a shared date, which is an informative token', () => {
    expect(recall('0603', ['My birthday is 0603.'])).toEqual(['My birthday is 0603.'])
  })

  it('ranks a two-informative-token match above a one-token match', () => {
    const port = createKeywordDeliveryRecall()
    const entries = port.recall({
      inputText: 'the loud concert',
      replyIntent: 'answer',
      sessionId: 's1',
      candidates: [turn('The concert was fine.'), turn('The loud concert was bright.')].map(
        (candidate, index) => ({ ...candidate, turnId: `t${index}` }),
      ),
    })
    expect(entries.map((entry) => entry.turn.text)).toEqual([
      'The loud concert was bright.',
      'The concert was fine.',
    ])
    expect(entries[0]?.score).toBeGreaterThan(entries[1]?.score ?? 0)
  })

  it('is deterministic for the same input', () => {
    const candidates = ['The loud concert was bright.', 'A plain remark.']
    expect(recall('the loud concert', candidates)).toEqual(recall('the loud concert', candidates))
  })
})
