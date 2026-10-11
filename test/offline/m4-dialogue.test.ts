import { describe, expect, it } from 'vitest'
import { collectDialogueViolations } from '../conformance/dialogue.conformance'
import * as faulty from '../support/faulty-ports'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  FIXTURE_TURN_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  ALLOWED_DELIVERY_PAIRS,
  CHARACTER_CONTENT,
  FIXTURE_CHARACTER_PROFILE,
  PERSONA_AUTHORING_STATUS,
  SPOKEN_ADMISSION,
  classifyMemoryBucket,
  createDeliveryMemoryStore,
  createDialoguePort,
  deriveSegmentId,
  intentTemplatesFor,
  isAllowedDeliveryPair,
  isSubstantiveSpeech,
  isTruncatedSpeech,
  personaAuthoringIssues,
  renderDialoguePrompt,
  renderPersonaBlock,
  resolveCharacterProfile,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
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

describe('M4 dialogue conformance', () => {
  it('satisfies every dialogue assertion with the real implementation', async () => {
    const memory = createDeliveryMemoryStore()
    const violations = await collectDialogueViolations(() => ({
      dialogue: createDialoguePort({ clock: FIXTURE_CLOCK,  history: memory }),
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
    const outcome = await generate(createDialoguePort({ clock: FIXTURE_CLOCK }), fixtureDialogueRequest(), context)
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('cancelled')
    expect(outcome.end.segmentCount).toBe(0)
    expect(outcome.end.usage.status).toBe('cancelled')
  })

  it('keeps already emitted segments when stopped midway', async () => {
    const context = createCallContext()
    const segments: DialogueSegment[] = []
    const end = await createDialoguePort({ clock: FIXTURE_CLOCK }).generate(fixtureDialogueRequest(), context, {
      segment: async (segment) => {
        segments.push(segment)
        context.abort()
      },
    })
    expect(segments).toHaveLength(1)
    expect(end.status).toBe('cancelled')
    expect(end.segmentCount).toBe(1)
  })

  it('treats a passed deadline as a timeout and stops generating', async () => {
    const port = createDialoguePort({ clock: { nowMs: () => 10_000 } })
    const outcome = await generate(port, fixtureDialogueRequest(), createCallContext(5_000))
    expect(outcome.segments).toHaveLength(0)
    expect(outcome.end.status).toBe('cancelled')
    expect(outcome.end.usage.status).toBe('timeout')
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
      createDialoguePort({ clock: FIXTURE_CLOCK }),
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
        createDialoguePort({ clock: FIXTURE_CLOCK }),
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
    const outcome = await generate(createDialoguePort({ clock: FIXTURE_CLOCK,  history: memory }))
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

  it('defines a pairing rule for every delivery classification', () => {
    expect(Object.keys(ALLOWED_DELIVERY_PAIRS).sort()).toEqual([
      'fully-delivered',
      'not-delivered',
      'partial-unknown',
    ])
    expect(isAllowedDeliveryPair('fully-delivered', 'completed')).toBe(true)
    expect(isAllowedDeliveryPair('fully-delivered', 'failed')).toBe(false)
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
    memory.noteTurnPersona('turn-old', 'character-fixture@0')
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-old',
        segmentId: 'seg-0',
        textHash: 'hash-old',
        text: 'Old persona line.',
      }),
    )
    memory.noteTurnPersona('turn-new', 'character-fixture@1')
    await memory.commit(
      fixtureCommitDelivery({
        turnId: 'turn-new',
        segmentId: 'seg-0',
        textHash: 'hash-new',
        text: 'Current persona line.',
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
      fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 5 } }),
    )

    // Both turns were heard. Only the budget forces a choice, and speech from a
    // superseded persona is what gives way first — the newest turn is never
    // dropped, because an empty context reads as amnesia.
    expect(capture.view?.turns.map((turn) => turn.turnId)).toEqual(['turn-new'])
    expect(
      capture.view?.exclusions.some((entry) => entry.reason === 'trim-stale-persona'),
    ).toBe(true)
    expect(capture.view?.truncatedByCharacterLimit).toBe(true)
  })

  it('remembers which persona produced a turn', async () => {
    const memory = createDeliveryMemoryStore()
    const port = createDialoguePort({ clock: FIXTURE_CLOCK, memory })
    await generate(port)
    await memory.commit(fixtureCommitDelivery({ turnId: FIXTURE_TURN_ID }))

    expect(memory.audit()[0]?.personaVersion).toBe('character-fixture@1')
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
    // The fixture profile declares no boundaries, so none are rendered.
    expect(block).not.toContain('Never:')
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
