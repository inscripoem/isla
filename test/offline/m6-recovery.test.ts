import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEventStore,
  createInMemoryBackend,
  createMemoryProjection,
  createRecoveryView,
} from '../../src/storage'
import type { EventStorePort } from '../../src/contracts'
import {
  LATEST_SCHEMA_VERSION,
  createSqliteBackend,
  migrate,
  openDatabase,
  resolveStorageConfig,
} from '../../src/storage/sqlite'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureRuntimeEvent,
} from '../support/fixture-data'

const cleanups: string[] = []
function tempConfig(): { dbPath: string; backupDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'isla-recovery-'))
  cleanups.push(dir)
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(dir, 'isla.db') }, dir)
}
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

/** A session with one completed segment and one interrupted (unresolved) segment. */
async function seed(store: EventStorePort): Promise<void> {
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      turnId: 't-ok',
      segmentId: 's-ok',
      textHash: 'h-ok',
      text: 'done',
      classification: 'fully-delivered',
      terminalOutcome: 'completed',
    }),
    fixtureRuntimeEvent({ eventId: 'evt-ok', seq: 1, type: 'delivery.committed' }),
  )
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      turnId: 't-cut',
      segmentId: 's-cut',
      textHash: 'h-cut',
      text: 'half',
      classification: 'partial-unknown',
      terminalOutcome: 'unknown',
    }),
    fixtureRuntimeEvent({ eventId: 'evt-cut', seq: 2, type: 'delivery.committed' }),
  )
}

describe('M6 recovery view (C-32)', () => {
  it('separates confirmed history from unresolved records (in-memory)', async () => {
    const backend = createInMemoryBackend()
    await seed(createEventStore(backend))
    const recovery = createRecoveryView(backend)

    expect(recovery.confirmed(FIXTURE_SESSION_ID).map((record) => record.text)).toEqual(['done'])
    const unresolved = recovery.unresolved(FIXTURE_SESSION_ID)
    expect(unresolved.map((entry) => entry.record.text)).toEqual(['half'])
    expect(unresolved[0]?.terminalOutcome).toBe('unknown')
  })
})

describe('M6 restart recovery (C-33)', () => {
  it('restores only confirmed history after reopen and keeps the rest unknown (no replay)', async () => {
    const config = tempConfig()
    const db1 = openDatabase(config.dbPath)
    migrate(db1, { dbPath: config.dbPath, backupDir: config.backupDir })
    await seed(createEventStore(createSqliteBackend(db1)))
    db1.close()

    const db2 = openDatabase(config.dbPath)
    migrate(db2, { dbPath: config.dbPath, backupDir: config.backupDir })
    const backend2 = createSqliteBackend(db2)
    const recovery = createRecoveryView(backend2)

    // Only the completed segment is spoken history; the interrupted one is not.
    expect(recovery.confirmed(FIXTURE_SESSION_ID).map((record) => record.text)).toEqual(['done'])
    expect(
      recovery.unresolved(FIXTURE_SESSION_ID).map((entry) => ({
        text: entry.record.text,
        outcome: entry.terminalOutcome,
      })),
    ).toEqual([{ text: 'half', outcome: 'unknown' }])

    // Export agrees with the stored events, in order.
    const store2 = createEventStore(backend2)
    const events = await store2.readSession(FIXTURE_SESSION_ID)
    expect(events.map((event) => event.eventId)).toEqual(['evt-ok', 'evt-cut'])
    const jsonl = await store2.exportJsonl(FIXTURE_SESSION_ID)
    expect(jsonl.split('\n').filter((line) => line.length > 0)).toHaveLength(2)
    db2.close()
  })

  it('re-derives the memory projection from committed events after restart', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    await store.append(fixtureRuntimeEvent({ eventId: 'e1', seq: 1 }))
    await store.append(fixtureRuntimeEvent({ eventId: 'e2', seq: 2 }))

    const projection = createMemoryProjection()
    for (const event of await store.readSession(FIXTURE_SESSION_ID)) await projection.apply(event)
    expect(projection.appliedSeq()).toBe(2)
  })

  it('refuses to start on an unsupported schema version (evidence unavailable)', () => {
    const config = tempConfig()
    const db = openDatabase(config.dbPath)
    migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    db.prepare('UPDATE schema_version SET version = ?').run(LATEST_SCHEMA_VERSION + 1)
    expect(() => migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })).toThrow(
      /unsupported schema version/,
    )
    db.close()
  })
})
