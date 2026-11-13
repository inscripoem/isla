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

/** Invariant ids from the invariant register table; `null` when no table is found. */
export function invariantIdsFromRegister(text: string): ReadonlySet<string> | null {
  for (const table of parseTables(text)) {
    const idColumn = columnIndex(table.header, 'ID')
    if (idColumn < 0) continue
    const ids = table.rows
      .map((row) => (row[idColumn] ?? '').trim())
      .filter((id) => /^INV-\d+$/.test(id))
    if (ids.length > 0) return new Set(ids)
  }
  return null
}
