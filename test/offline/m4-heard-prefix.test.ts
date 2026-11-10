import { describe, expect, it } from 'vitest'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureDialogueRequest,
} from '../support/fixture-data'
import {
  FIXTURE_CHARACTER_PROFILE,
  HEARD_PREFIX_MARKER,
  INTERRUPTED_SPEECH_MARKER,
  SPOKEN_ADMISSION,
  assembleDialogueContext,
  buildMemoryInspect,
  classifyMemoryBucket,
  createDeliveryMemoryStore,
  createDialoguePort,
  renderDialoguePrompt,
  renderRollupLine,
} from '../../src/dialogue'
import type {
  AssembledDialogueContext,
  DeliveryMemoryStore,
  DialogueTextSource,
} from '../../src/dialogue'
import type { CallContext, ClockPort, DialogueSegment } from '../../src/contracts'

/**
 * M4 heard-prefix memory (issue #146 A02).
 *
 * Why this file exists
 * --------------------
 * A partial delivery that carries a receipt is not spoken memory: playback
 * started, so the listener may have heard a prefix, but the sentence was never
 * finished. Before this batch such a record was audit-only and the model could
 * not see that a sentence had been started and cut off. The new `heard-prefix`
 * bucket renders it in its own section, with its own marker, under the same
 * character budget, and never lets it into confirmed history, pinning, the
 * recency window, displacement, the consistency scan or delivery recall.
 *
 * Falsifiability follows the C-58 method: every assertion names the change that
 * would turn it red, so a future edit that widens admission, duplicates a
 * marker, breaks the byte-identical default or lets the budget overshoot is
 * caught here.
 *
 * Registered conditions (offline, M4's own dialogue conditions - no new C-xx or
 * INV-xx identifier is minted by this batch; issue #25 owns the numbering):
 *   1. given a partial record with a receipt, the prompt contains exactly one
 *      "cut off after start" line;
 *   2. given a partial record without a receipt, the prompt is byte-identical
 *      to the baseline;
 *   3. under budget pressure the heard-prefix line drops before complete
 *      statements.
 *
 * Scope note (not claimed): the production durable path still returns only
 * spoken records (`DeliveryMemoryStore.confirmedHistory`), so on that path the
 * prompt is unchanged. Making heard-prefix rows reach production needs a later
 * M6 widening of the history query, which is not part of this batch.
 */

const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

/** A partial delivery that carries a playback receipt: the legitimate pair. */
const PARTIAL_WITH_RECEIPT = {
  classification: 'partial-unknown',
  terminalOutcome: 'cancelled',
} as const

/** Fixed render costs used by the budget assertions. */
const COMPLETE_LINE = `- We talked about the concert.`
const COMPLETE_LINE_CHARACTERS = 30
const HEARD_PREFIX_TEXT = 'I was thinking maybe we could'
const HEARD_PREFIX_LINE_CHARACTERS = 53
const ROLLUP_LINE_CHARACTERS = 26

function captureView(): { view: AssembledDialogueContext | null } {
  return { view: null }
}

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

function sinkOf(collected: DialogueSegment[]) {
  return {
    segment: async (segment: DialogueSegment) => {
      collected.push(segment)
    },
  }
}

/** Commit one record with a stable delivery identity derived from its turn. */
async function commitRecord(
  memory: DeliveryMemoryStore,
  record: {
    turnId: string
    text: string
    classification?: 'fully-delivered' | 'partial-unknown' | 'not-delivered'
    terminalOutcome?: 'completed' | 'cancelled' | 'unknown' | 'failed'
    receiptId?: string | null
    modality?: 'audio' | 'subtitle' | 'avatar'
    segmentId?: string
    personaProfileVersion?: string
    textHash?: string
  },
): Promise<void> {
  const ack = await memory.commit(
    fixtureCommitDelivery({
      sessionId: FIXTURE_SESSION_ID,
      turnId: record.turnId,
      segmentId: record.segmentId ?? `${record.turnId}-seg-0`,
      textHash: record.textHash ?? `hash-${record.turnId}-${record.segmentId ?? 'seg-0'}`,
      text: record.text,
      ...(record.classification === undefined ? {} : { classification: record.classification }),
      ...(record.terminalOutcome === undefined ? {} : { terminalOutcome: record.terminalOutcome }),
      ...(record.receiptId === undefined ? {} : { receiptId: record.receiptId }),
      ...(record.modality === undefined ? {} : { modality: record.modality }),
      ...(record.personaProfileVersion === undefined
        ? {}
        : { personaProfileVersion: record.personaProfileVersion }),
    }),
  )
  if (ack.status !== 'applied' && ack.status !== 'duplicate') {
    throw new Error(`fixture record was not stored: ${ack.status}`)
  }
}

