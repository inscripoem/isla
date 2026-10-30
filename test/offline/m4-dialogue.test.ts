import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectDialogueViolations } from '../conformance/dialogue.conformance'
import * as faulty from '../support/faulty-ports'
import { createCallContext, createGate } from '../support/context'
import type { CallContextHandle } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  ALLOWED_DELIVERY_PAIRS,
  CHARACTER_CONTENT,
  FIXTURE_CHARACTER_PROFILE,
  MAX_STANDING_FACT_CHARACTERS,
  MAX_STANDING_FACTS,
  PERSONA_AUTHORING_STATUS,
  PROVIDER_DIALOGUE_MODEL_VERSION,
  SPOKEN_ADMISSION,
  classifyMemoryBucket,
  collectPersonaContentIssues,
  createDeliveryMemoryStore,
  createDialoguePort,
  createIntentTextSource,
  createOpenAiCompatibleTextSource,
  deriveSegmentId,
  intentTemplatesFor,
  isAllowedDeliveryPair,
  isSubstantiveSpeech,
  isTruncatedSpeech,
  personaAuthoringIssues,
  personaVersionKey,
  renderDialoguePrompt,
  renderPersonaBlock,
  resolveCharacterProfile,
  standingFactsFromBible,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DialogueOutcomeReport,
  DialogueTextSource,
  DeliveryMemoryStore,
} from '../../src/dialogue'
import type {
  CallContext,
  ClockPort,
  DialogueEnd,
  DialoguePort,
  DialogueRequest,
  DialogueSegment,
  DialogueSink,
} from '../../src/contracts'
import { REPLY_INTENTS } from '../../src/contracts'

/** Captures the assembled context handed to a text source. */
function captureView(): { view: AssembledDialogueContext | null } {
  return { view: null }
}

/**
 * Fixture deadlines such as `atMs: 60_000` live in the injected clock's domain,
 * so every port under test must share this clock. See DialoguePortOptions.clock.
 */
const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

interface CollectedOutcome {
  segments: DialogueSegment[]
  end: DialogueEnd
}

function sinkOf(collected: DialogueSegment[]): DialogueSink {
  return {
    segment: async (segment) => {
      collected.push(segment)
    },
  }
}

async function generate(
  port: DialoguePort,
  request: DialogueRequest = fixtureDialogueRequest(),
  context: CallContext = createCallContext(),
): Promise<CollectedOutcome> {
  const segments: DialogueSegment[] = []
  const end = await port.generate(request, context, sinkOf(segments))
  return { segments, end }
}

/** A text source with fixed output, used to drive edge cases deterministically. */
function fixedTextSource(lines: readonly string[]): DialogueTextSource {
  return {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(_view, maxSegments) {
      return lines.slice(0, Math.max(0, maxSegments))
    },
  }
}

function mutableTextSource(read: () => readonly string[]): DialogueTextSource {
  return {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(_view, maxSegments) {
      return read().slice(0, Math.max(0, maxSegments))
    },
  }
}

