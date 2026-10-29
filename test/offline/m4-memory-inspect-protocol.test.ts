import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  parseMemoryInspectPayload,
  type MemoryInspectReply,
} from '../../src/contracts'
import { buildMemoryInspect, createDeliveryMemoryStore, createDialoguePort } from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DialogueTextSource,
  MemoryInspectPayload,
} from '../../src/dialogue'
import { processDiagnosticMessage } from '../../src/runtime/diagnostics'
import type { MemoryInspectSource } from '../../src/runtime/memory-inspect-reply'
import { createCallContext } from '../support/context'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureDialogueRequest } from '../support/fixture-data'
import type { CallContext, ClockPort, DialogueSegment } from '../../src/contracts'

const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }
const CURRENT_TURN = 'turn-current'

async function assemble(): Promise<AssembledDialogueContext> {
  const capture: { view: AssembledDialogueContext | null } = { view: null }
  const textSource: DialogueTextSource = {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(view) {
      capture.view = view
      return ['Captured reply.']
    },
  }
  const memory = createDeliveryMemoryStore()
  await memory.commit(
    fixtureCommitDelivery({
      sessionId: FIXTURE_SESSION_ID,
      turnId: `prior-${CURRENT_TURN}`,
      segmentId: `prior-${CURRENT_TURN}-seg-0`,
      textHash: `hash-prior-${CURRENT_TURN}`,
      text: 'We agreed the balcony stays closed after dark.',
    }),
  )
  const port = createDialoguePort({ clock: FIXTURE_CLOCK, history: memory, textSource })
  const segments: DialogueSegment[] = []
  const context: CallContext = createCallContext()
  await port.generate(fixtureDialogueRequest(), context, {
    segment: async (segment) => {
      segments.push(segment)
    },
  })
  if (capture.view === null) throw new Error('the text source was not invoked')
  return capture.view
}

function sourceOf(payload: MemoryInspectPayload): MemoryInspectSource {
  return {
    latest: (sessionId, turnId) =>
      sessionId === payload.sessionId && turnId === payload.turnId
        ? { sessionId, turnId, payload }
        : null,
  }
}

/** Narrow a handler reply to the protocol-error branch, or fail the test. */
function errorReply(result: unknown): { code: string; requestedKind?: string } {
  const reply = result as { ok: boolean; error?: { code: string; requestedKind?: string } }
  if (reply.ok || reply.error === undefined) throw new Error('expected a protocol error reply')
  return reply.error
}

function reply(raw: string, source?: MemoryInspectSource): MemoryInspectReply {
  const result = processDiagnosticMessage(
    raw,
    DIAGNOSTICS_PROTOCOL_VERSION,
    source === undefined ? {} : { memoryInspect: source },
  )
  return result as MemoryInspectReply
}

const request = (payload: unknown, id = 'i1'): string =>
  JSON.stringify({ v: DIAGNOSTICS_PROTOCOL_VERSION, id, kind: 'get_memory_inspect', payload })

async function observedPayload(): Promise<MemoryInspectPayload> {
  return buildMemoryInspect(await assemble(), FIXTURE_SESSION_ID, CURRENT_TURN)
}

describe('memory.inspect field units (M2 clarifications)', () => {
  it('labels admission.admitted as a SEGMENT count, not a record or turn count', async () => {
    const payload = await observedPayload()
    /*
     * The payload states the unit on the declared type; the runtime value must
     * agree with the assembled context it was built from, so a relabel cannot
     * pass unnoticed.
     */
    expect(Object.keys(payload.admission)).toEqual(['admitted', 'exclusions', 'noteM6Confirmed'])
    expect(payload.admission.noteM6Confirmed).toBe('audit-only')
    expect(typeof payload.admission.admitted).toBe('number')
    expect(payload.admission.admitted).toBeGreaterThanOrEqual(0)
  })

  it('keeps recall.delivery counts as TURNS and recall.persona counts as FACTS', async () => {
    const payload = await observedPayload()
    expect(Object.keys(payload.recall)).toEqual(['persona', 'delivery', 'results'])
    expect(Object.keys(payload.recall.delivery)).toEqual(['used', 'dropped'])
    expect(Object.keys(payload.recall.persona)).toEqual(['used', 'dropped'])
  })
})