/** Commit one heard-prefix record (partial delivery that carries a receipt). */
async function commitHeardPrefix(
  memory: DeliveryMemoryStore,
  record: {
    turnId: string
    text: string
    modality?: 'audio' | 'subtitle' | 'avatar'
    segmentId?: string
    personaProfileVersion?: string
    /** Distinguishes two commits of one utterance identity from each other. */
    textHash?: string
  },
): Promise<void> {
  const { textHash, ...rest } = record
  await commitRecord(memory, {
    ...PARTIAL_WITH_RECEIPT,
    ...rest,
    ...(textHash === undefined ? {} : { textHash }),
  })
}

/** Assemble through the local record source, which returns every stored record. */
async function assembleWithLocalSource(
  memory: DeliveryMemoryStore,
  maxCharacters = 2000,
  maxTurns = 8,
): Promise<AssembledDialogueContext> {
  return assembleDialogueContext({
    request: fixtureDialogueRequest({ contextLimits: { maxTurns, maxCharacters } }),
    profile: FIXTURE_CHARACTER_PROFILE,
    memory,
  })
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

describe('M4 heard-prefix classification', () => {
  it('classifies a partial delivery with a receipt as heard-prefix', () => {
    const partialBase = {
      sessionId: FIXTURE_SESSION_ID,
      turnId: 'turn-partial',
      segmentId: 'seg-partial-0',
      textHash: 'hash-partial-0',
      text: HEARD_PREFIX_TEXT,
      outputId: 'output-partial-0',
      receiptId: 'receipt-partial-0',
      modality: 'audio' as const,
      segmentIndex: 0,
      personaProfileId: 'character-fixture',
      personaProfileVersion: '1',
    }

    // Counterfactual: deleting the new branch in `classifyMemoryBucket` makes
    // this decision `audit-only` / `not-fully-delivered` and reddens the line.
    expect(
      classifyMemoryBucket({
        ...partialBase,
        classification: 'partial-unknown',
      }),
    ).toEqual({ bucket: 'heard-prefix', reason: 'partial-with-receipt' })

    // No receipt means no playback evidence: still audit-only.
    expect(
      classifyMemoryBucket({
        ...partialBase,
        classification: 'partial-unknown',
        receiptId: null,
      }),
    ).toEqual({ bucket: 'audit-only', reason: 'not-fully-delivered' })

    // An empty partial record said nothing, so there is no prefix to keep.
    expect(
      classifyMemoryBucket({
        ...partialBase,
        classification: 'partial-unknown',
        text: '...',
      }),
    ).toEqual({ bucket: 'audit-only', reason: 'not-fully-delivered' })

    // A receipt for a delivery that never played is not a heard prefix.
    expect(
      classifyMemoryBucket({
        ...partialBase,
        classification: 'not-delivered',
      }),
    ).toEqual({ bucket: 'audit-only', reason: 'not-fully-delivered' })

    // Regression: a fully delivered record with a receipt is still spoken.
    expect(
      classifyMemoryBucket({
        ...partialBase,
        classification: 'fully-delivered',
        text: 'We talked about the concert.',
      }),
    ).toEqual({ bucket: 'spoken', reason: 'delivered-with-receipt' })
  })

  it('keeps the FR-02 evidence layer unchanged', async () => {
    // The admission table answers "may it enter spoken history", and a
    // partial record may not - heard-prefix is a separate bucket.
    expect(SPOKEN_ADMISSION['partial-unknown']).toBe('audit-only')
    expect(SPOKEN_ADMISSION['not-delivered']).toBe('audit-only')

    const memory = createDeliveryMemoryStore()
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })

    // Counterfactual: widening the `'spoken'` filter in
    // `DeliveryMemoryStore.confirmedHistory` to include heard-prefix makes the
    // durable spoken projection non-empty and reddens this assertion.
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])
    expect(memory.records()).toHaveLength(1)
  })
})

