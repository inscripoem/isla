import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEventStore,
  createHistoryQuery,
  createRecoveryView,
} from '../../src/storage'
import {
  createSqliteBackend,
  migrate,
  openDatabase,
  resolveStorageConfig,
} from '../../src/storage/sqlite'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { createControlledMediaDriver } from '../support/m1-kit'

/**
 * M6-01 acceptance: the real M5/M1/M6 application loop over a SQLite store.
 *
 * This test joins the two existing proofs:
 * - `i1-application.test.ts` runs the app loop over an in-memory M6 store;
 * - `m6-recovery.test.ts` proves SQLite reopen restores only confirmed history.
 *
 * It proves the combination: one completed turn and one interrupted turn are
 * written through the application path, the database is closed and reopened, and
 * only the confirmed turn is restored. The interrupted turn remains unresolved
 * and is never replayed as spoken history.
 *
 * Storage reopen is not application/process restart. #45 covers lifecycle
 * recovery over an existing store; neither test proves process-crash recovery.
 * The injected media driver emits controlled events, so this is API evidence,
 * not acoustic proof.
 */

const directories: string[] = []
const harnesses: LoopHarness[] = []
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

async function closeHarness(harness: LoopHarness): Promise<void> {
  const index = harnesses.indexOf(harness)
  if (index >= 0) harnesses.splice(index, 1)
  await harness.close()
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close().catch(() => {})
  for (const db of databases.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  const ack = await harness.client.bootstrapOperator(token)
  expect(ack.kind).toBe('operator.ack')
  expect((await harness.client.attach()).kind).toBe('session.attach.ack')
  expect(((await harness.client.resume()).payload as { status: string }).status).toBe('applied')
}

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 4_000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('M6-01 app-loop SQLite recovery (C-32/C-33, INV-12)', () => {
  it('restores only confirmed history after the app loop writes SQLite and reopens', async () => {
    const config = tempConfig()
    const db1 = openFresh(config)
    const backend1 = createSqliteBackend(db1)
    const media = createControlledMediaDriver({ autoEvents: true })
    const harness = await createLoopHarness({ backend: backend1, media })
    harnesses.push(harness)
    await boot(harness)

    const sessionId = harness.currentSessionId()
    const store1 = createEventStore(backend1)
    const history1 = createHistoryQuery(backend1)

    // One completed turn is confirmed spoken history. Wait until that turn
    // leaves the active slot, rather than only for the first record, so a
    // multi-segment turn is fully captured before the interrupted turn starts.
    await harness.client.input('a first confirmed question')
    const firstConfirmed = await until(
      async () => (await history1.confirmedHistory(sessionId)),
      (records) => records.length > 0,
    )
    const firstTurnId = firstConfirmed[0]?.turnId
    if (firstTurnId === undefined) throw new Error('first turn was not identified')
    await until(
      async () => (await harness.composition.coordinator.endpoint.snapshot()).activeTurnId,
      (activeTurnId) => activeTurnId !== firstTurnId,
    )
    const confirmedBefore = (await history1.confirmedHistory(sessionId)).filter(
      (record) => record.turnId === firstTurnId,
    )
    expect(confirmedBefore.length).toBeGreaterThan(0)
    for (const record of confirmedBefore) {
      expect(record).toMatchObject({
        sessionId,
        classification: 'fully-delivered',
        personaProfileId: 'character-i1',
        personaProfileVersion: '1',
      })
      expect(record.segmentIndex).not.toBeNull()
      expect(record.text.length).toBeGreaterThan(0)
      expect(record.textHash.length).toBeGreaterThan(0)
    }

    // The second turn starts playing, then Stop interrupts it. Capture the
    // outputs that were already started so the wait cannot match the first turn.
    const startedBefore = new Set(
      harness.client
        .receipts()
        .filter((receipt) => receipt.stage === 'started')
        .map((receipt) => receipt.outputId),
    )
    media.holdEndedFrom(media.createCount())
    await harness.client.input('an interrupted question')
    await until(
      () =>
        harness.client
          .receipts()
          .some((receipt) => receipt.stage === 'started' && !startedBefore.has(receipt.outputId)),
      (started) => started,
    )
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')

    const secondDelivery = await until(
      () =>
        harness.composition
          .coordinator
          .deliveries()
          .find((delivery) => delivery.turnId !== firstTurnId),
      (delivery) => delivery !== undefined,
    )
    const secondTurnId = secondDelivery?.turnId
    if (secondTurnId === undefined) throw new Error('interrupted turn was not identified')

    const confirmedAtRuntime = (await history1.confirmedHistory(sessionId)).filter(
      (record) => record.turnId === firstTurnId,
    )
    expect(confirmedAtRuntime).toEqual(confirmedBefore)
    expect(
      (await history1.confirmedHistory(sessionId)).filter(
        (record) => record.turnId === secondTurnId,
      ),
    ).toEqual([])

    const unresolvedBefore = createRecoveryView(backend1).unresolved(sessionId)
    expect(unresolvedBefore.filter((entry) => entry.record.turnId === firstTurnId)).toEqual([])
    const unresolvedSecond = unresolvedBefore.filter(
      (entry) => entry.record.turnId === secondTurnId,
    )
    expect(unresolvedSecond.length).toBeGreaterThan(0)
    for (const entry of unresolvedSecond) {
      expect(entry.record.classification).not.toBe('fully-delivered')
      expect(entry.terminalOutcome).not.toBe('completed')
    }

    const storedBefore = backend1.storedDeliveries()
    expect(
      storedBefore
        .filter((entry) => entry.record.turnId === firstTurnId)
        .every((entry) => entry.record.classification === 'fully-delivered'),
    ).toBe(true)
    expect(
      storedBefore
        .filter((entry) => entry.record.turnId === secondTurnId)
        .some((entry) => entry.record.classification !== 'fully-delivered'),
    ).toBe(true)

    const eventsBefore = await store1.readSession(sessionId)
    expect(eventsBefore.length).toBeGreaterThan(0)

    await closeHarness(harness)
    closeDatabase(db1)

    // Reopen the same database and read through fresh ports: this is a storage
    // reopen, not application/process restart.
    const db2 = openFresh(config)
    const backend2 = createSqliteBackend(db2)
    const history2 = createHistoryQuery(backend2)
    const recovery2 = createRecoveryView(backend2)
    const store2 = createEventStore(backend2)

    const confirmedAfter = (await history2.confirmedHistory(sessionId)).filter(
      (record) => record.turnId === firstTurnId,
    )
    expect(confirmedAfter).toEqual(confirmedBefore)
    expect(
      (await history2.confirmedHistory(sessionId)).filter(
        (record) => record.turnId === secondTurnId,
      ),
    ).toEqual([])

    const unresolvedAfter = recovery2
      .unresolved(sessionId)
      .filter((entry) => entry.record.turnId === secondTurnId)
    expect(unresolvedAfter).toEqual(unresolvedSecond)
    expect(recovery2.unresolved(sessionId).some((entry) => entry.record.turnId === firstTurnId)).toBe(false)
    expect(await store2.readSession(sessionId)).toEqual(eventsBefore)

    const storedAfter = backend2.storedDeliveries()
    expect(
      storedAfter
        .filter((entry) => entry.record.turnId === firstTurnId)
        .every((entry) => entry.record.classification === 'fully-delivered'),
    ).toBe(true)
    expect(
      storedAfter
        .filter((entry) => entry.record.turnId === secondTurnId)
        .some((entry) => entry.record.classification !== 'fully-delivered'),
    ).toBe(true)

    closeDatabase(db2)
  })

  it('reopens with empty confirmed history when nothing completed', async () => {
    const config = tempConfig()
    const db1 = openFresh(config)
    const backend1 = createSqliteBackend(db1)
    const harness = await createLoopHarness({ backend: backend1 })
    harnesses.push(harness)
    await boot(harness)

    const sessionId = harness.currentSessionId()
    expect(await harness.confirmedHistory()).toEqual([])
    expect(backend1.storedDeliveries()).toEqual([])

    await closeHarness(harness)
    closeDatabase(db1)

    const db2 = openFresh(config)
    const backend2 = createSqliteBackend(db2)
    expect(await createHistoryQuery(backend2).confirmedHistory(sessionId)).toEqual([])
    expect(createRecoveryView(backend2).unresolved(sessionId)).toEqual([])
    expect(backend2.storedDeliveries()).toEqual([])

    closeDatabase(db2)
  })
})