function capturingTextSource(
  capture: { view: AssembledDialogueContext | null },
): DialogueTextSource {
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

/** A source whose compose result is re-read for each call. */
function countingTextSource(read: () => readonly string[]): DialogueTextSource {
  return {
    model: 'test-source',
    modelVersion: 'test-v1',
    resolvedModel: null,
    async compose(_view, maxSegments) {
      return read().slice(0, Math.max(0, maxSegments))
    },
  }
}

/** A sink that aborts the context synchronously on its first accepted segment. */
function abortingSink(
  collected: DialogueSegment[],
  context: CallContextHandle,
): DialogueSink {
  return {
    segment: async (segment) => {
      collected.push(segment)
      context.abort()
    },
  }
}

describe('M4 dialogue conformance', () => {
  it('satisfies every dialogue assertion with the real implementation', async () => {
    const memory = createDeliveryMemoryStore()
    const violations = await collectDialogueViolations(() => ({
      dialogue: createDialoguePort({ clock: FIXTURE_CLOCK,  history: memory, textSource: createIntentTextSource() }),
      commit: memory,
      history: memory,
    }))
    expect(violations).toEqual([])
  })

  it('rejects inconsistent and mutable dialogue output', async () => {
    const violations = await collectDialogueViolations(() => ({
      dialogue: faulty.createFaultyDialoguePort(),
      commit: createDeliveryMemoryStore(),
    }))
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('dialogue-valid')
    expect(codes).toContain('dialogue-immutable')
  })

  it('rejects punctuation-only output treated as substantive', async () => {
    const violations = await collectDialogueViolations(() => ({
      dialogue: faulty.createFaultyPunctuationDialoguePort(),
      commit: createDeliveryMemoryStore(),
    }))
    expect(violations.map((violation) => violation.code)).toContain('dialogue-substantive')
  })
})

describe('M4 generation invariants', () => {
  it('drops punctuation-only text before it reaches the sink', async () => {
    const port = createDialoguePort({ clock: FIXTURE_CLOCK,  textSource: fixedTextSource(['...', '!?']) })
    const outcome = await generate(port)
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('completed')
    expect(outcome.end.segmentCount).toBe(0)
  })

  it('reports cancelled with no segments when stopped before the first segment', async () => {
    const context = createCallContext()
    context.abort()
    const outcome = await generate(createDialoguePort({ clock: FIXTURE_CLOCK, textSource: createIntentTextSource() }), fixtureDialogueRequest(), context)
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('cancelled')
    expect(outcome.end.segmentCount).toBe(0)
    expect(outcome.end.usage.status).toBe('cancelled')
  })

  it('keeps already emitted segments when stopped midway', async () => {
    const context = createCallContext()
    const segments: DialogueSegment[] = []
    const end = await createDialoguePort({ clock: FIXTURE_CLOCK, textSource: createIntentTextSource() }).generate(fixtureDialogueRequest(), context, {
      segment: async (segment) => {
        segments.push(segment)
        context.abort()
      },
    })
    expect(segments).toHaveLength(1)
    expect(end.status).toBe('cancelled')
    expect(end.segmentCount).toBe(1)
  })

  it('treats a passed deadline as a deadline_exceeded timeout and stops generating', async () => {
    const port = createDialoguePort({ clock: { nowMs: () => 10_000 }, textSource: createIntentTextSource() })
    const outcome = await generate(port, fixtureDialogueRequest(), createCallContext(5_000))
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('deadline_exceeded')
    expect(outcome.end.usage.status).toBe('timeout')
  })

  it('treats a deadline exactly at the clock time as expired (>= boundary)', async () => {
    const port = createDialoguePort({ clock: { nowMs: () => 5_000 }, textSource: createIntentTextSource() })
    const outcome = await generate(port, fixtureDialogueRequest(), createCallContext(5_000))
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('deadline_exceeded')
  })

  it('does not emit a segment when the deadline elapses during an awaited step', async () => {
    const gate = createGate()
    const source: DialogueTextSource = {
      model: 'test-source',
      modelVersion: 'test-v1',
      resolvedModel: null,
      async compose(_view) {
        await gate.promise
        return ['late reply one', 'late reply two']
      },
    }
    // Clock starts under the deadline, then passes it while compose is awaited.
    let now = 4_000
    const port = createDialoguePort({ clock: { nowMs: () => now }, textSource: source })
    const context = createCallContext(5_000)
    const segments: DialogueSegment[] = []
    const pending = port.generate(fixtureDialogueRequest(), context, sinkOf(segments))
    now = 6_000
    gate.release()
    const end = await pending
    expect(segments).toHaveLength(0)
    expect(end.status).toBe('deadline_exceeded')
    expect(end.usage.status).toBe('timeout')
  })

  it('reports generated vs emitted vs discarded on a completed call', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: countingTextSource(() => ['one', '...', 'three']),
      onOutcome: (report) => reports.push(report),
    })
    const outcome = await generate(port)
    expect(outcome.segments).toHaveLength(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      generated: 2,
      emitted: 1,
      discarded: 1,
      discards: { 'no-speech': 1 },
      endStatus: 'completed',
      usageStatus: 'ok',
    })
    expect(reports[0]?.requestId).toBe(fixtureDialogueRequest().requestId)
  })

  it('reports a stop that arrives during a sink write and keeps the emitted segment', async () => {
    const segments: DialogueSegment[] = []
    const context = createCallContext()
    const reports: DialogueOutcomeReport[] = []
    const portGated = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: fixedTextSource(['one', 'two', 'three']),
      onOutcome: (report) => reports.push(report),
    })
    // The sink aborts synchronously after the first accepted segment, so the
    // post-await re-check sees a Stop and must not emit the next segment.
    const end = await portGated.generate(
      fixtureDialogueRequest(),
      context,
      abortingSink(segments, context),
    )
    expect(end.status).toBe('cancelled')
    expect(segments).toHaveLength(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ generated: 2, discarded: 1, endStatus: 'cancelled' })
    // The first segment was already counted as emitted before the re-check.
    expect(reports[0]?.emitted).toBe(1)
  })

  it('never changes finalized text for a reused segment identity', async () => {
    let lines: readonly string[] = ['Original reply.']
    const port = createDialoguePort({ clock: FIXTURE_CLOCK,  textSource: mutableTextSource(() => lines) })
    const first = await generate(port)
    const second = await generate(port)
    expect(second.segments.map((segment) => segment.segmentId)).toEqual(
      first.segments.map((segment) => segment.segmentId),
    )
    expect(second.segments.map((segment) => segment.text)).toEqual(
      first.segments.map((segment) => segment.text),
    )

    lines = ['A completely different reply.']
    const third = await generate(port)
    expect(third.segments[0]?.text).toBe(first.segments[0]?.text)
  })

  it('emits at most two segments per turn', async () => {
    const port = createDialoguePort({ clock: FIXTURE_CLOCK,  textSource: fixedTextSource(['one', 'two', 'three']) })
    const outcome = await generate(port)
    expect(outcome.segments).toHaveLength(2)
    expect(outcome.segments.map((segment) => segment.index)).toEqual([0, 1])
    expect(outcome.end.segmentCount).toBe(2)
  })

  it('fails generation for an unknown character profile', async () => {
    const outcome = await generate(
      createDialoguePort({ clock: FIXTURE_CLOCK, textSource: createIntentTextSource() }),
      fixtureDialogueRequest({
        characterProfileId: 'character-unknown',
        characterProfileVersion: '9',
      }),
    )
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('failed')
    expect(outcome.end.usage.status).toBe('failed')
  })

  it('produces substantive text for every reply intent', async () => {
    for (const intent of REPLY_INTENTS) {
      const plan = fixtureDialogueRequest().responsePlan
      const outcome = await generate(
        createDialoguePort({ clock: FIXTURE_CLOCK, textSource: createIntentTextSource() }),
        fixtureDialogueRequest({ responsePlan: { ...plan, replyIntent: intent } }),
      )
      expect(outcome.segments.length).toBeGreaterThan(0)
      expect(isSubstantiveSpeech(outcome.segments[0]?.text ?? '')).toBe(true)
    }
  })

  it('derives a stable segment identity from the turn and position', () => {
    const request = fixtureDialogueRequest()
    expect(deriveSegmentId(request, 0)).toBe(deriveSegmentId(request, 0))
    expect(deriveSegmentId(request, 0)).not.toBe(deriveSegmentId(request, 1))
  })

  it('classifies text with letters or digits as speech', () => {
    expect(isSubstantiveSpeech('Hello there.')).toBe(true)
    expect(isSubstantiveSpeech('...')).toBe(false)
    expect(isSubstantiveSpeech('  ')).toBe(false)
  })
})

