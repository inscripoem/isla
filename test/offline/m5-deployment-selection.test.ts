import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClockPort, ReactionPort, RuntimeEvent, SelectionPort } from '../../src/contracts'
import { createRuleSelectionPort } from '../../src/decision'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createProductionApplication } from '../../src/runtime/production'
import type { ProductionApplication, ProductionDeployment } from '../../src/runtime/production'
import type { StorageConfig } from '../../src/storage/config'
import { createEventStore } from '../../src/storage/event-store'
import { createSqliteBackend, openDatabase } from '../../src/storage/sqlite'
import {
  createControlledMediaDriver,
  createM1ActualBlobMap,
  createRegistryResolver,
} from '../support/m1-kit'
import { createPerformerClient } from '../support/performer-client'
import type { PerformerClient } from '../support/performer-client'
import {
  CLI_IPC_SHUTDOWN_MESSAGE,
  bootstrapOperatorToken,
  collectUntilExit,
  createCliHarness,
  waitForListening,
} from '../support/production-cli-kit'
import { TEST_DEPLOYMENT_ORIGIN } from '../support/production-kit'
import { createProductionDeployment } from '../support/production-deployment-rule-selection'

/**
 * The explicitly selected rule-selection deployment entry over the actual
 * controlled application.
 *
 * `test/support/production-deployment-rule-selection.ts` composes the existing
 * controlled deployment and replaces only the selection peer with M3's real
 * deterministic rule port bound to the deployment's runtime clock. These tests
 * use the real application transport, real SQLite persistence and the real M1
 * fixed synthesis; reaction, dialogue text and the renderer remain the labeled
 * substitutes supplied by the base deployment.
 *
 * They establish: plans are recorded as `m3-rules` with the rule's own reason
 * code for two sequential turns, no fixture or fallback decision is presented
 * as an M3 decision, the reaction port is still the explicit substitute, the
 * port is bound to the deployment clock (a second clock domain would fail the
 * deadline assertion), and the CLI can load the entry by path. They do not
 * establish live M3/M4 providers, acoustic output, formal-console acceptance or
 * full I1 completion.
 */

const LIVE = 'session-deployment-selection-live'
const INPUT_A = 'first controlled input for the rule selection deployment'
const INPUT_B = 'second controlled input for the rule selection deployment'
const DEPLOYMENT_MODULE = join(
  process.cwd(),
  'test/support/production-deployment-rule-selection.ts',
)

interface Fixture {
  readonly app: ProductionApplication
  readonly deployment: ProductionDeployment
  readonly storage: StorageConfig
  readonly port: number
  readonly clock: ClockPort
  readonly sessionId: string
  readonly clients: PerformerClient[]
}

const fixtures: Fixture[] = []
const tempDirs: string[] = []
const cliHarness = createCliHarness('isla-m5-deployment-selection-')

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const client of fixture.clients) await client.close().catch(() => {})
    await fixture.app.stop().catch(() => {})
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  await cliHarness.cleanup()
})

function tempStorage(): StorageConfig {
  const directory = mkdtempSync(join(tmpdir(), 'isla-m5-deployment-selection-'))
  tempDirs.push(directory)
  return { dbPath: join(directory, 'isla.db'), backupDir: join(directory, 'backups') }
}

/** A clock the test can move forward; it starts at the given non-negative origin. */
interface MutableClock extends ClockPort {
  setNowMs(value: number): void
}

function createMutableClock(originMs: number): MutableClock {
  let nowMs = originMs
  return {
    nowMs: () => nowMs,
    setNowMs(value: number) {
      nowMs = value
    },
  }
}

async function readSession(storage: StorageConfig, sessionId: string): Promise<RuntimeEvent[]> {
  const database = openDatabase(storage.dbPath)
  try {
    return await createEventStore(createSqliteBackend(database)).readSession(sessionId)
  } finally {
    database.close()
  }
}

