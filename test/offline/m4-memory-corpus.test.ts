import { describe, expect, it } from 'vitest'
import type { CorpusFile, ProbeKind, Speaker } from '../support/memory-corpus'
import { loadMemoryCorpus } from '../support/memory-corpus'

/**
 * M4 memory corpora (M4-X07) — structural validation of the three fixture files.
 *
 * These corpora are consumer-facing regression fixtures. No producer is wired
 * this round: nothing in `src/` reads them, and a passing test is a statement
 * about the corpus structure, not about dialogue quality.
 *
 * Every rule below is its own assertion so a failure names the rule that broke.
 */

const FILE_NAMES = [
  'cross-turn-reference.json',
  'temporal-reasoning.json',
  'contradiction-update.json',
] as const

/** The held-out split, frozen from the first day. Changing it must fail loudly. */
const FROZEN_HELD_OUT: Readonly<Record<string, readonly string[]>> = {
  'cross-turn-reference': ['ctr-03', 'ctr-06'],
  'temporal-reasoning': ['tr-02', 'tr-05'],
  'contradiction-update': ['cu-01', 'cu-04'],
}

/**
 * For each expected turn in `contradiction-update.json`, the earlier turns it
 * supersedes. The corpus premise is "newer turn wins", so an expected turn must
 * come after them. Keyed by `<case id>|<expected turn id>`.
 */
const SUPERSEDED_TURN_IDS: Readonly<Record<string, readonly string[]>> = {
  'cu-01|cu-01-s2-t01': ['cu-01-s1-t01'],
  'cu-02|cu-02-s3-t01': ['cu-02-s1-t01', 'cu-02-s2-t01'],
  'cu-03|cu-03-s1-t04': ['cu-03-s1-t01', 'cu-03-s1-t02'],
  'cu-04|cu-04-s2-t02': ['cu-04-s1-t02'],
  'cu-05|cu-05-s2-t02': ['cu-05-s1-t01'],
  'cu-05|cu-05-s3-t02': ['cu-05-s1-t03'],
  'cu-06|cu-06-s2-t01': ['cu-06-s1-t01'],
}

const PROBE_KINDS: readonly ProbeKind[] = ['recall', 'temporal', 'contradiction']
const SPEAKERS: readonly Speaker[] = ['character', 'audience']

const corpora = FILE_NAMES.map((fileName) => ({
  fileName,
  corpus: loadMemoryCorpus(fileName),
}))

const turnIdsOf = (corpus: CorpusFile): string[] =>
  corpus.cases.flatMap((entry) =>
    entry.sessions.flatMap((session) => session.turns.map((turn) => turn.id)),
  )

