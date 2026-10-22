import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  CONFLICT_MARKER,
  MAX_CONSISTENCY_COMPARISONS,
  MAX_CONSISTENCY_FINDINGS,
  MAX_CONSISTENCY_STATEMENTS,
  MAX_CONSISTENCY_TEXT_UNITS,
  createDeliveryMemoryStore,
  createDialoguePort,
  renderDialoguePrompt,
  scanContradictions,
  summarizeConsistencyAudit,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  ConsistencyStatement,
  DeliveryMemoryStore,
  DialogueTextSource,
  StatementRef,
} from '../../src/dialogue'

/**
 * Consistency scan tests.
 *
 * What is being locked:
 *   - the three kinds of disagreement are DETECTED (negation, quantity,
 *     opposite attribute);
 *   - unrelated statements are NOT flagged, because a noisy detector trains an
 *     operator to ignore the audit;
 *   - the finding carries ids and counts, never statement text;
 *   - the scan changes nothing: admission, order, text and - with the marker
 *     off, which is the default - the character budget are untouched;
 *   - the scan's work is bounded, and any input that was not fully inspected is
 *     reported `incomplete` instead of being presented as a complete audit.
 */
const FIXTURE_CLOCK = { nowMs: () => 1_000 }

function turnRef(turnId: string, sessionId: string = FIXTURE_SESSION_ID): StatementRef {
  return { kind: 'turn', sessionId, turnId }
}

function factRef(factIndex: number): StatementRef {
  return { kind: 'persona-fact', factIndex }
}

function statements(pairs: readonly (readonly [StatementRef, string])[]): ConsistencyStatement[] {
  return pairs.map(([ref, text]) => ({ ref, text }))
}

/** Conflict-free statement with tokens unique to its index; yields one claim. */
function filler(index: number): ConsistencyStatement {
  return { ref: turnRef(`filler-${index}`), text: `topic${index} alpha${index} beta${index}` }
}

/** Conflict-free statement with two clauses, so it yields two claims. */
function twoClauseFiller(index: number): ConsistencyStatement {
  return {
    ref: turnRef(`pair-${index}`),
    text: `alpha${index} beta${index}。gamma${index} delta${index}`,
  }
}

function fillers(
  count: number,
  make: (index: number) => ConsistencyStatement = filler,
): ConsistencyStatement[] {
  return Array.from({ length: count }, (_, index) => make(index))
}

/** Three independent contradictions, each confined to its own statement pair. */
function threeContradictions(): ConsistencyStatement[] {
  return statements([
    [turnRef('t1'), 'I like coffee.'],
    [turnRef('t2'), 'I do not like coffee.'],
    [turnRef('t3'), '我的生日是0603。'],
    [turnRef('t4'), '我的生日是0704。'],
    [turnRef('t5'), '我喜欢猫。'],
    [turnRef('t6'), '我讨厌猫。'],
  ])
}

/**
 * N independent contradictions, one per statement pair, with unique topic
 * tokens so cross-pair comparisons cannot add extra findings. Used to exceed the
 * default findings cap without hitting a work ceiling.
 */
function independentContradictions(pairs: number): ConsistencyStatement[] {
  const out: ConsistencyStatement[] = []
  for (let index = 0; index < pairs; index += 1) {
    out.push(
      { ref: turnRef(`like-${index}`), text: `I like item${index}.` },
      { ref: turnRef(`not-like-${index}`), text: `I do not like item${index}.` },
    )
  }
  return out
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

async function assemble(
  memory: DeliveryMemoryStore,
  options: { markConflictingTurns?: boolean } = {},
): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const port = createDialoguePort({
    clock: FIXTURE_CLOCK,
    history: memory,
    textSource: capturingTextSource(capture),
    ...(options.markConflictingTurns === undefined
      ? {}
      : { markConflictingTurns: options.markConflictingTurns }),
  })
  await port.generate(fixtureDialogueRequest(), createCallContext(), { segment: async () => {} })
  if (capture.view === null) throw new Error('context was not assembled')
  return capture.view
}

