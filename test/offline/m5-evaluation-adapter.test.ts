import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ClockPort,
  ControlStopMessage,
  EventStorePort,
  HistoryQueryPort,
  ReactionPort,
  TrustedControlContext,
} from '../../src/contracts'
import { APPLICATION_CONTRACT_VERSION } from '../../src/contracts'
import { runComparison } from '../../src/evaluation/comparison'
import type { EvalCase, Variant } from '../../src/evaluation/comparison'
import { createAudioResourceRegistry } from '../../src/performance/audio-resources'
import type { AudioResolver } from '../../src/performance/browser/types'
import { createMonotonicClock } from '../../src/runtime/clock'
import type { RuntimeComposition } from '../../src/runtime/composition'
import { createEvaluationAdapter } from '../../src/runtime/evaluation-adapter'
import type {
  EvaluationAttemptObservation,
  EvaluationConsumer,
  EvaluationVariantConfig,
} from '../../src/runtime/evaluation-adapter'
import { createRetainedSynthesis } from '../../src/runtime/physical-synthesis'
import type { ProductionPeers } from '../../src/runtime/production'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createSqliteBackend, migrate, openDatabase } from '../../src/storage/sqlite'
import { createFixtureReactionPort } from '../support/correct-ports'
import { createControlledConsumer } from '../support/evaluation-consumer'
import {
  M1_FIXTURE_SEGMENT_0_TEXT,
  M1_FIXTURE_VOICE_ID,
  M1_FIXTURE_VOICE_VERSION,
  createControlledMediaDriver,
  createControlledResolver,
} from '../support/m1-kit'
import { defaultKokoroProfile } from '../support/m1-kokoro-kit'
import { kokoroSdkTestConfig } from '../support/m1-kokoro-sdk-kit'
import { createRealWorkerKit } from '../support/m1-real-worker-kit'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import { createTestProductionPeers } from '../support/production-kit'
import type { TestProductionPeersOptions } from '../support/production-kit'

/**
 * M5 evaluation adapter over the real M6 runner, the real coordinator and the
 * real SQLite store.
 *
 * Every case goes through `runComparison` (M6-02) and the adapter's real
 * `runVariant`: a fresh composition per attempt, Resume through the real control
 * path, `input.submit`, `runTurn`, the admitted drain, and the record mapping.
 * The M3/M4/M1 peer modules are the controlled test kit; the performer is the
 * real browser-side machine over controlled M1 media, so playback receipts are
 * produced by an actual machine rather than fabricated.
 *
 * Coverage of the honesty boundaries: completion requires effective delivery
 * evidence; a synthesis rejection and a failed dialogue are execution failures
 * rather than cancellations; held playback is an incomplete delivery with real
 * cancelled receipts; a consumer that confirms nothing yields no terminal
 * evidence; a real operator Stop stays a cancellation; late usage joins its own
 * invocation; cleanup faults stay observable without replacing the record; and a
 * session id that is not fresh is refused before any attempt.
 */

const dirs: string[] = []
const databases: Array<ReturnType<typeof openDatabase>> = []
/** Failure-safe teardown for the combined acceptance's real worker thread. */
const physicalCleanups: Array<() => Promise<void>> = []

const OPERATOR_CONTEXT: TrustedControlContext = {
  connectionId: 'evaluation-adapter-test-control',
  role: 'operator',
  actorId: 'evaluation-adapter-test',
  authenticated: true,
}

