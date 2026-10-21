import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureDialogueRequest } from '../support/fixture-data'
import {
  buildMemoryInspect,
  createDeliveryMemoryStore,
  createDialoguePort,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DeliveryMemoryStore,
  DialogueTextSource,
} from '../../src/dialogue'
import type { CallContext, ClockPort, DialogueRequest, DialogueSegment } from '../../src/contracts'

const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

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

async function assemble(
  memory: DeliveryMemoryStore,
  request: DialogueRequest = fixtureDialogueRequest(),
): Promise<AssembledDialogueContext> {
  const capture = { view: null }
  const port = createDialoguePort({
    clock: FIXTURE_CLOCK,
    history: memory,
    textSource: capturingTextSource(capture),
  })
  const segments: DialogueSegment[] = []
  const context: CallContext = createCallContext()
  await port.generate(request, context, {
    segment: async (segment) => {
      segments.push(segment)
    },
  })
  if (capture.view === null) throw new Error('context was not assembled')
  return capture.view
}

async function commitTurn(
  memory: DeliveryMemoryStore,
  turnId: string,
  text: string,
  sessionId: string = FIXTURE_SESSION_ID,
): Promise<void> {
  await memory.commit(
    fixtureCommitDelivery({
      sessionId,
      turnId,
      segmentId: `${turnId}-seg-0`,
      textHash: `hash-${turnId}`,
      text,
    }),
  )
}

describe('M4 memory.inspect diagnostic', () => {
  it('reports admission and exclusions for a turn with admitted memory', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-1', 'The capital of France is Paris.')
    const context = await assemble(memory)
    const payload = buildMemoryInspect(context, FIXTURE_SESSION_ID, 'turn-current')

    expect(payload.turnId).toBe('turn-current')
    expect(payload.sessionId).toBe(FIXTURE_SESSION_ID)
    // One fully-delivered, receipt-bearing record is admitted as spoken.
    expect(payload.admission.admitted).toBeGreaterThan(0)
    expect(payload.admission.noteM6Confirmed).toBe('audit-only')
    expect(payload.historySource).toBe('history-port')
  })

  it('never emits memory or persona text in the redacted payload', async () => {
    const memory = createDeliveryMemoryStore()
    await commitTurn(memory, 'turn-1', 'A memorable private detail about the listener.')
    const context = await assemble(memory)
    const payload = buildMemoryInspect(context, FIXTURE_SESSION_ID, 'turn-current')
    const serialized = JSON.stringify(payload)

    // Redaction: the memory text must not appear anywhere in the payload.
    expect(serialized).not.toContain('private detail')
    expect(serialized).not.toContain('A memorable')
    // Provenance and scores are present as structured fields, not rendered lines.
    expect(payload.admission.admitted).toBeGreaterThan(0)
  })

  it('reports recall provenance as structured fields', async () => {
    const memory = createDeliveryMemoryStore()
    // A single confirmed turn inside the session.
    await commitTurn(memory, 'turn-1', 'Paris is the capital.')
    const context = await assemble(memory)
    const payload = buildMemoryInspect(context, FIXTURE_SESSION_ID, 'turn-current')

    // Every recall result carries structured provenance, never a rendered string.
    for (const recall of payload.recall.results) {
      if (recall.provenance.kind === 'persona-fact') {
        expect(recall.provenance.factId).toBeTruthy()
      } else {
        expect(recall.provenance.sessionId).toBeTruthy()
        expect(recall.provenance.turnId).toBeTruthy()
      }
      expect(typeof recall.score).toBe('number')
    }
    expect(payload.budget.estimatedCharacters).toBeGreaterThan(0)
    expect(Array.isArray(payload.warnings)).toBe(true)
  })
})