import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * M6 storage — schema versioning and migrations (B1; INV-09, INV-10).
 *
 * Guarantees
 * ----------
 * - INV-09: an unsupported (newer) `schema_version` is rejected, never silently
 *   opened or forward-migrated.
 * - INV-10: before applying pending migrations to a database that already holds
 *   schema, the file is backed up (WAL checkpointed first so the copy is
 *   complete); every pending migration and the version bump apply as one
 *   transaction, so a failure rolls back and leaves the prior version intact.
 * - Idempotent: re-running `migrate` on an up-to-date database is a no-op.
 *
 * `schema_version` is independent of the application contract version (`0.2`)
 * and the diagnostic protocol version (1).
 *
 * The migration set is injected (default: the built-in set) so the atomic-apply
 * path can be exercised with a deliberately failing migration — the same
 * dependency-injection discipline as the storage backend.
 */

/** Highest schema version this build knows how to produce. */
export const LATEST_SCHEMA_VERSION = 2

export interface Migration {
  readonly version: number
  up(database: DatabaseSync): void
}

const BUILT_IN_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS events (
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp_ms REAL NOT NULL,
          epoch INTEGER NOT NULL,
          turn_id TEXT,
          segment_id TEXT,
          output_id TEXT,
          type TEXT NOT NULL,
          source_module TEXT NOT NULL,
          versions TEXT,
          payload TEXT NOT NULL,
          PRIMARY KEY (session_id, event_id),
          UNIQUE (session_id, seq)
        )
      `)
      database.exec(`
        CREATE TABLE IF NOT EXISTS deliveries (
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          segment_id TEXT NOT NULL,
          modality TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          text TEXT NOT NULL,
          output_id TEXT,
          receipt_id TEXT,
          classification TEXT NOT NULL,
          terminal_outcome TEXT NOT NULL,
          persona_version TEXT,
          event_seq INTEGER NOT NULL,
          PRIMARY KEY (session_id, turn_id, segment_id, modality)
        )
      `)
    },
  },
  {
    version: 2,
    up(database) {
      // #22 delivery attribution: preserve the original segment index and the
      // generating persona identity/version. Existing (legacy) rows keep NULL —
      // values are never inferred from identifiers or the current persona.
      // The legacy `persona_version` column (migration 1) is retained read-only.
      // Guarded by an introspection check so the migration is safe to re-run.
      const columns = new Set(
        (database.prepare('PRAGMA table_info(deliveries)').all() as { name: string }[]).map(
          (column) => column.name,
        ),
      )
      const added: readonly (readonly [string, string])[] = [
        ['segment_index', 'INTEGER'],
        ['persona_profile_id', 'TEXT'],
        ['persona_profile_version', 'TEXT'],
      ]
      for (const [name, type] of added) {
        if (!columns.has(name)) database.exec(`ALTER TABLE deliveries ADD COLUMN ${name} ${type}`)
      }
    },
  },
]

export interface MigrationIO {
  /** Path to the database file (for the pre-migration backup). */
  dbPath: string
  /** Directory for backups. */
  backupDir: string
  /** Stable timestamp for the backup name (tests); defaults to `Date.now()`. */
  timestampMs?: number
}

export interface MigrationResult {
  from: number
  to: number
  backedUp: boolean
}

function ensureVersionTable(database: DatabaseSync): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
}

/** Read the current schema version, creating the version table when absent. */
export function readSchemaVersion(database: DatabaseSync): number {
  ensureVersionTable(database)
  const row = database.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  if (row === undefined) {
    database.exec('INSERT INTO schema_version (version) VALUES (0)')
    return 0
  }
  return row.version
}

function databaseHasSchema(database: DatabaseSync): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get()
  return row !== undefined
}

/**
 * Apply all pending migrations. Rejects an unsupported schema version; backs up
 * an existing database (after a WAL checkpoint) before changing it; applies
 * every pending migration and the version bump atomically; idempotent when
 * already current.
 */
export function migrate(
  database: DatabaseSync,
  io: MigrationIO,
  migrations: readonly Migration[] = BUILT_IN_MIGRATIONS,
): MigrationResult {
  const latest = migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
  const current = readSchemaVersion(database)
  if (current > latest) {
    throw new RangeError(`unsupported schema version ${current}; this build supports up to ${latest}`)
  }
  if (current === latest) {
    return { from: current, to: current, backedUp: false }
  }

  const pending = migrations.filter((migration) => migration.version > current)

  let backedUp = false
  if (databaseHasSchema(database) && existsSync(io.dbPath)) {
    // WAL: flush committed data into the main file so the backup is complete
    // and self-contained (copying the .db alone could miss the -wal contents).
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    mkdirSync(io.backupDir, { recursive: true })
    const stamp = io.timestampMs ?? Date.now()
    copyFileSync(io.dbPath, join(io.backupDir, `isla-v${current}-${stamp}.db`))
    backedUp = true
  }

  // Apply every pending migration and the version bump as one atomic unit, so a
  // failure leaves neither partial schema nor a bumped version.
  database.exec('BEGIN')
  try {
    for (const migration of pending) migration.up(database)
    database.prepare('UPDATE schema_version SET version = ?').run(latest)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return { from: current, to: latest, backedUp }
}