afterEach(async () => {
  // The real thread is terminated first so a caller-owned provider close can
  // settle even when the test failed before its explicit release.
  for (const cleanup of physicalCleanups.splice(0)) {
    try {
      await cleanup()
    } catch {
      // Best-effort teardown; a cleanup fault must not wedge the suite.
    }
  }
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Best-effort close.
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface AdapterHarness {
  readonly store: EventStorePort
  readonly history: HistoryQueryPort
  readonly clock: ClockPort
  readonly sessions: string[]
  readonly observations: EvaluationAttemptObservation[]
  nextSessionId(): string
}

function createHarness(): AdapterHarness {
  const dir = mkdtempSync(join(tmpdir(), 'isla-m5-eval-adapter-'))
  dirs.push(dir)
  const dbPath = join(dir, 'eval.db')
  const backupDir = join(dir, 'backups')
  const database = openDatabase(dbPath)
  databases.push(database)
  migrate(database, { dbPath, backupDir })
  const backend = createSqliteBackend(database)
  const sessions: string[] = []
  const observations: EvaluationAttemptObservation[] = []
  return {
    store: createEventStore(backend),
    history: createHistoryQuery(backend),
    clock: createMonotonicClock(),
    sessions,
    observations,
    nextSessionId() {
      const id = `session-eval-${sessions.length + 1}`
      sessions.push(id)
      return id
    },
  }
}

const VARIANT: Variant = { id: 'rules-split', kind: 'rules', combined: false }

/**
 * The controlled deployment peers bound to the shared offline fixture identity.
 * The real M4 persona registry only resolves `character-fixture`; the coordinator
 * default would report a failed dialogue for an unknown character, and the fixed
 * synthesis catalog is keyed by the fixture voice.
 */
function fixturePeers(
  harness: AdapterHarness,
  options: Omit<TestProductionPeersOptions, 'clock'> = {},
  profile: Partial<NonNullable<ProductionPeers['profile']>> = {},
): ProductionPeers {
  return {
    ...createTestProductionPeers({ clock: harness.clock, ...options }),
    profile: {
      characterProfileId: 'character-fixture',
      characterProfileVersion: '1',
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
      ...profile,
    },
  }
}

function evalCase(id: string): EvalCase {
  return { id, input: `viewer says ${id}` }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('until: condition never held')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function autoConsumer(
  options: {
    holdEndedFrom?: number
    autoEvents?: boolean
    autoResolve?: boolean
    receiptPrefix?: string
  } = {},
): ReturnType<typeof createControlledConsumer> {
  const resolver = createControlledResolver()
  if (options.autoResolve !== false) resolver.setAutoResolve()
  const media = createControlledMediaDriver({
    autoEvents: options.autoEvents ?? true,
    ...(options.holdEndedFrom !== undefined ? { holdEndedFrom: options.holdEndedFrom } : {}),
  })
  return createControlledConsumer({
    media,
    resolver,
    receiptPrefix: options.receiptPrefix ?? 'eval',
  })
}

function buildAdapter(
  harness: AdapterHarness,
  variants: readonly EvaluationVariantConfig[],
  options: {
    consumer?: EvaluationConsumer
    store?: EventStorePort
    nextSessionId?: () => string
  } = {},
) {
  return createEvaluationAdapter({
    store: options.store ?? harness.store,
    history: harness.history,
    variants,
    ...(options.consumer !== undefined ? { consumer: options.consumer } : {}),
    clock: harness.clock,
    nextSessionId: options.nextSessionId ?? harness.nextSessionId,
    onObservation: (observation) => harness.observations.push(observation),
  })
}

/** A synthesis port that fails every preparation, like a rejected provider. */
function rejectingSynthesis(counter: { calls: number }): ProductionPeers['createSynthesis'] {
  return () => ({
    async prepare() {
      counter.calls += 1
      throw new Error('independent-synthesis-failure')
    },
  })
}

describe('M5 evaluation adapter through the M6 runner', () => {
  it('records completion only with matching effective delivery evidence', async () => {
    const harness = createHarness()
    const consumer = autoConsumer({ receiptPrefix: 'completed' })
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness) }],
      { consumer },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    const record = run.records[0]
    expect(record).toMatchObject({
      caseId: 'case-1',
      variantId: 'rules-split',
      cold: true,
      outcome: 'completed',
      totalMs: null,
      attempts: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
      failureReason: null,
    })
    // Timing is a documented current limitation: budgets are not measurements.
    expect(record.timing).toEqual({
      submitMs: null,
      planMs: null,
      dialogueMs: null,
      synthesisMs: null,
      firstAudibleMs: null,
      stopToSilenceMs: null,
    })
    expect(run.summary.failureRate).toBe(0)

    const observation = harness.observations[0]
    // The observation names the generated session so a caller can retrieve the
    // raw evidence without replacing `nextSessionId`.
    expect(observation.sessionId).toBe(harness.sessions[0])
    expect(observation.cycleStatus).toBe('completed')
    expect(observation.turnEndStatus).toBe('completed')
    expect(observation.dialogueEndStatus).toBe('completed')
    expect(observation.dependencyFailures).toEqual([])
    expect(observation.outputConfirmation).toBe('confirmed')
    expect(observation.deliveries.length).toBeGreaterThan(0)
    expect(
      observation.deliveries.every(
        (delivery) =>
          delivery.classification === 'fully-delivered' && delivery.terminalOutcome === 'completed',
      ),
    ).toBe(true)
    // The selection reports usable counts; M4-01 reports a usage record that
    // declares its counts missing, so the successful turn's aggregate usage
    // stays unknown until M4-02 adoption.
    expect(
      observation.invocations.find((invocation) => invocation.call === 'selection'),
    ).toMatchObject({ usage: 'reported', usageMissing: false })
    expect(
      observation.invocations.find((invocation) => invocation.call === 'dialogue'),
    ).toMatchObject({ usage: 'reported', usageMissing: true })
    expect(observation.portInvocations.selection).toBe(1)
    expect(observation.portInvocations.dialogue).toBe(1)
    expect(observation.drainFailure).toBeNull()
    expect(observation.teardownFailure).toBeNull()

    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'input.accepted')).toBe(true)
    expect(
      events.some((event) => event.type === 'turn.ended' && event.payload.status === 'completed'),
    ).toBe(true)
    const committed = events.filter((event) => event.type === 'delivery.committed')
    expect(committed.length).toBeGreaterThan(0)
    expect(committed.every((event) => event.payload.classification === 'fully-delivered')).toBe(true)
  })

  it('labels the first attempted case cold and the next case warm', async () => {
    const harness = createHarness()
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness) }],
      { consumer: autoConsumer({ receiptPrefix: 'warm' }) },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1'), evalCase('case-2')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records.map((record) => record.cold)).toEqual([true, false])
    expect(run.records.every((record) => record.outcome === 'completed')).toBe(true)
    // Every attempt ran in its own fresh session with its own committed evidence.
    expect(harness.sessions).toHaveLength(2)
    expect(new Set(harness.sessions).size).toBe(2)
    for (const sessionId of harness.sessions) {
      const events = await harness.store.readSession(sessionId)
      expect(
        events.some(
          (event) =>
            event.type === 'delivery.committed' && event.payload.classification === 'fully-delivered',
        ),
      ).toBe(true)
    }
  })

  it('refuses completion for a completed cycle with no effective delivery evidence', async () => {
    const harness = createHarness()
    const voiceless = {
      model: 'fixture-voiceless',
      modelVersion: 'fixture-v1',
      resolvedModel: null,
      async compose() {
        return []
      },
    }
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness, { textSource: voiceless }) }],
      { consumer: autoConsumer({ receiptPrefix: 'voiceless' }) },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain(
      'without matching effective completed delivery evidence',
    )
    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('completed')
    expect(observation.deliveries).toEqual([])

    const events = await harness.store.readSession(harness.sessions[0])
    expect(
      events.some((event) => event.type === 'turn.ended' && event.payload.status === 'completed'),
    ).toBe(true)
    expect(events.some((event) => event.type === 'delivery.committed')).toBe(false)
  })

  it('draws the not-run boundary before any attempt for missing prerequisites', async () => {
    const harness = createHarness()
    const peers = fixturePeers(harness)
    const adapter = buildAdapter(
      harness,
      [
        { variant: VARIANT, peers },
        {
          variant: { id: 'broken-peers', kind: 'model', combined: true },
          peers: { ...peers, textSource: undefined as never },
        },
      ],
      { consumer: autoConsumer({ receiptPrefix: 'refusals' }) },
    )

    const run = await runComparison(
      {
        variants: [
          { ...VARIANT, kind: 'model' },
          { id: 'ghost', kind: 'rules', combined: false },
          { id: 'broken-peers', kind: 'model', combined: true },
        ],
        cases: [evalCase('case-1')],
      },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toEqual([])
    expect(run.notRun.map((entry) => entry.variantId)).toEqual([
      'rules-split',
      'ghost',
      'broken-peers',
    ])
    expect(run.notRun[0].reason).toContain('mislabelled')
    expect(run.notRun[1].reason).toContain('no deployment peers are configured')
    expect(run.notRun[2].reason).toContain('cannot run')
    // Nothing was attempted: no session, no runtime, no provider call.
    expect(harness.sessions).toEqual([])

    const withoutConsumer = buildAdapter(harness, [{ variant: VARIANT, peers }])
    const refused = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-2')] },
      { runVariant: withoutConsumer.runVariant },
    )
    expect(refused.records).toEqual([])
    expect(refused.notRun).toHaveLength(1)
    expect(refused.notRun[0].reason).toContain('no audio consumer')
    expect(harness.sessions).toEqual([])
  })

  it('refuses a case that supplies a replyIntent before any work', async () => {
    const harness = createHarness()
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness) }],
      { consumer: autoConsumer({ receiptPrefix: 'intent' }) },
    )

    // ADR-007 D8: replyIntent is the actual prompt condition, which this adapter
    // cannot execute without overriding M3's selection decision.
    const refused = await runComparison(
      {
        variants: [VARIANT],
        cases: [{ id: 'case-intent', input: 'viewer says hello', replyIntent: 'answer' }],
      },
      { runVariant: adapter.runVariant },
    )
    expect(refused.records).toEqual([])
    expect(refused.notRun).toHaveLength(1)
    expect(refused.notRun[0].reason).toContain('replyIntent')
    expect(refused.notRun[0].reason).toContain('ADR-007 D8')
    // Refused before any work: no session was claimed.
    expect(harness.sessions).toEqual([])

    // labels.intent is the human reference label, not a condition: it does not
    // block execution.
    const labelled = await runComparison(
      {
        variants: [VARIANT],
        cases: [{ id: 'case-labelled', input: 'viewer says hello', labels: { intent: 'greeting' } }],
      },
      { runVariant: adapter.runVariant },
    )
    expect(labelled.notRun).toEqual([])
    expect(labelled.records).toHaveLength(1)
    expect(labelled.records[0].outcome).toBe('completed')
  })

  it('reports a pre-attempt cleanup fault in the not-run reason', async () => {
    const harness = createHarness()
    const consumer: EvaluationConsumer = {
      attach: () => {
        throw new Error('probe attach fault')
      },
      detach: () => {
        throw new Error('probe pre-attempt detach fault')
      },
    }
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness) }],
      { consumer },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toEqual([])
    expect(run.notRun).toHaveLength(1)
    expect(run.notRun[0].reason).toContain('consumer attach failed before any attempt')
    // The cleanup fault is reported rather than swallowed: a not-run has no record.
    expect(run.notRun[0].reason).toContain('cleanup after the refusal failed')
    expect(run.notRun[0].reason).toContain('probe pre-attempt detach fault')
    // Nothing was attempted: no input admission, and the store stays usable.
    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'input.accepted')).toBe(false)
  })

  it('refuses session ids that are not fresh and leaves prior evidence untouched', async () => {
    const harness = createHarness()
    const peers = fixturePeers(harness)
    await harness.store.append({
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      eventId: 'session-prior-1',
      seq: 1,
      timestampMs: 1,
      sessionId: 'session-prior',
      epoch: 1,
      turnId: null,
      segmentId: null,
      outputId: null,
      type: 'session.seeded',
      sourceModule: 'M6',
      versions: null,
      payload: { seeded: true },
    })
    const before = await harness.store.readSession('session-prior')

    const adapter = buildAdapter(harness, [{ variant: VARIANT, peers }], {
      consumer: autoConsumer({ receiptPrefix: 'isolation' }),
      nextSessionId: () => 'session-prior',
    })
    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toEqual([])
    expect(run.notRun).toHaveLength(1)
    expect(run.notRun[0].reason).toContain('already holds')
    expect(harness.observations).toEqual([])
    // The seeded evidence is unchanged and the caller's store is still open.
    expect(await harness.store.readSession('session-prior')).toEqual(before)

    // A repeated id is refused for the second attempt of the same adapter.
    const repeatAdapter = buildAdapter(harness, [{ variant: VARIANT, peers }], {
      consumer: autoConsumer({ receiptPrefix: 'isolation-repeat' }),
      nextSessionId: () => 'session-repeat',
    })
    const first = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: repeatAdapter.runVariant },
    )
    expect(first.records).toHaveLength(1)
    const second = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-2')] },
      { runVariant: repeatAdapter.runVariant },
    )
    expect(second.records).toEqual([])
    expect(second.notRun).toHaveLength(1)
    expect(second.notRun[0].reason).toContain('already used by an earlier attempt')
    const events = await harness.store.readSession('session-repeat')
    expect(events.some((event) => event.type === 'input.accepted')).toBe(true)
  })

  it('records a failed attempt when the admission write fails after acceptance', async () => {
    const harness = createHarness()
    const failing: EventStorePort = {
      append: async (event) => {
        if (event.type === 'input.accepted') throw new Error('simulated storage failure')
        return harness.store.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) =>
        harness.store.commitDeliveryWithEvent(delivery, event),
      readSession: (sessionId) => harness.store.readSession(sessionId),
      exportJsonl: (sessionId) => harness.store.exportJsonl(sessionId),
    }
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness) }],
      { consumer: autoConsumer({ receiptPrefix: 'degraded' }), store: failing },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    // The input was admitted, so the case is an attempt; the failed admission
    // write degrades the session, which is observed either at turn entry or by
    // the selection freshness check.
    expect(run.records[0].failureReason).toMatch(/^runtime cycle status: (stale|degraded)$/)
    const observation = harness.observations[0]
    expect(['stale', 'degraded']).toContain(observation.cycleStatus)
    expect(observation.deliveries).toEqual([])
  })

  it('reports a synthesis execution failure as failed with its recorded reason', async () => {
    const harness = createHarness()
    const synthesis = { calls: 0 }
    const adapter = buildAdapter(
      harness,
      [
        {
          variant: VARIANT,
          peers: fixturePeers(harness, { createSynthesis: rejectingSynthesis(synthesis) }),
        },
      ],
      { consumer: autoConsumer({ receiptPrefix: 'synthesis' }) },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(synthesis.calls).toBeGreaterThan(0)
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain('dependency failure')
    expect(run.records[0].failureReason).toContain('synthesis')
    // An execution failure must not disappear from the failure rate.
    expect(run.summary.failureRate).toBe(1)

    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('cancelled')
    expect(observation.dependencyFailures.length).toBeGreaterThan(0)
    expect(observation.dependencyFailures.every((failure) => failure.startsWith('synthesis'))).toBe(
      true,
    )
    expect(observation.deliveries).toEqual([])

    const events = await harness.store.readSession(harness.sessions[0])
    const failures = events.filter((event) => event.type === 'dependency.failed')
    expect(failures).toHaveLength(2)
    expect(
      failures.every(
        (event) => event.payload.stage === 'synthesis' && event.payload.reason === 'rejected',
      ),
    ).toBe(true)
  })

  it('reports a failed dialogue as failed rather than cancellation', async () => {
    const harness = createHarness()
    const adapter = buildAdapter(
      harness,
      [
        {
          variant: VARIANT,
          peers: fixturePeers(harness, {}, { characterProfileId: 'character-unknown' }),
        },
      ],
      { consumer: autoConsumer({ receiptPrefix: 'dialogue' }) },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain('failed dialogue')
    expect(run.summary.failureRate).toBe(1)

    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('cancelled')
    expect(observation.dialogueEndStatus).toBe('failed')
    expect(observation.turnEndStatus).toBe('failed')
    expect(observation.deliveries).toEqual([])
    expect(observation.dependencyFailures).toEqual([])
  })

  it('records held playback as incomplete delivery, never as completed speech', async () => {
    const harness = createHarness()
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
    const consumer = createControlledConsumer({
      media,
      resolver,
      receiptPrefix: 'held',
      // The machine's own local expiry is `offer + (deadline - ready)`, so it
      // fires earlier than the coordinator's playback deadline by the offer ->
      // ready delay. A short, real ready delay keeps the machine's cancelled
      // receipt (and the coordinator's commit of the partial delivery) ahead of
      // the deadline deterministically instead of racing two timers in the same
      // millisecond.
      beforeReady: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
      },
    })
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: { ...fixturePeers(harness), timings: { playbackMs: 60 } } }],
      { consumer },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain('without completed delivery evidence')
    expect(run.summary.failureRate).toBe(1)

    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('cancelled')
    // The real machine published cancelled receipts, so the coordinator
    // truthfully reports confirmed cancellation; that is not completed speech.
    expect(observation.outputConfirmation).toBe('confirmed')
    expect(observation.deliveries.length).toBeGreaterThan(0)
    expect(
      observation.deliveries.every(
        (delivery) =>
          delivery.classification === 'partial-unknown' && delivery.terminalOutcome === 'cancelled',
      ),
    ).toBe(true)
    expect(consumer.receipts().some((receipt) => receipt.stage === 'cancelled')).toBe(true)
    expect(consumer.receipts().some((receipt) => receipt.stage === 'completed')).toBe(false)

    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'delivery.committed')).toBe(true)
    expect(
      events.every(
        (event) =>
          event.type !== 'delivery.committed' || event.payload.classification === 'partial-unknown',
      ),
    ).toBe(true)
  })

  it('records missing terminal delivery evidence as failed, not completion', async () => {
    const harness = createHarness()
    const consumer = createControlledConsumer({
      media: createControlledMediaDriver(),
      resolver: createControlledResolver(),
      receiptPrefix: 'silent',
      silent: true,
    })
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: { ...fixturePeers(harness), timings: { playbackMs: 60 } } }],
      { consumer },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain('without terminal delivery evidence')

    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('cancelled')
    expect(observation.outputConfirmation).toBe('unknown')
    expect(observation.deliveries).toEqual([])
    expect(consumer.receipts()).toEqual([])
  })

  it('preserves a real operator Stop as cancellation', async () => {
    const harness = createHarness()
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    let composition: RuntimeComposition | null = null
    let stopAckStatus: string | null = null
    const consumer = createControlledConsumer({
      media: createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 }),
      resolver,
      receiptPrefix: 'stop',
      onAttach: (attached) => {
        composition = attached
      },
      beforeReady: async () => {
        const current = composition
        if (current === null || stopAckStatus !== null) return
        const snapshot = await current.coordinator.endpoint.snapshot()
        const stop: ControlStopMessage = {
          protocolVersion: APPLICATION_CONTRACT_VERSION,
          messageId: 'stop-1',
          sessionId: snapshot.sessionId,
          epoch: snapshot.epoch,
          kind: 'control.stop',
          payload: { requestId: 'stop-request-1' },
        }
        const ack = await current.coordinator.endpoint.control(stop, OPERATOR_CONTEXT)
        stopAckStatus = ack.status
      },
    })
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: { ...fixturePeers(harness), timings: { playbackMs: 60 } } }],
      { consumer },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    // The Stop went through the real control path while the turn was active.
    expect(stopAckStatus).toBe('applied')
    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('cancelled')
    expect(run.records[0].failureReason).toBeNull()
    expect(run.records[0].attempts).toBeNull()

    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('cancelled')
    expect(observation.deliveries.every((delivery) => delivery.classification !== 'fully-delivered')).toBe(
      true,
    )
    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'session.stopped')).toBe(true)
  })

  it('preserves a real operator Stop during held active playback as cancellation', async () => {
    const harness = createHarness()
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    // Playback starts and never ends: the Stop must interrupt active playback.
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
    let attachedComposition: RuntimeComposition | null = null
    // A reader function: the attachment happens inside the consumer callback, so
    // control-flow narrowing on a plain variable would be misleading.
    const currentComposition = (): RuntimeComposition | null => attachedComposition
    const consumer = createControlledConsumer({
      media,
      resolver,
      receiptPrefix: 'stop-active',
      onAttach: (attached) => {
        attachedComposition = attached
      },
    })
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: { ...fixturePeers(harness), timings: { playbackMs: 300 } } }],
      { consumer },
    )

    const runPromise = runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )
    // Wait until the controlled media has actually started playing, then Stop
    // through the real control path.
    await media.startedGate(0)
    const current = currentComposition()
    if (current === null) throw new Error('the consumer never attached the composition')
    const snapshot = await current.coordinator.endpoint.snapshot()
    const stop: ControlStopMessage = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'stop-active-1',
      sessionId: snapshot.sessionId,
      epoch: snapshot.epoch,
      kind: 'control.stop',
      payload: { requestId: 'stop-active-request-1' },
    }
    const ack = await current.coordinator.endpoint.control(stop, OPERATOR_CONTEXT)
    expect(ack.status).toBe('applied')

    const run = await runPromise
    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('cancelled')
    expect(run.records[0].failureReason).toBeNull()
    expect(run.records[0].attempts).toBeNull()

    const observation = harness.observations[0]
    expect(observation.sessionId).toBe(harness.sessions[0])
    expect(observation.cycleStatus).toBe('cancelled')
    // The started playback was cancelled, not completed.
    expect(consumer.receipts().some((receipt) => receipt.stage === 'cancelled')).toBe(true)
    expect(
      observation.deliveries.every((delivery) => delivery.classification !== 'fully-delivered'),
    ).toBe(true)
    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'session.stopped')).toBe(true)
  })

  it('joins late usage to each invocation instead of adding attempts', async () => {
    const harness = createHarness()
    const fixtureReaction = createFixtureReactionPort()
    const decisionRequests: string[] = []
    const lateReaction: ReactionPort = {
      async decide(request, context) {
        decisionRequests.push(request.requestId)
        // The decision is valid but resolves after the reaction budget: the
        // coordinator times the call out and observes the resolution late.
        const decision = await fixtureReaction.decide(request, context)
        await new Promise((resolve) => setTimeout(resolve, 40))
        return decision
      },
    }
    const adapter = buildAdapter(
      harness,
      [
        {
          variant: VARIANT,
          peers: {
            ...fixturePeers(harness, { reaction: lateReaction }),
            // The reaction budget expires first; the unended playback keeps the
            // turn open so each late usage is admitted and drained before the
            // observation cut.
            timings: { reactionMs: 20, playbackMs: 140 },
          },
        },
      ],
      { consumer: autoConsumer({ holdEndedFrom: 0, receiptPrefix: 'late' }) },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    const observation = harness.observations[0]
    const reactionFacts = observation.invocations.filter(
      (invocation) => invocation.call === 'reaction',
    )
    // One invocation per dispatched dialogue segment; the late usage fills each
    // one rather than adding an attempt.
    expect(decisionRequests.length).toBeGreaterThan(0)
    expect(reactionFacts).toHaveLength(decisionRequests.length)
    expect(reactionFacts.map((fact) => fact.requestId).sort()).toEqual(
      [...decisionRequests].sort(),
    )
    expect(reactionFacts.every((fact) => fact.disposition === 'timeout')).toBe(true)
    expect(reactionFacts.every((fact) => fact.usage === 'late')).toBe(true)
    expect(reactionFacts.every((fact) => fact.usageMissing === false)).toBe(true)
    expect(observation.portInvocations.reaction).toBe(decisionRequests.length)

    // Each identity joins exactly once: one call, one late usage, no extra attempt.
    const events = await harness.store.readSession(harness.sessions[0])
    for (const requestId of decisionRequests) {
      const calls = events.filter(
        (event) => event.type === 'provider.call' && event.payload.requestId === requestId,
      )
      const late = events.filter(
        (event) => event.type === 'provider.usage.late' && event.payload.requestId === requestId,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0].payload.disposition).toBe('timeout')
      expect(late).toHaveLength(1)
    }
    // The aggregate stays unknown on this base: M4 reports no dialogue counts.
    expect(run.records[0].usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      usageMissing: true,
    })
  })

  it('keeps a completed record when only the observation callback fails', async () => {
    const harness = createHarness()
    const adapter = createEvaluationAdapter({
      store: harness.store,
      history: harness.history,
      variants: [{ variant: VARIANT, peers: fixturePeers(harness) }],
      consumer: autoConsumer({ receiptPrefix: 'callback' }),
      clock: harness.clock,
      nextSessionId: harness.nextSessionId,
      onObservation: (observation) => {
        harness.observations.push(observation)
        throw new Error('simulated observation fault')
      },
    })

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    // A callback exception alone does not invalidate an observed delivery.
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('completed')
    expect(run.records[0].failureReason).toBeNull()
    expect(harness.observations).toHaveLength(1)
    expect(harness.observations[0].teardownFailure).toBeNull()

    const events = await harness.store.readSession(harness.sessions[0])
    const cleanup = events.filter((event) => event.type === 'evaluation.cleanup.failed')
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0].payload.observationFailure).toBe('simulated observation fault')
    expect(cleanup[0].payload.teardownFailure).toBeNull()
    expect(cleanup[0].payload.drainFailure).toBeNull()
    expect(cleanup[0].payload.attemptOutcome).toBe('completed')
    expect(cleanup[0].payload.failureReason).toBeNull()
  })

  it('keeps the original execution failure and attempted usage when teardown fails', async () => {
    const harness = createHarness()
    const inner = autoConsumer({ receiptPrefix: 'faults' })
    const consumer: EvaluationConsumer = {
      attach: async (composition) => {
        await inner.attach(composition)
        // Fault injection: composition disposal has no public seam.
        const dispose = composition.dispose.bind(composition)
        ;(composition as { dispose: () => void }).dispose = () => {
          dispose()
          throw new Error('simulated dispose fault')
        }
      },
      detach: () => {
        inner.detach()
        throw new Error('simulated detach fault')
      },
    }
    const synthesis = { calls: 0 }
    const adapter = buildAdapter(
      harness,
      [
        {
          variant: VARIANT,
          peers: fixturePeers(harness, { createSynthesis: rejectingSynthesis(synthesis) }),
        },
      ],
      { consumer },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    // The execution failure survives the cleanup faults, and both are reported:
    // the record keeps the execution reason and appends the cleanup trouble.
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    const failureReason = run.records[0].failureReason
    expect(failureReason).toContain('dependency failure')
    expect(failureReason).toContain('synthesis')
    expect(failureReason).toContain('cleanup failed: consumer detach failed: simulated detach fault')
    expect(failureReason).toContain('composition dispose failed: simulated dispose fault')
    // Attempted usage stays observable even though the aggregate is unknown.
    const observation = harness.observations[0]
    expect(
      observation.invocations.find((invocation) => invocation.call === 'selection')?.usage,
    ).toBe('reported')
    expect(observation.teardownFailure).toContain('consumer detach failed: simulated detach fault')
    expect(observation.teardownFailure).toContain(
      'composition dispose failed: simulated dispose fault',
    )

    const events = await harness.store.readSession(harness.sessions[0])
    const cleanup = events.filter((event) => event.type === 'evaluation.cleanup.failed')
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0].payload.teardownFailure).toContain('simulated detach fault')
    expect(cleanup[0].payload.teardownFailure).toContain('simulated dispose fault')
    // The durable event keeps the original execution failure; the record's reason
    // additionally carries the cleanup trouble.
    expect(cleanup[0].payload.failureReason).toContain('dependency failure')
    expect(cleanup[0].payload.failureReason).toContain('synthesis')
    expect(cleanup[0].payload.failureReason).not.toContain('cleanup failed')
    expect(cleanup[0].payload.attemptOutcome).toBe('failed')
    expect(cleanup[0].payload.observationFailure).toBeNull()
    // The caller's store is still open and usable after teardown faults.
    expect((await harness.store.readSession(harness.sessions[0])).length).toBeGreaterThan(0)
  })

  it('carries cleanup trouble in the returned attempt when the diagnostic channel fails', async () => {
    const harness = createHarness()
    const inner = autoConsumer({ receiptPrefix: 'probe' })
    const consumer: EvaluationConsumer = {
      attach: (composition) => inner.attach(composition),
      detach: () => {
        inner.detach()
        throw new Error('probe detach fault')
      },
    }
    // The store refuses the diagnostic write the way the independent probe did:
    // it throws for the cleanup event.
    const failingStore: EventStorePort = {
      append: async (event) => {
        if (event.type === 'evaluation.cleanup.failed') {
          throw new Error('probe diagnostic write fault')
        }
        return harness.store.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) =>
        harness.store.commitDeliveryWithEvent(delivery, event),
      readSession: (sessionId) => harness.store.readSession(sessionId),
      exportJsonl: (sessionId) => harness.store.exportJsonl(sessionId),
    }
    // No onObservation callback: the returned record and the store are the only
    // channels, and the store write fails.
    const adapter = createEvaluationAdapter({
      store: failingStore,
      history: harness.history,
      variants: [{ variant: VARIANT, peers: fixturePeers(harness) }],
      consumer,
      clock: harness.clock,
      nextSessionId: harness.nextSessionId,
    })

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toHaveLength(1)
    // The delivered output is not invalidated by a cleanup fault, and the turn
    // evidence and usage are preserved...
    expect(run.records[0].outcome).toBe('completed')
    expect(run.records[0].usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      usageMissing: true,
    })
    // ...but the cleanup trouble is carried by the returned attempt itself.
    expect(run.records[0].failureReason).toContain('cleanup failed')
    expect(run.records[0].failureReason).toContain('probe detach fault')
    expect(run.records[0].failureReason).toContain('cleanup diagnostics were not persisted')
    expect(harness.observations).toEqual([])

    // The observed turn evidence is intact; only the diagnostic event is absent.
    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'delivery.committed')).toBe(true)
    expect(events.some((event) => event.type === 'evaluation.cleanup.failed')).toBe(false)
  })

  it('reports a rejected cleanup acknowledgement in the returned attempt', async () => {
    const harness = createHarness()
    const inner = autoConsumer({ receiptPrefix: 'ack' })
    const consumer: EvaluationConsumer = {
      attach: (composition) => inner.attach(composition),
      detach: () => {
        inner.detach()
        throw new Error('probe acknowledgement detach fault')
      },
    }
    // The store answers the diagnostic append with a rejected acknowledgement
    // rather than storing it; that rejection must not be treated as persisted.
    const rejectingStore: EventStorePort = {
      append: async (event) => {
        if (event.type === 'evaluation.cleanup.failed') {
          return {
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'unavailable',
            message: 'simulated diagnostic rejection',
          }
        }
        return harness.store.append(event)
      },
      commitDeliveryWithEvent: (delivery, event) =>
        harness.store.commitDeliveryWithEvent(delivery, event),
      readSession: (sessionId) => harness.store.readSession(sessionId),
      exportJsonl: (sessionId) => harness.store.exportJsonl(sessionId),
    }
    const adapter = createEvaluationAdapter({
      store: rejectingStore,
      history: harness.history,
      variants: [{ variant: VARIANT, peers: fixturePeers(harness) }],
      consumer,
      clock: harness.clock,
      nextSessionId: harness.nextSessionId,
    })

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('completed')
    expect(run.records[0].failureReason).toContain('cleanup failed')
    expect(run.records[0].failureReason).toContain('probe acknowledgement detach fault')
    expect(run.records[0].failureReason).toContain('the store acknowledged failed (unavailable)')
    const events = await harness.store.readSession(harness.sessions[0])
    expect(events.some((event) => event.type === 'evaluation.cleanup.failed')).toBe(false)
  })
})

