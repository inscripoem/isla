import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import { loadMemoryCorpus } from '../support/memory-corpus'
import {
  MIN_RECALL_SCORE,
  MIN_SIMILARITY,
  PARAPHRASE_ALIASES,
  RECALL_RRF_K,
  RECALL_WEIGHTS,
  asRecallPort,
  conceptProfileOf,
  cosine,
  createDeliveryMemoryStore,
  createDialoguePort,
  createKeywordDeliveryRecall,
  createMultiFactorRecall,
  jaccard,
  latinTokensOf,
  MAX_RECALLED_TURNS,
  cjkTrigramsOf,
  mayRecallCandidate,
  recallItemKey,
  recallSubjectOf,
  recencyOf,
  renderDialoguePrompt,
  scoreSalience,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  AssembledTurn,
  DeliveryMemoryStore,
  DeliveryRecallRequest,
  DialogueOutcomeReport,
  DialogueTextSource,
  ListenerHistoryPort,
  ListenerHistoryQuery,
  ListenerTurn,
  RecallCandidate,
  RecallPort,
  RecallRequest,
  RecalledItem,
} from '../../src/dialogue'
import type { DialogueRequest } from '../../src/contracts'

/**
 * Multi-factor recall ranking (issue #146 A04).
 *
 * What is locked here, and what is deliberately NOT:
 *
 *   - The ranker is deterministic and local: no provider call, no model, no
 *     embedding, no I/O, no wall clock. The same request scores the same way,
 *     twice in a row and in any candidate order.
 *   - Admission is lexical evidence. Importance, recency and prior use rank; they
 *     never admit. A 60-day-old high-importance memory is recalled against a
 *     matching question and a low-importance one is not, but neither is recalled
 *     against an unrelated question, however fresh or important.
 *   - `replyIntent` reorders admissible items and never changes the admissible
 *     SET.
 *   - The current session's audience turns are candidates and render with an
 *     `[audience]` label; they never enter character history, and a listener turn
 *     from another session is never recalled.
 *   - With no `recall` port the prompt is byte-identical to the delivery-only
 *     path, and the provider attempt count does not move.
 *   - A recalled line that does not fit the recall budget is REPORTED, not
 *     silently truncated.
 *
 * The corpus comparison at the end is a fixture regression check over frozen
 * held-out cases, not a quality measurement: the ranks it computes say nothing
 * about reply quality and must not be presented as measured recall quality
 * (issue #146 X07 owns evaluation).
 */
const DAY_MS = 86_400_000

/** The shared fixture clock, in the fixture's own millisecond domain. */

const SESSION = FIXTURE_SESSION_ID

/** One assembled confirmed turn with the fields the ranker reads. */
function characterTurn(turnId: string, text: string, overrides: Partial<AssembledTurn> = {}): AssembledTurn {
  return {
    sessionId: SESSION,
    turnId,
    segments: [],
    text,
    interrupted: false,
    personaVersion: null,
    pinned: false,
    salienceScore: scoreSalience({ role: 'character', text }).decayed,
    salienceSignals: [],
    scope: 'session-only',
    kind: 'utterance',
    characters: text.length,
    ...overrides,
  }
}

function listenerTurn(
  eventId: string,
  text: string,
  receivedAtMs: number,
  sessionId: string = SESSION,
): ListenerTurn {
  return {
    eventId,
    sessionId,
    text,
    receivedAtMs,
    actorId: 'actor-local-audience',
    trust: 'untrusted-content',
  }
}

function characterCandidate(turn: AssembledTurn): RecallCandidate {
  return { role: 'character', turn }
}

function listenerCandidate(turn: ListenerTurn): RecallCandidate {
  return { role: 'listener', turn }
}

function recallRequest(overrides: Partial<RecallRequest> = {}): RecallRequest {
  return {
    inputText: '',
    replyIntent: 'answer',
    candidates: [],
    sessionId: SESSION,
    nowMs: 100 * DAY_MS,
    ...overrides,
  }
}

function ids(entries: readonly RecalledItem[]): string[] {
  return entries.map((entry) =>
    entry.role === 'character' ? entry.turn.turnId : entry.turn.eventId,
  )
}

/** A recording listener-history port that returns a fixed set of turns. */
function recordingListenerHistory(turns: readonly ListenerTurn[]): ListenerHistoryPort {
  return { recent: async () => ({ turns, unavailable: null }) }
}

/**
 * A listener-history port that HONOURS `limit`, like a conforming source: it
 * returns the newest `limit` rows of this session before `beforeEventId`.
 *
 * It also records every query, so a test can assert what the port asked for.
 * `limit` is the only window the source has; the assembler's own
 * `contextLimits.maxTurns` cap is a second, independent window, and the rows
 * the port returns are exactly the union a recall test needs (the recency
 * window plus the v2 allowance).
 */
function windowedListenerHistory(
  turns: readonly ListenerTurn[],
): ListenerHistoryPort & { readonly calls: readonly ListenerHistoryQuery[] } {
  const calls: ListenerHistoryQuery[] = []
  return {
    calls,
    recent: async (query: ListenerHistoryQuery) => {
      calls.push(query)
      const eligible = turns.filter((turn) => turn.eventId !== query.beforeEventId)
      const limit = Math.max(0, query.limit)
      return {
        // Newest last, everything before the selected event - the contract the
        // assembler assumes of its source.
        turns: eligible.slice(Math.max(0, eligible.length - limit)),
        unavailable: null,
      }
    },
  }
}

/** A text source that records its view and returns one fixed segment. */
function capturingTextSource(capture: { view: AssembledDialogueContext | null }): DialogueTextSource {
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

/** Commit one fully-delivered single-segment turn into the store. */
async function commitTurn(
  memory: DeliveryMemoryStore,
  turnId: string,
  text: string,
): Promise<void> {
  await memory.commit(
    fixtureCommitDelivery({
      sessionId: SESSION,
      turnId,
      segmentId: `${turnId}-seg-0`,
      textHash: `hash-${turnId}`,
      text,
    }),
  )
}

/**
 * Assembly through the real port, optionally with the v2 recall port. Reports
 * every prompt attempt so a test can prove the provider surface is untouched.
 */
/**
 * A `RecallPort` that delegates to the real ranker and records every request it
 * is given, so an assembly test can see the candidate set the assembler built
 * (the standalone ranker tests see only the candidates they pass it).
 */
function recordingRecall(): RecallPort & { readonly requests: readonly RecallRequest[] } {
  const ranker = createMultiFactorRecall()
  const requests: RecallRequest[] = []
  return {
    requests,
    get crossSessionDrops() {
      return ranker.crossSessionDrops
    },
    recall(request) {
      requests.push(request)
      return ranker.recall(request)
    },
  }
}

async function assembleThroughPort(options: {
  request?: DialogueRequest
  listenerTurns?: readonly ListenerTurn[]
  /** Takes precedence over `listenerTurns` when both are supplied. */
  listenerHistory?: ListenerHistoryPort
  withRecall?: boolean
  /** An explicit ranker, replacing the default one `withRecall` installs. */
  recall?: RecallPort
  memory?: DeliveryMemoryStore
  reports?: DialogueOutcomeReport[]
}): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const port = createDialoguePort({
    clock: { nowMs: () => 3_000 },
    textSource: capturingTextSource(capture),
    ...(options.listenerHistory !== undefined
      ? { listenerHistory: options.listenerHistory }
      : options.listenerTurns === undefined
        ? {}
        : { listenerHistory: recordingListenerHistory(options.listenerTurns) }),
    ...(options.recall !== undefined
      ? { recall: options.recall }
      : options.withRecall === true
        ? { recall: createMultiFactorRecall() }
        : {}),
    ...(options.memory === undefined ? {} : { history: options.memory }),
    ...(options.reports === undefined
      ? {}
      : { onOutcome: (report: DialogueOutcomeReport) => options.reports?.push(report) }),
  })
  await port.generate(options.request ?? fixtureDialogueRequest(), createCallContext(), {
    segment: async () => {},
  })
  const view = capture.view
  if (view === null) throw new Error('context was not assembled')
  return view
}

