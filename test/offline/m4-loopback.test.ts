import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MediaDriver, MediaEvent, MediaHandle } from '../../src/performance/browser/types'
import { renderDialoguePrompt } from '../../src/dialogue'
import type { AssembledDialogueContext, DialogueTextSource } from '../../src/dialogue'
import { createRuleSelectionPort } from '../../src/decision'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { createCallContext } from '../support/context'
import { loadDecisionCorpus } from '../support/decision-corpus'
import { M1_FIXTURE_SEGMENT_0_TEXT } from '../support/m1-kit'
import { createCatalogDialogueTextSource, createDeliveryFailingBackend } from '../support/m4-kit'

/**
 * Loopback integration evidence over the actual I1 production composition and
 * transport: the real M5 coordinator, the real M4 dialogue composition, the real
 * M6 in-memory store and the real M1 browser `PlaybackController`, driven through
 * a genuine loopback WebSocket with a controlled media driver. Only one test
 * exercises the real M3 selection port, which is the deterministic rule over the
 * reviewed decision corpus; every other test still uses the fixture selection.
 * The M3 reaction and the provider text remain substitutes because issue #89 has
 * not delivered the rule `ReactionPort` yet. The media events are controlled
 * synthetic evidence, not acoustic proof.
 */

const harnesses: LoopHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
})

async function makeHarness(
  options: Parameters<typeof createLoopHarness>[0] = {},
): Promise<LoopHarness> {
  const harness = await createLoopHarness(options)
  harnesses.push(harness)
  return harness
}

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  expect((await harness.client.bootstrapOperator(token)).kind).toBe('operator.ack')
  expect((await harness.client.attach()).kind).toBe('session.attach.ack')
  expect(((await harness.client.resume()).payload as { status: string }).status).toBe('applied')
}

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * A controlled media driver whose first handle reports `playing` then `error`
 * (a playback that started and then failed), and whose later handles report the
 * normal `playing`/`ended`. It emits on microtasks, never wall-clock timers.
 */
function createFailFirstMediaDriver(): MediaDriver {
  let index = 0
  return {
    create(): MediaHandle {
      const fail = index === 0
      index += 1
      const listeners = new Set<(event: MediaEvent) => void>()
      const emit = (event: MediaEvent): void => {
        for (const listener of [...listeners]) listener(event)
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        load() {},
        async play() {
          queueMicrotask(() => {
            emit({ type: 'playing' })
            if (fail) queueMicrotask(() => emit({ type: 'error', reasonCode: 'playback_failed' }))
            else queueMicrotask(() => emit({ type: 'ended' }))
          })
        },
        detach() {
          return true
        },
      }
    },
  }
}

/**
 * A text source that speaks the catalog lines it is given and also records the
 * assembled context it received. The harness prefers a supplied
 * `dialogueTextSource` over the capturing default, so a test that needs both a
 * specific catalog and the view has to carry the capture itself. Test-only.
 */
function captureDialogueTextSource(
  capture: { view: AssembledDialogueContext | null },
  lines: readonly string[],
): DialogueTextSource {
  const base = createCatalogDialogueTextSource(lines)
  return {
    model: base.model,
    modelVersion: base.modelVersion,
    resolvedModel: base.resolvedModel,
    async compose(view, maxSegments) {
      capture.view = view
      return base.compose(view, maxSegments)
    },
  }
}

