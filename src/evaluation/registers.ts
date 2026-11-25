import { columnIndex, parseTables } from './markdown'
import { parseCaseRegistry } from './requirements-registry'

/**
 * M6 / R3 — one loader for the shared registers used by more than one gate.
 *
 * The trace gate parses `requirements.yaml` for its cross-check; the AI-use gate
 * (G6) needs the same case and invariant sets. Two independent parsers would drift,
 * so the sets come from here and the trace gate keeps using the parsed registry it
 * needs for its deeper cross-check. The agreement test proves both see the same ids.
 *
 * A parse failure returns `null`, never an empty set: "the register is empty" and
 * "the register could not be read" must not look alike to a gate that fails closed.
 */

/** Case ids from the case registry text; `null` when the registry does not parse. */
export function caseIdsFromRegistry(text: string): ReadonlySet<string> | null {
  const parsed = parseCaseRegistry(text)
  if (!parsed.ok) return null
  return new Set(parsed.registry.cases.map((entry) => entry.id))
}

/**
 * Invariant ids from every register table; `null` when no ID table is found.
 *
 * The current-invariant table and the clearly separated reclassified-legacy table
 * are both read. Historical AI-use entries may cite an id that was an invariant
 * when the entry was written; resolving it keeps the historical record checkable
 * without treating the id as a current system invariant. Current status is
 * decided by `requirements.yaml`'s `category`, not by presence in this file.
 */
export function invariantIdsFromRegister(text: string): ReadonlySet<string> | null {
  const ids = new Set<string>()
  for (const table of parseTables(text)) {
    const idColumn =
      columnIndex(table.header, 'ID') >= 0
        ? columnIndex(table.header, 'ID')
        : columnIndex(table.header, 'Former ID')
    if (idColumn < 0) continue
    for (const row of table.rows) {
      const id = (row[idColumn] ?? '').trim()
      if (/^INV-\d+$/.test(id)) ids.add(id)
    }
  }
  return ids.size === 0 ? null : ids
}