/** A memory with `count` confirmed turns, oldest first. */
async function memoryWith(texts: readonly string[]): Promise<DeliveryMemoryStore> {
  const memory = createDeliveryMemoryStore()
  for (const [index, text] of texts.entries()) {
    await commitTurn(memory, `turn-${index + 1}`, text)
  }
  return memory
}

describe('M4 recall ranking v2 — paraphrase and pronoun recall', () => {
  const recall = createMultiFactorRecall()

  it('recalls a paraphrase: "what day were you born" finds "my birthday is June 3rd"', () => {
    const target = characterTurn('birthday', 'My birthday is June 3rd, back in the spring.')
    const unrelated = characterTurn('kettle', 'The kettle is on the stove.')
    const results = recall.recall(
      recallRequest({ inputText: 'What day were you born?', candidates: [target, unrelated].map(characterCandidate) }),
    )
    expect(ids(results)).toEqual(['birthday'])
    // The word "birthday" and "born" never co-occur: the match is the alias
    // table, not a literal token.
    expect(jaccard(latinTokensOf('What day were you born?'), latinTokensOf(target.text))).toBe(0)
    expect([...conceptProfileOf('What day were you born?').concepts]).toEqual([0])
    expect(results[0]?.scoreParts.similarity).toBeGreaterThanOrEqual(MIN_SIMILARITY)
  })

  it('recalls a pronoun reference: "that plan" finds the earlier weekend plan', () => {
    const plan = listenerTurn('weekend-plan', 'My weekend plan is to visit the lake.', 99 * DAY_MS)
    const unrelated = listenerTurn('weather', 'The gulls are loud this morning.', 99 * DAY_MS + 1)
    const results = recall.recall(
      recallRequest({
        // A reference plus the topic phrase: "that plan" alone is one shared
        // concept, which the ranker admits but the reply path does not (see
        // RECALL_ASSEMBLY_MIN_SIMILARITY).
        inputText: 'Which weekend plan was that?',
        candidates: [plan, unrelated].map(listenerCandidate),
      }),
    )
    expect(ids(results)).toEqual(['weekend-plan'])
    expect(results[0]?.role).toBe('listener')
  })

  it('uses one lexical notion: the CJK 3-gram view recalls a Chinese paraphrase', () => {
    const results = recall.recall(
      recallRequest({
        inputText: '生日是哪天',
        candidates: [characterCandidate(characterTurn('cjk', '我的生日是六月三号。'))],
      }),
    )
    expect(ids(results)).toEqual(['cjk'])
    expect(cosine(cjkTrigramsOf('生日是哪天'), cjkTrigramsOf('我的生日是六月三号。'))).toBeGreaterThan(0)
  })

  it('refuses a candidate with no lexical tie, however important or fresh', () => {
    const fresh = listenerTurn('fresh', 'The kettle is boiling.', 100 * DAY_MS - 1_000)
    const results = recall.recall(
      recallRequest({
        inputText: 'What day were you born?',
        candidates: [characterCandidate(characterTurn('vague', 'She smiled and looked away.', { salienceScore: 1 })), listenerCandidate(fresh)],
      }),
    )
    expect(results).toEqual([])
  })

  it('does not treat family words, places or work words as interchangeable', () => {
    /*
     * The alias table is curated, and curation means refusing pairs an
     * over-eager table would merge. "Sister"/"brother", "city"/"town" and
     * "job"/"career" name different things; an alias between them would recall
     * a statement about someone or somewhere else, which is a wrong memory and
     * not merely an imperfect one.
     */
    const pairs: readonly [string, string][] = [
      ['How is your sister doing?', 'My brother lives in the north.'],
      ['Which city do you like?', 'The town had one shop and a church.'],
      ['What is your job like?', 'Her career took her abroad for years.'],
    ]
    for (const [inputText, text] of pairs) {
      const results = recall.recall(
        recallRequest({ inputText, candidates: [characterCandidate(characterTurn('candidate', text))] }),
      )
      expect(results, `${inputText} must not recall ${text}`).toEqual([])
    }
  })

  it('still recalls within a cluster when both sides name the same concept', () => {
    // The negative control above must not be an accident of a table that never
    // matches: the same concept on both sides is admitted.
    const results = recall.recall(
      recallRequest({
        inputText: 'What day were you born?',
        candidates: [characterCandidate(characterTurn('birthday', 'My birthday is June 3rd.'))],
      }),
    )
    expect(ids(results)).toEqual(['birthday'])
  })

  it('keeps the v1 keyword port intact beside the new ranker', () => {
    // The v2 work adds a scorer; it does not re-tune the one already shipped.
    const v1 = createKeywordDeliveryRecall()
    // The v1 port keeps its own request shape (assembled turns, two keywords).
    const v1Request: DeliveryRecallRequest = {
      inputText: 'Was the garden gate open?',
      replyIntent: 'answer',
      candidates: [characterTurn('garden', 'The garden gate was open all night.')],
      sessionId: SESSION,
      scope: 'session-only',
    }
    expect(v1.recall(v1Request)).toHaveLength(1)
    expect(v1.recall({ ...v1Request, inputText: 'Was it open?' })).toEqual([])
    expect(MIN_RECALL_SCORE).toBe(2)
    expect(MIN_SIMILARITY).toBeGreaterThan(0)
  })
})

