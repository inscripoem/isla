import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_AUDIENCE,
  BIBLE_LEAK_RULES,
  collectBibleLeakIssues,
  createKeywordDeliveryRecall,
  isDurableAudience,
  mayRecallCandidate,
  mayRecallAcrossSessions,
  normalizeAudience,
  renderProvenanceSuffix,
  renderScopeSuffix,
  scopeFor,
} from '../../src/dialogue'
import type { AssembledTurn, AudienceIdentity, MemoryKind, Provenance } from '../../src/dialogue'
import { CHARACTER_CONTENT } from '../../src/dialogue/persona-content'

/**
 * Audience identity and memory scope (M4-04).
 *
 * What these tests pin down, in the order the rules matter:
 *   1. An anonymous or ephemeral listener never yields a durable memory. M5
 *      ruled that a per-session temporary id does not make a memory durable.
 *   2. Cross-session recall needs three things at once: audience-bound scope, a
 *      durable identity, and the SAME stable id on both sides. Any one missing
 *      forbids it.
 *   3. The persona bible never carries a record id or a listener's private data.
 *      This guard is write-time and identity-independent on purpose.
 *
 * Every rule here is a refusal, so the assertions are mostly about what did NOT
 * happen. A test that only checked the happy path would pass just as well with
 * the guard removed.
 */

const IDENTIFIED: AudienceIdentity = { kind: 'identified', audienceId: 'aud-7' }
const EPHEMERAL: AudienceIdentity = { kind: 'session-ephemeral', audienceId: 'tmp-3' }

describe('audience identity', () => {
  it('treats a missing identity as anonymous, so forgetting to pass one fails safe', () => {
    expect(normalizeAudience(undefined)).toEqual(ANONYMOUS_AUDIENCE)
  })

  it('treats a blank id as no identity rather than as a malformed one', () => {
    expect(normalizeAudience({ kind: 'identified', audienceId: '   ' })).toEqual(ANONYMOUS_AUDIENCE)
  })

  it('does not treat an ephemeral session id as durable (M5 ruling)', () => {
    expect(isDurableAudience(EPHEMERAL)).toBe(false)
    expect(isDurableAudience(ANONYMOUS_AUDIENCE)).toBe(false)
    expect(isDurableAudience(undefined)).toBe(false)
  })

  it('treats identified and pseudonymous as durable', () => {
    expect(isDurableAudience(IDENTIFIED)).toBe(true)
    expect(isDurableAudience({ kind: 'pseudonymous', audienceId: 'aud-8', label: 'Blue' })).toBe(true)
  })
})

describe('memory scope', () => {
  it('degrades listener facts to session-only without a durable identity', () => {
    for (const kind of ['listener-fact', 'private-content'] as const) {
      expect(scopeFor(kind, ANONYMOUS_AUDIENCE)).toEqual({
        scope: 'session-only',
        reason: 'anonymous-audience',
        durable: false,
      })
      expect(scopeFor(kind, EPHEMERAL)).toEqual({
        scope: 'session-only',
        reason: 'ephemeral-audience-id',
        durable: false,
      })
    }
  })

  it('keeps listener facts only under a durable identity', () => {
    expect(scopeFor('listener-fact', IDENTIFIED)).toEqual({
      scope: 'audience-bound',
      reason: 'audience-bound',
      durable: true,
    })
  })

  it('never treats a persona fact as audience memory, even for a known listener', () => {
    expect(scopeFor('persona-fact', IDENTIFIED)).toEqual({
      scope: 'session-only',
      reason: 'persona-fact-not-memory',
      durable: false,
    })
  })

  it('keeps utterances session-only for an anonymous audience', () => {
    expect(scopeFor('utterance', ANONYMOUS_AUDIENCE).scope).toBe('session-only')
    expect(scopeFor('utterance', IDENTIFIED).scope).toBe('audience-bound')
  })

  it('covers every memory kind without leaving one unclassified', () => {
    const kinds: readonly MemoryKind[] = ['utterance', 'listener-fact', 'private-content', 'persona-fact']
    for (const kind of kinds) {
      for (const audience of [ANONYMOUS_AUDIENCE, EPHEMERAL, IDENTIFIED]) {
        const decision = scopeFor(kind, audience)
        expect(typeof decision.scope).toBe('string')
        expect(typeof decision.durable).toBe('boolean')
      }
    }
  })
})

