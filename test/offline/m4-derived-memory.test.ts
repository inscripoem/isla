import { describe, expect, it } from 'vitest'
import {
  DERIVED_EXTRACTOR_VERSION,
  EPISODE_MAX_GAP_MS,
  EPISODE_MAX_TURNS,
  deriveEpisode,
  deriveEpisodes,
  deriveTopics,
  monotonicAppliedSeq,
} from '../../src/dialogue'
import type { DerivedEpisode, DeriveSourceTurn } from '../../src/dialogue'

function turn(turnId: string, atMs: number, text: string, sessionId = 'sess-1'): DeriveSourceTurn {
  return { turnId, sessionId, text, atMs }
}

function turnsFrom(texts: readonly string[], stepMs = 1000): DeriveSourceTurn[] {
  return texts.map((text, index) => turn(`t${index + 1}`, 1_000 + index * stepMs, text))
}

/** Episodes far enough apart to form separate windows, one per topic. */
function episodesFrom(topicTexts: readonly string[], audienceId: string | null = 'lan'): DerivedEpisode[] {
  return topicTexts.map((text, index) =>
    deriveEpisode([turn(`${audienceId ?? 'none'}-${index + 1}`, index * 3_600_000, text)], { audienceId }),
  )
}

const WITH_AUDIENCE = { audienceId: 'lan' }

describe('M4-X02 deriveEpisodes windowing', () => {
  it('returns no episodes for an empty record set', () => {
    expect(deriveEpisodes([], WITH_AUDIENCE)).toEqual([])
  })

  it('derives every field of a single-turn episode exactly', () => {
    const [episode] = deriveEpisodes([turn('t1', 5_000, 'abc')], WITH_AUDIENCE)
    expect(episode).toEqual({
      id: 'episode:sess-1:5000:t1',
      sessionId: 'sess-1',
      audienceId: 'lan',
      startMs: 5_000,
      endMs: 5_000,
      topic: 'abc',
      summary: 'abc',
      importance: 0.251,
      sourceTurnIds: ['t1'],
      extractorVersion: DERIVED_EXTRACTOR_VERSION,
    })
  })

  it('keeps a gap of exactly EPISODE_MAX_GAP_MS in one episode and splits one millisecond more', () => {
    const atBoundary = [turn('t1', 0, 'First.'), turn('t2', EPISODE_MAX_GAP_MS, 'Second.')]
    expect(deriveEpisodes(atBoundary, WITH_AUDIENCE)).toHaveLength(1)
    const pastBoundary = [turn('t1', 0, 'First.'), turn('t2', EPISODE_MAX_GAP_MS + 1, 'Second.')]
    expect(deriveEpisodes(pastBoundary, WITH_AUDIENCE)).toHaveLength(2)
  })

  it('keeps EPISODE_MAX_TURNS turns in one episode and splits the next', () => {
    const texts = Array.from({ length: EPISODE_MAX_TURNS }, (_, index) => `Line ${index}.`)
    expect(deriveEpisodes(turnsFrom(texts), WITH_AUDIENCE)).toHaveLength(1)
    expect(deriveEpisodes(turnsFrom([...texts, 'Extra.']), WITH_AUDIENCE)).toHaveLength(2)
  })

  it('keeps duplicate turn ids in their recorded order', () => {
    const duplicated = [turn('t1', 0, 'One.'), turn('t1', 10, 'Two.')]
    expect(deriveEpisodes(duplicated, WITH_AUDIENCE)[0]?.sourceTurnIds).toEqual(['t1', 't1'])
  })
})