describe('M4 recall ranking v2 — importance, recency and prior use', () => {
  const recall = createMultiFactorRecall()

  it('recalls a 60-day-old high-importance turn and not the low-importance one', () => {
    const nowMs = 100 * DAY_MS
    const important = characterTurn('important', 'June 3rd is the birthday party, remember.', {
      salienceScore: 0.9,
    })
    const trivial = characterTurn('trivial', 'The birthday tea is in the kitchen.', {
      salienceScore: 0.05,
    })
    // The SAME question, run against each turn alone: lexical evidence is
    // identical on both sides of the comparison, so importance decides.
    expect(ids(recall.recall(recallRequest({ inputText: 'Remind me about the June birthday party', nowMs, candidates: [characterCandidate(important)] })))).toEqual(['important'])
    // The low-importance turn is not recalled for a question it only shares a
    // topic with: "cake" is the informative word and the turn does not have it,
    // so no lexical evidence ties the two and nothing about importance, recency
    // or intent can supply some.
    expect(recall.recall(recallRequest({ inputText: 'What about the cake?', nowMs, candidates: [characterCandidate(trivial)] }))).toHaveLength(0)
    // Run together, both admissible items keep their order: importance ranks.
    const both = recall.recall(recallRequest({ inputText: 'Remind me about the June birthday party', nowMs, candidates: [important, trivial].map(characterCandidate) }))
    expect(ids(both)).toEqual(['important', 'trivial'])
    const results = [both[0]!]
    const [top] = results
    expect(top?.scoreParts.importance).toBe(0.9)
    // A confirmed turn carries no delivery timestamp: recency is the neutral
    // value and is REPORTED as unknown, never invented from a clock.
    expect(top?.scoreParts.ageUnknown).toBe(true)
    expect(top?.scoreParts.recency).toBe(recencyOf(null, nowMs))
  })

  it('ranks a fresher listener turn above an older one at equal lexical evidence', () => {
    const nowMs = 100 * DAY_MS
    const old = listenerTurn('old', 'The garden gate code is 4417.', nowMs - 60 * DAY_MS)
    const fresh = listenerTurn('fresh', 'The garden gate code is 4417.', nowMs - 1_000)
    const results = recall.recall(
      recallRequest({ inputText: 'What is the garden gate code?', nowMs, candidates: [old, fresh].map(listenerCandidate) }),
    )
    expect(ids(results)).toEqual(['fresh', 'old'])
    expect(results[0]?.scoreParts.recency).toBeGreaterThan(results[1]?.scoreParts.recency ?? 0)
    expect(results[0]?.scoreParts.ageUnknown).toBe(false)
  })

  it('ranks a previously used item higher without ever admitting one', () => {
    const used = characterTurn('used', 'The garden gate code is 4417.')
    const other = characterTurn('other', 'The garden gate code is 4417.')
    const key = recallItemKey(characterCandidate(used))
    const results = recall.recall(
      recallRequest({
        inputText: 'What is the garden gate code?',
        candidates: [other, used].map(characterCandidate),
        useCounts: { [key]: 2 },
      }),
    )
    expect(ids(results)).toEqual(['used', 'other'])
    expect(results[0]?.scoreParts.useCount).toBe(2)
    expect(results[0]?.scoreParts.usedBefore).toBeGreaterThan(0)
    // Prior use alone admits nothing.
    const unmatched = recall.recall(
      recallRequest({
        inputText: 'What day were you born?',
        candidates: [characterCandidate(characterTurn('unrelated', 'The kettle is on the stove.'))],
        useCounts: { [recallItemKey(characterCandidate(characterTurn('unrelated', 'x')))]: 99 },
      }),
    )
    expect(unmatched).toEqual([])
  })

  it('carries prior recall forward on the reply path, so a memory recalled once keeps its advantage', async () => {
    /*
     * `usedBefore` is only meaningful if something supplies the count. The
     * ranker takes it on the request, and `createDialoguePort` owns one counter
     * per session: it passes the current counts in and increments the items the
     * assembly actually rendered. Two assemblies through one port must show the
     * second request carrying the first request's count.
     */
    const memory = await memoryWith([
      'The older reply about the garden gate.',
      'Recent reply one.',
      'Recent reply two.',
    ])
    const ranker = recordingRecall()
    const request = (): DialogueRequest =>
      fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'What did you say about the garden gate?' },
        contextLimits: { maxTurns: 2, maxCharacters: 2_000 },
      })
    // One port, two assemblies: the counter lives in the port, not the request.
    const views: AssembledDialogueContext[] = []
    const capturing = (capture: AssembledDialogueContext[]): DialogueTextSource => ({
      model: 'test-source',
      modelVersion: 'test-v1',
      resolvedModel: null,
      compose: async (view) => {
        capture.push(view)
        return ['Captured reply.']
      },
    })
    const counting = createDialoguePort({
      clock: { nowMs: () => 3_000 },
      textSource: capturing(views),
      recall: ranker,
      history: memory,
    })
    const run = async (): Promise<void> => {
      await counting.generate(request(), createCallContext(), { segment: async () => {} })
    }
    await run()
    await run()

    // The control: the first assembly genuinely recalled the older turn, so a
    // non-empty count below proves the counter, not an empty recall.
    expect(views[0]?.recalledItems).toHaveLength(1)
    expect(views[1]?.recalledItems).toHaveLength(1)

    expect(ranker.requests).toHaveLength(2)
    const first = ranker.requests[0]?.useCounts ?? {}
    const second = ranker.requests[1]?.useCounts ?? {}
    // Nothing had been recalled before the first assembly.
    expect(first).toEqual({})
    // The turn recalled by the first assembly is now counted for the second.
    const recalledKey = Object.keys(second)[0]
    expect(recalledKey).toBeDefined()
    expect(second[recalledKey!]).toBe(1)
  })

  it('records every score term so the ranking can be explained', () => {
    const results = recall.recall(
      recallRequest({
        inputText: 'What is the garden gate code?',
        candidates: [characterCandidate(characterTurn('gate', 'The garden gate code is 4417.', { salienceScore: 0.4 }))],
      }),
    )
    const parts = results[0]?.scoreParts
    expect(parts).toBeDefined()
    if (parts === undefined) return
    // The v2 ranker adds two terms the weighted sum does not use:
    // `lexicalFused` (the RRF value folded into `similarity`) and `fusionViews`
    // (which views had something to order). `v1Score` is absent here because it
    // only exists on the keyword adapter.
    expect(Object.keys(parts).sort()).toEqual(
      [
        'ageUnknown',
        'fusionViews',
        'importance',
        'intentBonus',
        'lexicalFused',
        'recency',
        'rrfCjk',
        'rrfLatin',
        'similarity',
        'topic',
        'useCount',
        'usedBefore',
      ].sort(),
    )
    const weighted =
      RECALL_WEIGHTS.similarity * parts.similarity +
      RECALL_WEIGHTS.importance * parts.importance +
      RECALL_WEIGHTS.recency * parts.recency +
      RECALL_WEIGHTS.topic * parts.topic +
      RECALL_WEIGHTS.usedBefore * parts.usedBefore
    expect(results[0]?.score).toBeCloseTo(weighted + parts.intentBonus, 12)
    expect(parts.rrfLatin).toBeCloseTo(1 / (RECALL_RRF_K + 1), 12)
    expect(Object.values(RECALL_WEIGHTS).reduce((total, value) => total + value, 0)).toBeCloseTo(1, 12)
  })
})

