import { existsSync, readFileSync } from 'node:fs'

/**
 * M6 / R3 — the changed-file list a gate runs against.
 *
 * CI writes the pull request's changed paths to a file and exports
 * `CHANGED_FILES_FILE`. The gates read that file rather than receiving paths as
 * argv, because an argv list word-splits on spaces and would silently change the
 * set of files a gate sees.
 *
 * A missing or unreadable variable yields an empty list. That is a *successful empty
 * diff*, not an acquisition error: the CI step that produces the file fails closed
 * when the diff cannot be acquired, so a gate never has to interpret a failure.
 */
export const CHANGED_FILES_ENV = 'CHANGED_FILES_FILE'

/** Read the changed paths from `CHANGED_FILES_FILE`; `[]` when it is absent. */
export function readChangedFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = env[CHANGED_FILES_ENV]
  if (path === undefined || path.trim().length === 0 || !existsSync(path)) return []
  // Do not trim: a filename may legally contain leading or trailing spaces, and the
  // written list has no padding. A trailing newline yields one empty entry, dropped.
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}
