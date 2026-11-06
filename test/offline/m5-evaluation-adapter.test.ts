import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClockPort,
  ControlStopMessage,
  EventStorePort,
  HistoryQueryPort,
  ReactionPort,
  SelectionPort,
  SelectionRequest,
  TrustedControlContext,
} from '../../src/contracts'
import { APPLICATION_CONTRACT_VERSION, MAX_SELECTION_CANDIDATES } from '../../src/contracts'
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
  EvaluationInputPlan,
  EvaluationVariantConfig,
  PreparedEvaluationInput,
} from '../../src/runtime/evaluation-adapter'
import type { DialogueOutcomeEvent } from '../../src/runtime/dialogue-outcome'
import { createRetainedSynthesis } from '../../src/runtime/physical-synthesis'
import type { ProductionPeers } from '../../src/runtime/production'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createSqliteBackend, migrate, openDatabase } from '../../src/storage/sqlite'
import { createFixtureReactionPort, createFixtureSelectionPort } from '../support/correct-ports'
import { createControlledConsumer } from '../support/evaluation-consumer'
import { createVirtualClock } from '../support/virtual-clock'
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
 * cancelled receipts; a ready that arrives past the conservative local
 * lifetime expires the grant before playback and yields no delivery; a
 * consumer that confirms nothing yields no terminal evidence; a real operator
 * Stop stays a cancellation; late usage joins its own invocation; cleanup
 * faults stay observable without replacing the record; and a session id that
 * is not fresh is refused before any attempt.
 */

const dirs: string[] = []
const databases: Array<ReturnType<typeof openDatabase>> = []
/** Failure-safe teardown for the combined acceptance's real worker thread. */
const physicalCleanups: Array<() => Promise<void>> = []
/** Best-effort machine disposal for a consumer whose attempt never settles. */
const consumerCleanups: Array<() => void> = []

const OPERATOR_CONTEXT: TrustedControlContext = {
  connectionId: 'evaluation-adapter-test-control',
  role: 'operator',
  actorId: 'evaluation-adapter-test',
  authenticated: true,
}