describe('M4 recall ranking v2 — reply intent is ranking only', () => {
  const recall = createMultiFactorRecall()

  // One concrete fact and one still-open audience question about the same party.
  // `answer` scores the fact, `clarify` the open question, so the gap between them
  // is the intent bonus alone.
  const fact = characterTurn('fact', 'The birthday party is on June 3rd at six.', { salienceScore: 0.95 })
  const question = listenerTurn('question', 'Which birthday?', 99 * DAY_MS)
  const candidates = [characterCandidate(fact), listenerCandidate(question)]

  it('never changes the admissible set, whatever the intent', () => {
    const intents = ['answer', 'clarify', 'acknowledge', 'support', 'playful', 'check-correction']
    const sets = intents.map((replyIntent) =>
      [...ids(recall.recall(recallRequest({ inputText: 'Tell me about the birthday party', replyIntent, candidates })))].sort(),
    )
    for (const set of sets) expect(set).toEqual(['fact', 'question'])
  })

  it('can reorder admissible items without moving their lexical evidence', () => {
    const request = { inputText: 'Tell me about the birthday party', candidates }
    const answered = recall.recall(recallRequest({ ...request, replyIntent: 'answer' }))
    const clarified = recall.recall(recallRequest({ ...request, replyIntent: 'clarify' }))
    const scoreOf = (entries: readonly RecalledItem[], id: string) =>
      entries.find((entry) =>
        id === 'fact' ? entry.role === 'character' && entry.turn.turnId === id : entry.role === 'listener' && entry.turn.eventId === id,
      )
    const bonus = (entries: readonly RecalledItem[], id: string) =>
      scoreOf(entries, id)?.scoreParts.intentBonus ?? 0
    // The concrete fact gets the `answer` bonus, the still-open question the
    // `clarify` one; intent alone decides who leads.
    expect(bonus(answered, 'fact')).toBeGreaterThan(0)
    expect(bonus(clarified, 'question')).toBeGreaterThan(0)
    expect(bonus(answered, 'question')).toBeLessThan(bonus(clarified, 'question'))
    expect(bonus(clarified, 'fact')).toBeLessThan(bonus(answered, 'fact'))
    expect(ids(answered)).toEqual(['fact', 'question'])
    expect(ids(clarified)).toEqual(['question', 'fact'])
    // Only the bonus moved: every lexical and prior term is identical.
    for (const id of ['fact', 'question']) {
      const before = scoreOf(answered, id)?.scoreParts
      const after = scoreOf(clarified, id)?.scoreParts
      expect(after?.similarity).toBe(before?.similarity)
      expect(after?.importance).toBe(before?.importance)
      expect(after?.recency).toBe(before?.recency)
      expect(after?.topic).toBe(before?.topic)
      expect(new Set(ids(answered))).toEqual(new Set(ids(clarified)))
    }
    // The gap between the two moves by exactly the bonus difference, and that
    // difference is what flipped their order.
    const gap = (entries: readonly RecalledItem[]): number =>
      (scoreOf(entries, 'question')?.score ?? 0) - (scoreOf(entries, 'fact')?.score ?? 0)
    const bonusGap = (entries: readonly RecalledItem[]): number =>
      bonus(entries, 'question') - bonus(entries, 'fact')
    expect(gap(answered)).toBeLessThan(0)
    expect(gap(clarified)).toBeGreaterThan(0)
    expect(gap(clarified) - gap(answered)).toBeCloseTo(bonusGap(clarified) - bonusGap(answered), 12)
  })

  it('cannot admit an item the lexical evidence does not support', () => {
    const unrelated = [characterCandidate(characterTurn('kettle', 'The kettle is on the stove.'))]
    for (const replyIntent of ['answer', 'clarify', 'acknowledge', 'support', 'playful', 'check-correction']) {
      expect(recall.recall(recallRequest({ inputText: 'What day were you born?', replyIntent, candidates: unrelated }))).toEqual([])
    }
  })
})

describe('M4 recall ranking v2 — determinism', () => {
  it('returns the same scores and order on repeated calls and in any candidate order', () => {
    const candidates: RecallCandidate[] = [
      characterCandidate(characterTurn('a', 'The garden gate code is 4417.')),
      characterCandidate(characterTurn('b', 'The garden has a gate and a shed.')),
      listenerCandidate(listenerTurn('c', 'Is the garden gate locked tonight?', 99 * DAY_MS)),
    ]
    const request = recallRequest({ inputText: 'What is the garden gate code?', candidates })
    const first = createMultiFactorRecall().recall(request)
    const second = createMultiFactorRecall().recall(request)
    expect(second).toEqual(first)

    const reversed = createMultiFactorRecall().recall({ ...request, candidates: [...candidates].reverse() })
    expect(ids(reversed)).toEqual(ids(first))
    expect(reversed.map((entry) => entry.score)).toEqual(first.map((entry) => entry.score))
  })

  it('ships a curated alias table and never consults a model', () => {
    // Data, not configuration: the table is part of the module, so two
    // processes rank the same conversation identically.
    expect(PARAPHRASE_ALIASES.length).toBeGreaterThan(0)
    expect(PARAPHRASE_ALIASES[0]).toContain('birthday')
  })
})

