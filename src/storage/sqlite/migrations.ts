import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * M6 storage — schema versioning and migrations (B1; INV-10, INV-11).
 *
 * Guarantees
 * ----------
 * - INV-10: an unsupported (newer) `schema_version` is rejected, never silently
 *   opened or forward-migrated.
 * - INV-11: before applying pending migrations to a database that already holds
 *   schema, a consistent snapshot of the database is taken (`VACUUM INTO`, which
 *   includes committed WAL content) and the migration fails closed — no schema
 *   change, no version bump — if that snapshot cannot be produced; every pending
 *   migration and the version bump then apply as one transaction, so a failure
 *   rolls back and leaves the prior version intact.
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

export const BUILT_IN_MIGRATIONS: readonly Migration[] = [
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
      // The legacy `persona_version` column (migration 1) is removed below once it is
      // verified to hold no data.
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

      // Reject contradictory legacy evidence before it can reach confirmedHistory:
      // `fully-delivered` must be `completed`; other classifications must not be.
      const contradictory = database
        .prepare(
          `SELECT COUNT(*) AS n FROM deliveries
             WHERE (classification = 'fully-delivered' AND terminal_outcome <> 'completed')
                OR (classification <> 'fully-delivered' AND terminal_outcome = 'completed')`,
        )
        .get() as { n: number }
      if (contradictory.n > 0) {
        throw new Error(
          `refusing migration: ${contradictory.n} delivery row(s) contradict the C6 classification/terminalOutcome contract; the database is preserved — agree a quarantine/archive policy before migrating`,
        )
      }

      // Remove the legacy `persona_version` column only when it holds no real data.
      // A non-NULL value means a persona attribution the contract cannot map; never
      // infer a pair from it, and preserve the database instead.
      if (columns.has('persona_version')) {
        const legacy = database
          .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE persona_version IS NOT NULL')
          .get() as { n: number }
        if (legacy.n > 0) {
          throw new Error(
            `refusing to drop deliveries.persona_version: ${legacy.n} non-NULL legacy value(s); the database is preserved — agree a mapping/archive policy (do not infer a persona pair)`,
          )
        }
        database.exec('ALTER TABLE deliveries DROP COLUMN persona_version')
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
 * Apply all pending migrations. Rejects an unsupported schema version; takes a
 * consistent pre-migration backup of an existing database (failing closed if the
 * snapshot cannot be produced) before changing it; applies every pending
 * migration and the version bump atomically; idempotent when already current.
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
    // Consistent snapshot. `VACUUM INTO` materialises the database's logical
    // content (including committed WAL frames) into a new file under a read
    // transaction, so a concurrent reader cannot yield a partial copy.
    //
    // Why not checkpoint-then-copy: `PRAGMA wal_checkpoint(TRUNCATE)` reports its
    // outcome (`busy`, `log`, `checkpointed`) rather than guaranteeing one, so a
    // reader holding a snapshot leaves `busy = 1` and the WAL unflushed — copying
    // the `.db` alone could then miss committed rows while still reporting a
    // successful backup. `VACUUM INTO` either writes a complete snapshot or
    // throws; on throw we fail closed below, before any schema change.
    mkdirSync(io.backupDir, { recursive: true })
    const stamp = io.timestampMs ?? Date.now()
    const backupPath = join(io.backupDir, `isla-v${current}-${stamp}.db`)
    rmSync(backupPath, { force: true })
    database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
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
