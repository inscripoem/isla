import type {
  EventStorePort,
  HistoryQueryPort,
  MemoryCommitPort,
  ReplayReaderPort,
} from '../../src/contracts'
import { createChecker } from './violations'
import type { Violation } from './violations'
import { createCoordinatorContractRunner } from './coordinator-runner'
import type { ContractRunner } from './contract-runner'
import { createVirtualClock } from './virtual-clock'
import * as correct from './correct-ports'
import { FIXTURE_SESSION_ID } from './fixture-data'

/**
 * Reusable test-only probe for two real M5 coordinators sharing one
 * EventStorePort. It accepts injected storage/history/replay ports, so the same
 * assertions run against the fixture store, deliberate faulty stores, or an
 * external implementation (for example the M6 in-memory store once merged)
 * without this module importing `src/storage` or `src/dialogue`.
 */

export interface SharedStoreHarness {
  store: EventStorePort
  history: HistoryQueryPort
  replay: ReplayReaderPort
  /**
   * Arms one failure on the next atomic delivery commit (the delivery mutation
   * and its supporting event), not on an earlier ordinary event append.
   */
  failNextDeliveryCommit: () => void
}

export interface SharedStoreProbeOptions {
  createHarness: () => SharedStoreHarness
  sessionA?: string
  sessionB?: string
  /** Per-coordinator memory commit port; defaults to an isolated fixture per session. */
  createCommit?: () => MemoryCommitPort
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function parseJsonl(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function storesText(payload: unknown, text: string): boolean {
  return JSON.stringify(payload).includes(text)
}

function buildRunner(
  store: EventStorePort,
  history: HistoryQueryPort,
  replay: ReplayReaderPort,
  commit: MemoryCommitPort,
  sessionId: string,
): ContractRunner {
  return createCoordinatorContractRunner(
    createVirtualClock(),
    {
      selection: correct.createFixtureSelectionPort(),
      reaction: correct.createFixtureReactionPort(),
      dialogue: correct.createFixtureDialoguePort(),
      synthesis: correct.createFixtureSynthesisPort(),
      renderer: correct.createFixtureRendererPort(),
      player: correct.createFixturePlayer(),
      commit,
      store,
      history,
      projection: correct.createFixtureMemoryProjection(),
      replay,
      authorizer: correct.createFixtureControlAuthorizer(),
    },
    { sessionId },
  )
}

export async function collectSharedStoreViolations(
  options: SharedStoreProbeOptions,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const { store, history, replay, failNextDeliveryCommit } = options.createHarness()
  const sessionA = options.sessionA ?? FIXTURE_SESSION_ID
  const sessionB = options.sessionB ?? 'session-shared-store-b'
  const createCommit = options.createCommit ?? (() => correct.createFixtureMemoryCommit())

  const alpha = buildRunner(store, history, replay, createCommit(), sessionA)
  const beta = buildRunner(store, history, replay, createCommit(), sessionB)

  await alpha.resume()
  await beta.resume()
  await alpha.accept('one from alpha', 'shared-a-1')
  await beta.accept('one from beta', 'shared-b-1')
  const turnA = await alpha.runTurn()
  const turnB = await beta.runTurn()
  await settle()

  check(
    'shared-both-completed',
    turnA.status === 'completed' && turnB.status === 'completed',
    `both coordinators must complete their cycle (got ${turnA.status}/${turnB.status})`,
  )
  check(
    'shared-delivery-each',
    alpha.deliveries().length === 1 &&
      beta.deliveries().length === 1 &&
      alpha.deliveries().every((delivery) => delivery.sessionId === sessionA) &&
      beta.deliveries().every((delivery) => delivery.sessionId === sessionB),
    'each coordinator must commit exactly one delivery scoped to its own session',
  )

  const readA = await store.readSession(sessionA)
  const readB = await store.readSession(sessionB)
  check(
    'shared-session-isolated',
    readA.length > 0 &&
      readB.length > 0 &&
      readA.every((event) => event.sessionId === sessionA) &&
      readB.every((event) => event.sessionId === sessionB),
    'each session must read only its own events',
  )
  check(
    'shared-input-isolated',
    readA.some((event) => storesText(event.payload, 'one from alpha')) &&
      !readA.some((event) => storesText(event.payload, 'one from beta')) &&
      readB.some((event) => storesText(event.payload, 'one from beta')) &&
      !readB.some((event) => storesText(event.payload, 'one from alpha')),
    'session reads must not leak the other session input',
  )

  const exportA = parseJsonl(await store.exportJsonl(sessionA))
  const exportB = parseJsonl(await store.exportJsonl(sessionB))
  check(
    'shared-export-consistent',
    sameJson(exportA, readA) && sameJson(exportB, readB),
    'each JSONL export must equal its own session read',
  )
  check(
    'shared-export-isolated',
    !JSON.stringify(exportA).includes(sessionB) && !JSON.stringify(exportB).includes(sessionA),
    'a JSONL export must not contain the other session',
  )

  const historyA = await history.confirmedHistory(sessionA)
  const historyB = await history.confirmedHistory(sessionB)
  check(
    'shared-history-scoped',
    historyA.length === 1 &&
      historyB.length === 1 &&
      historyA[0]?.sessionId === sessionA &&
      historyB[0]?.sessionId === sessionB,
    'confirmed history must be scoped to the requesting session',
  )

  const archiveA = await replay.load(sessionA)
  check(
    'shared-replay-isolated',
    sameJson(archiveA.events, readA),
    'replay must return exactly the committed session events',
  )
  if (archiveA.events[0] !== undefined) archiveA.events[0].type = 'mutated-by-probe'
  const rereadA = await store.readSession(sessionA)
  check(
    'shared-replay-detached',
    rereadA.every((event) => event.type !== 'mutated-by-probe'),
    'mutating a replay read must not change committed state',
  )

  // Stop on one coordinator must not affect the other or corrupt shared storage.
  const stopA = await alpha.stop()
  await settle()
  check(
    'shared-stop-isolated',
    stopA.status === 'applied' && alpha.lifecycle() === 'stopped' && beta.lifecycle() === 'running',
    'Stop on one session must not change another session',
  )
  check(
    'shared-stop-store-intact',
    (await store.readSession(sessionB)).length > 0 &&
      (await history.confirmedHistory(sessionA)).length === 1,
    'a Stop must not corrupt shared storage',
  )

  // Exact post-Stop snapshots, taken immediately before the other session's
  // failed write, prove an isolated failure elsewhere leaves them untouched.
  const eventsASnapshot = await store.readSession(sessionA)
  const historyASnapshot = await history.confirmedHistory(sessionA)
  const alphaLifecycleSnapshot = alpha.lifecycle()
  const betaLifecycleSnapshot = beta.lifecycle()

  // A storage failure in one session must degrade only that session.
  await beta.accept('beta before failure', 'shared-b-2')
  failNextDeliveryCommit()
  const failedTurn = await beta.runTurn()
  await settle()
  check(
    'shared-failure-isolated',
    failedTurn.status === 'degraded' && beta.lifecycle() === 'degraded',
    'a storage failure must degrade the owning session',
  )
  check(
    'shared-failure-no-delivery',
    beta.deliveries().length === 1,
    'a failed commit must not add a delivery',
  )
  check(
    'shared-failure-other-session-intact',
    sameJson(await store.readSession(sessionA), eventsASnapshot) &&
      sameJson(await history.confirmedHistory(sessionA), historyASnapshot) &&
      alpha.lifecycle() === alphaLifecycleSnapshot &&
      betaLifecycleSnapshot === 'running' &&
      alpha.lifecycle() === 'stopped',
    'a storage failure in one session must not change another session records or history',
  )

  return violations()
}