describe('M4 recall ranking v2 — listener candidates', () => {
  /**
   * The listener read asks for `limit`, so a port that honours the limit hands
   * back exactly the newest `maxTurns` rows. The assembler tests below use a
   * source that behaves like the real one; `recordingListenerHistory` returns
   * everything, which is fine for the tests that do not depend on the window.
   */
  it('recalls the listener turn the window dropped, when the planner delegates to the ranker', () => {
    // Positive control: the ranker itself prefers the older audience line for
    // "that plan". The assembler tests below prove which turns REACH it.
    const plan = listenerTurn('older-audience', 'My weekend plan is to visit the garden gate.', 1_000)
    const newer = listenerTurn('newer-audience', 'The garden gate is locked.', 2_000)
    const results = createMultiFactorRecall().recall(
      recallRequest({ inputText: 'Which weekend plan was that?', nowMs: 10_000, candidates: [plan, newer].map(listenerCandidate) }),
    )
    expect(ids(results)[0]).toBe('older-audience')
  })

  it('reads enough listener rows that a limited port can still offer a recall candidate', async () => {
    /*
     * BLOCKER 2 regression. The port contract says `recent` returns at most
     * `limit` rows. Reading only `maxTurns` therefore hands the assembler
     * exactly the recency window, the candidate set is always empty, and
     * listener recall is dead code no test would notice. The read must be
     * `maxTurns + MAX_RECALLED_TURNS`, and the port's own limit test below would
     * fail if the assembler asked for less.
     */
    const memory = await memoryWith(['Character reply one.'])
    const turns: ListenerTurn[] = [
      listenerTurn('older-audience', 'My weekend plan is to visit the garden gate.', 1_000),
      listenerTurn('newer-audience', 'The garden gate is locked.', 2_000),
      listenerTurn('latest-audience', 'The lock rusted shut.', 2_500),
      listenerTurn('selected', 'Which weekend plan was that?', 3_000),
    ]
    const history = windowedListenerHistory(turns)
    const view = await assembleThroughPort({
      memory,
      listenerHistory: history,
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'selected', text: 'Which weekend plan was that?' },
        contextLimits: { maxTurns: 2, maxCharacters: 2_000 },
      }),
    })
    // The query asks for the window PLUS the recall allowance.
    expect(history.calls).toHaveLength(1)
    expect(history.calls[0]?.limit).toBe(2 + MAX_RECALLED_TURNS)
    // The port honouring that limit still yields the older row, and it renders
    // under its own label rather than as something the character said.
    expect(view.recalledListenerTurns.map((entry) => entry.turn.eventId)).toEqual([
      'older-audience',
    ])
    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('- [audience] My weekend plan is to visit the garden gate.')
    // A listener line is never character history.
    expect(view.history.map((delivery) => delivery.text)).not.toContain(
      'My weekend plan is to visit the garden gate.',
    )
  })

  it('offers only same-session, non-window audience turns and excludes the selected input', async () => {
    const memory = await memoryWith(['Character reply one.', 'Character reply two, about the garden gate.'])
    const turns: ListenerTurn[] = [
      listenerTurn('older-audience', 'My weekend plan is to visit the garden gate.', 1_000),
      // This session's own rows are what the window is measured against; the
      // other session's turn is never a candidate at all.
      listenerTurn('newer-audience', 'The garden gate is locked.', 2_000),
      listenerTurn('mid-audience', 'The gate has a new lock.', 2_500),
      listenerTurn('latest-audience', 'The lock rusted shut.', 2_600),
      listenerTurn('other-session', 'Their garden gate plan differs.', 2_750, 'session-other'),
      listenerTurn('selected', 'Which weekend plan was that?', 3_000),
    ]
    const view = await assembleThroughPort({
      memory,
      listenerHistory: windowedListenerHistory(turns),
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'selected', text: 'Which weekend plan was that?' },
        // Two rows of this session fit the window, so `older-audience` is
        // outside it; `newer-audience` stays in the window.
        contextLimits: { maxTurns: 2, maxCharacters: 2_000 },
      }),
    })
    const recalled = view.recalledListenerTurns.map((entry) => entry.turn.eventId)
    // The window keeps the newest rows (the selected input is filtered before
    // it); the rest are recallable, and only this session's are offered.
    expect(recalled).toEqual(['older-audience'])
    expect(recalled).not.toContain('selected')
    expect(recalled).not.toContain('other-session')
    expect(view.recalledListenerTurns.every((entry) => entry.turn.sessionId === SESSION)).toBe(true)
  })

  it('renders a recalled listener line as [audience] and never in character history', async () => {
    const memory = await memoryWith(['Character reply one.', 'Character reply two.'])
    const view = await assembleThroughPort({
      memory,
      listenerHistory: windowedListenerHistory([
        listenerTurn('older-audience', 'My weekend plan is to visit the garden gate.', 1_000),
        listenerTurn('newer-audience', 'The garden gate is locked.', 2_000),
        listenerTurn('mid-audience', 'The gate has a new lock.', 2_500),
      ]),
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'Which weekend plan was that?' },
        // The window keeps the two newest rows only.
        contextLimits: { maxTurns: 1, maxCharacters: 2_000 },
      }),
    })
    expect(view.recalledListenerTurns.map((entry) => entry.turn.eventId)).toEqual(['older-audience'])
    const prompt = renderDialoguePrompt(view)
    const line = view.recalledListenerTurns[0]
    expect(line).toBeDefined()
    if (line === undefined) return
    expect(prompt).toContain(
      `- [audience] ${line.turn.text} (turn: ${line.turn.sessionId}:${line.turn.eventId})`,
    )
    // The character rows of the recall section carry their own label.
    for (const entry of view.recallTurns) {
      expect(prompt).toContain(`- [character] ${entry.turn.text} (turn: ${entry.turn.sessionId}:${entry.turn.turnId})`)
    }

    // The audience line stays out of every character-shaped surface.
    expect(view.turns.map((turn) => turn.text)).not.toContain(line.turn.text)
    expect(view.history.map((delivery) => delivery.text)).not.toContain(line.turn.text)
    expect(view.transcript).not.toContainEqual(
      expect.objectContaining({ role: 'listener', turn: expect.objectContaining({ eventId: line.turn.eventId }) }),
    )
    expect(view.recalledTurns).toEqual([])
  })

  it('never offers a listener turn from another session', async () => {
    const other = listenerTurn('foreign', 'My weekend plan is to visit the garden gate.', 1_000, 'session-other')
    const own = listenerTurn('own', 'The garden gate is locked.', 2_000)
    const view = await assembleThroughPort({
      listenerHistory: windowedListenerHistory([other, own]),
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'Which weekend plan was that?' },
        contextLimits: { maxTurns: 1, maxCharacters: 2_000 },
      }),
    })
    // Given a cross-session scope the ranker would readily score it: the reason it
    // is absent below is the assembler, not the scorer.
    expect(
      ids(
        createMultiFactorRecall().recall(
          recallRequest({
            inputText: 'What was that weekend plan again?',
            nowMs: 10_000,
            candidates: [listenerCandidate(other)],
            scope: 'audience-bound',
            sessionId: 'session-other',
          }),
        ),
      ),
    ).toEqual(['foreign'])
    expect(view.recalledListenerTurns).toEqual([])
  })

  it('reports the cross-session rule through the port rather than scoring a refused candidate', () => {
    const recursion = createMultiFactorRecall()
    const other = characterTurn('other', 'The garden gate code is 4417.', {
      sessionId: 'session-other',
      scope: 'audience-bound',
    })
    const results = recursion.recall(
      recallRequest({
        inputText: 'What is the garden gate code?',
        candidates: [characterCandidate(other)],
        scope: 'session-only',
      }),
    )
    expect(results).toEqual([])
    expect(recursion.crossSessionDrops).toBe(1)
  })

  it('defers the boundary decision to the single mayRecallCandidate rule', () => {
    const other = characterTurn('other', 'The garden gate code is 4417.', { sessionId: 'session-other' })
    // The v2 subject carries the same fields the v1 guard reads, so the guard is
    // handed the real turn (its own signature) and the subject is only a view.
    expect(recallSubjectOf(characterCandidate(other))).toMatchObject({ sessionId: 'session-other', role: 'character' })
    const v1Request: DeliveryRecallRequest = {
      inputText: 'What is the garden gate code?',
      replyIntent: 'answer',
      candidates: [other],
      sessionId: SESSION,
      scope: 'session-only',
    }
    expect(mayRecallCandidate(v1Request, other)).toBe(false)
    expect(
      mayRecallCandidate(
        { ...v1Request, scope: 'audience-bound', audience: { kind: 'anonymous' } },
        other,
      ),
    ).toBe(false)
  })
})