describe('M4 loopback over the production composition', () => {
  it('carries confirmed previous text into the M4 context of a later turn', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = await makeHarness({ realM4: true, captureView: capture })
    await boot(harness)

    await harness.client.input('first message')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 2,
    )
    await harness.client.input('second message', 'msg-second')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 4,
    )

    const view = capture.view
    expect(view).not.toBeNull()
    expect(view?.historySource).toBe('history-port')
    expect(view?.turns).toHaveLength(1)
    expect(view?.turns[0]?.segments.map((segment) => segment.segmentIndex)).toEqual([0, 1])
    expect(view?.turns[0]?.text).toContain('We talked about the concert.')
  })

  it('keeps playback-started-then-failed audit-only without degrading the session', async () => {
    const harness = await makeHarness({
      realM4: true,
      media: createFailFirstMediaDriver(),
      // A single catalogued line, so the failed output is the whole turn.
      dialogueTextSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
    })
    await boot(harness)

    await harness.client.input('playback will fail')
    await until(
      () => harness.composition.coordinator.deliveries(),
      (deliveries) => deliveries.length >= 1,
    )
    const failed = harness.composition.coordinator
      .deliveries()
      .find((delivery) => delivery.classification === 'partial-unknown')
    expect(failed?.terminalOutcome).toBe('failed')
    expect(harness.composition.coordinator.lifecycle()).toBe('running')
    expect(await harness.confirmedHistory()).toHaveLength(0)
    expect(
      harness.m4Memory?.records().some((record) => record.classification === 'partial-unknown'),
    ).toBe(true)

    // The session is healthy: a later turn still completes and enters history.
    await harness.client.input('next message', 'msg-next')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect((await harness.confirmedHistory())[0]?.classification).toBe('fully-delivered')
  })

  it('never admits a delivery into M4 memory after a failed M6 atomic commit', async () => {
    const { backend, failNextDelivery } = createDeliveryFailingBackend()
    const harness = await makeHarness({ realM4: true, backend })
    await boot(harness)

    failNextDelivery()
    await harness.client.input('storage will fail')
    await until(
      () => harness.composition.coordinator.lifecycle(),
      (lifecycle) => lifecycle === 'degraded',
    )
    expect(harness.m4Memory?.records()).toHaveLength(0)
    expect(await harness.confirmedHistory()).toHaveLength(0)
  })

  it('admits fully-delivered history into a later context and never the unconfirmed failed turn', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = await makeHarness({
      realM4: true,
      captureView: capture,
      media: createFailFirstMediaDriver(),
      // A single catalogued line, so the failed output is the whole turn. The
      // source also records each assembled view, because the harness would
      // otherwise use its own capturing source instead of this catalog.
      dialogueTextSource: captureDialogueTextSource(capture, [M1_FIXTURE_SEGMENT_0_TEXT]),
    })
    await boot(harness)

    // Turn 1 fails mid-playback: it is recorded as `partial-unknown` in M4
    // memory and commits nothing to the durable store.
    await harness.client.input('playback will fail')
    await until(
      () => harness.composition.coordinator.deliveries(),
      (deliveries) => deliveries.length >= 1,
    )
    const failed = harness.m4Memory
      ?.records()
      .find((record) => record.classification === 'partial-unknown')
    expect(failed).toBeDefined()
    if (failed === undefined) return
    expect(await harness.confirmedHistory()).toHaveLength(0)

    // Turn 2 is delivered normally and enters confirmed history together with
    // its playback receipt.
    await harness.client.input('spoken normally', 'msg-delivered')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    const delivered = (await harness.confirmedHistory())[0]
    expect(delivered?.classification).toBe('fully-delivered')
    expect(delivered?.receiptId).not.toBeNull()
    expect(delivered?.turnId).not.toBe(failed.turnId)

    // Turn 3 composes after turn 2 is committed, so the captured view is the
    // one assembled from the durable history port; its own commit then makes
    // two confirmed turns visible.
    await harness.client.input('third turn', 'msg-observer')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 2,
    )

    const view = capture.view
    expect(view).not.toBeNull()
    // Assembled from the durable store, not the local memory stand-in.
    expect(view?.historySource).toBe('history-port')
    // Only the fully delivered turn is admitted, by its own identity, even
    // though both turns speak the same catalog line.
    expect(view?.turns.map((turn) => turn.turnId)).toEqual([delivered?.turnId])
    expect(view?.turns[0]?.text).toContain(M1_FIXTURE_SEGMENT_0_TEXT)
    // The failed turn exists only as audit memory (`m4Memory.records()`); it is
    // never admitted into the assembled context nor into confirmed history.
    // Admission is evidence-based: only a fully delivered segment with its
    // receipt enters. The provider text is still the catalog substitute and
    // issue #89 remains open for the reaction port; the store, the coordinator,
    // the dialogue composition and this history consumption are real.
    expect(view?.turns.map((turn) => turn.turnId)).not.toContain(failed.turnId)
    expect((await harness.confirmedHistory()).map((record) => record.turnId)).not.toContain(
      failed.turnId,
    )
  })

  it("sends the real rule selection's non-default reply intent unchanged into the dialogue request and renders only that intent's reference lines", async () => {
    // Corpus grounding half: the reviewed corpus fixes the rule's DEFAULT intent.
    const corpus = loadDecisionCorpus(
      join(process.cwd(), 'test', 'fixtures', 'decision', 'v1', 'manifest.json'),
    )
    const corpusCase = corpus.cases.find((entry) => entry.entry.id === 'selection-001')
    expect(corpusCase).toBeDefined()
    if (corpusCase === undefined) return
    // The corpus clock sits at 1000 ms, well inside the request deadline of
    // 3000 ms, so the rule evaluates instead of rejecting the call as expired.
    const corpusPort = createRuleSelectionPort({ clock: { nowMs: () => corpusCase.entry.initialNowMs } })
    const corpusResult = await corpusPort.select(
      corpusCase.request,
      createCallContext(corpusCase.request.deadline.atMs),
    )
    expect(corpusResult.disposition).toBe('respond')
    expect(corpusResult.selectedEventIds).toEqual(['message-001'])
    // `answer` is the rule's default whenever the request offers it, and the
    // corpus offers it first: this grounds the DEFAULT intent in reviewed evidence.
    expect(corpusResult.replyIntent).toBe('answer')

    // Loopback half: with only `clarify` allowed, the rule can never take its
    // default branch, so any accepted plan must carry the non-default intent.
    const clock = createMonotonicClock()
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = await makeHarness({
      realM4: true,
      captureView: capture,
      clock,
      // The same clock instance serves the harness and the rule port, so the
      // request deadline, the call context and the coordinator share one domain.
      selection: createRuleSelectionPort({ clock }),
      profile: { allowedIntents: ['clarify'] },
    })
    // The reaction port and the provider text are still the fixture/catalog
    // substitutes pending issue #89; the selection is the only newly real
    // component here.
    await boot(harness)

    const firstCandidate = corpusCase.request.candidates[0]
    expect(firstCandidate).toBeDefined()
    await harness.client.input(firstCandidate?.text ?? 'Which game are you playing?')
    await until(
      () => harness.composition.coordinator.deliveries(),
      (deliveries) => deliveries.length >= 1,
    )

    const view = capture.view
    expect(view).not.toBeNull()
    if (view === null) return
    // The accepted plan's intent reaches the dialogue request and is copied
    // unchanged into the assembled context.
    expect(view.replyIntent).toBe('clarify')
    // Only the assembled intent's own reference templates are attached.
    expect(view.replyTemplates).toEqual(['Which part should I start with?'])
    const prompt = renderDialoguePrompt(view)
    expect(prompt).toContain('Intent: clarify')
    expect(prompt).toContain('Reference lines for this intent:')
    expect(prompt).toContain('- Which part should I start with?')
    // Per issue #44 §1 the intent may only reorder recall priority, never change
    // admission, so no other intent's reference line may appear in the prompt.
    expect(prompt).not.toContain('We talked about the concert.')
    expect(prompt).not.toContain('It was loud and fun.')
    expect(prompt).not.toContain('Thanks for saying that.')
    expect(prompt).not.toContain('That sounds rough')
    expect(prompt).not.toContain('I would rate it eleven out of ten.')
    expect(prompt).not.toContain('Let me double-check')
  })
})
