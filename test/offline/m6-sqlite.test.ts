import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILT_IN_MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  createSqliteBackend,
  migrate,
  openDatabase,
  readSchemaVersion,
  resolveStorageConfig,
} from '../../src/storage/sqlite'

const cleanups: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'isla-sqlite-'))
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

function configIn(dir: string) {
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(dir, 'isla.db') }, dir)
}

describe('M6 SQLite config (C-26)', () => {
  it('defaults to .cache/isla/isla.db with a sibling backups dir', () => {
    const cwd = '/tmp/project'
    const config = resolveStorageConfig({}, cwd)
    expect(config.dbPath).toBe(join(cwd, '.cache/isla/isla.db'))
    expect(config.backupDir).toBe(join(cwd, '.cache/isla/backups'))
  })

  it('honours an absolute override', () => {
    const config = resolveStorageConfig({ ISLA_STORAGE_DB_PATH: '/var/data/isla.db' }, '/tmp/project')
    expect(config.dbPath).toBe('/var/data/isla.db')
    expect(config.backupDir).toBe('/var/data/backups')
  })

  it('resolves a relative override against cwd', () => {
    const config = resolveStorageConfig({ ISLA_STORAGE_DB_PATH: 'data/isla.db' }, '/tmp/project')
    expect(config.dbPath).toBe('/tmp/project/data/isla.db')
  })

  it('rejects an empty override (fail-fast, never a silent default)', () => {
    expect(() => resolveStorageConfig({ ISLA_STORAGE_DB_PATH: '   ' }, '/tmp/project')).toThrow()
  })
})