describe('M4-X02 deriveEpisode properties', () => {
  const SOURCE = [
    'The harbour bell rang twice at dawn, and the keeper counted every stroke of it.',
    'Nobody answered the call from the northern lighthouse.',
    'We should sail before the tide turns against us.',
    'Bring rope, lamp oil and the spare chart for the outer reef.',
  ]

  it('quotes only words present in the source text', () => {
    const episode = deriveEpisodes(turnsFrom(SOURCE), WITH_AUDIENCE)[0]!
    const sourceWords = new Set(SOURCE.join(' ').split(/\s+/))
    // Punctuation is trimmed from the word only for comparison, never added.
    const quotedWords = `${episode.topic} ${episode.summary}`.split(/\s+/)
    for (const word of quotedWords) {
      expect(sourceWords.has(word), word).toBe(true)
    }
    expect(SOURCE.join(' ')).toContain(episode.summary)
    expect(SOURCE[0]).toContain(episode.topic)
  })

  it('truncates the topic and summary at a word boundary without inventing text', () => {
    const longWord = 'a'.repeat(80)
    const longText = `${'word '.repeat(40)}end.`
    const [topicEpisode] = deriveEpisodes([turn('t1', 0, longText)], WITH_AUDIENCE)
    expect(topicEpisode!.topic.length).toBeLessThanOrEqual(60)
    expect(longText.startsWith(`${topicEpisode!.topic} `)).toBe(true)

    const summaryTurns = turnsFrom(
      [1, 2, 3, 4].map(
        (index) => `Turn ${index} ${'filler word '.repeat(20)}padding ends here.`,
      ),
    )
    const summary = deriveEpisodes(summaryTurns, WITH_AUDIENCE)[0]!.summary
    expect(summary.length).toBeLessThanOrEqual(200)
    const joinedSentences = summaryTurns.slice(0, 3).map((item) => item.text.split(/(?<=[.!?])/)[0]!.trim())
    const full = joinedSentences.join(' ')
    expect(full.length).toBeGreaterThan(200)
    expect(full.startsWith(summary)).toBe(true)
    expect(full[summary.length]).toBe(' ')

    const [wholeWord] = deriveEpisodes([turn('t1', 0, `${longWord}.`)], WITH_AUDIENCE)
    expect(wholeWord!.topic).toBe(`${longWord}.`)
  })

  it('records real turn ids in order and is pure across identical calls', () => {
    const input = turnsFrom(SOURCE)
    const first = deriveEpisodes(input, WITH_AUDIENCE)
    const second = deriveEpisodes(input, WITH_AUDIENCE)
    expect(first[0]!.sourceTurnIds).toEqual(['t1', 't2', 't3', 't4'])
    expect(second).toEqual(first)
    expect(input.map((item) => item.turnId)).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('applies the importance formula exactly on known windows', () => {
    const wide = deriveEpisodes(
      [turn('t1', 0, 'a'.repeat(80)), turn('t2', 1, 'b'.repeat(80))],
      WITH_AUDIENCE,
    )
    expect(wide[0]!.importance).toBe(0.54)
    const saturated = deriveEpisodes(
      [turn('t1', 0, 'a'.repeat(4_000)), turn('t2', 1, 'b'.repeat(4_000)), turn('t3', 2, 'c'.repeat(4_000))],
      WITH_AUDIENCE,
    )
    expect(saturated[0]!.importance).toBe(1)
    const tiny = deriveEpisodes([turn('t1', 0, 'abc')], WITH_AUDIENCE)
    expect(tiny[0]!.importance).toBe(0.251)
  })

  it('builds ids that separate the same first turn id across sessions', () => {
    const one = deriveEpisode([turn('t1', 0, 'One.', 'sess-a')], WITH_AUDIENCE)
    const other = deriveEpisode([turn('t1', 0, 'One.', 'sess-b')], WITH_AUDIENCE)
    expect(one.id).toBe('episode:sess-a:0:t1')
    expect(other.id).toBe('episode:sess-b:0:t1')
    expect(one.id).not.toBe(other.id)
  })

  it('refuses an empty window', () => {
    expect(() => deriveEpisode([], WITH_AUDIENCE)).toThrow(RangeError)
  })
})

describe('M4-X02 deriveTopics runs', () => {
  it('closes a run that reappears and leaves the latest run open', () => {
    const episodes = episodesFrom(['Harbour news.', 'Cargo lists.', 'Harbour news.'])
    const topics = deriveTopics(episodes)
    expect(topics).toHaveLength(3)
    expect(topics.map((topic) => topic.topic)).toEqual(['Harbour news.', 'Cargo lists.', 'Harbour news.'])
    expect(topics[0]!.validToMs).toBe(episodes[0]!.endMs)
    expect(topics[1]!.validToMs).toBe(episodes[1]!.endMs)
    expect(topics[2]!.validToMs).toBeNull()
    expect(topics[2]!.validFromMs).toBe(episodes[2]!.startMs)
    expect(topics[2]!.id).toBe(`topic:lan:${episodes[2]!.id}`)
  })

  it('keeps contiguous same-topic episodes in one open run', () => {
    const episodes = episodesFrom(['Cargo lists.', 'Cargo lists.', 'Cargo lists.'])
    const topics = deriveTopics(episodes)
    expect(topics).toHaveLength(1)
    const [topic] = topics
    expect(topic!.validToMs).toBeNull()
    expect(topic!.lastSeenMs).toBe(episodes[2]!.endMs)
    expect(topic!.sourceEpisodeIds).toEqual(episodes.map((episode) => episode.id))
    expect(topic!.id).toBe(`topic:lan:${episodes[0]!.id}`)
    expect(topic!.summary).toBe(episodes[0]!.summary)
    expect(topic!.importance).toBe(episodes[0]!.importance)
  })

  it('treats topic keys case-insensitively within one audience', () => {
    const episodes = episodesFrom(['Cargo lists.', 'cargo lists.'])
    const topics = deriveTopics(episodes)
    expect(topics).toHaveLength(1)
    expect(topics[0]!.topic).toBe('Cargo lists.')
  })

  it('excludes null audiences and groups the rest per audience', () => {
    const lanEpisodes = episodesFrom(['Lan news.', 'Lan news.'])
    const strangerEpisodes = episodesFrom(['Stranger news.'], 'stranger')
    const privateEpisodes = episodesFrom(['Private remark.', 'Lan news.'], null)
    const topics = deriveTopics([...lanEpisodes, ...privateEpisodes, ...strangerEpisodes])
    expect(topics.map((topic) => topic.audienceId)).toEqual(['lan', 'stranger'])
    expect(topics[0]!.sourceEpisodeIds).toEqual(lanEpisodes.map((episode) => episode.id))
    expect(topics[1]!.sourceEpisodeIds).toEqual([strangerEpisodes[0]!.id])
  })

  it('averages importance within a run and orders topics by validFromMs', () => {
    const late = episodesFrom(['Late topic.']).map((episode) => ({
      ...episode,
      id: `${episode.id}:late`,
      startMs: episode.startMs + 5_000,
    }))
    const early = episodesFrom(['Early topic.'])
    const topics = deriveTopics([...late, ...early])
    expect(topics.map((topic) => topic.topic)).toEqual(['Early topic.', 'Late topic.'])
    expect(topics[0]!.importance).toBe(early[0]!.importance)
    expect(topics[0]!.validFromMs).toBe(early[0]!.startMs)
  })
})

describe('M4-X02 applied cursor', () => {
  it('never lowers the cursor below the persisted value', () => {
    expect(monotonicAppliedSeq(5, 3)).toBe(5)
    expect(monotonicAppliedSeq(3, 7)).toBe(7)
    expect(monotonicAppliedSeq(4, 4)).toBe(4)
  })
})
