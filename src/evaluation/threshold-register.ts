import { columnIndex, parseTables, type MarkdownTable } from './markdown'

/**
 * M6 / CP05 (#103) — the threshold register's own rule, enforced.
 *
 * `docs/architecture/evaluation-thresholds.md` fixes the *shape* of a threshold
 * and forbids inventing a value: without a measured baseline a threshold is
 * `pending`, "never `0` and never a target" (protocol §5.4). That rule lived only
 * in prose, so any edit could have replaced `pending` with a plausible number and
 * nothing would have noticed.
 *
 * This checker reads the register and refuses the states the protocol forbids:
 *
 *  - a `pending` row that carries a baseline, a comparison or a pilot head;
 *  - a fixed row that omits the baseline value, the head/date or the approver;
 *  - a status outside the declared vocabulary;
 *  - a row that cannot be identified (bad NFR id, blank cell, repeated obligation).
 *
 * It is deliberately a reader, not a writer: the register stays the single source
 * of truth and this module never edits it.
 */

export const THRESHOLD_COLUMNS = [
  'NFR',
  'Obligation',
  'Statistic',
  'Comparison',
  'Verification',
  'Baseline',
  'Head / date',
  'Approver',
  'Status',
] as const

/** The status vocabulary the register declares. */
export const THRESHOLD_STATUSES = ['pending', 'observed', 'unknown', 'not-run'] as const

const NFR_PATTERN = /^NFR-\d{2}$/
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/
const DIGIT_PATTERN = /\d/

function isThresholdTable(table: MarkdownTable): boolean {
  return columnIndex(table.header, 'NFR') !== -1 && columnIndex(table.header, 'Status') !== -1
}

function findThresholdTable(tables: readonly MarkdownTable[]): MarkdownTable | null {
  return tables.find(isThresholdTable) ?? null
}

/**
 * Every violation of the register's rule, or an empty list when it holds.
 *
 * A missing table is a violation rather than a pass: an absent register cannot
 * prove that any threshold is honestly pending.
 */
export function collectThresholdViolations(markdown: string): string[] {
  const table = findThresholdTable(parseTables(markdown))
  if (table === null) {
    return [
      'no threshold table was found; the register must hold a table with the NFR and Status columns',
    ]
  }

  const positions = THRESHOLD_COLUMNS.map((name) => columnIndex(table.header, name))
  const missing = THRESHOLD_COLUMNS.filter((_, index) => positions[index] === -1)
  if (missing.length > 0) {
    return [`the threshold table is missing the column(s): ${missing.join(', ')}`]
  }
  if (table.rows.length === 0) {
    return ['the threshold table has no rows; an empty register claims nothing']
  }

  const violations: string[] = []
  const seen = new Set<string>()

  table.rows.forEach((row, index) => {
    const cells = positions.map((position) => (row[position] ?? '').trim())
    const [nfr, obligation, statistic, comparison, , baseline, head, approver, rawStatus] = cells

    const blank = THRESHOLD_COLUMNS.filter((_, cell) => cells[cell] === '')
    if (blank.length > 0) {
      violations.push(`row ${index + 1} has a blank ${blank.join(', ')} cell`)
      return
    }

    const at = `${nfr} (${obligation})`
    if (!NFR_PATTERN.test(nfr as string)) {
      violations.push(`${at} does not name an NFR id such as NFR-01`)
    }

    const status = (rawStatus as string).toLowerCase().replace(/\s+/g, '-')
    if (!(THRESHOLD_STATUSES as readonly string[]).includes(status)) {
      violations.push(
        `${at} has status "${rawStatus}"; the vocabulary is ${THRESHOLD_STATUSES.join(', ')}`,
      )
      return
    }

    const identity = `${nfr} ${obligation}`
    if (seen.has(identity)) {
      violations.push(`${at} repeats an obligation already listed`)
    }
    seen.add(identity)

    if (status === 'pending') {
      if (baseline !== 'pending') {
        violations.push(
          `${at} is pending but records baseline "${baseline}"; a threshold with no measured baseline is pending, never a value or a target`,
        )
      }
      if (comparison !== 'pending') {
        violations.push(`${at} is pending but records comparison "${comparison}"`)
      }
      if (head !== 'pending') {
        violations.push(
          `${at} is pending but names the head "${head}"; the head is recorded when a pilot produces the baseline`,
        )
      }
      return
    }

    if (statistic === 'pending') {
      violations.push(`${at} is ${status} but its statistic is still pending`)
    }
    if (baseline === 'pending' || !DIGIT_PATTERN.test(baseline as string)) {
      violations.push(
        `${at} is ${status} but records no measured baseline value ("${baseline}")`,
      )
    }
    if (comparison === 'pending') {
      violations.push(`${at} is ${status} but its comparison is still pending`)
    }
    if (!DATE_PATTERN.test(head as string)) {
      violations.push(`${at} is ${status} but does not name the head and date of the pilot`)
    }
    if ((approver as string).toLowerCase().includes('pending')) {
      violations.push(`${at} is ${status} but its approver is still pending`)
    }
  })

  return violations
}