describe('M4 delivery memory', () => {
  it('keeps generated text out of spoken history until delivery is confirmed', async () => {
    const memory = createDeliveryMemoryStore()
    const outcome = await generate(createDialoguePort({ clock: FIXTURE_CLOCK,  history: memory, textSource: createIntentTextSource() }))
    expect(outcome.segments.length).toBeGreaterThan(0)
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)

    const segment = outcome.segments[0]
    const ack = await memory.commit(
      fixtureCommitDelivery({
        segmentId: segment?.segmentId ?? '',
        text: segment?.text ?? '',
        textHash: 'hash-confirmed',
      }),
    )
    expect(ack.status).toBe('applied')

    const partial = await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-partial',
        segmentId: 'seg-partial',
        textHash: 'hash-partial',
        text: 'half a sentence',
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
      }),
    )
    expect(partial.status).toBe('applied')

    const history = await memory.confirmedHistory(FIXTURE_SESSION_ID)
    expect(history).toHaveLength(1)
    expect(history.every((record) => record.classification === 'fully-delivered')).toBe(true)
    expect(history[0]?.text).toBe(segment?.text)
  })

  it('is idempotent and never overwrites a contradicted record', async () => {
    const memory = createDeliveryMemoryStore()
    const delivery = fixtureCommitDelivery()
    expect((await memory.commit(delivery)).status).toBe('applied')
    expect((await memory.commit(delivery)).status).toBe('duplicate')

    const conflict = await memory.commit(
      fixtureCommitDelivery({ classification: 'not-delivered', terminalOutcome: 'failed' }),
    )
    expect(conflict.status).toBe('conflict')
    expect(memory.records()).toHaveLength(1)
    expect(memory.records()[0]?.classification).toBe('fully-delivered')
  })

  it('treats a changed text hash as a conflict', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(fixtureCommitDelivery({ textHash: 'hash-1' }))
    const ack = await memory.commit(fixtureCommitDelivery({ textHash: 'hash-2' }))
    expect(ack.status).toBe('conflict')
  })

  /*
   * Hard-fail policy: an incoherent classification/outcome pair is rejected and
   * nothing is stored. To relax this, change DELIVERY_PAIR_POLICY or
   * ALLOWED_DELIVERY_PAIRS in src/dialogue/memory-commit.ts.
   */
  it('rejects an inconsistent classification and outcome pair', async () => {
    const memory = createDeliveryMemoryStore()
    const ack = await memory.commit(
      fixtureCommitDelivery({ classification: 'fully-delivered', terminalOutcome: 'failed' }),
    )
    expect(ack).toMatchObject({ status: 'failed', reasonCode: 'invalid-delivery-pair' })
    expect(memory.records()).toHaveLength(0)
  })

  /*
   * Playback that started and then failed is a legitimate partial delivery: C6
   * permits it and M5 produces it. Rejecting it would leave M6 holding a delivery
   * M4 refused, and a composed session would degrade for a valid outcome.
   */
  it('accepts a partial delivery that failed after playback started', async () => {
    const memory = createDeliveryMemoryStore()
    const ack = await memory.commit(
      fixtureCommitDelivery({
        segmentId: 'seg-failed',
        textHash: 'hash-failed',
        text: 'half a sentence',
        classification: 'partial-unknown',
        terminalOutcome: 'failed',
      }),
    )
    expect(ack.status).toBe('applied')

    // Accepted for audit only. It still never becomes something she "said",
    // because admission requires fully-delivered.
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(memory.records()).toHaveLength(1)
  })

  /*
   * The store is the only thing allowed to decide what a record means, so nothing
   * outside it may keep a handle on one. Without the isolation boundary, mutating a
   * partial delivery after commit made it appear in spoken history with no second
   * commit.
   */
  it('isolates committed records from later caller mutation', async () => {
    const memory = createDeliveryMemoryStore()
    const delivery = fixtureCommitDelivery({
      segmentId: 'seg-mutable',
      textHash: 'hash-mutable',
      text: 'half a sentence',
      classification: 'partial-unknown',
      terminalOutcome: 'cancelled',
    })
    await memory.commit(delivery)

    delivery.classification = 'fully-delivered'
    delivery.text = 'a completely different line'
    delivery.receiptId = 'receipt-invented'

    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(memory.records()[0]?.classification).toBe('partial-unknown')
    expect(memory.records()[0]?.text).toBe('half a sentence')

    // A returned view is a copy too, so editing it cannot reach stored state.
    const view = memory.records()
    const first = view[0]
    if (first !== undefined) first.classification = 'not-delivered'
    expect(memory.records()[0]?.classification).toBe('partial-unknown')
    expect(memory.audit()[0]?.delivery.text).toBe('half a sentence')
  })

  it('defines a pairing rule for every delivery classification', () => {
    expect(Object.keys(ALLOWED_DELIVERY_PAIRS).sort()).toEqual([
      'fully-delivered',
      'not-delivered',
      'partial-unknown',
    ])
    expect(isAllowedDeliveryPair('fully-delivered', 'completed')).toBe(true)
    expect(isAllowedDeliveryPair('fully-delivered', 'failed')).toBe(false)
    expect(isAllowedDeliveryPair('partial-unknown', 'failed')).toBe(true)
    // Permitted is not the same as admitted: the pair stays audit-only.
    expect(SPOKEN_ADMISSION['partial-unknown']).toBe('audit-only')
  })
})

describe('M4 context assembly', () => {
  async function seedHistory(memory: DeliveryMemoryStore): Promise<void> {
    for (const turnId of ['turn-a', 'turn-b', 'turn-c']) {
      await memory.commit(
        fixtureCommitDelivery({ turnId, segmentId: 'seg-0', textHash: `hash-${turnId}` }),
      )
    }
  }

  it('bounds context by the configured turn limit', async () => {
    const memory = createDeliveryMemoryStore()
    await seedHistory(memory)

    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({ clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
    })
    await generate(
      port,
      fixtureDialogueRequest({ contextLimits: { maxTurns: 2, maxCharacters: 2000 } }),
    )

    const view = capture.view
    expect(view).not.toBeNull()
    expect(view?.history).toHaveLength(2)
    expect(view?.history[1]?.turnId).toBe('turn-c')
    expect(view?.truncatedByTurnLimit).toBe(true)
    expect(view?.estimatedCharacters).toBeGreaterThan(0)
  })

  it('reports no history when nothing has been confirmed as spoken', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
      }),
    )
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(memory.records()).toHaveLength(1)
  })
})

describe('M4 persona recall seam', () => {
  it('recalls nothing by default, leaving the prompt unchanged', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({ clock: FIXTURE_CLOCK,
      textSource: capturingTextSource(capture),
    })
    await generate(port, fixtureDialogueRequest())

    const view = capture.view
    expect(view).not.toBeNull()
    expect(view?.recalledFacts).toEqual([])
    expect(renderDialoguePrompt(view as AssembledDialogueContext)).not.toContain(
      'Relevant background:',
    )
  })

  it('renders recalled facts with their bible provenance when enabled', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const port = createDialoguePort({ clock: FIXTURE_CLOCK,
      textSource: capturingTextSource(capture),
      personaRecall: {
        recall: () => [
          { fact: { id: 'likes-purple', text: 'She likes purple-red.', keywords: ['purple'] }, score: 3 },
        ],
      },
    })
    await generate(port, fixtureDialogueRequest())

    const view = capture.view as AssembledDialogueContext
    expect(view.recalledFacts).toHaveLength(1)
    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('Relevant background:')
    expect(prompt).toContain('(bible: likes-purple)')
  })

  it('charges recalled facts against the same character budget as history', async () => {
    const memory = createDeliveryMemoryStore()
    for (const turnId of ['turn-a', 'turn-b', 'turn-c']) {
      await memory.commit(
        fixtureCommitDelivery({ turnId, segmentId: 'seg-0', textHash: `hash-${turnId}` }),
      )
    }

    async function historyTurns(recalledLength: number): Promise<number> {
      const capture: { view: AssembledDialogueContext | null } = { view: null }
      const port = createDialoguePort({ clock: FIXTURE_CLOCK,
        history: memory,
        textSource: capturingTextSource(capture),
        personaRecall: {
          recall: () => [
            { fact: { id: 'big', text: 'x'.repeat(recalledLength), keywords: [] }, score: 1 },
          ],
        },
      })
      await generate(
        port,
        fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 200 } }),
      )
      return capture.view?.turns.length ?? -1
    }

    // More recalled characters must leave less room for confirmed history.
    expect(await historyTurns(0)).toBeGreaterThan(await historyTurns(150))
  })
})