describe('M4 consistency scan: detection', () => {
  it('detects a negated restatement in English', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
      ]),
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      kind: 'negation',
      evidence: 'polarity',
      left: turnRef('t1'),
      right: turnRef('t2'),
    })
    expect(result.incomplete).toBe(false)
  })

  it('detects a negated restatement in Chinese', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我喜欢这只黑猫。'],
        [turnRef('t2'), '我不喜欢这只黑猫。'],
      ]),
    })
    expect(result.findings.map((finding) => finding.kind)).toEqual(['negation'])
  })

  it('detects two different birthdays', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我的生日是0603。'],
        [turnRef('t2'), '我的生日是0704。'],
      ]),
    })
    expect(result.findings.map((finding) => [finding.kind, finding.evidence])).toEqual([
      ['quantity', 'quantity'],
    ])
  })

  it('detects opposite attributes about the same object', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我喜欢猫。'],
        [turnRef('t2'), '我讨厌猫。'],
      ]),
    })
    expect(result.findings.map((finding) => [finding.kind, finding.evidence])).toEqual([
      ['attribute', 'antonym'],
    ])
  })

  it('detects a turn contradicting a standing fact', () => {
    const result = scanContradictions({
      statements: statements([
        [factRef(0), 'Elleya is 151 cm tall.'],
        [turnRef('t1'), 'Elleya is 160 cm tall.'],
      ]),
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('quantity')
    expect(result.findings[0]?.right).toEqual(turnRef('t1'))
  })

  it('does not flag two unrelated statements', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我们明天去公园。'],
        [turnRef('t2'), '这个音乐会很吵。'],
      ]),
    })
    expect(result.findings).toEqual([])
  })

  it('does not flag two different subjects that share a predicate', () => {
    // "likes coffee" and "hates tea" are two preferences, not a disagreement.
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I hate tea.'],
      ]),
    })
    expect(result.findings).toEqual([])
  })

  it('does not flag opposite polarity about a different object', () => {
    // Sharing the predicate verb is not sharing the claim: the polarities
    // differ, but about different objects, so both can be true at once.
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like tea.'],
      ]),
    })
    expect(result.findings).toEqual([])
  })

  it('does not flag two different numbered facts', () => {
    // Both clauses carry a number and share a shape word, but they are about
    // different things: an order number is not a flight number.
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), '订单号是8821。'],
        [turnRef('t2'), '航班号是3077。'],
      ]),
    })
    expect(result.findings).toEqual([])
  })

  it('splits a multiline statement into clauses and still detects a disagreement', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'The concert was loud.\nI like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
      ]),
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('negation')
  })

  it('reads contractions with ASCII and curly apostrophes as negation', () => {
    for (const text of ["I don't like coffee.", 'I don\u2019t like coffee.']) {
      const result = scanContradictions({
        statements: statements([
          [turnRef('t1'), text],
          [turnRef('t2'), 'I like coffee.'],
        ]),
      })
      expect(result.findings.map((finding) => finding.kind)).toEqual(['negation'])
    }
  })

  it('never carries statement text, only ids and counts', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
      ]),
    })
    expect(JSON.stringify(result)).not.toContain('coffee')
    expect(JSON.stringify(summarizeConsistencyAudit(result))).not.toContain('coffee')
    expect(result.findings[0]?.sharedTokenCount).toBeGreaterThan(0)
  })

  it('is deterministic and bounded', () => {
    const input = {
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
        [turnRef('t3'), '我的生日是0603。'],
        [turnRef('t4'), '我的生日是0704。'],
      ]),
    }
    expect(scanContradictions(input)).toEqual(scanContradictions(input))
    expect(scanContradictions({ ...input, maxFindings: 1 }).findings).toHaveLength(1)
    expect(MAX_CONSISTENCY_FINDINGS).toBeGreaterThan(0)
  })
})