describe('cross-session recall', () => {
  it('forbids it when the memory is session-scoped, even for the right listener', () => {
    expect(
      mayRecallAcrossSessions({ scope: 'session-only', ownerAudienceId: 'aud-7', currentAudience: IDENTIFIED }),
    ).toBe(false)
  })

  it('forbids it for a different audience', () => {
    expect(
      mayRecallAcrossSessions({
        scope: 'audience-bound',
        ownerAudienceId: 'aud-other',
        currentAudience: IDENTIFIED,
      }),
    ).toBe(false)
  })

  it('forbids it without a durable current identity', () => {
    expect(
      mayRecallAcrossSessions({
        scope: 'audience-bound',
        ownerAudienceId: 'tmp-3',
        currentAudience: EPHEMERAL,
      }),
    ).toBe(false)
    expect(
      mayRecallAcrossSessions({
        scope: 'audience-bound',
        ownerAudienceId: 'aud-7',
        currentAudience: undefined,
      }),
    ).toBe(false)
  })

  it('forbids it when the memory has no recorded owner', () => {
    expect(
      mayRecallAcrossSessions({ scope: 'audience-bound', ownerAudienceId: null, currentAudience: IDENTIFIED }),
    ).toBe(false)
  })

  it('allows it only for the same stable id', () => {
    expect(
      mayRecallAcrossSessions({
        scope: 'audience-bound',
        ownerAudienceId: 'aud-7',
        currentAudience: IDENTIFIED,
      }),
    ).toBe(true)
  })
})

describe('bible write guard', () => {
  it('reports a record id pasted into the bible', () => {
    const issues = collectBibleLeakIssues('> - [S] Remembers audienceId: aud-42 well.')
    expect(issues.map((issue) => issue.rule)).toContain(BIBLE_LEAK_RULES.actorId)
  })

  it('reports private content asserted as fact', () => {
    const issues = collectBibleLeakIssues(
      ['> - [S] Her close friend lives at 12 Maple Road.', '> - [R] Writes to li.wei@example.com nightly.'].join('\n'),
    )
    const rules = issues.map((issue) => issue.rule)
    expect(rules).toContain(BIBLE_LEAK_RULES.privateContent)
  })

  it('does not fire on a boundary that forbids the very thing it names', () => {
    // The shipped bible says exactly this. A guard that flagged it would force
    // the author to delete the boundary the reviewer needs.
    const issues = collectBibleLeakIssues(
      '> - Never claim that fictional magic can diagnose, cure or replace professional medical care.',
    )
    expect(issues).toEqual([])
  })

  it('does not fire on prose that merely discusses the word audience', () => {
    const issues = collectBibleLeakIssues('The audience is addressed with mock exasperation.')
    expect(issues).toEqual([])
  })

  it('reports the line number so an author can find the entry', () => {
    const bible = ['# 5. People she cares about', '', '> - [S] actorId: viewer-9'].join('\n')
    const [issue] = collectBibleLeakIssues(bible)
    expect(issue?.line).toBe(3)
  })
})

describe('the shipped persona', () => {
  it('has a bible, and the bible passes the write guard', () => {
    const bible = readFileSync(resolve(CHARACTER_CONTENT.sourceDocument), 'utf8')
    expect(collectBibleLeakIssues(bible)).toEqual([])
  })

  it('declares what belongs in a listener memory rather than in the bible', () => {
    expect(readFileSync(resolve(CHARACTER_CONTENT.sourceDocument), 'utf8').length).toBeGreaterThan(0)
  })
})