describe('M4 memory semantics', () => {
  it('admits a delivered audio segment that carries a receipt', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(fixtureCommitDelivery())

    const history = await memory.confirmedHistory(FIXTURE_SESSION_ID)
    expect(history).toHaveLength(1)
    expect(history[0] === undefined ? null : classifyMemoryBucket(history[0])).toMatchObject({
      bucket: 'spoken',
    })
  })

  it('keeps a delivered audio segment without a receipt out of spoken history', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(fixtureCommitDelivery({ receiptId: null, textHash: 'hash-noreceipt' }))

    // A delivery claim with no playback evidence is held back, but not thrown
    // away: the record stays auditable.
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(memory.records()).toHaveLength(1)
  })

  it('never admits partial or undelivered text', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        segmentId: 'seg-partial',
        textHash: 'hash-partial',
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
      }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        segmentId: 'seg-none',
        textHash: 'hash-none',
        classification: 'not-delivered',
        terminalOutcome: 'failed',
      }),
    )

    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(memory.records()).toHaveLength(2)
    expect(SPOKEN_ADMISSION['partial-unknown']).toBe('audit-only')
    expect(SPOKEN_ADMISSION['not-delivered']).toBe('audit-only')
  })

  it('detects an utterance that stops mid-sentence', () => {
    expect(isTruncatedSpeech('We were just about to sa')).toBe(true)
    expect(isTruncatedSpeech('We talked about the concert.')).toBe(false)
    expect(isTruncatedSpeech('He said "hello."')).toBe(false)
  })
})

describe('M4 context continuity', () => {
  it('marks an interrupted turn instead of presenting it as complete', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-cut',
        segmentId: 'seg-0',
        textHash: 'hash-cut',
        text: 'We were just about to sa',
      }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    // The words were delivered, so they stay in context — but they are marked.
    // Without the marker a model reads a fragment as a finished statement and
    // continues from a sentence the audience never heard completed.
    expect(capture.view?.turns).toHaveLength(1)
    expect(capture.view?.turns[0]?.interrupted).toBe(true)
    expect(capture.view === null ? '' : renderDialoguePrompt(capture.view)).toContain(
      '[cut off mid-sentence]',
    )
  })

  it('keeps one entry per utterance when a segment is confirmed for two modalities', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({ turnId: 'turn-d', segmentId: 'seg-0', textHash: 'hash-d' }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-d',
        segmentId: 'seg-0',
        textHash: 'hash-d',
        modality: 'subtitle',
      }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    expect(capture.view?.history).toHaveLength(1)
    expect(capture.view?.exclusions.some((entry) => entry.reason === 'duplicate-modality')).toBe(
      true,
    )
  })

  it('drops memory from an older persona before current-persona memory', async () => {
    const memory = createDeliveryMemoryStore()
    // Attribution comes from each record's persisted persona fields, so the
    // fixtures supply explicit durable pairs.
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-old',
        segmentId: 'seg-0',
        textHash: 'hash-old',
        text: 'Old persona line.',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '0',
      }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-new',
        segmentId: 'seg-0',
        textHash: 'hash-new',
        text: 'Current persona line.',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '1',
      }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    await generate(
      port,
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 25 } }),
    )

    // Both turns were heard and both fit individually; only the budget forces a
    // choice. Speech from a superseded persona gives way first, and the newest turn
    // survives because it is the one that still fits.
    expect(capture.view?.turns.map((turn) => turn.turnId)).toEqual(['turn-new'])
    expect(
      capture.view?.exclusions.some((entry) => entry.reason === 'trim-stale-persona'),
    ).toBe(true)
    expect(capture.view?.truncatedByCharacterLimit).toBe(true)
  })

  it('derives persona attribution only from the persisted delivery fields', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-known',
        segmentId: 'seg-known',
        textHash: 'hash-known',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '1',
      }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-unknown',
        segmentId: 'seg-unknown',
        textHash: 'hash-unknown',
        personaProfileId: null,
        personaProfileVersion: null,
      }),
    )

    const audit = memory.audit()
    expect(audit.find((entry) => entry.delivery.turnId === 'turn-known')?.personaVersion).toBe(
      personaVersionKey('character-fixture', '1'),
    )
    // An all-null persisted pair stays unknown and is never invented.
    expect(
      audit.find((entry) => entry.delivery.turnId === 'turn-unknown')?.personaVersion,
    ).toBeNull()
  })
})

describe('M4 persona authoring', () => {
  it('exposes a template slot for every reply intent', () => {
    expect(Object.keys(CHARACTER_CONTENT.intentTemplates).sort()).toEqual(
      [...REPLY_INTENTS].sort(),
    )
  })

  it('reports what is still missing from the authored persona', () => {
    const issues = personaAuthoringIssues()
    // A draft is allowed to be incomplete and must not turn the suite red; a
    // persona marked ready must be clean.
    if (PERSONA_AUTHORING_STATUS === 'ready') {
      expect(issues).toEqual([])
    } else {
      expect(issues.length).toBeGreaterThan(0)
    }
  })

  it('resolves the authored persona without rewriting its words', () => {
    const profile = resolveCharacterProfile(
      CHARACTER_CONTENT.profileId,
      CHARACTER_CONTENT.version,
    )
    expect(profile?.origin).toBe('author')
    expect(
      profile === null ? [] : intentTemplatesFor(profile, 'answer'),
    ).toEqual(CHARACTER_CONTENT.intentTemplates.answer)
  })

  it('renders a persona block without inventing sections', () => {
    const block = renderPersonaBlock(FIXTURE_CHARACTER_PROFILE)
    expect(block.startsWith('Persona:')).toBe(true)
    expect(block).toContain('Style:')
    // The fixture profile declares neither boundaries nor standing facts, so
    // neither section is rendered.
    expect(block).not.toContain('Never:')
    expect(block).not.toContain('Always true:')
  })

  it('caps the standing facts that reach every turn', () => {
    const overFull = {
      ...CHARACTER_CONTENT,
      standingFacts: Array.from(
        { length: MAX_STANDING_FACTS + 1 },
        (_unused, index) => `Fact number ${index}.`,
      ),
    }
    expect(
      collectPersonaContentIssues(overFull).some((issue) => issue.includes('at most')),
    ).toBe(true)

    const withinCap = { ...CHARACTER_CONTENT, standingFacts: ['She is a witch.'] }
    expect(
      collectPersonaContentIssues(withinCap).some((issue) => issue.includes('at most')),
    ).toBe(false)
  })

  it('rejects a standing fact that is too long for a per-turn block', () => {
    const verbose = { ...CHARACTER_CONTENT, standingFacts: ['x'.repeat(200)] }
    expect(
      collectPersonaContentIssues(verbose).some((issue) => issue.includes('characters')),
    ).toBe(true)
  })

  it('points at a character bible that still exists', () => {
    // The long-form persona lives outside this file; if it is renamed or moved,
    // the persona silently loses its source. This keeps the link honest.
    expect(CHARACTER_CONTENT.sourceDocument.length).toBeGreaterThan(0)
    const bible = fileURLToPath(
      new URL(`../../${CHARACTER_CONTENT.sourceDocument}`, import.meta.url),
    )
    expect(existsSync(bible)).toBe(true)
  })

  it('keeps the [S] lines in the bible identical to the standing facts', () => {
    // The bible and standingFacts are two copies of the same claims, and only
    // the latter reaches the model. Without this check a divergence would make
    // the bible silently stale — reviewers would read claims the character no
    // longer holds. Marking is what turns that into a build failure.
    const biblePath = fileURLToPath(
      new URL(`../../${CHARACTER_CONTENT.sourceDocument}`, import.meta.url),
    )
    const marked = standingFactsFromBible(readFileSync(biblePath, 'utf8'))
    expect(marked.length).toBeGreaterThan(0)
    expect([...marked].sort()).toEqual([...CHARACTER_CONTENT.standingFacts].sort())
  })

  it('keeps every standing fact within the per-turn character cap', () => {
    for (const fact of CHARACTER_CONTENT.standingFacts) {
      expect(fact.length).toBeLessThanOrEqual(MAX_STANDING_FACT_CHARACTERS)
    }
  })

  it('speaks nothing when the persona has no template for the intent', () => {
    const silent = resolveCharacterProfile('silent', '1', [
      {
        profileId: 'silent',
        version: '1',
        personaSummary: 'Says nothing.',
        styleNotes: [],
        origin: 'harness',
      },
    ])
    expect(silent === null ? null : intentTemplatesFor(silent, 'answer')).toEqual([])
  })
})