describe('M4 consistency scan: work ceilings', () => {
  it('visits exactly the statement ceiling without reporting incomplete', () => {
    const result = scanContradictions({ statements: fillers(MAX_CONSISTENCY_STATEMENTS) })
    expect(result.statementsVisited).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(result.statementsExamined).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(result.incomplete).toBe(false)
  })

  it('reports incomplete one statement past the ceiling and keeps prefix findings', () => {
    const result = scanContradictions({
      statements: [
        { ref: turnRef('t-like'), text: 'I like coffee.' },
        { ref: turnRef('t-not-like'), text: 'I do not like coffee.' },
        ...fillers(MAX_CONSISTENCY_STATEMENTS - 1),
      ],
    })
    // Exactly one statement over the ceiling: the two contradictions plus
    // MAX_CONSISTENCY_STATEMENTS - 1 fillers.
    expect(result.statementsOffered).toBe(MAX_CONSISTENCY_STATEMENTS + 1)
    expect(result.statementsVisited).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(result.incomplete).toBe(true)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      kind: 'negation',
      left: turnRef('t-like'),
      right: turnRef('t-not-like'),
    })
  })

  it('skips an oversized statement whole instead of truncating it', () => {
    // The prefix would contradict the small statement if the scanner cut the
    // text to fit; skipping whole means no such finding can be manufactured.
    const result = scanContradictions({
      statements: [
        { ref: turnRef('t-huge'), text: `I like coffee.${' filler'.repeat(5_000)}` },
        { ref: turnRef('t-small'), text: 'I do not like coffee.' },
      ],
    })
    expect(result.incomplete).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.statementsVisited).toBe(2)
    expect(result.statementsExamined).toBe(1)
    expect(result.textUnits).toBe('I do not like coffee.'.length)
  })

  it('charges preprocessing to the text ceiling and stops past it', () => {
    const half = 'x'.repeat(MAX_CONSISTENCY_TEXT_UNITS / 2)
    const exact = scanContradictions({
      statements: [
        { ref: turnRef('t-a'), text: half },
        { ref: turnRef('t-b'), text: half },
      ],
    })
    expect(exact.textUnits).toBe(MAX_CONSISTENCY_TEXT_UNITS)
    expect(exact.statementsExamined).toBe(2)
    expect(exact.incomplete).toBe(false)

    const over = scanContradictions({
      statements: [
        { ref: turnRef('t-a'), text: half },
        { ref: turnRef('t-b'), text: half },
        { ref: turnRef('t-c'), text: 'x' },
      ],
    })
    expect(over.textUnits).toBe(MAX_CONSISTENCY_TEXT_UNITS)
    expect(over.statementsExamined).toBe(2)
    expect(over.incomplete).toBe(true)
  })

  it('scans a long single-token statement at the text ceiling', () => {
    // Regression: the contraction branch of the negation regex used to backtrack
    // quadratically over a long word, so a single accepted-size statement took
    // ~1.5 s. Functional coverage here; the timing evidence is the benchmark
    // under test/bench.
    const exact = scanContradictions({
      statements: [{ ref: factRef(0), text: 'x'.repeat(MAX_CONSISTENCY_TEXT_UNITS) }],
    })
    expect(exact.statementsExamined).toBe(1)
    expect(exact.textUnits).toBe(MAX_CONSISTENCY_TEXT_UNITS)
    expect(exact.incomplete).toBe(false)

    const over = scanContradictions({
      statements: [
        { ref: factRef(0), text: 'x'.repeat(MAX_CONSISTENCY_TEXT_UNITS) },
        { ref: factRef(1), text: 'x'.repeat(MAX_CONSISTENCY_TEXT_UNITS) },
      ],
    })
    expect(over.statementsExamined).toBe(1)
    expect(over.incomplete).toBe(true)
  })

  it('skips a statement whole when its clauses would exceed the claim ceiling', () => {
    // Exactly the claim ceiling: 128 statements x 2 clauses = 256 claims, all
    // examined. The audit is still partial, but because of the comparison
    // ceiling, not the claim ceiling.
    const exact = scanContradictions({
      statements: fillers(MAX_CONSISTENCY_STATEMENTS, twoClauseFiller),
    })
    expect(exact.claims).toBe(256)
    expect(exact.statementsExamined).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(exact.comparisons).toBe(MAX_CONSISTENCY_COMPARISONS)
    expect(exact.incomplete).toBe(true)

    // One claim over: 254 claims, then a three-clause statement would need 257,
    // one more than the ceiling, so it is skipped whole and the count stays 254.
    const over = scanContradictions({
      statements: [
        ...fillers(127, twoClauseFiller),
        { ref: turnRef('t-three'), text: 'alpha7 beta7。gamma7 delta7。epsilon7 zeta7' },
      ],
    })
    expect(over.statementsVisited).toBe(128)
    expect(over.statementsExamined).toBe(127)
    expect(over.claims).toBe(254)
    expect(over.incomplete).toBe(true)
  })

  it('stops at the comparison ceiling and reports incomplete', () => {
    // 141 claims are the largest claim count whose full pair space (9870 pairs)
    // fits the comparison ceiling; 142 claims need 10011 and are cut off.
    const atBoundary = scanContradictions({
      statements: [...fillers(70, twoClauseFiller), filler(70)],
    })
    expect(atBoundary.claims).toBe(141)
    expect(atBoundary.comparisons).toBe(9_870)
    expect(atBoundary.incomplete).toBe(false)

    const over = scanContradictions({ statements: fillers(71, twoClauseFiller) })
    expect(over.claims).toBe(142)
    expect(over.comparisons).toBe(MAX_CONSISTENCY_COMPARISONS)
    expect(over.incomplete).toBe(true)
  })

  it('treats findings-cap early termination as incomplete', () => {
    const capped = scanContradictions({ statements: threeContradictions(), maxFindings: 1 })
    expect(capped.findings).toHaveLength(1)
    expect(capped.incomplete).toBe(true)

    // The cap can fire on the very last pair; everything was inspected, so the
    // audit stays complete rather than claiming a gap that does not exist.
    const lastPair = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
      ]),
      maxFindings: 1,
    })
    expect(lastPair.findings).toHaveLength(1)
    expect(lastPair.incomplete).toBe(false)
  })

  it('handles invalid findings budgets deterministically', () => {
    const pair = statements([
      [turnRef('t1'), 'I like coffee.'],
      [turnRef('t2'), 'I do not like coffee.'],
    ])

    for (const budget of [0, -3, 0.5]) {
      const result = scanContradictions({ statements: pair, maxFindings: budget })
      expect(result.findings).toEqual([])
      expect(result.incomplete).toBe(true)
      expect(result.statementsVisited).toBe(0)
    }

    // Non-finite budgets fall back to the default instead of removing the cap.
    // More contradictions than the default cap are supplied, so a fallback that
    // removed the cap would report all of them, and a fallback that applied it
    // reports exactly MAX_CONSISTENCY_FINDINGS and flags the audit incomplete.
    const many = independentContradictions(MAX_CONSISTENCY_FINDINGS + 1)
    for (const budget of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = scanContradictions({ statements: many, maxFindings: budget })
      expect(result.findings).toHaveLength(MAX_CONSISTENCY_FINDINGS)
      expect(result.incomplete).toBe(true)
    }

    const rounded = scanContradictions({ statements: threeContradictions(), maxFindings: 2.7 })
    expect(rounded.findings).toHaveLength(2)
    expect(rounded.incomplete).toBe(true)

    const noStatements = scanContradictions({ statements: [], maxFindings: 0 })
    expect(noStatements.incomplete).toBe(false)
  })

  it('bounds a long conflict-free history deterministically', () => {
    const long = fillers(5_000, twoClauseFiller)
    const first = scanContradictions({ statements: long })
    const second = scanContradictions({ statements: long })

    expect(first).toEqual(second)
    expect(first.statementsVisited).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(first.comparisons).toBe(MAX_CONSISTENCY_COMPARISONS)
    expect(first.incomplete).toBe(true)
  })

  it('preserves the caller order of findings', () => {
    const result = scanContradictions({
      statements: statements([
        [turnRef('t-later'), '我的生日是0704。'],
        [turnRef('t-earlier'), '我的生日是0603。'],
      ]),
    })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.left).toEqual(turnRef('t-later'))
    expect(result.findings[0]?.right).toEqual(turnRef('t-earlier'))
  })

  it('summarizes the audit with counts only', () => {
    const result = scanContradictions({
      statements: [
        { ref: turnRef('t1'), text: 'I like coffee.' },
        { ref: turnRef('t2'), text: 'I do not like coffee.' },
        ...fillers(MAX_CONSISTENCY_STATEMENTS),
      ],
    })
    const summary = summarizeConsistencyAudit(result)

    expect(summary.findings).toBe(result.findings.length)
    expect(summary.incomplete).toBe(true)
    expect(summary.statementsVisited).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(summary.statementsExamined).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(JSON.stringify(summary)).not.toContain('coffee')
  })
})

