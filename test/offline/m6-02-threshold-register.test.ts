import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  THRESHOLD_COLUMNS,
  collectThresholdViolations,
} from '../../src/evaluation/threshold-register'

const REGISTER = join(process.cwd(), 'docs/architecture/evaluation-thresholds.md')

function document(rows: readonly (readonly string[])[], header: readonly string[] = THRESHOLD_COLUMNS): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function pendingRow(overrides: Partial<Record<number, string>> = {}): string[] {
  const row = [
    'NFR-01',
    'input → first audible output',
    'p95',
    'pending',
    'M1/M2 observation method (#102)',
    'pending',
    'pending',
    'M1/M2/M5',
    'pending',
  ]
  for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value as string
  return row
}

const FIXED_ROW = [
  'NFR-01',
  'input → first audible output',
  'p95',
  '≤ 500 ms',
  'report firstAudibleMs',
  '412 ms',
  'main 205424f 2026-11-20',
  'M6',
  'observed',
]

describe('M6 CP05 #103 threshold register', () => {
  it('accepts the committed register', () => {
    expect(collectThresholdViolations(readFileSync(REGISTER, 'utf8'))).toEqual([])
  })

  it('accepts a fixed threshold that records every required part', () => {
    expect(collectThresholdViolations(document([FIXED_ROW]))).toEqual([])
  })

  it('accepts a pending row that records no value at all', () => {
    expect(collectThresholdViolations(document([pendingRow()]))).toEqual([])
  })

  it('refuses a pending row carrying a baseline value', () => {
    const violations = collectThresholdViolations(document([pendingRow({ 5: '0' })]))
    expect(violations.join(' ')).toContain('never a value or a target')
  })

  it('refuses a pending row carrying a comparison', () => {
    const violations = collectThresholdViolations(document([pendingRow({ 3: '≤ 500 ms' })]))
    expect(violations.join(' ')).toContain('records comparison')
  })

  it('refuses a pending row naming the pilot head', () => {
    const violations = collectThresholdViolations(
      document([pendingRow({ 6: 'main 205424f 2026-11-20' })]),
    )
    expect(violations.join(' ')).toContain('names the head')
  })

  it('refuses a fixed row whose baseline is still pending', () => {
    const row = [...FIXED_ROW]
    row[5] = 'pending'
    row[8] = 'observed'
    const violations = collectThresholdViolations(document([row]))
    expect(violations.join(' ')).toContain('records no measured baseline value')
  })

  it('refuses a fixed row whose baseline holds no measurement', () => {
    const row = [...FIXED_ROW]
    row[5] = 'fast'
    const violations = collectThresholdViolations(document([row]))
    expect(violations.join(' ')).toContain('records no measured baseline value')
  })

  it('refuses a fixed row without a head and date', () => {
    const row = [...FIXED_ROW]
    row[6] = 'main only'
    const violations = collectThresholdViolations(document([row]))
    expect(violations.join(' ')).toContain('does not name the head and date')
  })

  it('refuses a fixed row with a pending approver', () => {
    const row = [...FIXED_ROW]
    row[7] = 'pending M6'
    const violations = collectThresholdViolations(document([row]))
    expect(violations.join(' ')).toContain('approver is still pending')
  })

  it('refuses a status outside the declared vocabulary', () => {
    const row = [...FIXED_ROW]
    row[8] = 'done'
    const violations = collectThresholdViolations(document([row]))
    expect(violations.join(' ')).toContain('the vocabulary is')
  })

  it('refuses a table that lost a required column', () => {
    const header = THRESHOLD_COLUMNS.filter((column) => column !== 'Approver')
    const row = FIXED_ROW.filter((_, index) => index !== 7)
    const violations = collectThresholdViolations(document([row], header))
    expect(violations.join(' ')).toContain('missing the column(s): Approver')
  })

  it('refuses a blank cell', () => {
    const violations = collectThresholdViolations(document([pendingRow({ 4: '' })]))
    expect(violations.join(' ')).toContain('blank')
  })

  it('refuses the same obligation listed twice', () => {
    const violations = collectThresholdViolations(document([pendingRow(), pendingRow()]))
    expect(violations.join(' ')).toContain('repeats an obligation')
  })

  it('refuses a document with no threshold table', () => {
    expect(collectThresholdViolations('# Thresholds\n\nNone yet.\n')).toEqual([
      'no threshold table was found; the register must hold a table with the NFR and Status columns',
    ])
  })
})