async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - started > timeoutMs) {
      throw new Error('until timed out before observing its condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function startFixture(options: {
  liveSessionId: string
  clock?: ClockPort
}): Promise<Fixture> {
  const storage = tempStorage()
  const clock = options.clock ?? createMonotonicClock()
  const deployment = createProductionDeployment({
    clock,
    databasePath: storage.dbPath,
    env: { ISLA_TEST_LIVE_SESSION_ID: options.liveSessionId },
  })
  const app = await createProductionApplication({
    storage,
    initialSelection: deployment.initialSelection,
    peers: deployment.peers,
    allowedOrigins: deployment.allowedOrigins,
    port: 0,
    graceMs: 200,
    clock,
    ...(deployment.release !== undefined ? { ownedRelease: deployment.release } : {}),
  })
  const bound = await app.start()
  const fixture: Fixture = {
    app,
    deployment,
    storage,
    port: bound.port,
    clock,
    sessionId: deployment.initialSelection.liveSessionId,
    clients: [],
  }
  fixtures.push(fixture)
  return fixture
}

async function bootPerformer(
  fixture: Fixture,
  options: { media?: ReturnType<typeof createControlledMediaDriver> } = {},
): Promise<PerformerClient> {
  let receipts = 0
  const client = createPerformerClient({
    url: `ws://127.0.0.1:${fixture.port}/app`,
    origin: TEST_DEPLOYMENT_ORIGIN,
    sessionId: fixture.sessionId,
    resolver: createRegistryResolver(createM1ActualBlobMap()),
    media: options.media ?? createControlledMediaDriver({ autoEvents: true }),
    receipts: {
      newReceiptId: () => `deployment-selection-receipt-${(receipts += 1)}`,
      localNowMs: () => null,
    },
  })
  fixture.clients.push(client)
  await client.snapshot
  const token = await bootstrapOperatorToken(fixture.port)
  expect((await client.bootstrapOperator(token)).kind).toBe('operator.ack')
  expect((await client.attach()).kind).toBe('session.attach.ack')
  expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
  return client
}

interface RecordedPlan {
  readonly provider: unknown
  readonly modelVersion: unknown
  readonly reasonCode: unknown
  readonly disposition: unknown
  readonly selectedEventIds: readonly string[]
}

function plansOf(events: readonly RuntimeEvent[]): RecordedPlan[] {
  return events
    .filter((event) => event.type === 'selection.plan')
    .map((event) => {
      const plan = (event.payload as { plan?: Record<string, unknown> }).plan ?? {}
      const ids = plan.selectedEventIds
      return {
        provider: plan.provider,
        modelVersion: plan.modelVersion,
        reasonCode: plan.reasonCode,
        disposition: plan.disposition,
        selectedEventIds: Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === 'string')
          : [],
      }
    })
}

function selectionCallDispositions(events: readonly RuntimeEvent[]): unknown[] {
  return events
    .filter(
      (event) => event.type === 'provider.call' && event.payload.call === 'selection',
    )
    .map((event) => event.payload.disposition)
}

function acceptedEventId(ack: Record<string, unknown> | unknown): string {
  const payload = (ack as { payload?: { eventId?: unknown } }).payload
  if (typeof payload?.eventId !== 'string') {
    throw new Error('the input acknowledgement carried no event id')
  }
  return payload.eventId
}

async function awaitCompletedTurns(fixture: Fixture, count: number): Promise<RuntimeEvent[]> {
  return until(
    () => readSession(fixture.storage, fixture.sessionId),
    (events) =>
      events.filter((event) => event.type === 'turn.ended' && event.payload.status === 'completed')
        .length >= count,
  )
}