describe('M4 session isolation', () => {
  /*
   * M5's turn counter is local to each session, so turn ids repeat. One dialogue
   * instance therefore has to keep the sessions apart in all three places it holds
   * state: the finalized-text registry, the delivery record key and the
   * turn-to-persona mapping.
   */
  it('does not let one session inherit another session state', async () => {
    const memory = createDeliveryMemoryStore()
    let lines: readonly string[] = ['First session line.']
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: mutableTextSource(() => lines),
    })

    const first = await generate(
      port,
      fixtureDialogueRequest({ sessionId: 'session-one', turnId: 'turn-1' }),
    )
    lines = ['Second session line.']
    const second = await generate(
      port,
      fixtureDialogueRequest({ sessionId: 'session-two', turnId: 'turn-1' }),
    )

    expect(first.segments[0]?.text).toBe('First session line.')
    expect(second.segments[0]?.text).toBe('Second session line.')
    expect(second.segments[0]?.segmentId).not.toBe(first.segments[0]?.segmentId)

    // The same local turn id under two sessions is two deliveries, not a conflict.
    const ackOne = await memory.commit(
      fixtureCommitDelivery({
        sessionId: 'session-one',
        turnId: 'turn-1',
        segmentId: 'seg-0',
        textHash: 'hash-one',
        text: 'First session line.',
      }),
    )
    const ackTwo = await memory.commit(
      fixtureCommitDelivery({
        sessionId: 'session-two',
        turnId: 'turn-1',
        segmentId: 'seg-0',
        textHash: 'hash-two',
        text: 'Second session line.',
      }),
    )
    expect(ackOne.status).toBe('applied')
    expect(ackTwo.status).toBe('applied')

    expect(await memory.confirmedHistory('session-one')).toHaveLength(1)
    expect(await memory.confirmedHistory('session-two')).toHaveLength(1)
  })

  it('keeps persisted persona attribution apart per session', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: 'session-one',
        turnId: 'turn-1',
        segmentId: 'seg-0',
        textHash: 'hash-one',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '1',
      }),
    )
    await memory.commit(
      fixtureCommitDelivery({
        sessionId: 'session-two',
        turnId: 'turn-1',
        segmentId: 'seg-0',
        textHash: 'hash-two',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '0',
      }),
    )

    const entriesOne = await memory.memoryEntries('session-one')
    const entriesTwo = await memory.memoryEntries('session-two')
    expect(entriesOne).toHaveLength(1)
    expect(entriesTwo).toHaveLength(1)
    // The same local turn id under two sessions keeps its own persisted persona.
    expect(entriesOne[0]?.personaVersion).toBe(personaVersionKey('character-fixture', '1'))
    expect(entriesTwo[0]?.personaVersion).toBe(personaVersionKey('character-fixture', '0'))
  })
})

describe('M4 character budget', () => {
  it('honours a zero character budget instead of keeping one turn', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({ turnId: 'turn-a', segmentId: 'seg-0', textHash: 'hash-a' }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
    })
    await generate(
      port,
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 0 } }),
    )

    expect(capture.view?.turns).toEqual([])
    expect(capture.view?.estimatedCharacters).toBe(0)
    expect(capture.view?.truncatedByCharacterLimit).toBe(true)
    expect(
      capture.view?.warnings.some((warning) => warning.includes('newest confirmed turn')),
    ).toBe(true)
  })

  /*
   * The cap is hard, so a turn longer than the whole budget is dropped rather than
   * kept over budget. Stored evidence is untouched: only the context view shrinks.
   */
  it('drops the newest turn when it alone exceeds the character budget', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-long',
        segmentId: 'seg-0',
        textHash: 'hash-long',
        text: `${'x'.repeat(200)}.`,
      }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
    })
    await generate(
      port,
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 40 } }),
    )

    expect(capture.view?.turns).toEqual([])
    expect(capture.view?.exclusions.some((entry) => entry.reason === 'character-budget')).toBe(true)
    expect(memory.records()).toHaveLength(1)
  })

  /*
   * Recall is charged to the same budget, so it has to fit too. Warning only would
   * let recall consume the whole cap and silently starve history on every turn.
   */
  it('drops recalled facts that cannot fit the character budget', async () => {
    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: capturingTextSource(capture),
      personaRecall: {
        recall: () => [
          { fact: { id: 'small', text: 'Short.', keywords: [] }, score: 2 },
          { fact: { id: 'huge', text: 'x'.repeat(500), keywords: [] }, score: 1 },
        ],
      },
    })
    await generate(
      port,
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 60 } }),
    )

    expect(capture.view?.recalledFacts.map((entry) => entry.fact.id)).toEqual(['small'])
    expect(capture.view?.recallExclusions.map((entry) => entry.factId)).toEqual(['huge'])
    expect(
      capture.view?.warnings.some((warning) => warning.includes('recalled persona facts were dropped')),
    ).toBe(true)
  })

  it('charges the rendering prefix and the interrupted marker', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-cut',
        segmentId: 'seg-0',
        textHash: 'hash-cut',
        text: 'We were just about to sa',
      }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    const turn = capture.view?.turns[0]
    expect(turn?.interrupted).toBe(true)
    // '- ' prefix plus the text plus the marker, which is what the prompt contains.
    expect(turn?.characters).toBe(2 + 'We were just about to sa'.length + ' [cut off mid-sentence]'.length)
  })
})

