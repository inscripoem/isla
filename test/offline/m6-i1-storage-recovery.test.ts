import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommitDelivery } from '../../src/contracts'
import {
  createEventStore,
  createHistoryQuery,
  createMemoryProjection,
  createRecoveryView,
  createReplayReader,
} from '../../src/storage'
import {
  createSqliteBackend,
  migrate,
  openDatabase,
  resolveStorageConfig,
} from '../../src/storage/sqlite'
import type { RunnerDeps } from '../support/contract-runner'
import { createCoordinatorContractRunner } from '../support/coordinator-runner'
import * as correct from '../support/correct-ports'
import { FIXTURE_SESSION_ID } from '../support/fixture-data'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * M6-01 acceptance: the real M5 coordinator over a real SQLite M6 store.
 *
 * This uses M5's coordinator contract runner with explicit RunnerDeps: the M6
 * event store, history, replay and projection are real SQLite/in-process ports;
 * all non-storage peers are controlled fixtures. No fixture event store or
 * fixture history is used for the assertions.
 *
 * The test proves the completed/interrupted/earlier-completed/empty matrix, then
 * reads the persisted classifications and original identities after closing and
 * reopening SQLite. It is storage-reopen evidence, not application/process-crash
 * recovery, an acoustic observation or a real-provider run.
 */

const directories: string[] = []
const databases: Array<ReturnType<typeof openDatabase>> = []

function tempConfig(): { dbPath: string; backupDir: string } {
  const directory = mkdtempSync(join(tmpdir(), 'isla-m6-i1-recovery-'))
  directories.push(directory)
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(directory, 'isla.db') }, directory)
}

function openFresh(config: { dbPath: string; backupDir: string }): ReturnType<typeof openDatabase> {
  const db = openDatabase(config.dbPath)
  databases.push(db)
  migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
  return db
}

