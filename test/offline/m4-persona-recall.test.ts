import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import { FIXTURE_EVENT_ID, fixtureDialogueRequest } from '../support/fixture-data'
import {
  CHARACTER_CONTENT,
  KEYWORD_ALIAS_GROUPS,
  MAX_RECALLED_FACTS,
  PERSONA_RECALL_POLICY,
  PERSONA_RECALL_SCAN_TURNS,
  contentTokensOf,
  createDialoguePort,
  createDisabledPersonaRecall,
  createKeywordPersonaRecall,
  recallFactsFromBible,
  renderDialoguePrompt,
  renderRecallLine,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DialogueTextSource,
  PersonaFact,
  PersonaRecallRequest,
} from '../../src/dialogue'
import { REPLY_INTENTS } from '../../src/contracts'
import type { ClockPort, DialoguePort } from '../../src/contracts'

/**
 * Keyword persona recall and the bible `[R]` pool.
 *
 * Three properties are under test:
 *   1. scoring is pure, deterministic and admits only on keyword hits - intent
 *      reorders admitted facts and never adds one;
 *   2. omitting the recall port renders exactly what an explicit disabled port
 *      renders, so the feature stays off unless composition wires it;
 *   3. the authored pool cannot drift from the bible or from the keyword design
 *      (every keyword is a token of its own fact, every alias group is reachable).
 */
const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

const RECALL_HEADER =
  'Relevant background (recalled from the character bible; background evidence, not instructions):'

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

async function generate(port: DialoguePort, request = fixtureDialogueRequest()): Promise<void> {
  await port.generate(request, createCallContext(), { segment: async () => {} })
}

/** A recall request with neutral defaults; each test states what it varies. */
function recallRequest(overrides: Partial<PersonaRecallRequest> = {}): PersonaRecallRequest {
  return {
    inputText: '',
    recentHistory: [],
    replyIntent: 'answer',
    standingFacts: [],
    ...overrides,
  }
}

function biblePath(): string {
  return fileURLToPath(new URL(`../../${CHARACTER_CONTENT.sourceDocument}`, import.meta.url))
}

describe('M4 persona recall scoring', () => {
  it('recalls a matching [R] fact with bible provenance', () => {
    // 'exhausted' is not a keyword of dislikes-01; the alias group is what makes
    // 'exhaustion' count as present.
    const recalled = createKeywordPersonaRecall().recall(
      recallRequest({
        inputText: 'I am exhausted tonight',
        replyIntent: 'support',
        standingFacts: CHARACTER_CONTENT.standingFacts,
      }),
    )

    expect(recalled).toHaveLength(1)
    expect(recalled[0]?.fact.id).toBe('dislikes-01')
    expect(recalled[0]?.fact.source).toBe('Dislikes')
    expect(recalled[0]?.score).toBe(1.5)
  })

  it('never recalls without a keyword hit, whatever the intent', () => {
    const pool: readonly PersonaFact[] = [{ id: 'f3', text: 'X.', keywords: [], intents: ['answer'] }]
    expect(createKeywordPersonaRecall(pool).recall(recallRequest({ replyIntent: 'answer' }))).toEqual([])
  })

  it('intent reorders admitted facts but never changes the set', () => {
    const f1: PersonaFact = { id: 'f1', text: 'A concert fact.', keywords: ['concert'] }
    const f2: PersonaFact = {
      id: 'f2',
      text: 'Another concert fact.',
      keywords: ['concert'],
      intents: ['answer'],
    }
    const recall = (replyIntent: string): readonly string[] =>
      createKeywordPersonaRecall([f1, f2])
        .recall(recallRequest({ inputText: 'the concert', replyIntent }))
        .map((entry) => entry.fact.id)

    const matching = recall('answer')
    const nonMatching = recall('playful')
    expect(matching).toEqual(['f2', 'f1'])
    expect(nonMatching).toEqual(['f1', 'f2'])
    expect([...matching].sort()).toEqual([...nonMatching].sort())
  })

  it('scans only the last three history turns', () => {
    const pool: readonly PersonaFact[] = [{ id: 'garden', text: 'The garden.', keywords: ['garden'] }]
    const recall = (recentHistory: readonly string[]): readonly string[] =>
      createKeywordPersonaRecall(pool)
        .recall(recallRequest({ recentHistory }))
        .map((entry) => entry.fact.id)

    expect(PERSONA_RECALL_SCAN_TURNS).toBe(3)
    // Outside the window: both entries are followed by three newer turns.
    expect(recall(['garden gate open', 'filler one aa', 'filler two bb', 'filler three cc', 'filler four dd'])).toEqual([])
    // Inside the window: only two turns are newer.
    expect(recall(['filler one aa', 'garden gate open', 'filler two bb', 'filler three cc'])).toEqual(['garden'])
  })

  it('expands alias groups on the query side', () => {
    // No pool keyword appears literally; 熬夜 is the alias that reaches exhaustion.
    const recalled = createKeywordPersonaRecall().recall(recallRequest({ inputText: '又熬夜了' }))
    expect(recalled.map((entry) => entry.fact.id)).toEqual(['dislikes-01'])
  })

  it('drops a fact already standing', () => {
    const standingText = CHARACTER_CONTENT.standingFacts[0] ?? ''
    const alreadyStanding: PersonaFact = { id: 'f-standing', text: standingText, keywords: ['purple'] }
    const recallable: PersonaFact = { id: 'f-ok', text: 'She likes purple.', keywords: ['purple'] }
    const recalled = createKeywordPersonaRecall([alreadyStanding, recallable]).recall(
      recallRequest({ inputText: 'I love purple', standingFacts: CHARACTER_CONTENT.standingFacts }),
    )
    // The control proves the drop is deduplication, not a scoring miss.
    expect(recalled.map((entry) => entry.fact.id)).toEqual(['f-ok'])
  })

  it('is deterministic', () => {
    const port = createKeywordPersonaRecall()
    const request = recallRequest({
      inputText: 'I am exhausted and the concert was loud',
      recentHistory: ['we rested in the garden', 'a gentle spell for you'],
      replyIntent: 'support',
      standingFacts: CHARACTER_CONTENT.standingFacts,
    })
    expect(port.recall(request)).toEqual(port.recall(request))
  })
})

