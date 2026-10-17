import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEventStore } from '../../src/storage'
import {
  LATEST_SCHEMA_VERSION,
  createSqliteBackend,
  migrate,
  openDatabase,
  readSchemaVersion,
} from '../../src/storage/sqlite'
import { FIXTURE_SESSION_ID, fixtureRuntimeEvent } from '../support/fixture-data'

/**
 * M6-01 — durability: recovery from the files a crash leaves behind.
 *
 * `m6-recovery.test.ts` reopens a database that was **closed cleanly**, so the WAL is
 * already checkpointed and recovery never runs. This test copies `isla.db` and its
 * `-wal` exactly as they sit on disk after committed writes, and requires a fresh
 * handle over that copy to:
 *
 *   1. recover every **committed** row,
 *   2. keep the schema version, so no migration is re-run or half-applied.
 *
 * Honest limitation: it reproduces the on-disk state a crash leaves for **committed**
 * data, not a real process kill. It does **not** cover an uncommitted WAL tail: SQLite
 * keeps the dirty pages of a small uncommitted transaction in the page cache and only
 * writes frames at COMMIT or when the cache spills, so a one-row `BEGIN`/`INSERT`
 * leaves the `-wal` byte-identical (review #42 verified the same size and SHA-256 on
 * this fixture). Proving that case needs either a cache-spill fixture or a real killed
 * subprocess, and neither is asserted here.
 */

const directories: string[] = []
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('M6-01 durability — recovery from a crash-state copy (INV-12, FR-06)', () => {
  it('recovers committed rows from a crash-state copy and keeps the version', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'm6-crash-'))
    directories.push(directory)
    const dbPath = join(directory, 'isla.db')
    const backupDir = join(directory, 'backups')

    const db = openDatabase(dbPath)
    migrate(db, { dbPath, backupDir })
    const store = createEventStore(createSqliteBackend(db))

    for (let index = 1; index <= 3; index += 1) {
      const ack = await store.append(
        fixtureRuntimeEvent({
          eventId: `committed-${index}`,
          seq: index,
          turnId: 'turn-1',
          segmentId: `seg-${index}`,
        }),
      )
      expect(ack).toMatchObject({ outcome: 'stored' })
    }

    // Copy the files exactly as a crash would leave them, then abandon the handle.
    // The `-wal` holds the committed frames that were not checkpointed yet: recovering
    // them is what this case proves, and the assertion below is what makes the copy
    // meaningful rather than an empty file.
    const crashed = join(directory, 'crashed')
    mkdirSync(crashed, { recursive: true })
    copyFileSync(dbPath, join(crashed, 'isla.db'))
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    const walBytes = statSync(`${dbPath}-wal`).size
    expect(walBytes).toBeGreaterThan(0)
    copyFileSync(`${dbPath}-wal`, join(crashed, 'isla.db-wal'))
    expect(statSync(join(crashed, 'isla.db-wal')).size).toBe(walBytes)
    if (existsSync(`${dbPath}-shm`)) copyFileSync(`${dbPath}-shm`, join(crashed, 'isla.db-shm'))
    db.close()

    // A fresh handle over the crash copy recovers the committed state.
    const recovered = openDatabase(join(crashed, 'isla.db'))
    expect(readSchemaVersion(recovered)).toBe(LATEST_SCHEMA_VERSION)

    const events = await createEventStore(createSqliteBackend(recovered)).readSession(FIXTURE_SESSION_ID)
    expect(events.map((event) => event.eventId)).toEqual(['committed-1', 'committed-2', 'committed-3'])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
    recovered.close()
  })

  it('does not lose a committed row when the writer is abandoned without a clean close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'm6-abandon-'))
    directories.push(directory)
    const dbPath = join(directory, 'isla.db')
    const backupDir = join(directory, 'backups')

    const writer = openDatabase(dbPath)
    migrate(writer, { dbPath, backupDir })
    const store = createEventStore(createSqliteBackend(writer))
    expect(
      await store.append(fixtureRuntimeEvent({ eventId: 'durable-1', seq: 1, turnId: 'turn-1', segmentId: 'seg-1' })),
    ).toMatchObject({ outcome: 'stored' })

    // No close, no checkpoint: a second handle must already see the committed row.
    const reader = openDatabase(dbPath)
    const seen = await createEventStore(createSqliteBackend(reader)).readSession(FIXTURE_SESSION_ID)
    expect(seen.map((event) => event.eventId)).toEqual(['durable-1'])

    reader.close()
    writer.close()
  })
})