describe('M4 history source composition', () => {
  /*
   * A local store holds only what this process has seen, so it is never a
   * substitute for the durable source. Choosing it merely because it is non-empty
   * would let one newly committed delivery replace reconstructed history.
   */
  it('treats the durable source as authoritative and does not borrow the local store', async () => {
    const durable = createDeliveryMemoryStore()
    const local = createDeliveryMemoryStore()
    for (const turnId of ['turn-1', 'turn-2']) {
      await durable.commit(
        fixtureCommitDelivery({
          turnId,
          segmentId: 'seg-0',
          textHash: `hash-${turnId}`,
          text: `${turnId} line.`,
          personaProfileId: null,
          personaProfileVersion: null,
        }),
      )
    }
    await durable.commit(
      fixtureCommitDelivery({
        turnId: 'turn-3',
        segmentId: 'seg-0',
        textHash: 'hash-turn-3',
        text: 'turn-3 line.',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '1',
      }),
    )
    // A local record with a contradictory persona for turn-3 must not influence
    // the durable record's attribution.
    await local.commit(
      fixtureCommitDelivery({
        turnId: 'turn-3',
        segmentId: 'seg-0',
        textHash: 'hash-turn-3',
        text: 'turn-3 line.',
        personaProfileId: 'character-fixture',
        personaProfileVersion: '0',
      }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: durable,
      memory: local,
      textSource: capturingTextSource(capture),
    })
    await generate(
      port,
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 2000 } }),
    )

    const view = capture.view
    expect(view?.historySource).toBe('history-port')
    // Every durable record survives; the smaller local view does not truncate it.
    expect(view?.turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    // Attribution is the durable record's own persisted pair.
    expect(view?.turns[2]?.personaVersion).toBe(personaVersionKey('character-fixture', '1'))
    expect(view?.turns[0]?.personaVersion).toBeNull()
  })

  it('does not infer a missing or partial persisted persona from local state', async () => {
    const durable = createDeliveryMemoryStore()
    const local = createDeliveryMemoryStore()
    const legacy: Array<{ turnId: string; personaProfileId: string | null; personaProfileVersion: string | null }> = [
      { turnId: 'turn-half-id', personaProfileId: 'character-fixture', personaProfileVersion: null },
      { turnId: 'turn-half-version', personaProfileId: null, personaProfileVersion: '1' },
      { turnId: 'turn-all-null', personaProfileId: null, personaProfileVersion: null },
    ]
    for (const entry of legacy) {
      await durable.commit(
        fixtureCommitDelivery({
          turnId: entry.turnId,
          segmentId: 'seg-0',
          textHash: `hash-${entry.turnId}`,
          text: `${entry.turnId} line.`,
          personaProfileId: entry.personaProfileId,
          personaProfileVersion: entry.personaProfileVersion,
        }),
      )
      // The local store has a complete, contradictory pair for the same key; it
      // must not fill in the missing durable component.
      await local.commit(
        fixtureCommitDelivery({
          turnId: entry.turnId,
          segmentId: 'seg-0',
          textHash: `hash-${entry.turnId}`,
          text: `${entry.turnId} line.`,
          personaProfileId: 'character-fixture',
          personaProfileVersion: '0',
        }),
      )
    }

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: durable,
      memory: local,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    // The three turn identities and their raw partial fields must actually be
    // present, so an empty history cannot satisfy the assertion below vacuously.
    const view = capture.view
    expect(view?.turns.map((turn) => turn.turnId)).toEqual([
      'turn-half-id',
      'turn-half-version',
      'turn-all-null',
    ])
    expect(
      view?.history.map((record) => [
        record.turnId,
        record.personaProfileId,
        record.personaProfileVersion,
      ]),
    ).toEqual([
      ['turn-half-id', 'character-fixture', null],
      ['turn-half-version', null, '1'],
      ['turn-all-null', null, null],
    ])
    // Neither a half-known pair nor an all-null pair is comparable; each stays
    // unknown rather than borrowing the local pair.
    expect(view?.turns.map((turn) => turn.personaVersion)).toEqual([null, null, null])
  })

  it('flags the in-memory store as a stand-in rather than durable history', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({ turnId: 'turn-a', segmentId: 'seg-0', textHash: 'hash-a' }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    expect(capture.view?.historySource).toBe('local-stand-in')
    expect(
      capture.view?.warnings.some((warning) => warning.includes('no durable history source')),
    ).toBe(true)
  })
})

