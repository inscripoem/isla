import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  CONFLICT_MARKER,
  MAX_CONSISTENCY_FINDINGS,
  createDeliveryMemoryStore,
  createDialoguePort,
  renderDialoguePrompt,
  scanContradictions,
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
 *     off, which is the default - the character budget are untouched.
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
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
      ]),
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'negation',
      evidence: 'polarity',
      left: turnRef('t1'),
      right: turnRef('t2'),
    })
  })

  it('detects a negated restatement in Chinese', () => {
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我喜欢这只黑猫。'],
        [turnRef('t2'), '我不喜欢这只黑猫。'],
      ]),
    })
    expect(findings.map((finding) => finding.kind)).toEqual(['negation'])
  })

  it('detects two different birthdays', () => {
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我的生日是0603。'],
        [turnRef('t2'), '我的生日是0704。'],
      ]),
    })
    expect(findings.map((finding) => [finding.kind, finding.evidence])).toEqual([
      ['quantity', 'quantity'],
    ])
  })

  it('detects opposite attributes about the same object', () => {
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我喜欢猫。'],
        [turnRef('t2'), '我讨厌猫。'],
      ]),
    })
    expect(findings.map((finding) => [finding.kind, finding.evidence])).toEqual([
      ['attribute', 'antonym'],
    ])
  })

  it('detects a turn contradicting a standing fact', () => {
    const findings = scanContradictions({
      statements: statements([
        [factRef(0), 'Elleya is 151 cm tall.'],
        [turnRef('t1'), 'Elleya is 160 cm tall.'],
      ]),
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('quantity')
    expect(findings[0]?.right).toEqual(turnRef('t1'))
  })

  it('does not flag two unrelated statements', () => {
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), '我们明天去公园。'],
        [turnRef('t2'), '这个音乐会很吵。'],
      ]),
    })
    expect(findings).toEqual([])
  })

  it('does not flag two different subjects that share a predicate', () => {
    // "likes coffee" and "hates tea" are two preferences, not a disagreement.
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I hate tea.'],
      ]),
    })
    expect(findings).toEqual([])
  })

  it('does not flag opposite polarity about a different object', () => {
    // Sharing the predicate verb is not sharing the claim: the polarities
    // differ, but about different objects, so both can be true at once.
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like tea.'],
      ]),
    })
    expect(findings).toEqual([])
  })

  it('does not flag two different numbered facts', () => {
    // Both clauses carry a number and share a shape word, but they are about
    // different things: an order number is not a flight number.
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), '订单号是8821。'],
        [turnRef('t2'), '航班号是3077。'],
      ]),
    })
    expect(findings).toEqual([])
  })

  it('never carries statement text, only ids and counts', () => {
    const findings = scanContradictions({
      statements: statements([
        [turnRef('t1'), 'I like coffee.'],
        [turnRef('t2'), 'I do not like coffee.'],
      ]),
    })
    expect(JSON.stringify(findings)).not.toContain('coffee')
    expect(findings[0]?.sharedTokenCount).toBeGreaterThan(0)
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
    expect(scanContradictions({ ...input, maxFindings: 1 })).toHaveLength(1)
    expect(MAX_CONSISTENCY_FINDINGS).toBeGreaterThan(0)
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
    expect(view.warnings.some((warning) => warning.includes('potential contradiction'))).toBe(false)
  })
})