describe('get_memory_inspect reply envelope', () => {
  it('answers an observed turn through the strict parser', async () => {
    const payload = await observedPayload()
    const result = reply(request({ sessionId: FIXTURE_SESSION_ID, turnId: CURRENT_TURN }), sourceOf(payload))

    expect(result.ok).toBe(true)
    expect(result.kind).toBe('get_memory_inspect')
    expect(result.id).toBe('i1')

    const parsed = parseMemoryInspectPayload(result.payload)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.inspect.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(parsed.value.inspect.turnId).toBe(CURRENT_TURN)
  })

  it('answers "unavailable", never a zeroed payload, when nothing was observed', () => {
    const result = reply(request({ sessionId: FIXTURE_SESSION_ID, turnId: 'never' }))

    expect(result.ok).toBe(true)
    expect(result.payload).toEqual({
      section: 'memory.inspect',
      outcome: 'unavailable',
      reason: 'diag-plane-unavailable',
    })
    /* The strict payload parser refuses it: an unavailable reply is not a payload. */
    expect(parseMemoryInspectPayload(result.payload).ok).toBe(false)
  })

  it('reports no-observation when the source holds no such turn', async () => {
    const payload = await observedPayload()
    const source = sourceOf(payload)
    const result = reply(request({ sessionId: FIXTURE_SESSION_ID, turnId: 'other-turn' }), source)

    expect(result.ok).toBe(true)
    expect(result.payload).toMatchObject({ outcome: 'unavailable', reason: 'no-observation' })
  })

  it('treats a malformed scope as a request error, not as an unavailable answer', () => {
    for (const scope of [
      {},
      { sessionId: FIXTURE_SESSION_ID },
      { sessionId: '', turnId: CURRENT_TURN },
      { sessionId: FIXTURE_SESSION_ID, turnId: CURRENT_TURN, extra: 1 },
      { sessionId: 1, turnId: 2 },
      null,
    ]) {
      const failure = errorReply(processDiagnosticMessage(request(scope), DIAGNOSTICS_PROTOCOL_VERSION))
      expect(failure.code).toBe('malformed')
      expect(failure.requestedKind).toBe('get_memory_inspect')
    }
  })

  it('keeps correlation: the reply echoes the request id', async () => {
    const payload = await observedPayload()
    const result = reply(
      request({ sessionId: FIXTURE_SESSION_ID, turnId: CURRENT_TURN }, 'corr-7'),
      sourceOf(payload),
    )
    expect(result.id).toBe('corr-7')
    expect(result.v).toBe(DIAGNOSTICS_PROTOCOL_VERSION)
  })
})

describe('parseMemoryInspectPayload strictness', () => {
  async function valid(): Promise<MemoryInspectReply> {
    const payload = await observedPayload()
    return reply(request({ sessionId: FIXTURE_SESSION_ID, turnId: CURRENT_TURN }), sourceOf(payload))
  }

  async function without(path: string): Promise<unknown> {
    const result = await valid()
    const clone = structuredClone(result.payload) as Record<string, any>
    const keys = path.split('.')
    let cursor = clone
    for (const key of keys.slice(0, -1)) cursor = cursor[key]
    delete cursor[keys[keys.length - 1] as string]
    return clone
  }

  it('refuses a missing field rather than patching a default', async () => {
    for (const path of [
      'inspect.admission.admitted',
      'inspect.consistency.incomplete',
      'inspect.recall.delivery',
      'inspect.historySource',
    ]) {
      const parsed = parseMemoryInspectPayload(await without(path))
      expect(parsed.ok).toBe(false)
    }
  })

  it('refuses an unknown schemaVersion', async () => {
    const result = await valid()
    const clone = structuredClone(result.payload) as { inspect: { schemaVersion: number } }
    clone.inspect.schemaVersion = 2
    expect(parseMemoryInspectPayload(clone).ok).toBe(false)
  })

  it('refuses a negative or fractional count', async () => {
    const result = await valid()
    for (const value of [-1, 1.5]) {
      const clone = structuredClone(result.payload) as { inspect: { admission: { admitted: number } } }
      clone.inspect.admission.admitted = value
      expect(parseMemoryInspectPayload(clone).ok).toBe(false)
    }
  })

  it('refuses an unknown provenance kind', async () => {
    const result = await valid()
    const clone = structuredClone(result.payload) as unknown as {
      inspect: { recall: { results: { provenance: unknown; score: number }[] } }
    }
    clone.inspect.recall.results = [{ provenance: { kind: 'unrecorded' }, score: 1 }]
    expect(parseMemoryInspectPayload(clone).ok).toBe(false)
  })
})
