import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LATEST_SCHEMA_VERSION,
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