describe('M4 heard-prefix rendering', () => {
  it('renders a heard-prefix turn in its own section with exactly one marker', async () => {
    const memory = createDeliveryMemoryStore()
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })

    const view = await assembleWithLocalSource(memory)

    expect(view.heardPrefixTurns).toHaveLength(1)
    const turn = view.heardPrefixTurns[0]
    expect(turn?.heardPrefix).toBe(true)
    // `interrupted` is reserved for fully delivered mid-sentence text.
    expect(turn?.interrupted).toBe(false)
    expect(turn?.characters).toBe(HEARD_PREFIX_LINE_CHARACTERS)
    expect(turn?.pinned).toBe(false)
    // A cut-off fragment is not confirmed speech.
    expect(view.turns).toEqual([])
    expect(view.history).toEqual([])

    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('Started but cut off:')
    expect(countOccurrences(prompt, HEARD_PREFIX_MARKER)).toBe(1)
    expect(countOccurrences(prompt, INTERRUPTED_SPEECH_MARKER)).toBe(0)
    // Rendered byte for byte: exactly one marker, at the end of the line.
    expect(prompt).toContain('- I was thinking maybe we could [cut off after start]')
    // Counterfactual: merging the line into the confirmed-history block, or
    // rendering a second marker, reddens the assertions above and below.
    expect(prompt).not.toContain('Already said (confirmed spoken):')
  })

  it('renders exactly one mid-sentence marker for fully delivered truncated speech', async () => {
    const memory = createDeliveryMemoryStore()
    await commitRecord(memory, {
      turnId: 'turn-complete',
      text: 'We talked about the concert and then',
    })

    const view = await assembleWithLocalSource(memory)
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.interrupted).toBe(true)

    const prompt = renderDialoguePrompt(view)
    expect(countOccurrences(prompt, INTERRUPTED_SPEECH_MARKER)).toBe(1)
    expect(countOccurrences(prompt, HEARD_PREFIX_MARKER)).toBe(0)

    // Combination: both kinds in one store. Each marker appears exactly once,
    // which pins the mutual exclusion priority, and the cut-off section comes
    // BEFORE the confirmed-history section.
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })
    const combined = await assembleWithLocalSource(memory)
    expect(combined.turns).toHaveLength(1)
    expect(combined.heardPrefixTurns).toHaveLength(1)

    const combinedPrompt = renderDialoguePrompt(combined)
    expect(countOccurrences(combinedPrompt, INTERRUPTED_SPEECH_MARKER)).toBe(1)
    expect(countOccurrences(combinedPrompt, HEARD_PREFIX_MARKER)).toBe(1)
    const cutOffAt = combinedPrompt.indexOf('Started but cut off:')
    const spokenAt = combinedPrompt.indexOf('Already said (confirmed spoken):')
    expect(cutOffAt).toBeGreaterThanOrEqual(0)
    expect(spokenAt).toBeGreaterThanOrEqual(0)
    expect(cutOffAt).toBeLessThan(spokenAt)
  })

  it('excludes a partial record without a receipt, byte-identical to the baseline', async () => {
    const memory = createDeliveryMemoryStore()
    await commitRecord(memory, {
      ...PARTIAL_WITH_RECEIPT,
      turnId: 'turn-partial',
      text: HEARD_PREFIX_TEXT,
      receiptId: null,
    })

    const view = await assembleWithLocalSource(memory)
    expect(view.heardPrefixTurns).toEqual([])
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-partial' && entry.reason === 'not-fully-delivered',
      ),
    ).toBe(true)

    // Both sides read through the local record source, so `historySource` is
    // the same on both and only the record differs.
    const baseline = await assembleWithLocalSource(createDeliveryMemoryStore())
    expect(renderDialoguePrompt(view)).toBe(renderDialoguePrompt(baseline))
    expect(view.estimatedCharacters).toBe(baseline.estimatedCharacters)
    // Counterfactual: letting a partial record without a receipt reach any
    // rendered section breaks the byte-identical assertion.
    expect(view.history).toEqual([])
  })
})