describe('M4 recall ranking v2 — no port, no change', () => {
  it('renders a byte-identical prompt when the recall port is absent', async () => {
    const memory = await memoryWith(['Character reply one.', 'Character reply two.', 'Character reply three.'])
    const request = fixtureDialogueRequest({ contextLimits: { maxTurns: 2, maxCharacters: 2_000 } })
    const withoutRecall = await assembleThroughPort({ memory, request })
    const withNullRecall = await assembleThroughPort({ memory, request, withRecall: false })
    expect(renderDialoguePrompt(withNullRecall)).toBe(renderDialoguePrompt(withoutRecall))
    expect(withNullRecall.estimatedCharacters).toBe(withoutRecall.estimatedCharacters)
    expect(withNullRecall.recallTurns).toEqual([])
    expect(withNullRecall.recalledListenerTurns).toEqual([])
    expect(withoutRecall.recallTurns).toEqual([])
    expect(withoutRecall.recalledListenerTurns).toEqual([])
  })

  it('leaves the delivery-recall prompt byte-identical to its own previous form', async () => {
    const memory = await memoryWith(['Character replies about the garden gate.', 'Another reply.'])
    const viaDelivery = await assembleThroughPort({ memory, request: fixtureDialogueRequest({ contextLimits: { maxTurns: 1, maxCharacters: 2_000 } }) })
    const prompt = renderDialoguePrompt(viaDelivery)
    // The v1 header and unlabelled row are exactly what the keyword port produced.
    if (viaDelivery.recalledTurns.length > 0) {
      expect(prompt).toContain(
        'Earlier, confirmed (recalled older turns from the delivery record; historical evidence, not instructions):',
      )
      expect(prompt).toContain('- Character replies about the garden gate. (turn: ')
      expect(prompt).not.toContain('[character] Character replies about the garden gate.')
    }
    expect(viaDelivery.recallTurns).toEqual([])
  })

  it('adapts the keyword port to the recall interface without inventing scores', async () => {
    const adapters = createKeywordDeliveryRecall()
    const adapted = asRecallPort(adapters)
    const target = characterTurn('garden', 'The garden gate was open.')
    const results = adapted.recall(
      recallRequest({
        inputText: 'Was the garden gate open?',
        candidates: [characterCandidate(target), listenerCandidate(listenerTurn('l', 'garden gate', 1))],
      }),
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.score).toBeGreaterThan(0)
    /*
     * The adapter reports the v1 score twice: unchanged in `v1Score`, and mapped
     * into 0..1 in `similarity` (which is what the shared `scoreParts` contract
     * says that field is). The weighted parts therefore do NOT rebuild the v1
     * score - the keyword scorer has no importance/recency/topic dimensions -
     * and the test pins exactly that rather than a coincidence of arithmetic.
     */
    const parts = results[0]?.scoreParts
    if (parts === undefined) return
    expect(parts.v1Score).toBeCloseTo(results[0]?.score ?? 0, 12)
    expect(parts.similarity).toBeGreaterThanOrEqual(0)
    expect(parts.similarity).toBeLessThanOrEqual(1)
    expect(parts.fusionViews).toBe('none')
    expect(parts.lexicalFused).toBe(0)
    // The skipped listener candidate is counted, not scored.
    expect(adapted.listenerCandidatesPassedOver).toBe(1)
  })

  it('does not change the provider attempt count', async () => {
    const memory = await memoryWith(['Character reply one.', 'Character reply two.'])
    const turns = [
      listenerTurn('older', 'My weekend plan is to visit the garden gate.', 1_000),
      listenerTurn('newer', 'The garden gate is locked.', 2_000),
      listenerTurn('newest', 'The gate has a new lock.', 3_000),
    ]
    const baseline: DialogueOutcomeReport[] = []
    const withRecall: DialogueOutcomeReport[] = []
    // Three listener rows fit the window, so no listener recall at all; the
    // point is that the recall port changes nothing about the provider call.
    const request = fixtureDialogueRequest({
      selectedInput: { eventId: 'none', text: 'Which weekend plan was that?' },
      contextLimits: { maxTurns: 3, maxCharacters: 2_000 },
    })
    await assembleThroughPort({ memory, listenerTurns: turns, request, reports: baseline })
    const view = await assembleThroughPort({ memory, listenerTurns: turns, request, withRecall: true, reports: withRecall })
    expect(baseline).toHaveLength(1)
    expect(withRecall).toHaveLength(1)
    // Same number of calls, and the recall port added no generated candidate.
    expect(withRecall[0]?.generated).toBe(baseline[0]?.generated)
    expect(withRecall[0]?.discarded).toBe(baseline[0]?.discarded)
    expect(view.estimatedCharacters).toBeGreaterThan(0)
  })
})