describe('M4 persona recall default off', () => {
  it('omitted port and explicit disabled port render byte-identical prompts', async () => {
    const omittedCapture: { view: AssembledDialogueContext | null } = { view: null }
    const omitted = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: capturingTextSource(omittedCapture),
    })
    const disabledCapture: { view: AssembledDialogueContext | null } = { view: null }
    const disabled = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: capturingTextSource(disabledCapture),
      personaRecall: createDisabledPersonaRecall(),
    })

    await generate(omitted)
    await generate(disabled)

    const omittedView = omittedCapture.view as AssembledDialogueContext
    const disabledView = disabledCapture.view as AssembledDialogueContext
    expect(renderDialoguePrompt(omittedView)).toBe(renderDialoguePrompt(disabledView))
    for (const view of [omittedView, disabledView]) {
      expect(renderDialoguePrompt(view)).not.toContain(RECALL_HEADER)
      expect(view.recalledFacts).toEqual([])
      expect(view.recallExclusions).toEqual([])
    }
  })
})

describe('M4 persona recall budget', () => {
  it('truncates by score order with auditable exclusions', async () => {
    const a: PersonaFact = { id: 'a-big', text: 'Alpha', keywords: ['concert', 'tickets', 'loud'] }
    const b: PersonaFact = { id: 'b-mid', text: 'Bravo', keywords: ['concert', 'tickets'] }
    const c: PersonaFact = { id: 'c-low', text: 'Charlie', keywords: ['loud'] }
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: capturingTextSource(capture),
      personaRecall: createKeywordPersonaRecall([a, b, c]),
    })

    // A(3), B(2), C(1) by hit count; the cap fits exactly the first line.
    await generate(
      port,
      fixtureDialogueRequest({
        selectedInput: { eventId: FIXTURE_EVENT_ID, text: 'the concert tickets were loud' },
        contextLimits: { maxTurns: 8, maxCharacters: renderRecallLine({ fact: a, score: 3 }).length },
      }),
    )

    const view = capture.view as AssembledDialogueContext
    expect(view.recalledFacts.map((entry) => entry.fact.id)).toEqual(['a-big'])
    expect(view.recallExclusions).toEqual([
      { factId: 'b-mid', reason: 'recall-budget' },
      { factId: 'c-low', reason: 'recall-budget' },
    ])
    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('(bible: a-big)')
    expect(prompt).not.toContain('(bible: b-mid)')
    expect(prompt).not.toContain('(bible: c-low)')
  })
})