describe('M4 memory corpora — file level', () => {
  it('rule 1: each file parses and declares corpusVersion 1', () => {
    for (const { fileName, corpus } of corpora) {
      expect(corpus, fileName).toBeTypeOf('object')
      expect(corpus.corpusVersion, fileName).toBe(1)
    }
  })

  it('rule 2: each file holds 5 to 10 cases', () => {
    for (const { fileName, corpus } of corpora) {
      expect(corpus.cases.length, fileName).toBeGreaterThanOrEqual(5)
      expect(corpus.cases.length, fileName).toBeLessThanOrEqual(10)
    }
  })

  it('rule 3: case ids are unique across all corpora', () => {
    const ids = corpora.flatMap(({ corpus }) => corpus.cases.map((entry) => entry.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('rule 4: heldOutCaseIds is non-empty, a subset of the case ids, and not all of them', () => {
    for (const { fileName, corpus } of corpora) {
      const caseIds = corpus.cases.map((entry) => entry.id)
      expect(corpus.heldOutCaseIds.length, fileName).toBeGreaterThan(0)
      for (const id of corpus.heldOutCaseIds) {
        expect(caseIds, fileName).toContain(id)
      }
      expect(corpus.heldOutCaseIds.length, fileName).toBeLessThan(caseIds.length)
    }
  })

  it('B3 (i): corpusId equals the file base name', () => {
    for (const { fileName, corpus } of corpora) {
      expect(corpus.corpusId).toBe(fileName.replace(/\.json$/, ''))
    }
  })

  it('B3 (ii): heldOutCaseIds equals the frozen split literal', () => {
    for (const { corpus } of corpora) {
      expect(corpus.heldOutCaseIds).toEqual(FROZEN_HELD_OUT[corpus.corpusId])
    }
  })
})

describe('M4 memory corpora — case level', () => {
  it('rule 5: every case has 2 to 4 sessions and every session 3 to 8 turns', () => {
    for (const { fileName, corpus } of corpora) {
      for (const entry of corpus.cases) {
        expect(entry.sessions.length, `${fileName} ${entry.id}`).toBeGreaterThanOrEqual(2)
        expect(entry.sessions.length, `${fileName} ${entry.id}`).toBeLessThanOrEqual(4)
        for (const session of entry.sessions) {
          const label = `${fileName} ${entry.id} ${session.sessionId}`
          expect(session.turns.length, label).toBeGreaterThanOrEqual(3)
          expect(session.turns.length, label).toBeLessThanOrEqual(8)
        }
      }
    }
  })

  it('rule 6: turn ids are unique within a corpus', () => {
    for (const { fileName, corpus } of corpora) {
      const ids = turnIdsOf(corpus)
      expect(new Set(ids).size, fileName).toBe(ids.length)
    }
  })

  it('rule 7: atMs is non-decreasing within a session', () => {
    for (const { fileName, corpus } of corpora) {
      for (const entry of corpus.cases) {
        for (const session of entry.sessions) {
          const stamps = session.turns.map((turn) => turn.atMs)
          const label = `${fileName} ${entry.id} ${session.sessionId}`
          stamps.forEach((atMs, index) => {
            if (index > 0) expect(atMs, label).toBeGreaterThanOrEqual(stamps[index - 1]!)
          })
        }
      }
    }
  })

  it('rule 8: 1 to 2 probes per case, known kind, non-empty question, expected ids resolve', () => {
    for (const { fileName, corpus } of corpora) {
      const turnIds = new Set(turnIdsOf(corpus))
      for (const entry of corpus.cases) {
        const label = `${fileName} ${entry.id}`
        expect(entry.probes.length, label).toBeGreaterThanOrEqual(1)
        expect(entry.probes.length, label).toBeLessThanOrEqual(2)
        for (const probe of entry.probes) {
          expect(PROBE_KINDS, label).toContain(probe.kind)
          expect(probe.question.trim().length, label).toBeGreaterThan(0)
          for (const id of probe.expected) {
            expect(turnIds.has(id), `${label} expects ${id}`).toBe(true)
          }
        }
      }
    }
  })

  it('rule 9: speaker is a known value and text is non-empty', () => {
    for (const { fileName, corpus } of corpora) {
      for (const entry of corpus.cases) {
        for (const session of entry.sessions) {
          for (const turn of session.turns) {
            expect(SPEAKERS, `${fileName} ${turn.id}`).toContain(turn.speaker)
            expect(turn.text.trim().length, `${fileName} ${turn.id}`).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('B3 (iii): every contradiction expectation is a newer turn than the one it supersedes', () => {
    // "Newer" is session order first, then `atMs` inside the session: `atMs`
    // restarts at zero in every session.
    const corpus = corpora.find(({ corpus }) => corpus.corpusId === 'contradiction-update')!.corpus
    const order = new Map<string, readonly [number, number]>()
    for (const entry of corpus.cases) {
      entry.sessions.forEach((session, sessionIndex) => {
        for (const turn of session.turns) order.set(turn.id, [sessionIndex, turn.atMs])
      })
    }
    const newer = (a: readonly [number, number], b: readonly [number, number]): boolean =>
      a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
    for (const entry of corpus.cases) {
      for (const probe of entry.probes) {
        for (const id of probe.expected) {
          const superseded = SUPERSEDED_TURN_IDS[`${entry.id}|${id}`]!
          for (const old of superseded) {
            expect(newer(order.get(id)!, order.get(old)!), `${entry.id} expects ${id} newer than ${old}`).toBe(
              true,
            )
          }
        }
      }
    }
  })
})
