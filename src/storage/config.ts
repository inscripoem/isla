import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * M6 storage — SQLite configuration (B1; ADR-003 planned).
 *
 * The database and its backups live under ignored local storage, outside the
 * repository and outside OneDrive (PLAN line 23; AGENTS.md). Configuration is
 * validated fail-fast: an explicitly empty override is rejected rather than
 * silently defaulted (Configuration Governance).
 */

/** Default database path relative to the working directory. */
export const DEFAULT_DB_RELATIVE_PATH = '.cache/isla/isla.db'

/** Sub-directory holding pre-migration backups. */
export const BACKUP_DIR_NAME = 'backups'

export interface StorageConfig {
  /** Absolute path to the SQLite database file. */
  dbPath: string
  /** Directory for pre-migration backups. */
  backupDir: string
}

export interface StorageConfigEnv {
  readonly ISLA_STORAGE_DB_PATH?: string
}

/**
 * Resolve the storage configuration. `ISLA_STORAGE_DB_PATH` overrides the
 * default; a relative override is resolved against `cwd`. An empty override is
 * invalid (fail-fast, never a silent default).
 */
export function resolveStorageConfig(
  env: StorageConfigEnv = process.env,
  cwd: string = process.cwd(),
): StorageConfig {
  const override = env.ISLA_STORAGE_DB_PATH
  if (override !== undefined && override.trim().length === 0) {
    throw new RangeError('ISLA_STORAGE_DB_PATH must not be empty')
  }
  const dbPath =
    override !== undefined
      ? isAbsolute(override.trim())
        ? override.trim()
        : resolve(cwd, override.trim())
      : resolve(cwd, DEFAULT_DB_RELATIVE_PATH)
  return { dbPath, backupDir: join(dirname(dbPath), BACKUP_DIR_NAME) }
}