describe('controlled formal deployment with real rule selection', () => {
  it('records m3-rules plans for two sequential turns and keeps reaction substituted', async () => {
    const fixture = await startFixture({ liveSessionId: LIVE })
    const client = await bootPerformer(fixture)

    const firstId = acceptedEventId(await client.input(INPUT_A))
    await awaitCompletedTurns(fixture, 1)
    const secondId = acceptedEventId(await client.input(INPUT_B))
    const events = await awaitCompletedTurns(fixture, 2)

    const plans = plansOf(events)
    expect(plans).toHaveLength(2)
    for (const plan of plans) {
      expect(plan.provider).toBe('m3-rules')
      expect(plan.modelVersion).toBe('m3-rules-v0.1')
      expect(plan.reasonCode).toBe('oldest-offered')
      expect(plan.disposition).toBe('respond')
    }
    expect(plans[0]?.selectedEventIds).toEqual([firstId])
    expect(plans[1]?.selectedEventIds).toEqual([secondId])
    // No fixture decision and no M5 fallback plan may be presented as M3 output.
    expect(plans.some((plan) => plan.provider === 'fixture')).toBe(false)
    expect(plans.some((plan) => plan.disposition !== 'respond')).toBe(false)
    expect(selectionCallDispositions(events)).toEqual(['accepted', 'accepted'])

    const startedTurnIds = events
      .filter((event) => event.type === 'turn.started')
      .map((event) => event.turnId)
    const deliveredTurnIds = events
      .filter((event) => event.type === 'delivery.committed')
      .map((event) => event.turnId)
    expect(startedTurnIds).toHaveLength(2)
    expect(new Set(deliveredTurnIds)).toEqual(new Set(startedTurnIds))
    expect(client.errors()).toEqual([])

    // Reaction remains the base deployment's explicit substitute until M3
    // delivers its rule reaction port.
    const reactionRequest: Parameters<ReactionPort['decide']>[0] = {
      requestId: 'decision-deployment-selection',
      sessionId: fixture.sessionId,
      epoch: 1,
      turnId: 'turn-deployment-selection',
      segmentId: 'segment-deployment-selection',
      snapshotRevision: 1,
      capabilityRevision: 1,
      task: 'segment-reaction',
      segmentText: 'controlled segment',
      personaSummary: 'controlled persona',
      interactionState: 'calm',
      eligibleActionIds: ['smile'],
      deadline: { atMs: fixture.clock.nowMs() + 1000 },
      policyVersion: 'policy-v1',
      providerVersion: 'provider-v1',
    }
    const reaction = await fixture.deployment.peers.reaction.decide(reactionRequest, {
      signal: new AbortController().signal,
      deadline: { atMs: fixture.clock.nowMs() + 1000 },
    })
    expect(reaction.provider).toBe('fixture-rule')
    expect(reaction.reasonCode).toBe('fixture-rule-selected')
  })

  it('binds the deployed selection port to the exact deployment context clock', async () => {
    const clock = createMutableClock(1_000_000_000)
    const fixture = await startFixture({ liveSessionId: `${LIVE}-clock`, clock })
    const port = fixture.deployment.peers.selection
    const deadline = { atMs: 1_000_005_000 }
    const request: Parameters<SelectionPort['select']>[0] = {
      requestId: 'selection-deployment-clock',
      task: 'response-plan',
      sessionId: fixture.sessionId,
      epoch: 1,
      snapshotRevision: 1,
      candidates: [
        {
          eventId: 'event-deployment-clock',
          sessionId: fixture.sessionId,
          epoch: 1,
          source: 'local-audience',
          actorId: 'actor-deployment-clock',
          text: 'controlled clock-probe input',
          receivedAtMs: clock.nowMs(),
          expiresAtMs: deadline.atMs,
          trust: 'untrusted-content',
        },
      ],
      personaSummary: 'controlled persona',
      currentTopic: 'clock probe',
      recentHistory: [],
      allowedIntents: ['answer'],
      deadline,
      policyVersion: 'policy-v1',
      providerVersion: 'provider-v1',
    }
    const context: Parameters<SelectionPort['select']>[1] = {
      signal: new AbortController().signal,
      deadline,
    }

    await expect(port.select(request, context)).resolves.toMatchObject({
      provider: 'm3-rules',
      reasonCode: 'oldest-offered',
    })
    clock.setNowMs(1_000_010_000)
    await expect(port.select(request, context)).rejects.toMatchObject({
      name: 'SelectionCallError',
      code: 'deadline-exceeded',
    })

    // Control: the same request and context through a fresh monotonic clock.
    // That clock starts when createMonotonicClock is called, so it still reads
    // live and resolves. If the deployment port were bound to such a clock
    // instead of the supplied one, the deadline-exceeded assertion above would
    // resolve too, so this test fails rather than passing for an unrelated
    // clock.
    const fresh = createRuleSelectionPort({ clock: createMonotonicClock() })
    await expect(fresh.select(request, context)).resolves.toMatchObject({
      provider: 'm3-rules',
      reasonCode: 'oldest-offered',
    })
  })

  it('loads the explicitly selected entry through the production CLI module seam', async () => {
    const dbPath = cliHarness.tempDatabasePath()
    const child = cliHarness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: LIVE,
      },
      { ipc: true },
    )
    const listening = await waitForListening(child)
    let receipts = 0
    const client = createPerformerClient({
      url: `ws://127.0.0.1:${listening.port}/app`,
      origin: TEST_DEPLOYMENT_ORIGIN,
      sessionId: listening.sessionId,
      resolver: createRegistryResolver(createM1ActualBlobMap()),
      media: createControlledMediaDriver({ autoEvents: true }),
      receipts: {
        newReceiptId: () => `deployment-cli-receipt-${(receipts += 1)}`,
        localNowMs: () => null,
      },
    })
    cliHarness.track(() => client.close())
    try {
      await client.snapshot
      const token = await bootstrapOperatorToken(listening.port)
      expect((await client.bootstrapOperator(token)).kind).toBe('operator.ack')
      expect((await client.attach()).kind).toBe('session.attach.ack')
      expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')

      const acceptedId = acceptedEventId(await client.input(INPUT_A))
      await until(
        () =>
          client
            .events()
            .filter((event) => {
              const payload = (
                event as { payload?: { type?: unknown; data?: { status?: unknown } } }
              ).payload
              return payload?.type === 'turn.ended' && payload.data?.status === 'completed'
            }).length,
        (count) => count >= 1,
      )
      expect(client.errors()).toEqual([])

      const exit = collectUntilExit(child)
      expect(child.send({ type: CLI_IPC_SHUTDOWN_MESSAGE })).toBe(true)
      expect((await exit).code).toBe(0)

      const storage: StorageConfig = { dbPath, backupDir: join(dirname(dbPath), 'backups') }
      const events = await readSession(storage, listening.sessionId)
      const plans = plansOf(events)
      expect(plans).toHaveLength(1)
      expect(plans[0]).toMatchObject({
        provider: 'm3-rules',
        modelVersion: 'm3-rules-v0.1',
        reasonCode: 'oldest-offered',
        disposition: 'respond',
        selectedEventIds: [acceptedId],
      })
      expect(selectionCallDispositions(events)).toEqual(['accepted'])

      // The persisted plan belongs to the turn that started after it; that
      // exact turn must have ended completed, not merely some event of that type.
      const planIndex = events.findIndex((event) => event.type === 'selection.plan')
      expect(planIndex).toBeGreaterThanOrEqual(0)
      const started = events
        .slice(planIndex + 1)
        .find((event) => event.type === 'turn.started')
      expect(started?.turnId).toBeTruthy()
      const ended = events.filter(
        (event) => event.type === 'turn.ended' && event.turnId === started?.turnId,
      )
      expect(ended).toHaveLength(1)
      expect(ended[0]?.payload.status).toBe('completed')
    } finally {
      await client.close().catch(() => {})
    }
  })
})
