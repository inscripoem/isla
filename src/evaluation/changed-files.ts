import { existsSync, readFileSync } from 'node:fs'

/**
 * M6 / R3 — the changed-file list a gate runs against.
 *
 * CI records the pull request's changed paths in a **NUL-separated** file and exports
 * `CHANGED_FILES_FILE`. A file is used instead of argv because an argument list
 * word-splits on spaces; the separator is NUL rather than newline because a path may
 * contain a newline, and a newline-separated list would split it into two paths.
 *
 * The acquisition contract is deliberately strict, so a gate never passes vacuously:
 *
 *  - the variable **unset** → an empty list. That is a local run with no diff to
 *    check, not a failed acquisition.
 *  - the variable **set but the file missing or unreadable** → **throw**. A change set
 *    that was expected and did not arrive is an acquisition error; returning an empty
 *    list there would turn a broken pipeline into a passing gate.
 *  - the file present but **empty** → an empty list. That is a successful diff that
 *    happened to change nothing.
 */
export const CHANGED_FILES_ENV = 'CHANGED_FILES_FILE'

/** Read the changed paths from `CHANGED_FILES_FILE`; throws when it cannot. */
export function readChangedFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = env[CHANGED_FILES_ENV]
  if (path === undefined || path.trim().length === 0) return []

  if (!existsSync(path)) {
    throw new Error(
      `${CHANGED_FILES_ENV} points at ${path}, which does not exist — the change set was not acquired`,
    )
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${CHANGED_FILES_ENV} (${path}) could not be read: ${reason}`)
  }

  // NUL-separated: a path containing a space or a newline stays one entry.
  return raw.split('\0').filter((entry) => entry.length > 0)
}