afterEach(async () => {
  // A test that times out while awaiting a gate leaves its async function
  // pending, so its `finally` is not guaranteed to run; restore real timers
  // here so a later test never inherits the fake clock.
  vi.useRealTimers()
  for (const cleanup of consumerCleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // Best-effort teardown; a cleanup fault must not wedge the suite.
    }
  }
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

function createHarness(clock: ClockPort = createMonotonicClock()): AdapterHarness {
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
    clock,
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

/**
 * Explicit ready boundaries for the delayed-execution handshake. `hook` is the
 * consumer's `beforeReady`: it records that an offer was observed and waits
 * until the test releases that specific ready, so no wall-clock delay decides
 * when the handshake proceeds. The test advances the controlled clock between
 * `waitFor` and `release` to make the offer -> ready delay deterministic.
 */
interface ReadyGates {
  hook(): Promise<void>
  waitFor(index: number): Promise<void>
  release(index: number): void
}

function createReadyGates(): ReadyGates {
  const pending: Array<() => void> = []
  const waiters: Array<() => void> = []
  const notify = (): void => {
    for (const waiter of waiters.splice(0)) waiter()
  }
  return {
    async hook() {
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      pending.push(release)
      notify()
      await released
    },
    async waitFor(index) {
      while (pending.length <= index) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
    release(index) {
      pending[index]?.()
    },
  }
}

function buildAdapter(
  harness: AdapterHarness,
  variants: readonly EvaluationVariantConfig[],
  options: {
    consumer?: EvaluationConsumer
    store?: EventStorePort
    nextSessionId?: () => string
    input?: EvaluationInputPlan
    onDialogueOutcome?: (event: DialogueOutcomeEvent) => void
  } = {},
) {
  return createEvaluationAdapter({
    store: options.store ?? harness.store,
    history: harness.history,
    variants,
    ...(options.consumer !== undefined ? { consumer: options.consumer } : {}),
    clock: harness.clock,
    nextSessionId: options.nextSessionId ?? harness.nextSessionId,
    ...(options.input !== undefined ? { input: options.input } : {}),
    onObservation: (observation) => harness.observations.push(observation),
    ...(options.onDialogueOutcome !== undefined
      ? { onDialogueOutcome: options.onDialogueOutcome }
      : {}),
  })
}

/**
 * The fixture selection port with every real request recorded, so a test can
 * read the exact candidate batch the runtime offered and prove one selection.
 */
function capturingSelection(): {
  selection: SelectionPort
  requests: SelectionRequest[]
} {
  const base = createFixtureSelectionPort()
  const requests: SelectionRequest[] = []
  return {
    requests,
    selection: {
      async select(request, context) {
        requests.push(request)
        return base.select(request, context)
      },
    },
  }
}

/** The three fields a prepared input may carry, read back from a candidate. */
function candidateInput(candidate: {
  source: string
  text: string
  actorId: string
}): { source: string; text: string; actorId: string } {
  return { source: candidate.source, text: candidate.text, actorId: candidate.actorId }
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
    // Controlled time: fake timers install before the harness so the
    // coordinator's monotonic clock, the performer's clock and every timer
    // share one deterministic domain. The test decides when each ready is sent
    // and when the machine's conservative local expiry is reached.
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const resolver = createControlledResolver()
      resolver.setAutoResolve()
      // Playback starts and never ends: the controlled media holds `ended` for
      // every handle, so only the machine's conservative local expiry can end a
      // segment.
      const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
      const gates = createReadyGates()
      const consumer = createControlledConsumer({
        media,
        resolver,
        receiptPrefix: 'held',
        beforeReady: () => gates.hook(),
      })
      consumerCleanups.push(() => consumer.detach())
      const playbackMs = 60
      // The machine's local expiry is `offer + (deadline - ready)`, i.e. the
      // coordinator's playback deadline minus the offer -> ready delay. In this
      // handshake that delay is also the elapsed time the machine measures at
      // grant receipt, so releasing each ready after exactly readyAdvanceMs of
      // the controlled clock leaves a remaining local lifetime of
      // playbackMs - 2 * readyAdvanceMs > 0, and the machine's own expiry is
      // due readyAdvanceMs before the coordinator's deadline. The test advances
      // only to the machine's expiry, never to the deadline: the cancellation
      // is the real machine's, not a race between two timers.
      const readyAdvanceMs = 20
      const localExpiryMs = playbackMs - 2 * readyAdvanceMs
      const adapter = buildAdapter(
        harness,
        [{ variant: VARIANT, peers: { ...fixturePeers(harness), timings: { playbackMs } } }],
        { consumer },
      )

      const runPromise = runComparison(
        { variants: [VARIANT], cases: [evalCase('case-1')] },
        { runVariant: adapter.runVariant },
      )

      // Both dialogue segments follow the same explicit handshake: wait for the
      // offer, advance the controlled clock, release the ready, confirm started
      // playback, then advance to the machine's conservative local expiry.
      for (const segment of [0, 1] as const) {
        await gates.waitFor(segment)
        await vi.advanceTimersByTimeAsync(readyAdvanceMs)
        gates.release(segment)
        await media.startedGate(segment)
        expect(media.handles()[segment]?.started()).toBe(true)
        await vi.advanceTimersByTimeAsync(localExpiryMs + 1)
      }
      const run = await runPromise

      expect(run.records).toHaveLength(1)
      expect(run.records[0].outcome).toBe('failed')
      expect(run.records[0].failureReason).toContain('without completed delivery evidence')
      expect(run.summary.failureRate).toBe(1)

      // Both segments reached real, started playback on the controlled media.
      expect(media.createCount()).toBe(2)
      expect(media.handles().every((handle) => handle.started())).toBe(true)

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
      expect(consumer.receipts().filter((receipt) => receipt.stage === 'cancelled')).toHaveLength(2)
      expect(consumer.receipts().some((receipt) => receipt.stage === 'completed')).toBe(false)

      const events = await harness.store.readSession(harness.sessions[0])
      expect(events.some((event) => event.type === 'delivery.committed')).toBe(true)
      expect(
        events.every(
          (event) =>
            event.type !== 'delivery.committed' || event.payload.classification === 'partial-unknown',
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires a grant before playback when the ready arrives past the conservative local lifetime', async () => {
    // The probe's failure mode as its own case: in this handshake the ready
    // delay equals the elapsed time the machine measures at grant receipt, so a
    // ready released after more than half the playback budget leaves
    // remainingLocal = playbackMs - 2 * expiryAdvanceMs non-positive; the
    // machine discards the delivered grant as `offer_expired` without ever
    // playing.
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const resolver = createControlledResolver()
      resolver.setAutoResolve()
      const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
      const gates = createReadyGates()
      const consumer = createControlledConsumer({
        media,
        resolver,
        receiptPrefix: 'expired-ready',
        beforeReady: () => gates.hook(),
      })
      consumerCleanups.push(() => consumer.detach())
      const playbackMs = 60
      // Advancing the controlled clock past playbackMs / 2 before the ready
      // makes the machine's remaining local lifetime non-positive; this is this
      // setup's arithmetic, not a general property of the local expiry.
      const expiryAdvanceMs = Math.floor(playbackMs / 2) + 1
      const adapter = buildAdapter(
        harness,
        [{ variant: VARIANT, peers: { ...fixturePeers(harness), timings: { playbackMs } } }],
        { consumer },
      )

      const runPromise = runComparison(
        { variants: [VARIANT], cases: [evalCase('case-1')] },
        { runVariant: adapter.runVariant },
      )
      await gates.waitFor(0)
      await vi.advanceTimersByTimeAsync(expiryAdvanceMs)
      gates.release(0)
      // The machine discards the grant synchronously, but the bridge marks the
      // operation granted only after the grant send returns; the machine's
      // synchronous `offer_expired` receipt is emitted but not accepted while
      // the operation is still in `offered` phase. Advance the controlled clock
      // past the coordinator's playback deadline to settle the granted
      // operation with no accepted terminal evidence.
      await vi.advanceTimersByTimeAsync(playbackMs)
      const run = await runPromise

      // The ready arrived and the grant was sent, but no media was ever created
      // or started: the machine refused the grant before playback.
      expect(media.createCount()).toBe(0)
      expect(media.handles()).toEqual([])
      // The machine now publishes its expiry through the local observer as well
      // as the wire. This is local unknown evidence, not an accepted terminal.
      const localReceipts = consumer.receipts()
      expect(localReceipts).toHaveLength(1)
      expect(localReceipts[0]).toMatchObject({
        stage: 'unknown',
        reasonCode: 'offer_expired',
        source: 'performer-machine',
      })

      expect(run.records).toHaveLength(1)
      expect(run.records[0].outcome).toBe('failed')
      expect(run.records[0].failureReason).toContain('without terminal delivery evidence')
      expect(run.summary.failureRate).toBe(1)

      const observation = harness.observations[0]
      expect(observation.cycleStatus).toBe('cancelled')
      // No accepted terminal evidence exists: the runtime cannot claim
      // confirmed cancellation, and it must not invent a delivery.
      expect(observation.outputConfirmation).toBe('unknown')
      expect(observation.deliveries).toEqual([])

      const events = await harness.store.readSession(harness.sessions[0])
      expect(events.some((event) => event.type === 'delivery.committed')).toBe(false)
      // The durable record proves the operation was granted (a never-granted
      // one settles as `not_dispatched`) and then expired at the coordinator's
      // deadline: the machine's synchronous `offer_expired` receipt was emitted
      // but not accepted, no accepted playback receipt exists, and no delivery
      // was committed.
      const expired = events.find(
        (event) =>
          event.type === 'output.receipt' &&
          event.payload.stage === 'unknown' &&
          (event.payload.receipt as { reasonCode?: unknown } | undefined)?.reasonCode ===
            'expired_or_revoked',
      )
      expect(expired).toBeDefined()
      expect((expired?.payload.receipt as { source?: unknown } | undefined)?.source).toBe(
        'm5-performer-bridge',
      )
    } finally {
      vi.useRealTimers()
    }
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

  it('records projected dialogue outcome evidence and contains a faulty observer', async () => {
    const harness = createHarness()
    const forwarded: DialogueOutcomeEvent[] = []
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness) }],
      {
        consumer: autoConsumer({ receiptPrefix: 'outcome' }),
        onDialogueOutcome: (event) => {
          forwarded.push(event)
          throw new Error('observer fault')
        },
      },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    // The observer fault is isolated: the attempt still completes normally.
    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('completed')

    const observation = harness.observations[0]
    expect(observation.dialogueOutcomes.length).toBeGreaterThanOrEqual(1)
    const first = observation.dialogueOutcomes[0]
    expect(first.sessionId).toBe(harness.sessions[0])
    expect(first.endStatus).toBe('completed')
    expect(first.discarded).toBe(first.generated - first.emitted)
    expect(forwarded).toHaveLength(observation.dialogueOutcomes.length)
    expect(observation.dialogueOutcomeFailures).toEqual(['observer threw'])
  })

  it('reports a deadline_exceeded dialogue as a deadline failure even with a delivered prefix', async () => {
    const clock = createVirtualClock()
    const harness = createHarness(clock)
    // Advance the server clock past the dialogue deadline during the first
    // segment's sink write, so the producer emits one fulfilled segment and then
    // reports deadline_exceeded. The real deadline timers never fire.
    let advanced = false
    const base = createFixtureReactionPort()
    const reaction: ReactionPort = {
      async decide(request, context) {
        const result = await base.decide(request, context)
        if (!advanced) {
          advanced = true
          clock.advance(60_001)
        }
        return result
      },
    }
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness, { reaction }) }],
      { consumer: autoConsumer({ receiptPrefix: 'deadline' }) },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain('deadline')

    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBe('cancelled')
    expect(observation.dialogueEndStatus).toBe('deadline_exceeded')
    // A delivered prefix is real evidence, but an expired turn is never success.
    expect(observation.deliveries.length).toBeGreaterThan(0)

    const events = await harness.store.readSession(harness.sessions[0])
    const results = events.filter((event) => event.type === 'dialogue.result')
    expect(results).toHaveLength(1)
    expect((results[0].payload.end as { status: string }).status).toBe('deadline_exceeded')
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

  // Separately discovered hardening, not the original M1 finding: the
  // onObservation return value itself was not isolated. The M1 finding concerns
  // the forwarded onDialogueOutcome promise and is covered by the two tests below.
  it('keeps the completed snapshot when the onObservation promise rejects later', async () => {
    const harness = createHarness()
    let rejectObservation!: (reason?: unknown) => void
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const adapter = createEvaluationAdapter({
        store: harness.store,
        history: harness.history,
        variants: [{ variant: VARIANT, peers: fixturePeers(harness) }],
        consumer: autoConsumer({ receiptPrefix: 'late-observer' }),
        clock: harness.clock,
        nextSessionId: harness.nextSessionId,
        onObservation: (observation) => {
          harness.observations.push(observation)
          return new Promise<void>((_resolve, reject) => {
            rejectObservation = reject
          })
        },
      })

      const run = await runComparison(
        { variants: [VARIANT], cases: [evalCase('case-1')] },
        { runVariant: adapter.runVariant },
      )

      expect(run.notRun).toEqual([])
      expect(run.records[0].outcome).toBe('completed')
      expect(run.records[0].failureReason).toBeNull()
      expect(harness.observations).toHaveLength(1)

      // The comparison has already resolved, so the attempt and its observation
      // are complete. Reject only now; no wall-clock delay is involved.
      rejectObservation(new Error('late observation rejection'))
      await tick()
      expect(unhandled).toEqual([])

      // The snapshot handed out before the rejection is unchanged.
      const observation = harness.observations[0]
      expect(observation.cycleStatus).toBe('completed')
      expect(observation.outputConfirmation).toBe('confirmed')
      expect(observation.deliveries.length).toBeGreaterThan(0)
      expect(
        observation.deliveries.every(
          (delivery) =>
            delivery.classification === 'fully-delivered' &&
            delivery.terminalOutcome === 'completed',
        ),
      ).toBe(true)

      // Delivery and confirmed history remain the completed attempt's facts.
      const events = await harness.store.readSession(harness.sessions[0])
      expect(events.some((event) => event.type === 'delivery.committed')).toBe(true)
      const history = await harness.history.confirmedHistory(harness.sessions[0])
      expect(history.length).toBeGreaterThan(0)
      expect(history.every((record) => record.classification === 'fully-delivered')).toBe(true)
      expect(run.records[0].outcome).toBe('completed')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('isolates a late onDialogueOutcome rejection without revising the observation snapshot', async () => {
    const harness = createHarness()
    let rejectDialogueOutcome!: (reason?: unknown) => void
    let dialogueOutcomeCalls = 0
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const adapter = buildAdapter(
        harness,
        [{ variant: VARIANT, peers: fixturePeers(harness) }],
        {
          consumer: autoConsumer({ receiptPrefix: 'late-dialogue-outcome' }),
          onDialogueOutcome: () => {
            dialogueOutcomeCalls += 1
            if (dialogueOutcomeCalls > 1) return
            return new Promise<void>((_resolve, reject) => {
              rejectDialogueOutcome = reject
            })
          },
        },
      )

      const run = await runComparison(
        { variants: [VARIANT], cases: [evalCase('case-1')] },
        { runVariant: adapter.runVariant },
      )

      expect(run.notRun).toEqual([])
      expect(run.records[0].outcome).toBe('completed')
      expect(run.records[0].failureReason).toBeNull()
      expect(dialogueOutcomeCalls).toBeGreaterThan(0)

      // The adapter copies dialogueOutcomeFailures immediately before invoking
      // onObservation. This snapshot is therefore final for this attempt.
      const observation = harness.observations[0]
      expect(observation.dialogueOutcomes.length).toBeGreaterThan(0)
      const failuresSnapshot = [...observation.dialogueOutcomeFailures]
      expect(failuresSnapshot).not.toContain('observer rejected')

      // Deterministic late rejection: the comparison and its observation are done.
      rejectDialogueOutcome(new Error('late dialogue-outcome rejection'))
      await tick()
      expect(unhandled).toEqual([])
      expect(observation.dialogueOutcomeFailures).toEqual(failuresSnapshot)

      // The completed outcome, delivery evidence and confirmed history stand.
      expect(observation.cycleStatus).toBe('completed')
      expect(observation.deliveries.length).toBeGreaterThan(0)
      expect(
        observation.deliveries.every(
          (delivery) =>
            delivery.classification === 'fully-delivered' &&
            delivery.terminalOutcome === 'completed',
        ),
      ).toBe(true)
      const events = await harness.store.readSession(harness.sessions[0])
      expect(events.some((event) => event.type === 'delivery.committed')).toBe(true)
      const history = await harness.history.confirmedHistory(harness.sessions[0])
      expect(history.length).toBeGreaterThan(0)
      expect(history.every((record) => record.classification === 'fully-delivered')).toBe(true)
      expect(run.records[0].outcome).toBe('completed')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not wait for a never-settling onDialogueOutcome through a real Stop', async () => {
    const harness = createHarness()
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
    let attachedComposition: RuntimeComposition | null = null
    const currentComposition = (): RuntimeComposition | null => attachedComposition
    let dialogueOutcomeCalls = 0
    const neverSettles = new Promise<void>(() => {})
    const consumer = createControlledConsumer({
      media,
      resolver,
      receiptPrefix: 'never-dialogue-outcome',
      onAttach: (attached) => {
        attachedComposition = attached
      },
    })
    const adapter = buildAdapter(
      harness,
      [
        {
          variant: VARIANT,
          peers: { ...fixturePeers(harness), timings: { playbackMs: 300 } },
        },
      ],
      {
        consumer,
        onDialogueOutcome: () => {
          dialogueOutcomeCalls += 1
          return neverSettles
        },
      },
    )

    const runPromise = runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )
    // Stop through the real control path once active playback has started.
    await media.startedGate(0)
    const current = currentComposition()
    if (current === null) throw new Error('the consumer never attached the composition')
    const snapshot = await current.coordinator.endpoint.snapshot()
    const stop: ControlStopMessage = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'never-dialogue-outcome-stop-1',
      sessionId: snapshot.sessionId,
      epoch: snapshot.epoch,
      kind: 'control.stop',
      payload: { requestId: 'never-dialogue-outcome-stop-request-1' },
    }
    const ack = await current.coordinator.endpoint.control(stop, OPERATOR_CONTEXT)
    expect(ack.status).toBe('applied')

    let timer: ReturnType<typeof setTimeout> | undefined
    const waitedTooLong = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 3000)
    })
    try {
      const run = await Promise.race([runPromise, waitedTooLong])
      if (run === null) throw new Error('the adapter waited for a never-settling observer')
      expect(run.notRun).toEqual([])
      expect(run.records).toHaveLength(1)
      expect(run.records[0].outcome).toBe('cancelled')
      expect(run.records[0].failureReason).toBeNull()
      expect(dialogueOutcomeCalls).toBeGreaterThan(0)

      const observation = harness.observations[0]
      expect(observation.cycleStatus).toBe('cancelled')
      expect(
        observation.deliveries.every(
          (delivery) => delivery.classification !== 'fully-delivered',
        ),
      ).toBe(true)

      const events = await harness.store.readSession(harness.sessions[0])
      expect(events.some((event) => event.type === 'session.stopped')).toBe(true)
      expect(await harness.history.confirmedHistory(harness.sessions[0])).toEqual([])
    } finally {
      clearTimeout(timer)
    }
  })

  // Separately discovered hardening: the onObservation return value is not
  // awaited, so a never-settling promise cannot delay completion or Stop.
  it('does not wait for a never-settling observer and preserves a real Stop', async () => {
    const harness = createHarness()
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
    let attachedComposition: RuntimeComposition | null = null
    const currentComposition = (): RuntimeComposition | null => attachedComposition
    let observerCalls = 0
    const neverSettles = new Promise<void>(() => {})
    const consumer = createControlledConsumer({
      media,
      resolver,
      receiptPrefix: 'never-observer',
      onAttach: (attached) => {
        attachedComposition = attached
      },
    })
    const adapter = createEvaluationAdapter({
      store: harness.store,
      history: harness.history,
      variants: [
        {
          variant: VARIANT,
          peers: { ...fixturePeers(harness), timings: { playbackMs: 300 } },
        },
      ],
      consumer,
      clock: harness.clock,
      nextSessionId: harness.nextSessionId,
      onObservation: (observation) => {
        observerCalls += 1
        harness.observations.push(observation)
        return neverSettles
      },
    })

    const runPromise = runComparison(
      { variants: [VARIANT], cases: [evalCase('case-1')] },
      { runVariant: adapter.runVariant },
    )
    // Stop through the real control path once active playback has started.
    await media.startedGate(0)
    const current = currentComposition()
    if (current === null) throw new Error('the consumer never attached the composition')
    const snapshot = await current.coordinator.endpoint.snapshot()
    const stop: ControlStopMessage = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'never-observer-stop-1',
      sessionId: snapshot.sessionId,
      epoch: snapshot.epoch,
      kind: 'control.stop',
      payload: { requestId: 'never-observer-stop-request-1' },
    }
    const ack = await current.coordinator.endpoint.control(stop, OPERATOR_CONTEXT)
    expect(ack.status).toBe('applied')

    let timer: ReturnType<typeof setTimeout> | undefined
    const waitedTooLong = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 3000)
    })
    try {
      const run = await Promise.race([runPromise, waitedTooLong])
      if (run === null) throw new Error('the adapter waited for a never-settling observer')
      expect(run.notRun).toEqual([])
      expect(run.records).toHaveLength(1)
      expect(run.records[0].outcome).toBe('cancelled')
      expect(run.records[0].failureReason).toBeNull()
      expect(observerCalls).toBe(1)

      // The snapshot still describes the Stop; no delivery was promoted.
      const observation = harness.observations[0]
      expect(observation.cycleStatus).toBe('cancelled')
      expect(
        observation.deliveries.every(
          (delivery) => delivery.classification !== 'fully-delivered',
        ),
      ).toBe(true)

      const events = await harness.store.readSession(harness.sessions[0])
      expect(events.some((event) => event.type === 'session.stopped')).toBe(true)
      expect(await harness.history.confirmedHistory(harness.sessions[0])).toEqual([])
    } finally {
      clearTimeout(timer)
    }
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
 * Prepared-input injection. The adapter still drives the real coordinator and
 * the real M6 runner: only the input preparation step is parameterised. These
 * tests cover the default single-input path staying unchanged, a full ordered
 * batch reaching one selection with label isolation, the refusals that must
 * happen before any runtime or provider work, and a partially admitted batch
 * becoming a failed record with retained evidence and no selection.
 */