describe('M4 heard-prefix budget', () => {
  it('drops heard-prefix turns first when the budget is short', async () => {
    const memory = createDeliveryMemoryStore()
    await commitRecord(memory, { turnId: 'turn-complete', text: 'We talked about the concert.' })
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })

    // The complete turn (30) fits; the remaining 10 cannot hold 53 characters.
    const view = await assembleWithLocalSource(memory, 40)
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.turnId).toBe('turn-complete')
    expect(view.heardPrefixTurns).toEqual([])
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-partial' && entry.reason === 'heard-prefix-budget',
      ),
    ).toBe(true)
    expect(
      view.warnings.some((warning) => warning.includes('started-but-cut-off')),
    ).toBe(true)

    const prompt = renderDialoguePrompt(view)
    expect(prompt).not.toContain('Started but cut off:')
    expect(prompt).not.toContain(HEARD_PREFIX_MARKER)
    // Counterfactual: letting heard-prefix claim budget before history would
    // push the complete statement out and redden these two lines.
    expect(prompt).toContain(COMPLETE_LINE)
    expect(view.estimatedCharacters).toBe(COMPLETE_LINE_CHARACTERS)

    // `maxTurns: 0` leaves no allowance at all, like the recency window.
    const noTurns = await assembleWithLocalSource(memory, 2000, 0)
    expect(noTurns.heardPrefixTurns).toEqual([])
    expect(
      noTurns.exclusions.some(
        (entry) => entry.turnId === 'turn-partial' && entry.reason === 'heard-prefix-budget',
      ),
    ).toBe(true)
  })

  it('charges the heard-prefix section to the same character budget', async () => {
    const memory = createDeliveryMemoryStore()
    await commitRecord(memory, { turnId: 'turn-complete', text: 'We talked about the concert.' })
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })

    const view = await assembleWithLocalSource(memory, 200)
    expect(view.turns).toHaveLength(1)
    expect(view.heardPrefixTurns).toHaveLength(1)
    // Counterfactual: not charging the heard-prefix line reddens this total.
    expect(view.estimatedCharacters).toBe(
      COMPLETE_LINE_CHARACTERS + HEARD_PREFIX_LINE_CHARACTERS,
    )

    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('Already said (confirmed spoken):')
    expect(prompt).toContain('Started but cut off:')
    expect(prompt).toContain(COMPLETE_LINE)
    expect(prompt).toContain('- I was thinking maybe we could [cut off after start]')
  })

  it('aggregates the new exclusion reason for diagnostics without a wire change', async () => {
    const memory = createDeliveryMemoryStore()
    await commitRecord(memory, { turnId: 'turn-complete', text: 'We talked about the concert.' })
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })

    const view = await assembleWithLocalSource(memory, 40)
    const payload = buildMemoryInspect(view, FIXTURE_SESSION_ID, 'turn-current')

    // The dropped turn has one segment, so one exclusion is aggregated. The new
    // reason flows through the existing string-keyed map; diagnostics.ts is
    // untouched.
    expect(payload.admission.exclusions['heard-prefix-budget']).toBe(1)
    expect(payload.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(payload.turnId).toBe('turn-current')
    expect(payload.budget.estimatedCharacters).toBe(view.estimatedCharacters)
    // Redaction still holds: no memory text on the wire.
    expect(JSON.stringify(payload)).not.toContain('thinking maybe')
  })

  it('never exceeds the character budget when a rollup and a kept heard-prefix turn would coexist', async () => {
    const memory = createDeliveryMemoryStore()
    await commitRecord(memory, { turnId: 'turn-old', text: 'We talked about the concert.' })
    await commitRecord(memory, { turnId: 'turn-new', text: 'We talked about the concert.' })
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: 'A' })

    // History needs 60 for two complete turns; the cap is 59, so the older one
    // is trimmed and a 26-character rollup line is charged instead.
    const view = await assembleWithLocalSource(memory, 59)

    expect(view.turns).toHaveLength(1)
    expect(view.rollup).toEqual({ omittedTurns: 1, characters: ROLLUP_LINE_CHARACTERS })
    expect(renderRollupLine(1)).toHaveLength(ROLLUP_LINE_CHARACTERS)
    // 59 - 30 (kept) - 26 (rollup) = 3, less than the 25-character cut-off line.
    // Counterfactual: forgetting to charge the rollup leaves 29, the cut-off
    // line survives, and the total becomes 81 > 59 - both assertions red.
    expect(view.heardPrefixTurns).toEqual([])
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-partial' && entry.reason === 'heard-prefix-budget',
      ),
    ).toBe(true)
    expect(view.estimatedCharacters).toBe(
      COMPLETE_LINE_CHARACTERS + ROLLUP_LINE_CHARACTERS,
    )
    expect(view.estimatedCharacters).toBeLessThanOrEqual(59)
  })

  it('keeps a cheaper heard-prefix candidate after rejecting a more expensive one', async () => {
    const memory = createDeliveryMemoryStore()
    // Current persona (same version as the active one) ranks highest and is
    // tried first: 2 + 6 + 22 = 30 characters.
    await commitHeardPrefix(memory, {
      turnId: 'turn-expensive',
      text: 'Hello!',
      personaProfileVersion: '1',
    })
    // Stale persona ranks lower and is tried second: 2 + 1 + 22 = 25 characters.
    await commitHeardPrefix(memory, {
      turnId: 'turn-cheap',
      text: 'A',
      personaProfileVersion: '0',
    })

    const view = await assembleWithLocalSource(memory, 26)

    // Counterfactual: upgrading a rejected candidate into "reject the rest"
    // would drop the cheaper turn too and redden both lines below.
    expect(view.heardPrefixTurns.map((turn) => turn.turnId)).toEqual(['turn-cheap'])
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-expensive' && entry.reason === 'heard-prefix-budget',
      ),
    ).toBe(true)
    expect(view.estimatedCharacters).toBe(25)
  })

  it('deduplicates a dual-modality confirmed heard-prefix utterance', async () => {
    const memory = createDeliveryMemoryStore()
    // Same session/turn/segment, two modalities: two delivery keys, one
    // utterance.
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })
    await commitHeardPrefix(memory, {
      turnId: 'turn-partial',
      text: HEARD_PREFIX_TEXT,
      modality: 'subtitle',
    })

    const view = await assembleWithLocalSource(memory)

    // `modalityRank('audio') < modalityRank('subtitle')`, so audio survives.
    // Counterfactual: skipping the heard-prefix dedupe pass renders the segment
    // twice inside one turn and doubles the charge.
    expect(view.heardPrefixTurns).toHaveLength(1)
    const turn = view.heardPrefixTurns[0]
    expect(turn?.segments).toHaveLength(1)
    expect(turn?.segments[0]?.modality).toBe('audio')
    expect(turn?.characters).toBe(HEARD_PREFIX_LINE_CHARACTERS)
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-partial' && entry.reason === 'duplicate-modality',
      ),
    ).toBe(true)

    const prompt = renderDialoguePrompt(view)
    expect(countOccurrences(prompt, HEARD_PREFIX_MARKER)).toBe(1)
    expect(countOccurrences(prompt, '- I was thinking maybe we could')).toBe(1)
  })

  it('renders a cross-bucket duplicate utterance only as confirmed speech', async () => {
    const memory = createDeliveryMemoryStore()
    /*
     * The same utterance identity (session/turn/segment) committed twice with
     * different classifications. Both pairs are legal
     * (`ALLOWED_DELIVERY_PAIRS`), but the delivery keys differ only by
     * modality here, so the two records co-exist in the store.
     */
    await commitRecord(memory, {
      turnId: 'turn-shared',
      text: 'We talked about the concert.',
      modality: 'audio',
      segmentId: 'turn-shared-seg-0',
    })
    await commitHeardPrefix(memory, {
      turnId: 'turn-shared',
      text: 'We talked about the concert.',
      modality: 'subtitle',
      segmentId: 'turn-shared-seg-0',
      // A distinct text hash, so this is a second record for the same
      // utterance identity rather than an idempotent re-commit.
      textHash: 'hash-turn-shared-duplicate-subtitle',
    })

    const view = await assembleWithLocalSource(memory)

    // Counterfactual: without the cross-bucket check the same sentence is
    // rendered in both sections and charged twice; removing the check reddens
    // both lines below.
    expect(view.turns.map((turn) => turn.turnId)).toEqual(['turn-shared'])
    expect(view.heardPrefixTurns).toEqual([])
    expect(
      view.exclusions.some(
        (entry) => entry.turnId === 'turn-shared' && entry.reason === 'duplicate-modality',
      ),
    ).toBe(true)

    const prompt = renderDialoguePrompt(view)
    // The fixture's intent reference lines repeat the same sentence, so count
    // the rendered history line together with its section placement.
    expect(countOccurrences(prompt, COMPLETE_LINE)).toBe(2)
    expect(countOccurrences(prompt, HEARD_PREFIX_MARKER)).toBe(0)
    expect(prompt).not.toContain('Started but cut off:')
    expect(prompt).toContain(`Already said (confirmed spoken):\n${COMPLETE_LINE}`)
  })
})

describe('M4 heard-prefix injection path', () => {
  it('reaches classification through the MemoryEntrySource injection', async () => {
    const memory = createDeliveryMemoryStore()
    await commitHeardPrefix(memory, { turnId: 'turn-partial', text: HEARD_PREFIX_TEXT })

    const capture = captureView()
    // No `history` port: the local record source is the record source, which is
    // the existing injection point - no new port is needed for this feature.
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      memory,
      textSource: capturingTextSource(capture),
    })
    const segments: DialogueSegment[] = []
    const context: CallContext = createCallContext()
    await port.generate(fixtureDialogueRequest(), context, sinkOf(segments))

    const view = capture.view
    if (view === null) throw new Error('context was not assembled')
    expect(view.historySource).toBe('local-stand-in')
    expect(view.heardPrefixTurns).toHaveLength(1)
    expect(view.heardPrefixTurns[0]?.heardPrefix).toBe(true)
  })
})