describe('M4 coordinated attribution adoption', () => {
  it('builds a persona key that cannot collide across identity/version boundaries', () => {
    // A naive `id@version` join would make these two distinct personas equal.
    expect(personaVersionKey('a@b', 'c')).not.toBe(personaVersionKey('a', 'b@c'))
    expect(personaVersionKey('character-fixture', '1')).toBe(
      personaVersionKey('character-fixture', '1'),
    )
  })

  it('adopts persisted segmentIndex and persona in the projection and immutability checks', async () => {
    const memory = createDeliveryMemoryStore()
    const base = fixtureCommitDelivery({
      turnId: 'turn-adopt',
      segmentId: 'seg-adopt',
      textHash: 'hash-adopt',
      text: 'Adopted attribution.',
      segmentIndex: 3,
      personaProfileId: 'persona-x',
      personaProfileVersion: '9',
    })
    expect((await memory.commit(base)).status).toBe('applied')

    const [record] = await memory.confirmedHistory(FIXTURE_SESSION_ID)
    expect(record?.segmentIndex).toBe(3)
    expect(record?.personaProfileId).toBe('persona-x')
    expect(record?.personaProfileVersion).toBe('9')

    // Each attribution field is immutable identity, exactly like M6.
    expect((await memory.commit({ ...base, segmentIndex: 4 })).status).toBe('conflict')
    expect((await memory.commit({ ...base, personaProfileId: 'persona-y' })).status).toBe('conflict')
    expect((await memory.commit({ ...base, personaProfileVersion: '10' })).status).toBe('conflict')
    // The identical re-commit is still an idempotent duplicate.
    expect((await memory.commit(base)).status).toBe('duplicate')
    expect(memory.records()).toHaveLength(1)
  })

  it('orders turn segments by persisted segmentIndex, unknown last, ties in source order', async () => {
    const memory = createDeliveryMemoryStore()
    const segment = (
      segmentId: string,
      segmentIndex: number | null,
      text: string,
    ): ReturnType<typeof fixtureCommitDelivery> =>
      fixtureCommitDelivery({
        turnId: 'turn-order',
        segmentId,
        segmentIndex,
        textHash: `hash-${segmentId}`,
        text,
      })
    // Committed in an order that disagrees with the index order; unknown index
    // has no claimed position.
    await memory.commit(segment('seg-unknown', null, 'Unknown position.'))
    await memory.commit(segment('seg-two', 2, 'Second position.'))
    await memory.commit(segment('seg-zero', 0, 'First position.'))
    await memory.commit(segment('seg-two-tie', 2, 'Second position tie.'))

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    const segments = capture.view?.turns[0]?.segments ?? []
    expect(segments.map((entry) => entry.segmentId)).toEqual([
      'seg-zero',
      'seg-two',
      'seg-two-tie',
      'seg-unknown',
    ])
    expect(segments[segments.length - 1]?.segmentIndex).toBeNull()
  })

  it('does not reorder authoritative history for unresolved confirmedEventRefs', async () => {
    const memory = createDeliveryMemoryStore()
    for (const turnId of ['turn-1', 'turn-2']) {
      await memory.commit(
        fixtureCommitDelivery({
          turnId,
          segmentId: 'seg-0',
          textHash: `hash-${turnId}`,
          text: `${turnId} line.`,
        }),
      )
    }

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    // The ref would match turn-2 under the old ordering hint; an unresolved hint
    // must not move durable records.
    await generate(port, fixtureDialogueRequest({ confirmedEventRefs: ['turn-2'] }))

    expect(capture.view?.turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(
      capture.view?.warnings.some((warning) => warning.includes('confirmedEventRefs')),
    ).toBe(true)
  })

  it('excludes the persona prompt block from the history and recall budget', async () => {
    const memory = createDeliveryMemoryStore()
    await memory.commit(
      fixtureCommitDelivery({ turnId: 'turn-budget', segmentId: 'seg-0', textHash: 'hash-b' }),
    )

    const capture = captureView()
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      history: memory,
      textSource: capturingTextSource(capture),
    })
    await generate(port)

    const view = capture.view
    expect(view).not.toBeNull()
    const chargedHistory = (view?.turns ?? []).reduce((total, turn) => total + turn.characters, 0)
    // The persona block is nonempty but is not part of the character budget.
    expect(renderPersonaBlock(FIXTURE_CHARACTER_PROFILE).length).toBeGreaterThan(0)
    expect(view?.estimatedCharacters).toBe(chargedHistory)
  })
})

/**
 * One request as the loopback server observed it. The server is the only
 * witness to the wire format, so the fields are recorded verbatim.
 */
interface LoopbackRequest {
  method: string | undefined
  path: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  /** Parsed JSON body, or null when the body was not JSON. */
  body: unknown
  /** Raw body text, kept so a header-only assertion cannot hide a malformed payload. */
  rawBody: string
}

interface LoopbackServer {
  url: string
  close(): Promise<void>
  requests: LoopbackRequest[]
}

/** Answers one captured request. Every handler under test is deterministic. */
type LoopbackResponder = (response: ServerResponse) => void

/**
 * Starts a loopback HTTP server on an ephemeral port.
 *
 * This is the single declared substitute for the provider negative coverage: it
 * pins the OpenAI wire format M4 sends and serves controlled failure responses.
 * It stands in for no M3, M5 or M6 component; the real provider wiring belongs to
 * the composition root (issue #44 §4). The caller must always close it.
 */
async function startLoopback(responder: LoopbackResponder): Promise<LoopbackServer> {
  const requests: LoopbackRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = null
      }
      const record: LoopbackRequest = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
        rawBody,
      }
      requests.push(record)
      if (record.method === 'POST') responder(response)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      }),
  }
}

/** Returns the `messages` entries of a recorded body as plain records, or none if absent. */
function recordedEntries(body: unknown): Array<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null) return []
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
}