describe('M5 evaluation adapter prepared inputs', () => {
  const prepared = (
    source: PreparedEvaluationInput['source'],
    text: string,
    actorId: string,
  ): PreparedEvaluationInput => ({ source, text, actorId })

  it('keeps the default single-input path when no plan is configured', async () => {
    const harness = createHarness()
    const capture = capturingSelection()
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness, { selection: capture.selection }) }],
      { consumer: autoConsumer({ receiptPrefix: 'default-input' }) },
    )

    const run = await runComparison(
      {
        variants: [VARIANT],
        cases: [{ id: 'case-1', input: 'viewer says case-1', labels: { intent: 'greeting' } }],
      },
      { runVariant: adapter.runVariant },
    )

    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('completed')
    expect(capture.requests).toHaveLength(1)
    expect(capture.requests[0].candidates.map(candidateInput)).toEqual([
      { source: 'local-audience', text: 'viewer says case-1', actorId: 'evaluation-adapter' },
    ])
    const events = await harness.store.readSession(harness.sessions[0])
    const accepted = events.filter((event) => event.type === 'input.accepted')
    expect(accepted).toHaveLength(1)
    expect(accepted[0].payload.input).toMatchObject({
      source: 'local-audience',
      text: 'viewer says case-1',
      actorId: 'evaluation-adapter',
    })
  })

  it('admits the full ordered prepared batch before exactly one turn', async () => {
    const harness = createHarness()
    const capture = capturingSelection()
    const resolvedCaseIds: string[] = []
    const batch: PreparedEvaluationInput[] = [
      prepared('local-audience', 'first mention', 'viewer-1'),
      prepared('cohost-text', 'second mention', 'cohost-2'),
      prepared('external-fixture', 'third mention', 'viewer-3'),
      prepared('local-audience', 'fourth mention', 'viewer-4'),
      prepared('cohost-text', 'fifth mention', 'cohost-5'),
    ]
    expect(batch).toHaveLength(MAX_SELECTION_CANDIDATES)
    const adapter = buildAdapter(
      harness,
      [{ variant: VARIANT, peers: fixturePeers(harness, { selection: capture.selection }) }],
      {
        consumer: autoConsumer({ receiptPrefix: 'prepared' }),
        input: {
          mode: 'prepared',
          resolve: async (caseId) => {
            resolvedCaseIds.push(caseId)
            return batch
          },
        },
      },
    )

    const run = await runComparison(
      {
        variants: [VARIANT],
        cases: [
          {
            id: 'case-mentions',
            input: 'ignored default',
            labels: { intent: 'greeting', note: 'do not leak' },
          },
        ],
      },
      { runVariant: adapter.runVariant },
    )

    // The resolver receives only the case id, never the case or its labels.
    expect(resolvedCaseIds).toEqual(['case-mentions'])
    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('completed')
    // One selection over the whole batch, in order, carrying only the prepared
    // fields: no label reaches a provider candidate.
    expect(capture.requests).toHaveLength(1)
    expect(capture.requests[0].candidates.map(candidateInput)).toEqual(batch)
    expect(
      capture.requests[0].candidates.some((candidate) =>
        JSON.stringify(candidate).includes('do not leak'),
      ),
    ).toBe(false)
    expect(harness.observations[0].portInvocations.selection).toBe(1)

    const events = await harness.store.readSession(harness.sessions[0])
    const accepted = events.filter((event) => event.type === 'input.accepted')
    expect(accepted.map((event) => (event.payload.input as { text: string }).text)).toEqual([
      'first mention',
      'second mention',
      'third mention',
      'fourth mention',
      'fifth mention',
    ])
    // Exactly one turn was run, after every admission.
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    const lastAcceptedSeq = Math.max(...accepted.map((event) => event.seq))
    const turn = events.find((event) => event.type === 'turn.started')
    expect(turn?.seq ?? -1).toBeGreaterThan(lastAcceptedSeq)
  })

  it('refuses invalid prepared plans before any runtime or provider work', async () => {
    const harness = createHarness()
    const capture = capturingSelection()
    const peers = fixturePeers(harness, { selection: capture.selection })

    const refusal = async (plan: EvaluationInputPlan, expected: string): Promise<void> => {
      const adapter = buildAdapter(harness, [{ variant: VARIANT, peers }], {
        consumer: autoConsumer({ receiptPrefix: 'refusal' }),
        input: plan,
      })
      const run = await runComparison(
        { variants: [VARIANT], cases: [evalCase('case-refused')] },
        { runVariant: adapter.runVariant },
      )
      expect(run.records).toEqual([])
      expect(run.notRun).toHaveLength(1)
      expect(run.notRun[0].reason).toContain(expected)
      // Refused before any runtime work: no session claimed and no selection.
      expect(harness.sessions).toEqual([])
      expect(capture.requests).toEqual([])
    }

    await refusal(
      { mode: 'prepared' } as unknown as EvaluationInputPlan,
      'without a resolve(caseId) function',
    )
    await refusal(
      { mode: 'bogus', resolve: () => [] } as unknown as EvaluationInputPlan,
      'unknown input mode',
    )
    await refusal(
      {
        mode: 'prepared',
        resolve: () => {
          throw new Error('probe resolver fault')
        },
      },
      'resolver threw: probe resolver fault',
    )
    await refusal(
      { mode: 'prepared', resolve: () => undefined as unknown as readonly PreparedEvaluationInput[] },
      'did not return an array',
    )
    await refusal({ mode: 'prepared', resolve: () => [] }, 'returned no inputs')
    await refusal(
      {
        mode: 'prepared',
        resolve: () => [prepared('not-a-source' as never, 'text', 'actor-1')],
      },
      'invalid source',
    )
    await refusal(
      { mode: 'prepared', resolve: () => [{ source: 'local-audience', text: '', actorId: 'a' }] },
      'empty text',
    )
    await refusal(
      { mode: 'prepared', resolve: () => [{ source: 'local-audience', text: 't', actorId: '' }] },
      'empty actorId',
    )
    await refusal(
      {
        mode: 'prepared',
        resolve: () => [
          {
            source: 'local-audience',
            text: 'text',
            actorId: 'actor-1',
            intent: 'leak',
          } as unknown as PreparedEvaluationInput,
        ],
      },
      'unsupported field',
    )
    await refusal(
      {
        mode: 'prepared',
        resolve: () =>
          Array.from({ length: 6 }, (_, index) =>
            prepared('local-audience', `mention ${index}`, `actor-${index}`),
          ),
      },
      'at most 5',
    )
    // Across every refusal nothing was admitted, claimed or selected.
    expect(harness.sessions).toEqual([])
    expect(capture.requests).toEqual([])
  })

  it('records a failed attempt for a partially admitted batch and never runs a partial turn', async () => {
    const harness = createHarness()
    const capture = capturingSelection()
    const batch: PreparedEvaluationInput[] = [
      prepared('local-audience', 'kept one', 'viewer-1'),
      prepared('cohost-text', 'kept two', 'cohost-2'),
      prepared('local-audience', 'refused three', 'viewer-3'),
    ]
    const adapter = buildAdapter(
      harness,
      [
        {
          variant: VARIANT,
          peers: {
            ...fixturePeers(harness, { selection: capture.selection }),
            // The queue bound rejects the third input after two were accepted.
            maxPendingInputs: 2,
          },
        },
      ],
      {
        consumer: autoConsumer({ receiptPrefix: 'partial' }),
        input: { mode: 'prepared', resolve: () => batch },
      },
    )

    const run = await runComparison(
      { variants: [VARIANT], cases: [evalCase('case-partial')] },
      { runVariant: adapter.runVariant },
    )

    expect(run.notRun).toEqual([])
    expect(run.records).toHaveLength(1)
    expect(run.records[0].outcome).toBe('failed')
    expect(run.records[0].failureReason).toContain('skipped runTurn')
    expect(run.records[0].failureReason).toContain('only 2 of 3')
    expect(run.records[0].failureReason).toContain('too many pending inputs')
    expect(run.records[0].failureReason).toContain('a partial batch is never run')

    // Zero selection: no provider work happened for the partial batch.
    expect(capture.requests).toEqual([])
    const observation = harness.observations[0]
    expect(observation.cycleStatus).toBeNull()
    expect(observation.portInvocations.selection).toBe(0)
    expect(observation.deliveries).toEqual([])

    // The accepted inputs remain as retained admission evidence.
    const events = await harness.store.readSession(harness.sessions[0])
    const accepted = events.filter((event) => event.type === 'input.accepted')
    expect(accepted.map((event) => (event.payload.input as { text: string }).text)).toEqual([
      'kept one',
      'kept two',
    ])
    expect(events.some((event) => event.type === 'turn.started')).toBe(false)
    expect(events.some((event) => event.type === 'provider.call')).toBe(false)
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