describe('M6 SQLite migrations (C-27)', () => {
  it('creates the schema and version on a fresh database', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    const result = migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    expect(result).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION, backedUp: false })
    expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(tables).toContain('events')
    expect(tables).toContain('deliveries')
    expect(tables).toContain('schema_version')
    db.close()
  })

  it('is idempotent when re-run', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    const again = migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    expect(again).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION, backedUp: false })
    db.close()
  })

  it('rejects an unsupported schema version', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    db.prepare('UPDATE schema_version SET version = ?').run(LATEST_SCHEMA_VERSION + 1)
    expect(() => migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })).toThrow(
      /unsupported schema version/,
    )
    db.close()
  })

  it('backs up an existing database before applying pending migrations', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    // Force a pending migration on a database that already holds schema.
    db.prepare('UPDATE schema_version SET version = 0').run()
    const result = migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir, timestampMs: 123 })
    expect(result.backedUp).toBe(true)
    expect(existsSync(config.backupDir)).toBe(true)
    expect(readdirSync(config.backupDir).some((name) => name.endsWith('.db'))).toBe(true)
    db.close()
  })

  it('backs up a complete, self-contained snapshot while a reader pins the WAL', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })

    const insertEvent = (eventId: string, seq: number): void => {
      db.prepare(
        `INSERT INTO events
           (session_id, event_id, seq, timestamp_ms, epoch, type, source_module, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', eventId, seq, seq, 0, 'user-input', 'M5', '{}')
    }

    insertEvent('e1', 1)
    // A second connection pins a snapshot taken before the next commit, so a
    // `wal_checkpoint(TRUNCATE)` cannot flush the newer frame (`busy = 1`).
    // Copying the `.db` file then yields a truncated — historically malformed —
    // backup; `VACUUM INTO` must still capture every committed row.
    const reader = openDatabase(config.dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT * FROM events').all()
    insertEvent('e2', 2)

    // Force a pending migration so the pre-migration backup runs.
    db.prepare('UPDATE schema_version SET version = 0').run()
    const result = migrate(db, {
      dbPath: config.dbPath,
      backupDir: config.backupDir,
      timestampMs: 123,
    })
    expect(result.backedUp).toBe(true)
    reader.exec('ROLLBACK')
    reader.close()

    const backupPath = join(config.backupDir, 'isla-v0-123.db')
    expect(existsSync(backupPath)).toBe(true)
    const backup = openDatabase(backupPath)
    // Assert the backup *contents*, not just that a file exists.
    const ids = (backup.prepare('SELECT event_id FROM events ORDER BY seq').all() as {
      event_id: string
    }[]).map((row) => row.event_id)
    expect(ids).toEqual(['e1', 'e2'])
    expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    backup.close()
    db.close()
  })

  it('fails closed when the pre-migration backup cannot be produced', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    // v1 creates the `events` table, so the database counts as holding schema.
    migrate(
      db,
      { dbPath: config.dbPath, backupDir: config.backupDir },
      [
        {
          version: 1,
          up(database) {
            database.exec('CREATE TABLE IF NOT EXISTS events (session_id TEXT, event_id TEXT)')
          },
        },
      ],
    )
    db.prepare('INSERT INTO events (session_id, event_id) VALUES (?, ?)').run('s1', 'e1')
    // A regular file occupies the backups path, so no snapshot can be written.
    writeFileSync(config.backupDir, 'occupied')

    expect(() =>
      migrate(
        db,
        { dbPath: config.dbPath, backupDir: config.backupDir, timestampMs: 1 },
        [
          { version: 1, up() {} },
          {
            version: 2,
            up(database) {
              database.exec('CREATE TABLE marker (x)')
            },
          },
        ],
      ),
    ).toThrow()

    // No schema change and no version bump: the migration did not run.
    const marker = db.prepare("SELECT name FROM sqlite_master WHERE name = 'marker'").all()
    expect(marker).toHaveLength(0)
    expect(readSchemaVersion(db)).toBe(1)
    db.close()
  })

  it('rolls back a failed migration, leaving the prior version intact', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openDatabase(config.dbPath)
    expect(() =>
      migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir }, [
        {
          version: 1,
          up(database) {
            database.exec('CREATE TABLE partial (x)')
            throw new Error('migration boom')
          },
        },
      ]),
    ).toThrow(/migration boom/)
    expect(readSchemaVersion(db)).toBe(0)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'")
      .all()
    expect(tables).toHaveLength(0)
    db.close()
  })

  it('rejects a path that is a directory', () => {
    const dir = tempDir()
    expect(() => openDatabase(dir)).toThrow(/directory/)
  })
})

describe('M6 SQLite legacy attribution migration (C-48)', () => {
  function openLegacyV1(config: { dbPath: string; backupDir: string }) {
    const db = openDatabase(config.dbPath)
    migrate(
      db,
      { dbPath: config.dbPath, backupDir: config.backupDir },
      BUILT_IN_MIGRATIONS.filter((migration) => migration.version === 1),
    )
    return db
  }

  function insertLegacyDelivery(
    db: ReturnType<typeof openDatabase>,
    classification: string,
    outcome: string,
    personaVersion: string | null,
  ): void {
    db.prepare(
      `INSERT INTO deliveries
         (session_id, turn_id, segment_id, modality, text_hash, text, output_id, receipt_id,
          classification, terminal_outcome, persona_version, event_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      's1',
      't1',
      'seg1',
      'audio',
      'h1',
      'spoken',
      null,
      null,
      classification,
      outcome,
      personaVersion,
      1,
    )
  }

  it('preserves legacy NULL attribution across the v2 migration, and drops the legacy column', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openLegacyV1(config)
    insertLegacyDelivery(db, 'fully-delivered', 'completed', null)

    const result = migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })
    expect(result.to).toBe(LATEST_SCHEMA_VERSION)
    db.close()

    const reopened = openDatabase(config.dbPath)
    const stored = createSqliteBackend(reopened).storedDeliveries()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.record.segmentIndex).toBeNull()
    expect(stored[0]!.record.personaProfileId).toBeNull()
    expect(stored[0]!.record.personaProfileVersion).toBeNull()
    const columns = (
      reopened.prepare('PRAGMA table_info(deliveries)').all() as { name: string }[]
    ).map((column) => column.name)
    expect(columns).not.toContain('persona_version')
    reopened.close()
  })

  it('refuses a contradictory classification/outcome row and preserves the database', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openLegacyV1(config)
    insertLegacyDelivery(db, 'fully-delivered', 'cancelled', null)

    expect(() => migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })).toThrow(
      /contradict/,
    )
    expect(readSchemaVersion(db)).toBe(1)
    db.close()
  })

  it('refuses to drop persona_version when a legacy value is non-NULL', () => {
    const dir = tempDir()
    const config = configIn(dir)
    const db = openLegacyV1(config)
    insertLegacyDelivery(db, 'fully-delivered', 'completed', 'legacy-persona@1')

    expect(() => migrate(db, { dbPath: config.dbPath, backupDir: config.backupDir })).toThrow(
      /persona_version/,
    )
    expect(readSchemaVersion(db)).toBe(1)
    db.close()
  })
})