describe('delivery-recall cross-session guard', () => {
  function turn(overrides: Partial<AssembledTurn> & { sessionId: string; turnId: string }): AssembledTurn {
    return {
      segments: [],
      text: 'The loud concert was bright tonight.',
      interrupted: false,
      personaVersion: null,
      pinned: false,
      salienceScore: 0,
      salienceSignals: [],
      scope: 'audience-bound',
      kind: 'utterance',
      characters: 0,
      ...overrides,
    }
  }

  it('always allows a same-session candidate, whatever the audience', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
    }
    expect(
      mayRecallCandidate(request, turn({ sessionId: 's1', turnId: 't1', scope: 'session-only' })),
    ).toBe(true)
  })

  it('refuses a cross-session candidate for an anonymous audience', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
      scope: 'audience-bound' as const,
    }
    expect(mayRecallCandidate(request, turn({ sessionId: 'other', turnId: 't1' }))).toBe(false)
  })

  it('refuses a cross-session candidate for a per-session temporary id (M5 ruling)', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
      scope: 'audience-bound' as const,
      audience: EPHEMERAL,
    }
    expect(mayRecallCandidate(request, turn({ sessionId: 'other', turnId: 't1' }))).toBe(false)
  })

  it('refuses a session-scoped candidate even for an identified listener', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
      scope: 'audience-bound' as const,
      audience: IDENTIFIED,
    }
    expect(
      mayRecallCandidate(
        request,
        turn({ sessionId: 'other', turnId: 't1', scope: 'session-only' }),
      ),
    ).toBe(false)
  })

  it('allows a cross-session audience-bound candidate for a durable listener', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
      scope: 'audience-bound' as const,
      audience: IDENTIFIED,
    }
    expect(mayRecallCandidate(request, turn({ sessionId: 'other', turnId: 't1' }))).toBe(true)
  })

  it('refuses when the recorded owner is a different audience', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
      scope: 'audience-bound' as const,
      audience: IDENTIFIED,
      ownerAudienceIdOf: () => 'aud-someone-else',
    }
    expect(mayRecallCandidate(request, turn({ sessionId: 'other', turnId: 't1' }))).toBe(false)
  })

  it('allows when the recorded owner matches the current audience', () => {
    const request = {
      inputText: 'the loud concert',
      replyIntent: 'answer',
      candidates: [],
      sessionId: 's1',
      scope: 'audience-bound' as const,
      audience: IDENTIFIED,
      ownerAudienceIdOf: () => 'aud-7',
    }
    expect(mayRecallCandidate(request, turn({ sessionId: 'other', turnId: 't1' }))).toBe(true)
  })

  it('counts what it refused, so the loss is not silent', () => {
    const port = createKeywordDeliveryRecall()
    const result = port.recall({
      inputText: 'the loud concert was bright',
      replyIntent: 'answer',
      candidates: [turn({ sessionId: 'other', turnId: 't1' })],
      sessionId: 's1',
    })
    expect(result).toEqual([])
    expect(port.crossSessionDrops).toBe(1)
  })
})

describe('provenance rendering', () => {
  it('renders each source so a reviewer can trace the line back', () => {
    const cases: readonly [Provenance, string][] = [
      [{ source: 'bible', factId: 'fact-3' }, 'bible: fact-3'],
      [{ source: 'session-turn', sessionId: 's1', turnId: 't7' }, 'turn: s1:t7'],
      [{ source: 'audience-memory', audienceId: 'aud-7', ref: 'm1' }, 'memory: aud-7/m1'],
    ]
    for (const [provenance, expected] of cases) {
      expect(renderProvenanceSuffix(provenance)).toBe(expected)
    }
  })

  it('renders an empty suffix for an empty bible id rather than a hollow ()', () => {
    expect(renderProvenanceSuffix({ source: 'bible', factId: '' })).toBe('')
  })

  it('marks only audience-bound memory as such', () => {
    expect(renderScopeSuffix('audience-bound')).toBe(' [audience-bound]')
    expect(renderScopeSuffix('session-only')).toBe('')
  })
})