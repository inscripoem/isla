/**
 * Where the evaluation report is written and read.
 *
 * One definition for two consumers: `report.ts` writes the table and `eval-gate.ts`
 * (G4) reads it. Two copies of this path could drift and make the gate inspect a file
 * nobody writes.
 */
export const EVALUATION_TABLE_PATH = 'docs/architecture/evaluation-table.md'
