import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * M6 storage — SQLite database handle (B1).
 *
 * Opens the database file, creates its parent directory, and applies the
 * baseline pragmas: WAL journal, foreign keys, busy timeout. A path that is an
 * existing directory is rejected rather than opened as a database.
 *
 * `node:sqlite` is Node-only; this module stays outside the browser graph
 * (the `boundaries` fitness function enforces it).
 */
export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  if (existsSync(dbPath) && statSync(dbPath).isDirectory()) {
    throw new TypeError(`database path is a directory: ${dbPath}`)
  }
  const database = new DatabaseSync(dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA busy_timeout = 5000')
  return database
}