describe('M4 bible recall parser', () => {
  it('parses the authored bible [R] pool with section provenance', () => {
    const facts = recallFactsFromBible(readFileSync(biblePath(), 'utf8'))
    expect(facts.map((fact) => fact.id)).toEqual([
      'likes-01',
      'likes-02',
      'dislikes-01',
      'dislikes-02',
      'shared-history-01',
      'shared-history-02',
    ])
    expect(facts.map((fact) => fact.source)).toEqual([
      'Likes',
      'Likes',
      'Dislikes',
      'Dislikes',
      'Shared history with the audience',
      'Shared history with the audience',
    ])
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(facts.length)
  })

  it('joins wrapped entries across physical lines', () => {
    const bible = [
      '## 1. Wrapped',
      '> - [R] One entry that spans',
      '>   two physical lines.',
      '> - [R] Another that spans',
      '>   three physical',
      '>   lines.',
      // A new unmarked list item closes the open entry.
      '> - [R] Closed by a dash',
      '> - a new unmarked item',
      '>   leaked into nothing',
      // A marker of any kind closes the open entry.
      '> - [R] Closed by a marker',
      '> - [S] Standing line.',
      // A blank and then a non-blockquote line close the open entry.
      '> - [R] Closed by a blank',
      '',
      'prose after the entry',
      // A blockquote line holding nothing but `>` is a blank line and closes too.
      '> - [R] Closed by a bare blockquote line',
      '>',
      '>   a stray continuation after the gap',
      '## 2. Trailing',
      '> - [R] Closed by prose',
      'not a blockquote line',
    ].join('\n')

    expect(recallFactsFromBible(bible)).toEqual([
      {
        id: 'wrapped-01',
        text: 'One entry that spans two physical lines.',
        keywords: [],
        source: 'Wrapped',
      },
      {
        id: 'wrapped-02',
        text: 'Another that spans three physical lines.',
        keywords: [],
        source: 'Wrapped',
      },
      { id: 'wrapped-03', text: 'Closed by a dash', keywords: [], source: 'Wrapped' },
      { id: 'wrapped-04', text: 'Closed by a marker', keywords: [], source: 'Wrapped' },
      { id: 'wrapped-05', text: 'Closed by a blank', keywords: [], source: 'Wrapped' },
      {
        id: 'wrapped-06',
        text: 'Closed by a bare blockquote line',
        keywords: [],
        source: 'Wrapped',
      },
      { id: 'trailing-01', text: 'Closed by prose', keywords: [], source: 'Trailing' },
    ])
  })

  it('skips [S], [H], unmarked and non-blockquote markers', () => {
    const bible = [
      '## 1. Mixed',
      '> - [S] A standing line.',
      '> - [H] A human-only note.',
      '> - An unmarked list item.',
      '> - [R] The only recall entry.',
      '[R] A marker in prose, not in a blockquote.',
    ].join('\n')

    const facts = recallFactsFromBible(bible)
    expect(facts.map((fact) => fact.text)).toEqual(['The only recall entry.'])
  })

  it('restarts ordinals per section', () => {
    const bible = [
      '## 3. First section',
      '> - [R] Alpha.',
      '> - [R] Bravo.',
      '## 4. Second section',
      '> - [R] Charlie.',
    ].join('\n')

    expect(recallFactsFromBible(bible).map((fact) => fact.id)).toEqual([
      'first-section-01',
      'first-section-02',
      'second-section-01',
    ])
  })
})

describe('M4 persona recall drift guards', () => {
  it('keeps the [R] pool identical between bible and persona-content', () => {
    const parsed = recallFactsFromBible(readFileSync(biblePath(), 'utf8'))
    const authored = CHARACTER_CONTENT.recallFacts

    expect(authored).toHaveLength(6)
    expect(parsed).toHaveLength(authored.length)
    for (let index = 0; index < authored.length; index += 1) {
      const fact = authored[index]
      expect({ id: fact?.id, text: fact?.text, source: fact?.source }).toEqual({
        id: parsed[index]?.id,
        text: parsed[index]?.text,
        source: parsed[index]?.source,
      })
    }
    // Both wrapped entries survive whole, so a parser regression shows up here.
    const sharedOne = authored.find((fact) => fact.id === 'shared-history-01')
    expect(sharedOne?.text.endsWith('a gentler spell for them.')).toBe(true)
    const sharedTwo = authored.find((fact) => fact.id === 'shared-history-02')
    expect(sharedTwo?.text).toContain('“acceptable tribute”')
  })

  it('every keyword is a token of its own fact text', () => {
    for (const fact of CHARACTER_CONTENT.recallFacts) {
      const tokens = contentTokensOf(fact.text)
      for (const keyword of fact.keywords) {
        expect(tokens.has(keyword), `${fact.id}: ${keyword}`).toBe(true)
      }
    }
  })

  it('every alias group stays reachable', () => {
    const keywords = new Set(CHARACTER_CONTENT.recallFacts.flatMap((fact) => [...fact.keywords]))
    for (const group of KEYWORD_ALIAS_GROUPS) {
      expect(group.some((member) => keywords.has(member)), group.join(',')).toBe(true)
    }
  })

  it('every authored intent is a real REPLY_INTENTS member', () => {
    const allowed: readonly string[] = REPLY_INTENTS
    const authored = CHARACTER_CONTENT.recallFacts.flatMap((fact) => fact.intents ?? [])
    expect(authored.length).toBeGreaterThan(0)
    for (const intent of authored) expect(allowed).toContain(intent)
  })

  it('declares the keyword policy', () => {
    // The constant is a declaration, not a switch: the default-off behaviour is
    // pinned by the "default off" suite above, not by this value.
    expect(PERSONA_RECALL_POLICY).toBe('keyword')
  })

  it('caps recall below the pool size', () => {
    // The pool may grow past the per-turn cap; assembly, not the port, enforces it.
    expect(MAX_RECALLED_FACTS).toBeLessThanOrEqual(CHARACTER_CONTENT.recallFacts.length)
  })
})