describe('M4 dialogue provider source (offline negatives)', () => {
  it('sends the OpenAI wire format and honours the per-call usage and served model', async () => {
    const server = await startLoopback((response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'First spoken line.\n\nSecond spoken line.' } }],
          model: 'served-model-77',
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      )
    })
    try {
      const port = createDialoguePort({
        clock: FIXTURE_CLOCK,
        textSource: createOpenAiCompatibleTextSource({
          baseUrl: server.url,
          model: 'requested-model-5',
          apiKey: 'test-key-offline',
        }),
      })
      const outcome = await generate(port, fixtureDialogueRequest(), createCallContext(5_000))

      // The request must be exactly what the chat-completions contract expects;
      // otherwise a real provider would reject a call the fixture never sees.
      expect(server.requests).toHaveLength(1)
      const recorded = server.requests[0]
      expect(recorded?.method).toBe('POST')
      expect(recorded?.path?.endsWith('/chat/completions')).toBe(true)
      expect(recorded?.authorization).toBe('Bearer test-key-offline')
      const body = recorded?.body
      if (typeof body !== 'object' || body === null) throw new Error('request body is not JSON')
      const payload = body as Record<string, unknown>
      expect(typeof payload.model).toBe('string')
      expect(payload.stream).toBe(false)
      const messages = recordedEntries(body)
      expect(messages.length).toBeGreaterThan(0)
      // Both roles are present: the instruction and the assembled dialogue prompt.
      const roles = messages.map((entry) => String(entry.role))
      expect(roles).toContain('system')
      expect(roles).toContain('user')

      // Two lines survive as two candidates, and only the spoken ones reach the sink.
      expect(outcome.segments).toHaveLength(2)
      expect(outcome.end.status).toBe('completed')
      expect(outcome.end.usage.inputTokens).toBe(11)
      expect(outcome.end.usage.outputTokens).toBe(7)
      expect(outcome.end.usage.usageMissing).toBe(false)
      // The served identity is the per-call value, which differs from the request.
      expect(outcome.end.usage.resolvedModel).toBe('served-model-77')
      expect(outcome.end.usage.requestedModel).toBe('requested-model-5')
      for (const segment of outcome.segments) {
        expect(segment.model).toBe('requested-model-5')
        expect(segment.modelVersion).toBe(PROVIDER_DIALOGUE_MODEL_VERSION)
      }
    } finally {
      await server.close()
    }
  })

  it('fails visibly without a configured source instead of serving fixture text', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      onOutcome: (report) => reports.push(report),
    })
    const segments: DialogueSegment[] = []

    // The no-fallback default (issue #44 §2.4) must reject, not complete with
    // substitute text, and the message must name the missing configuration.
    const failure: unknown = await port
      .generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf(segments))
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ''
    expect(message).toMatch(/not configured|missing/i)
    expect(message).toContain('textSource')
    // The rejection names the configuration boundary, never the fixture source.
    expect(message.toLowerCase()).not.toContain('fixture')

    expect(segments).toHaveLength(0)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'failed',
      usageStatus: 'failed',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('rejects a blank apiKey before any request reaches the wire', async () => {
    const server = await startLoopback((response) => {
      // A valid completion would be served if the source ever got here; it must not.
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'Should never be spoken.' } }],
          model: 'served-model-77',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      )
    })
    try {
      const reports: DialogueOutcomeReport[] = []
      const port = createDialoguePort({
        clock: FIXTURE_CLOCK,
        textSource: createOpenAiCompatibleTextSource({
          baseUrl: server.url,
          model: 'm',
          apiKey: '   ',
        }),
        onOutcome: (report) => reports.push(report),
      })
      const segments: DialogueSegment[] = []

      const failure: unknown = await port
        .generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf(segments))
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(Error)
      const message = failure instanceof Error ? failure.message : ''
      expect(message).toMatch(/apiKey/i)

      // A blank key is a configuration fault, so the provider never sees a request.
      expect(server.requests).toHaveLength(0)
      expect(segments).toHaveLength(0)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ endStatus: 'failed', usageStatus: 'failed' })

      // The message names the missing key without echoing a credential-shaped value.
      expect(message).not.toMatch(/Bearer|sk-[A-Za-z0-9]|test-key-offline/)
    } finally {
      await server.close()
    }
  })

  it('fails honestly on an HTTP error response without echoing its body (bad response 1)', async () => {
    const server = await startLoopback((response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'backend exploded' } }))
    })
    try {
      const reports: DialogueOutcomeReport[] = []
      const port = createDialoguePort({
        clock: FIXTURE_CLOCK,
        textSource: createOpenAiCompatibleTextSource({
          baseUrl: server.url,
          model: 'requested-model-5',
          apiKey: 'test-key-offline',
        }),
        onOutcome: (report) => reports.push(report),
      })
      const segments: DialogueSegment[] = []
      const failure: unknown = await port
        .generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf(segments))
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(Error)
      const message = failure instanceof Error ? failure.message : ''
      // The fault names the status, never the provider's body.
      expect(message).toContain('500')
      expect(message).not.toContain('backend exploded')
      expect(message.toLowerCase()).not.toContain('fixture')

      expect(server.requests).toHaveLength(1)
      expect(segments).toHaveLength(0)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        endStatus: 'failed',
        usageStatus: 'failed',
        generated: 0,
        emitted: 0,
        discarded: 0,
      })
    } finally {
      await server.close()
    }
  })

  it('fails honestly on a non-JSON response body (bad response 2)', async () => {
    const server = await startLoopback((response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('not-json-at-all')
    })
    try {
      const reports: DialogueOutcomeReport[] = []
      const port = createDialoguePort({
        clock: FIXTURE_CLOCK,
        textSource: createOpenAiCompatibleTextSource({
          baseUrl: server.url,
          model: 'requested-model-5',
          apiKey: 'test-key-offline',
        }),
        onOutcome: (report) => reports.push(report),
      })
      const segments: DialogueSegment[] = []
      const failure: unknown = await port
        .generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf(segments))
        .then(
          () => null,
          (error: unknown) => error,
        )
      expect(failure).toBeInstanceOf(Error)
      const message = failure instanceof Error ? failure.message : ''
      expect(message).toMatch(/JSON/i)
      // A malformed body is never echoed back into the error message.
      expect(message).not.toContain('not-json-at-all')
      expect(message.toLowerCase()).not.toContain('fixture')

      expect(server.requests).toHaveLength(1)
      expect(segments).toHaveLength(0)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        endStatus: 'failed',
        usageStatus: 'failed',
        generated: 0,
        emitted: 0,
        discarded: 0,
      })
    } finally {
      await server.close()
    }
  })

  it('keeps the cancelled path when the turn is revoked during compose', async () => {
    const entered = createGate()
    const release = createGate()
    // The source ignores the signal and returns two lines anyway, so the port's
    // post-compose re-check, not the source, has to classify the call.
    const source: DialogueTextSource = {
      model: 'test-source',
      modelVersion: 'test-v1',
      resolvedModel: null,
      async compose(_view, maxSegments) {
        entered.release()
        await release.promise
        return ['first line', 'second line'].slice(0, Math.max(0, maxSegments))
      },
    }
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: source,
      onOutcome: (report) => reports.push(report),
    })
    const context = createCallContext(5_000)
    const segments: DialogueSegment[] = []
    const pending = port.generate(fixtureDialogueRequest(), context, sinkOf(segments))
    await entered.promise
    // The abort arrives while compose is still awaited, before any line exists.
    context.abort()
    release.release()
    const end = await pending

    expect(end.status).toBe('cancelled')
    expect(end.usage.status).toBe('cancelled')
    // No segment was written after the abort point.
    expect(segments).toHaveLength(0)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'cancelled',
      usageStatus: 'cancelled',
      generated: 2,
      emitted: 0,
      discarded: 2,
    })
    expect(reports[0]?.discards).toEqual({ aborted: 2 })
  })

  it('reports a provider call aborted mid-flight as cancelled, not failed', async () => {
    const context = createCallContext(5_000)
    // The handler deliberately never responds: the request stays open until the
    // client aborts it, so the abort competes with a real in-flight fetch.
    const server = await startLoopback(() => {
      context.abort()
    })
    try {
      const reports: DialogueOutcomeReport[] = []
      const port = createDialoguePort({
        clock: FIXTURE_CLOCK,
        textSource: createOpenAiCompatibleTextSource({
          baseUrl: server.url,
          model: 'requested-model-5',
          apiKey: 'test-key-offline',
        }),
        onOutcome: (report) => reports.push(report),
      })
      const segments: DialogueSegment[] = []
      const end = await port.generate(fixtureDialogueRequest(), context, sinkOf(segments))

      // The server saw the request, so the abort happened after the wire call began.
      expect(server.requests).toHaveLength(1)
      // The source returns no lines on abort; the port's re-check decides the status.
      expect(end.status).toBe('cancelled')
      expect(end.usage.status).toBe('cancelled')
      expect(segments).toHaveLength(0)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        endStatus: 'cancelled',
        usageStatus: 'cancelled',
        generated: 0,
        emitted: 0,
        discarded: 0,
      })
    } finally {
      await server.close()
    }
  })
})

