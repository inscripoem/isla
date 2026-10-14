import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectStorageViolations } from '../conformance/storage.conformance'
import {
  FIXTURE_SESSION_ID,
  fixtureCommitDelivery,
  fixtureRuntimeEvent,
} from '../support/fixture-data'
import {
  createEventStore,
  createHistoryQuery,
  createMemoryProjection,
  type StorageBackend,
  type StorageMutation,
} from '../../src/storage'
import {
  createSqliteBackend,
  migrate,
  openDatabase,
  resolveStorageConfig,
} from '../../src/storage/sqlite'

const cleanups: string[] = []
function tempConfig(): { dbPath: string; backupDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'isla-sqlite-backend-'))
  cleanups.push(dir)
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(dir, 'isla.db') }, dir)
}
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

function openMigrated(config: { dbPath: string; backupDir: string }) {
  const db = openDatabase(config.dbPath)
  migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
  return db
}

/** Test-only fault injection over any backend (mirrors the in-memory approach). */
function withFailNextCommit(backend: StorageBackend): {
  backend: StorageBackend
  failNextCommit: () => void
} {
  let shouldFail = false
  return {
    backend: {
      ...backend,
      commit: (mutations: readonly unknown[]): void => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('simulated storage failure')
        }
        ;(backend.commit as (m: readonly unknown[]) => void)(mutations)
      },
    },
    failNextCommit: () => {
      shouldFail = true
    },
  }
}

describe('M6 SQLite backend conformance (C-29)', () => {
  it('passes the storage conformance suite over SQLite', async () => {
    const config = tempConfig()
    const db = openMigrated(config)
    const violations = await collectStorageViolations(() => {
      const { backend, failNextCommit } = withFailNextCommit(createSqliteBackend(db))
      return {
        store: createEventStore(backend),
        projection: createMemoryProjection(),
        history: createHistoryQuery(backend),
        setFailNextCommit: failNextCommit,
      }
    })
    expect(violations).toEqual([])
    db.close()
  })
})

describe('M6 SQLite persistence and isolation (C-30/C-31)', () => {
  it('persists the delivery terminal outcome for recovery (C-17)', async () => {
    const config = tempConfig()
    const db = openMigrated(config)
    const store = createEventStore(createSqliteBackend(db))
    await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't-partial',
        segmentId: 's-partial',
        textHash: 'h-partial',
        text: 'half',
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-partial', seq: 1, type: 'delivery.committed' }),
    )
    const row = db
      .prepare('SELECT terminal_outcome FROM deliveries WHERE turn_id = ?')
      .get('t-partial') as { terminal_outcome: string } | undefined
    expect(row?.terminal_outcome).toBe('cancelled')
    db.close()
  })

  it('survives reopen with ordered confirmed history', async () => {
    const config = tempConfig()
    const db1 = openMigrated(config)
    const store1 = createEventStore(createSqliteBackend(db1))
    // Commit a later supporting-event seq first, then an earlier one.
    await store1.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't-late',
        segmentId: 's-late',
        textHash: 'h-late',
        text: 'late',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-late', seq: 5, type: 'delivery.committed' }),
    )
    await store1.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        turnId: 't-early',
        segmentId: 's-early',
        textHash: 'h-early',
        text: 'early',
      }),
      fixtureRuntimeEvent({ eventId: 'evt-early', seq: 2, type: 'delivery.committed' }),
    )
    db1.close()

    const db2 = openMigrated(config)
    const store2 = createEventStore(createSqliteBackend(db2))
    const events = await store2.readSession(FIXTURE_SESSION_ID)
    expect(events.map((event) => event.eventId)).toEqual(['evt-early', 'evt-late'])

    const history = createHistoryQuery(createSqliteBackend(db2))
    const confirmed = await history.confirmedHistory(FIXTURE_SESSION_ID)
    expect(confirmed.map((record) => record.text)).toEqual(['early', 'late'])
    db2.close()
  })

  it('keeps sessions isolated across reopen', async () => {
    const config = tempConfig()
    const db1 = openMigrated(config)
    const store1 = createEventStore(createSqliteBackend(db1))
    await store1.append(
      fixtureRuntimeEvent({ sessionId: 'session-alpha', eventId: 'evt-shared', seq: 1 }),
    )
    await store1.append(
      fixtureRuntimeEvent({ sessionId: 'session-beta', eventId: 'evt-shared', seq: 1 }),
    )
    db1.close()

    const db2 = openMigrated(config)
    const store2 = createEventStore(createSqliteBackend(db2))
    expect((await store2.readSession('session-alpha')).map((event) => event.eventId)).toEqual([
      'evt-shared',
    ])
    expect((await store2.readSession('session-beta')).map((event) => event.eventId)).toEqual([
      'evt-shared',
    ])
    expect(await store2.exportJsonl('session-alpha')).not.toContain('session-beta')
    db2.close()
  })
})

describe('M6 SQLite batch atomicity (C-42)', () => {
  it('rolls back the whole batch when a later mutation fails', () => {
    const config = tempConfig()
    const db = openMigrated(config)
    const backend = createSqliteBackend(db)

    const first: StorageMutation = {
      kind: 'event',
      event: fixtureRuntimeEvent({ eventId: 'tx-1', seq: 1 }),
    }
    // Same event identity in the same session -> PRIMARY KEY violation on the
    // second insert, i.e. a failure *after* the first mutation was applied.
    const second: StorageMutation = {
      kind: 'event',
      event: fixtureRuntimeEvent({ eventId: 'tx-1', seq: 2 }),
    }

    expect(() => backend.commit([first, second])).toThrow()
    // The whole batch rolled back: no partial state in any index.
    expect(backend.sessionEvents(FIXTURE_SESSION_ID)).toHaveLength(0)
    expect(backend.sequenceOwner(FIXTURE_SESSION_ID, 1)).toBeUndefined()
    expect(backend.sequenceOwner(FIXTURE_SESSION_ID, 2)).toBeUndefined()
    db.close()
  })
})