describe('M4 consistency scan: assembly integration', () => {
  async function memoryWithContradiction(): Promise<DeliveryMemoryStore> {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-a', 'I like coffee.')
    await commitTurn(memory, 'turn-b', 'I do not like coffee.')
    return memory
  }

  it('reports the finding and a warning without touching the prompt', async () => {
    const view = await assemble(await memoryWithContradiction())

    expect(view.conflicts).toHaveLength(1)
    expect(view.consistencyAudit.findings).toBe(1)
    expect(view.consistencyAudit.incomplete).toBe(false)
    expect(view.warnings.some((warning) => warning.includes('potential contradiction'))).toBe(true)
    // Default is audit-only: no marker text, and the budget is exactly the sum
    // of the rendered lines.
    expect(renderDialoguePrompt(view)).not.toContain(CONFLICT_MARKER)
    expect(view.turns.some((turn) => turn.conflicting === true)).toBe(false)
    expect(view.estimatedCharacters).toBe(
      view.turns.reduce((total, turn) => total + turn.characters, 0),
    )
  })

  it('admits both statements: the scan never picks a winner', async () => {
    const view = await assemble(await memoryWithContradiction())
    expect(view.turns.map((turn) => turn.text)).toEqual(['I like coffee.', 'I do not like coffee.'])
    expect(view.exclusions.filter((entry) => entry.reason === 'character-budget')).toEqual([])
  })

  it('marks the contested turns, and charges the marker to the budget', async () => {
    const memory = await memoryWithContradiction()
    const plain = await assemble(memory)
    const marked = await assemble(memory, { markConflictingTurns: true })

    expect(renderDialoguePrompt(marked)).toContain(CONFLICT_MARKER)
    const flagged = marked.turns.filter((turn) => turn.conflicting === true)
    expect(flagged).toHaveLength(2)
    // The marker is prompt text, so it costs characters - counted, not hidden.
    expect(marked.estimatedCharacters).toBe(
      plain.estimatedCharacters + flagged.length * CONFLICT_MARKER.length,
    )
    // The statement itself is never rewritten.
    expect(marked.turns.map((turn) => turn.text)).toEqual(plain.turns.map((turn) => turn.text))
  })

  it('keeps the character cap under the marker', async () => {
    const memory = await memoryWithContradiction()
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
      markConflictingTurns: true,
    })
    const view = await port
      .generate(
        fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 20 } }),
        createCallContext(),
        { segment: async () => {} },
      )
      .then(() => capture.view)
    if (view === null) throw new Error('context was not assembled')
    expect(view.estimatedCharacters).toBeLessThanOrEqual(20)
  })

  it('finds nothing in an unremarkable history', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-a', 'The concert was loud.')
    await commitTurn(memory, 'turn-b', 'A plain reply for today.')

    const view = await assemble(memory)
    expect(view.conflicts).toEqual([])
    expect(view.consistencyAudit.incomplete).toBe(false)
    expect(view.warnings.some((warning) => warning.includes('potential contradiction'))).toBe(false)
  })

  it('bounds the audit over a long history under a tiny prompt budget', async () => {
    const memory = createDeliveryMemoryStore()
    const offered = MAX_CONSISTENCY_STATEMENTS + 40
    for (let index = 0; index < offered; index += 1) {
      await commitTurn(memory, `turn-${index}`, filler(index).text)
    }

    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
    })
    await port.generate(
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 60 } }),
      createCallContext(),
      { segment: async () => {} },
    )
    if (capture.view === null) throw new Error('context was not assembled')
    const view = capture.view

    expect(view.consistencyAudit.incomplete).toBe(true)
    expect(view.consistencyAudit.statementsOffered).toBe(offered)
    expect(view.consistencyAudit.statementsVisited).toBe(MAX_CONSISTENCY_STATEMENTS)
    expect(
      view.warnings.some((warning) => warning.includes('consistency audit is incomplete')),
    ).toBe(true)
    // The bounded audit changes neither admission nor the character cap.
    expect(view.estimatedCharacters).toBeLessThanOrEqual(60)
    expect(view.turns.length).toBeGreaterThan(0)
    expect(renderDialoguePrompt(view)).toContain('Already said')
  })

  it('skips a huge turn whole and does not manufacture a contradiction', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-huge', `I like coffee.${' filler'.repeat(5_000)}`)
    await commitTurn(memory, 'turn-small', 'I do not like coffee.')

    const view = await assemble(memory)

    expect(view.conflicts).toEqual([])
    expect(view.consistencyAudit.incomplete).toBe(true)
    expect(view.consistencyAudit.statementsExamined).toBe(1)
    expect(
      view.warnings.some((warning) => warning.includes('consistency audit is incomplete')),
    ).toBe(true)
  })

  it('reports the findings cap as an incomplete audit', async () => {
    const memory = createDeliveryMemoryStore()
    for (let index = 0; index < MAX_CONSISTENCY_FINDINGS + 1; index += 1) {
      await commitTurn(memory, `like-${index}`, `I like item${index}.`)
      await commitTurn(memory, `not-like-${index}`, `I do not like item${index}.`)
    }

    const view = await assemble(memory)

    expect(view.conflicts).toHaveLength(MAX_CONSISTENCY_FINDINGS)
    expect(view.consistencyAudit.incomplete).toBe(true)
  })
})