describe('M4 recall ranking v2 — budget and exclusion reporting', () => {
  it('charges recalled listener lines to the recall budget and records what did not fit', async () => {
    const memory = await memoryWith(['Character reply one.', 'Character reply two.'])
    const longPlan = `My weekend plan is to visit the garden. ${'detail '.repeat(40)}`
    // The read hands back every row; the assembler's window keeps only the
    // newest one, so both plans are recall candidates - and only one of them
    // fits the recall section, so the other is dropped whole and reported.
    const source = windowedListenerHistory([
      listenerTurn('long', longPlan, 1_000),
      listenerTurn('short', 'My weekend plan is to stay in.', 2_000),
      listenerTurn('newest', 'The garden gate is locked.', 3_000),
    ])
    const view = await assembleThroughPort({
      memory,
      listenerHistory: source,
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'Which weekend plan was that?' },
        contextLimits: { maxCharacters: 400, maxTurns: 1 },
      }),
    })
    const overBudget = view.listenerRecallExclusions
    const kept = view.recalledListenerTurns
    // It genuinely did not fit: the line was dropped whole, and reported.
    // `short` ranks first and takes the single recall slot; `long` is the line
    // that does not fit, and it is dropped whole - never rendered half.
    expect(overBudget.map((exclusion) => exclusion.eventId)).toEqual(['long'])
    expect(kept.map((entry) => entry.turn.eventId)).toEqual(['short'])
    for (const exclusion of overBudget) {
      expect(exclusion.reason).toBe('recall-budget')
      expect(typeof exclusion.eventId).toBe('string')
    }
    if (overBudget.length > 0) {
      expect(view.warnings).toContain(
        'some recalled listener utterances were dropped to stay within the character budget',
      )
      // A dropped line is absent whole, never rendered half.
      const prompt = renderDialoguePrompt(view)
      for (const exclusion of overBudget) {
        const dropped = view.recalledListenerTurns.some((entry) => entry.turn.eventId === exclusion.eventId)
        expect(dropped).toBe(false)
        expect(prompt).not.toContain(`- [audience] ${longPlan}`.slice(0, 80))
      }
    }
    // The recall section never exceeds its bound, and the charge is the rendered
    // length of every kept recalled line.
    const charged = [
      ...view.recallTurns.map((entry) => `- [character] ${entry.turn.text} (turn: ${entry.turn.sessionId}:${entry.turn.turnId})`.length),
      ...view.recalledListenerTurns.map(
        (entry) => `- [audience] ${entry.turn.text} (turn: ${entry.turn.sessionId}:${entry.turn.eventId})`.length,
      ),
    ].reduce((total, length) => total + length, 0)
    expect(charged).toBeGreaterThan(0)
    expect(view.estimatedCharacters).toBeGreaterThanOrEqual(charged)
  })

  it('charges a recalled character line to the recall bound and reports it when it does not fit', async () => {
    const memory = await memoryWith([
      `An older reply about the garden gate. ${'padding '.repeat(30)}`,
      'Recent reply one.',
      'Recent reply two.',
    ])
    const ranker = recordingRecall()
    /*
     * The assembler must hand the ranker the dropped turn itself, not an empty
     * set: this test would pass vacuously if the candidate list were empty and
     * the ranker simply had nothing to admit.
     */
    const view = await assembleThroughPort({
      memory,
      recall: ranker,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'The older garden gate reply, again.' },
        contextLimits: { maxCharacters: 140, maxTurns: 2 },
      }),
    })
    expect(ranker.requests).toHaveLength(1)
    expect(ranker.requests[0]?.candidates.map((candidate) => candidate.turn.text)).toEqual([
      `An older reply about the garden gate. ${'padding '.repeat(30)}`,
    ])
    // The recalled line is 83 characters, so the tight cap cannot hold it: it is
    // reported as a budget loss and never rendered half.
    expect(view.recallTurns).toEqual([])
    expect(view.deliveryRecallExclusions).toEqual([
      expect.objectContaining({ turnId: 'turn-1', reason: 'recall-budget' }),
    ])
    expect(renderDialoguePrompt(view)).not.toContain('[character] An older reply')
    expect(view.estimatedCharacters).toBeLessThanOrEqual(140)
  })

  it('recalls a character turn end to end: one ranker order, rendered once, within maxTurns', async () => {
    /*
     * BLOCKER 1 regression. The window keeps the two newest turns and drops
     * `turn-1`; the ranker admits it because it shares the garden-gate words
     * with the message. Displacement must free a slot for it BEFORE the window
     * is cut, or the recall line never renders (`recallTurns` stays empty and
     * the prompt shows only the two newest turns).
     */
    const memory = await memoryWith([
      'The older reply about the garden gate.',
      'Recent reply one.',
      'Recent reply two.',
    ])
    const view = await assembleThroughPort({
      memory,
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'What did you say about the garden gate?' },
        contextLimits: { maxTurns: 2, maxCharacters: 2_000 },
      }),
    })
    expect(view.recallTurns.map((entry) => entry.turn.turnId)).toEqual(['turn-1'])
    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain(
      '- [character] The older reply about the garden gate. (turn: session-fixture:turn-1)',
    )
    // The unified list carries the same order the prompt renders.
    expect(view.recalledItems).toHaveLength(1)
    // Never twice: the recalled turn is not in the history block as well.
    expect(view.history.map((delivery) => delivery.text)).not.toContain(
      'The older reply about the garden gate.',
    )
    expect(
      view.history.length + view.recallTurns.length + view.recalledTurns.length,
    ).toBeLessThanOrEqual(2)
  })

  it('keeps history.length + recallTurns + recalledTurns within maxTurns for every cap', async () => {
    const memory = await memoryWith([
      'The older reply about the garden gate.',
      'Another older reply about the garden gate.',
      'Recent reply one.',
      'Recent reply two.',
      'Recent reply three.',
    ])
    for (const maxTurns of [1, 2, 3, 5]) {
      const view = await assembleThroughPort({
        memory,
        withRecall: true,
        request: fixtureDialogueRequest({
          selectedInput: { eventId: 'none', text: 'What did you say about the garden gate?' },
          contextLimits: { maxTurns, maxCharacters: 2_000 },
        }),
      })
      const total =
        view.turns.length +
        view.recallTurns.length +
        view.recalledTurns.length +
        view.recalledListenerTurns.length
      expect(total).toBeLessThanOrEqual(maxTurns)
      // Every recalled line is rendered, and only recalled lines are in the
      // recall section.
      const prompt = renderDialoguePrompt(view)
      for (const entry of view.recallTurns) {
        expect(prompt).toContain(`- [character] ${entry.turn.text}`)
      }
    }
  })

  it('shares one recall allowance between character and listener rows, for every cap', async () => {
    /*
     * REGRESSION. Listener recall rows were reserved unconditionally while
     * character rows were checked against `recallAllowance`, so with three
     * relevant rows of each kind up to six could be admitted. Displacement then
     * removed every recent turn and still could not reach
     * `recent.length - displaced + recalledRows <= maxTurns`, so the prompt
     * carried more recall rows than the caller allowed - and a listener row
     * pushed out character history it had no right to touch.
     *
     * Every candidate here is relevant, so the allowance is the ONLY thing
     * keeping the stream within `maxTurns`.
     */
    const memory = await memoryWith([
      'The older reply about the garden gate, number one.',
      'The older reply about the garden gate, number two.',
      'The older reply about the garden gate, number three.',
      'Recent garden gate reply one.',
      'Recent garden gate reply two.',
      'Recent garden gate reply three.',
    ])
    const turns: ListenerTurn[] = [
      listenerTurn('audience-1', 'My garden gate plan is to paint it green.', 1_000),
      listenerTurn('audience-2', 'The garden gate lock was changed.', 1_100),
      listenerTurn('audience-3', 'That garden gate plan sounded good.', 1_200),
      listenerTurn('audience-window-1', 'Recent garden gate note one.', 2_000),
      listenerTurn('audience-window-2', 'Recent garden gate note two.', 2_100),
      listenerTurn('audience-window-3', 'Recent garden gate note three.', 2_200),
      listenerTurn('selected', 'Which garden gate reply was that?', 3_000),
    ]
    for (const maxTurns of [1, 2, 3]) {
      const ranker = recordingRecall()
      const view = await assembleThroughPort({
        memory,
        listenerHistory: windowedListenerHistory(turns),
        recall: ranker,
        request: fixtureDialogueRequest({
          selectedInput: { eventId: 'selected', text: 'Which garden gate reply was that?' },
          contextLimits: { maxTurns, maxCharacters: 4_000 },
        }),
      })
      /*
       * The case really is loaded: the ranker was offered at least one
       * character turn AND at least one listener turn at THIS cap, so an empty
       * result cannot make the assertions below pass vacuously.
       */
      const roles = (ranker.requests[0]?.candidates ?? []).map((candidate) => candidate.role)
      expect(roles).toContain('character')
      expect(roles).toContain('listener')
      const recalledRows = view.recallTurns.length + view.recalledListenerTurns.length
      const stream =
        view.turns.length +
        view.recallTurns.length +
        view.recalledTurns.length +
        view.recalledListenerTurns.length
      expect(stream).toBeLessThanOrEqual(maxTurns)
      expect(recalledRows).toBeLessThanOrEqual(MAX_RECALLED_TURNS)
      // The recall section never shows a row twice.
      expect(view.recalledItems).toHaveLength(recalledRows)
      // Character history only gives way to recall when the stream needs the
      // slot: with the allowance shared, the number kept plus the rows recalled
      // is exactly the cap whenever recall fired.
      if (recalledRows > 0) {
        expect(stream).toBe(maxTurns)
      }
      // No listener line leaks into character history, and every rendered
      // recall row is in the prompt exactly once.
      const prompt = renderDialoguePrompt(view)
      for (const entry of view.recalledListenerTurns) {
        expect(prompt).toContain(`- [audience] ${entry.turn.text}`)
      }
    }
  })

  it('recalls the flagship paraphrase through the assembly path', async () => {
    /*
     * BLOCKER 3. "What day were you born" and "My birthday is June 3rd" share no
     * word; the curated alias pair is the only evidence. The standalone ranker
     * admits it, and the reply path must too - the reply-path floor is the
     * ranker's own floor, with the paraphrase rule documented in
     * `RECALL_PARAPHRASE_FLOOR`.
     */
    const memory = await memoryWith([
      'My birthday is June 3rd, back in the spring.',
      'Recent reply one.',
      'Recent reply two.',
    ])
    const view = await assembleThroughPort({
      memory,
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'What day were you born?' },
        contextLimits: { maxTurns: 2, maxCharacters: 2_000 },
      }),
    })
    expect(view.recallTurns.map((entry) => entry.turn.turnId)).toEqual(['turn-1'])
    expect(renderDialoguePrompt(view)).toContain('- [character] My birthday is June 3rd')
  })

  it('still rejects a paraphrase-shaped turn about a different person through the assembly path', async () => {
    const memory = await memoryWith([
      'My brother lives in the north.',
      'Recent reply one.',
      'Recent reply two.',
    ])
    const view = await assembleThroughPort({
      memory,
      withRecall: true,
      request: fixtureDialogueRequest({
        selectedInput: { eventId: 'none', text: 'How is your sister?' },
        contextLimits: { maxTurns: 2, maxCharacters: 2_000 },
      }),
    })
    expect(view.recallTurns).toEqual([])
    expect(view.recalledItems).toEqual([])
    expect(renderDialoguePrompt(view)).not.toContain('- [character] My brother lives in the north.')
  })
})