/**
 * Combined acceptance: the actual evaluation adapter over the retained M1
 * physical synthesis, the real M1 audio registry and a controlled real Node
 * worker thread behind the `createWorker` seam. No SDK or model is loaded: the
 * scripted thread holds every generation until the test settles it. The
 * consumer's resolver is the real registry, so the performer machine acquires
 * the exact generated resource and releases the lease before it publishes its
 * terminal receipt. Coverage: completion, a logical Stop while the physical job
 * is held, the retained adapter's busy refusal until that job settles, and reuse
 * afterwards. Scripted generations prove lifecycle wiring only; they are never
 * evidence of real playback or acoustic output.
 */
describe('M5 evaluation adapter over retained physical synthesis', () => {
  it('completes, stops a held physical job, refuses the busy successor and reuses the shared provider', async () => {
    const harness = createHarness()
    const registry = createAudioResourceRegistry({
      clock: harness.clock,
      byteBudget: 4_000_000,
      retentionMs: 60_000,
    })
    const kit = createRealWorkerKit()
    const creating = createRetainedSynthesis({
      config: kokoroSdkTestConfig(),
      profiles: [defaultKokoroProfile()],
      registry,
      clock: harness.clock,
      createWorker: kit.createWorker,
    })
    // The seam creates the real thread synchronously; initialization completes
    // when the controlled worker reports ready.
    kit.emitReady()
    const retained = await creating
    // The evaluation harness owns the shared provider. On a failed test the
    // real thread is terminated and the provider released before the temporary
    // database is removed; the explicit release below stays the asserted path.
    physicalCleanups.push(async () => {
      await kit.terminate()
      await retained.release().catch(() => {})
      registry.dispose()
    })

    // The consumer's resolver is the real M1 registry: it acquires the exact
    // generated resource and releases the lease before the performer machine
    // publishes its terminal completed receipt.
    const acquired: string[] = []
    /** Completed-receipt count when each lease was released, in release order. */
    const completedAtRelease: number[] = []
    let consumerForReceipts: ReturnType<typeof createControlledConsumer> | null = null
    const resolver: AudioResolver = {
      async resolve(audioRef, signal) {
        const lease = await registry.resolve(audioRef, signal)
        acquired.push(audioRef)
        let released = false
        return {
          blob: lease.blob,
          release: () => {
            if (released) return
            released = true
            // `-1` is unreachable: playback starts only after the consumer
            // exists, and it fails the ordering assertion loudly if it were not.
            completedAtRelease.push(
              consumerForReceipts === null
                ? -1
                : consumerForReceipts
                    .receipts()
                    .filter((receipt) => receipt.stage === 'completed').length,
            )
            lease.release()
          },
        }
      },
    }
    let attachedComposition: RuntimeComposition | null = null
    const currentComposition = (): RuntimeComposition | null => attachedComposition
    const consumer = createControlledConsumer({
      media: createControlledMediaDriver({ autoEvents: true }),
      resolver,
      receiptPrefix: 'physical',
      onAttach: (composition) => {
        attachedComposition = composition
      },
    })
    consumerForReceipts = consumer
    const peers = fixturePeers(harness, {
      createSynthesis: (gate) => retained.createSynthesis(gate),
      audioResources: registry,
      textSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
    })
    const adapter = buildAdapter(harness, [{ variant: VARIANT, peers }], { consumer })

    // ---- success: one scripted generation, acquired and released honestly ----
    const successRun = runComparison(
      { variants: [VARIANT], cases: [evalCase('case-success')] },
      { runVariant: adapter.runVariant },
    )
    void successRun.catch(() => {})
    await until(() => kit.generatePosts().length === 1)
    kit.complete(kit.generatePosts()[0]!.jobId, { samples: new Float32Array([0.1, -0.1]) })
    const success = await successRun

    expect(success.notRun).toEqual([])
    expect(success.records).toHaveLength(1)
    expect(success.records[0]).toMatchObject({
      caseId: 'case-success',
      variantId: VARIANT.id,
      outcome: 'completed',
      failureReason: null,
      totalMs: null,
      attempts: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
    })
    expect(success.records[0].timing).toEqual({
      submitMs: null,
      planMs: null,
      dialogueMs: null,
      synthesisMs: null,
      firstAudibleMs: null,
      stopToSilenceMs: null,
    })
    const successObservation = harness.observations.find((o) => o.caseId === 'case-success')
    if (successObservation === undefined) throw new Error('missing success observation')
    expect(successObservation.deliveries.length).toBeGreaterThan(0)
    expect(
      successObservation.deliveries.every((d) => d.classification === 'fully-delivered'),
    ).toBe(true)
    // The consumer acquired the generated resource from the real registry and
    // released the lease before the machine published the completed receipt.
    expect(acquired).toHaveLength(1)
    expect(acquired[0]).toMatch(/^audio:\/\/kokoro\//)
    expect(completedAtRelease).toEqual([0])
    expect(consumer.receipts().filter((r) => r.stage === 'completed')).toHaveLength(1)
    // No resource or lease is leaked after the attempt.
    expect(registry.snapshot().activeCount).toBe(0)
    expect(registry.snapshot().leasedCount).toBe(0)

    // ---- logical Stop while the physical job is held ----
    const stopRun = runComparison(
      { variants: [VARIANT], cases: [evalCase('case-stop')] },
      { runVariant: adapter.runVariant },
    )
    void stopRun.catch(() => {})
    await until(() => kit.generatePosts().length === 2)
    const heldJob = kit.generatePosts()[1]!
    const stopping = currentComposition()
    if (stopping === null) throw new Error('the consumer never attached the stop composition')
    const snapshot = await stopping.coordinator.endpoint.snapshot()
    const stop: ControlStopMessage = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'physical-stop-1',
      sessionId: snapshot.sessionId,
      epoch: snapshot.epoch,
      kind: 'control.stop',
      payload: { requestId: 'physical-stop-request-1' },
    }
    const ack = await stopping.coordinator.endpoint.control(stop, OPERATOR_CONTEXT)
    expect(ack.status).toBe('applied')
    const stopped = await stopRun

    expect(stopped.notRun).toEqual([])
    expect(stopped.records).toHaveLength(1)
    expect(stopped.records[0]).toMatchObject({
      caseId: 'case-stop',
      outcome: 'cancelled',
      failureReason: null,
      attempts: null,
      totalMs: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
    })
    // The logical wait was revoked while the real thread still holds the job:
    // no replacement generation and no playback acquisition.
    expect(kit.generatePosts()).toHaveLength(2)
    expect(kit.results()).toHaveLength(1)
    expect(acquired).toHaveLength(1)
    const stopObservation = harness.observations.find((o) => o.caseId === 'case-stop')
    if (stopObservation === undefined) throw new Error('missing stop observation')
    expect(stopObservation.cycleStatus).toBe('cancelled')
    // The stopped attempt produced no delivery evidence at all.
    expect(stopObservation.deliveries).toEqual([])
    const stopEvents = await harness.store.readSession(stopObservation.sessionId)
    expect(stopEvents.some((event) => event.type === 'session.stopped')).toBe(true)

    // ---- busy refusal until the held job settles ----
    const busy = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-busy')] },
      { runVariant: adapter.runVariant },
    )
    expect(busy.notRun).toEqual([])
    expect(busy.records).toHaveLength(1)
    // The retained adapter's physical occupancy is an execution failure, not a
    // cancellation, and it stays visible in the failure rate.
    expect(busy.records[0]).toMatchObject({
      caseId: 'case-busy',
      outcome: 'failed',
      attempts: null,
      totalMs: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null, usageMissing: true },
    })
    expect(busy.records[0].failureReason).toContain('recorded dependency failure')
    expect(busy.records[0].failureReason).toContain('busy')
    expect(busy.records[0].timing).toEqual({
      submitMs: null,
      planMs: null,
      dialogueMs: null,
      synthesisMs: null,
      firstAudibleMs: null,
      stopToSilenceMs: null,
    })
    expect(busy.summary.failureRate).toBe(1)
    expect(kit.generatePosts()).toHaveLength(2)
    const busyObservation = harness.observations.find((o) => o.caseId === 'case-busy')
    if (busyObservation === undefined) throw new Error('missing busy observation')
    expect(busyObservation.cycleStatus).toBe('cancelled')
    expect(busyObservation.dependencyFailures).toEqual(['unknown: busy'])
    expect(busyObservation.deliveries).toEqual([])
    const busyEvents = await harness.store.readSession(busyObservation.sessionId)
    expect(busyEvents.some((event) => event.type === 'session.stopped')).toBe(false)

    // ---- settlement and reuse ----
    kit.complete(heldJob.jobId, { samples: new Float32Array([0.2, -0.2]) })
    await until(() => kit.results().length === 2)
    await tick()

    const reuseRun = runComparison(
      { variants: [VARIANT], cases: [evalCase('case-reuse')] },
      { runVariant: adapter.runVariant },
    )
    void reuseRun.catch(() => {})
    await until(() => kit.generatePosts().length === 3)
    kit.complete(kit.generatePosts()[2]!.jobId, { samples: new Float32Array([0.3, -0.3]) })
    const reuse = await reuseRun

    expect(reuse.records).toHaveLength(1)
    expect(reuse.records[0]).toMatchObject({
      caseId: 'case-reuse',
      outcome: 'completed',
      failureReason: null,
      attempts: null,
      totalMs: null,
    })
    expect(reuse.records[0].timing).toEqual({
      submitMs: null,
      planMs: null,
      dialogueMs: null,
      synthesisMs: null,
      firstAudibleMs: null,
      stopToSilenceMs: null,
    })
    // The successor acquired and released a second generated resource.
    expect(acquired).toHaveLength(2)
    expect(acquired[1]).toMatch(/^audio:\/\/kokoro\//)
    expect(acquired[1]).not.toBe(acquired[0])
    expect(completedAtRelease).toEqual([0, 1])
    expect(consumer.receipts().filter((r) => r.stage === 'completed')).toHaveLength(2)
    expect(registry.snapshot().activeCount).toBe(0)
    expect(registry.snapshot().leasedCount).toBe(0)

    // ---- the caller-owned provider is released once through actual exit ----
    const releasing = retained.release()
    await until(() => kit.disposePosts() === 1)
    expect(kit.exited()).toBe(false)
    kit.requestExit()
    await releasing
    expect(kit.exited()).toBe(true)
    await retained.release()
    expect(kit.disposePosts()).toBe(1)
    registry.dispose()
  })
})