function closeDatabase(db: ReturnType<typeof openDatabase>): void {
  const index = databases.indexOf(db)
  if (index >= 0) databases.splice(index, 1)
  db.close()
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

interface RunnerKit {
  readonly runner: ReturnType<typeof createCoordinatorContractRunner>
  readonly store: ReturnType<typeof createEventStore>
  readonly history: ReturnType<typeof createHistoryQuery>
  readonly replay: ReturnType<typeof createReplayReader>
  readonly player: ReturnType<typeof correct.createFixturePlayer>
  readonly sessionId: string
}

function makeRunner(
  backend: ReturnType<typeof createSqliteBackend>,
  options: {
    dialogue?: ReturnType<typeof correct.createFixtureDialoguePort>
    player?: ReturnType<typeof correct.createFixturePlayer>
  } = {},
): RunnerKit {
  const store = createEventStore(backend)
  const history = createHistoryQuery(backend)
  const replay = createReplayReader(store)
  const player = options.player ?? correct.createFixturePlayer()
  const deps: RunnerDeps = {
    selection: correct.createFixtureSelectionPort(),
    reaction: correct.createFixtureReactionPort(),
    dialogue: options.dialogue ?? correct.createFixtureDialoguePort(),
    synthesis: correct.createFixtureSynthesisPort(),
    renderer: correct.createFixtureRendererPort(),
    player,
    commit: correct.createFixtureMemoryCommit(),
    store,
    history,
    projection: createMemoryProjection(),
    replay,
    authorizer: correct.createFixtureControlAuthorizer(),
  }
  const sessionId = FIXTURE_SESSION_ID
  return {
    runner: createCoordinatorContractRunner(createVirtualClock(), deps, {
      sessionId,
      profile: {
        characterProfileId: 'm6-recovery-character',
        characterProfileVersion: '1',
      },
    }),
    store,
    history,
    replay,
    player,
    sessionId,
  }
}

function deliveryFor(
  deliveries: readonly CommitDelivery[],
  segmentIndex: number,
): CommitDelivery | undefined {
  return deliveries.find((delivery) => delivery.segmentIndex === segmentIndex)
}

describe('M6-01 coordinator SQLite recovery (C-32/C-33, C-68, INV-12)', () => {
  it('restores only confirmed history after the coordinator writes SQLite and reopens', async () => {
    const config = tempConfig()
    const db1 = openFresh(config)
    const backend1 = createSqliteBackend(db1)
    const player = correct.createFixturePlayer({ hold: true, holdAfter: 1 })
    const { runner, store, history, sessionId } = makeRunner(backend1, { player })

    expect((await runner.resume()).status).toBe('applied')

    // One completed turn.
    await runner.accept('a first confirmed question')
    const completed = await runner.runTurn()
    expect(completed.status).toBe('completed')
    const confirmedBefore = await history.confirmedHistory(sessionId)
    expect(confirmedBefore).toHaveLength(1)
    expect(confirmedBefore[0]).toMatchObject({
      sessionId,
      classification: 'fully-delivered',
      segmentIndex: 0,
      personaProfileId: 'm6-recovery-character',
      personaProfileVersion: '1',
    })
    const firstTurnId = confirmedBefore[0]?.turnId
    if (firstTurnId === undefined) throw new Error('first turn was not identified')

    // One interrupted turn: Stop while the controlled player is holding.
    await runner.accept('an interrupted question')
    const interrupted = runner.runTurn()
    await waitUntil(() => player.status().lastStage === 'started')
    expect((await runner.stop()).status).toBe('applied')
    const stopped = await interrupted
    expect(stopped.status).not.toBe('completed')

    const deliveries = runner.deliveries()
    const secondTurnId = deliveries.find((delivery) => delivery.turnId !== firstTurnId)?.turnId
    if (secondTurnId === undefined) throw new Error('interrupted turn was not identified')
    expect(deliveries.filter((delivery) => delivery.turnId === firstTurnId)).toHaveLength(1)
    expect(
      deliveries
        .filter((delivery) => delivery.turnId === firstTurnId)
        .every((delivery) => delivery.classification === 'fully-delivered'),
    ).toBe(true)
    expect(
      deliveries
        .filter((delivery) => delivery.turnId === secondTurnId)
        .every((delivery) => delivery.classification !== 'fully-delivered'),
    ).toBe(true)

    const confirmedAtRuntime = (await history.confirmedHistory(sessionId)).filter(
      (record) => record.turnId === firstTurnId,
    )
    expect(confirmedAtRuntime).toEqual(confirmedBefore)
    expect(
      (await history.confirmedHistory(sessionId)).filter((record) => record.turnId === secondTurnId),
    ).toEqual([])

    const unresolvedBefore = createRecoveryView(backend1)
      .unresolved(sessionId)
      .filter((entry) => entry.record.turnId === secondTurnId)
    expect(unresolvedBefore.length).toBeGreaterThan(0)
    expect(unresolvedBefore.every((entry) => entry.record.classification !== 'fully-delivered')).toBe(
      true,
    )

    const eventsBefore = await store.readSession(sessionId)
    expect(eventsBefore.length).toBeGreaterThan(0)

    closeDatabase(db1)

    // Reopen the same database with fresh ports. This is storage reopen, not an
    // OS process restart or an application lifecycle claim.
    const db2 = openFresh(config)
    const backend2 = createSqliteBackend(db2)
    const store2 = createEventStore(backend2)
    const history2 = createHistoryQuery(backend2)
    const recovery2 = createRecoveryView(backend2)
    const replay2 = createReplayReader(store2)

    const confirmedAfter = (await history2.confirmedHistory(sessionId)).filter(
      (record) => record.turnId === firstTurnId,
    )
    expect(confirmedAfter).toEqual(confirmedBefore)
    expect(
      (await history2.confirmedHistory(sessionId)).filter((record) => record.turnId === secondTurnId),
    ).toEqual([])

    const unresolvedAfter = recovery2
      .unresolved(sessionId)
      .filter((entry) => entry.record.turnId === secondTurnId)
    expect(unresolvedAfter).toEqual(unresolvedBefore)
    expect(await store2.readSession(sessionId)).toEqual(eventsBefore)
    expect((await replay2.load(sessionId)).events).toEqual(eventsBefore)

    closeDatabase(db2)
  })

  it('keeps an earlier completed segment eligible and excludes the interrupted segment after reopen', async () => {
    const config = tempConfig()
    const db1 = openFresh(config)
    const backend1 = createSqliteBackend(db1)
    const player = correct.createFixturePlayer({ hold: true, holdAfter: 1 })
    const dialogue = correct.createFixtureDialoguePort({ segmentCount: 2 })
    const { runner, store, history, sessionId } = makeRunner(backend1, { player, dialogue })

    expect((await runner.resume()).status).toBe('applied')
    await runner.accept('two-segment interrupted turn')
    const interrupted = runner.runTurn()

    // The first segment completes immediately; the second is held and stopped.
    await waitUntil(() => player.status().lastStage === 'started')
    expect((await runner.stop()).status).toBe('applied')
    const stopped = await interrupted
    expect(stopped.status).not.toBe('completed')

    const deliveries = runner.deliveries()
    expect(deliveryFor(deliveries, 0)?.classification).toBe('fully-delivered')
    expect(deliveryFor(deliveries, 1)?.classification).not.toBe('fully-delivered')

    const confirmedBefore = await history.confirmedHistory(sessionId)
    expect(confirmedBefore).toHaveLength(1)
    expect(confirmedBefore[0]?.segmentIndex).toBe(0)

    const unresolvedBefore = createRecoveryView(backend1).unresolved(sessionId)
    expect(unresolvedBefore).toHaveLength(1)
    expect(unresolvedBefore[0]?.record.segmentIndex).toBe(1)
    expect(unresolvedBefore[0]?.record.classification).not.toBe('fully-delivered')

    const eventsBefore = await store.readSession(sessionId)
    closeDatabase(db1)

    const db2 = openFresh(config)
    const backend2 = createSqliteBackend(db2)
    const history2 = createHistoryQuery(backend2)
    const recovery2 = createRecoveryView(backend2)
    const store2 = createEventStore(backend2)

    expect(await history2.confirmedHistory(sessionId)).toEqual(confirmedBefore)
    expect(recovery2.unresolved(sessionId)).toEqual(unresolvedBefore)
    expect(await store2.readSession(sessionId)).toEqual(eventsBefore)

    closeDatabase(db2)
  })

  it('reopens with empty confirmed history when nothing completed', async () => {
    const config = tempConfig()
    const db1 = openFresh(config)
    const backend1 = createSqliteBackend(db1)
    const { runner, history, sessionId } = makeRunner(backend1)

    expect((await runner.resume()).status).toBe('applied')
    expect(await history.confirmedHistory(sessionId)).toEqual([])
    expect(createRecoveryView(backend1).unresolved(sessionId)).toEqual([])
    closeDatabase(db1)

    const db2 = openFresh(config)
    const backend2 = createSqliteBackend(db2)
    expect(await createHistoryQuery(backend2).confirmedHistory(sessionId)).toEqual([])
    expect(createRecoveryView(backend2).unresolved(sessionId)).toEqual([])
    closeDatabase(db2)
  })
})