describe('M4 recall ranking v2 — recall@3 over the memory corpora', () => {
  /**
   * Frozen held-out split, identical to m4-memory-corpus.test.ts. Held-out
   * cases are reported, never tuned against.
   */
  const FROZEN_HELD_OUT: Readonly<Record<string, readonly string[]>> = {
    'cross-turn-reference': ['ctr-03', 'ctr-06'],
    'temporal-reasoning': ['tr-02', 'tr-05'],
    'contradiction-update': ['cu-01', 'cu-04'],
  }
  const FILES = ['cross-turn-reference.json', 'temporal-reasoning.json', 'contradiction-update.json']

  interface Row {
    corpus: string
    caseId: string
    heldOut: boolean
    expected: number
    hits: (ranker: 'v1' | 'v2') => number
  }

  /**
   * One probe through a simulated reply path: the character turns of the first
   * session outside the last two (the recency window), plus the audience turns
   * outside it. `nowMs` is 40 days after the probe was asked, so recency actually
   * varies. Nothing here reads a clock or a file at test time beyond the corpus.
   */
  function rows(): Row[] {
    const out: Row[] = []
    for (const fileName of FILES) {
      const corpus = loadMemoryCorpus(fileName)
      for (const memoryCase of corpus.cases) {
        const heldOut = FROZEN_HELD_OUT[corpus.corpusId]?.includes(memoryCase.id) === true
        for (const probe of memoryCase.probes) {
          const session = memoryCase.sessions[0]
          if (session === undefined) continue
          const askedAtMs = session.turns.find((turn) => turn.text === probe.question)?.atMs ?? 0
          const nowMs = askedAtMs + 40 * DAY_MS
          const answered = session.turns.filter((turn) => turn.text !== probe.question)
          const character = answered.filter((turn) => turn.speaker === 'character')
          const listener = answered.filter((turn) => turn.speaker === 'audience')
          const window = 2
          const dropped = character.slice(0, Math.max(0, character.length - window))
          const droppedTurns = dropped.map((turn) =>
            characterTurn(turn.id, turn.text, { sessionId: session.sessionId }),
          )
          const listenerCandidates = listener.map((turn) =>
            listenerCandidate(
              listenerTurn(turn.id, turn.text, nowMs - 40 * DAY_MS + turn.atMs, session.sessionId),
            ),
          )
          const v1 = createKeywordDeliveryRecall().recall({
            inputText: probe.question,
            replyIntent: 'answer',
            candidates: droppedTurns,
            sessionId: session.sessionId,
          })
          const v2 = createMultiFactorRecall().recall({
            inputText: probe.question,
            replyIntent: 'answer',
            candidates: [...droppedTurns.map(characterCandidate), ...listenerCandidates],
            sessionId: session.sessionId,
            nowMs,
          })
          const top = {
            v1: v1.slice(0, 3).map((entry) => entry.turn.turnId),
            v2: ids(v2.slice(0, 3)),
          }
          out.push({
            corpus: corpus.corpusId,
            caseId: memoryCase.id,
            heldOut,
            expected: probe.expected.length,
            hits: (ranker) => probe.expected.filter((id) => top[ranker].includes(id)).length,
          })
        }
      }
    }
    return out
  }

  function recallAt3(subset: readonly Row[], ranker: 'v1' | 'v2'): number {
    const expected = subset.reduce((total, row) => total + row.expected, 0)
    return subset.reduce((total, row) => total + row.hits(ranker), 0) / expected
  }

  it('is at least as good as the keyword port on the tuning set', () => {
    const tuning = rows().filter((row) => !row.heldOut)
    expect(tuning.length).toBeGreaterThan(0)
    expect(recallAt3(tuning, 'v2')).toBeGreaterThanOrEqual(recallAt3(tuning, 'v1'))
  })

  it('does not regress on a single held-out case', () => {
    const heldOut = rows().filter((row) => row.heldOut)
    expect(heldOut.length).toBeGreaterThan(0)
    for (const row of heldOut) {
      expect(row.hits('v2'), `${row.corpus} ${row.caseId}`).toBeGreaterThanOrEqual(row.hits('v1'))
    }
    expect(recallAt3(heldOut, 'v2')).toBeGreaterThanOrEqual(recallAt3(heldOut, 'v1'))
  })
})
