/**
 * Minimal, tolerant Markdown table parser (R3 traceability fitness tooling).
 *
 * The traceability artifacts are prose Markdown; this helper extracts their
 * tables so the fitness functions can check them without a schema change. It is
 * deliberately narrow: it recognises GitHub-style pipe tables and their nearest
 * preceding heading. Unknown shapes are simply ignored (the fitness functions
 * report what they cannot find).
 */

export interface MarkdownTable {
  /** Nearest preceding heading, for identifying the table. */
  readonly heading: string
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isSeparator(line: string): boolean {
  if (!isRow(line)) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export function parseTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split('\n')
  const tables: MarkdownTable[] = []
  let heading = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /^#{1,6}\s+(.*)$/.exec(line)
    if (match !== null) {
      heading = (match[1] ?? '').trim()
      continue
    }
    if (isRow(line) && isSeparator(lines[index + 1] ?? '')) {
      const header = splitRow(line)
      const rows: string[][] = []
      let cursor = index + 2
      while (cursor < lines.length && isRow(lines[cursor] ?? '')) {
        rows.push(splitRow(lines[cursor] ?? ''))
        cursor += 1
      }
      tables.push({ heading, header, rows })
      index = cursor - 1
    }
  }
  return tables
}

/** Case-insensitive column lookup by header name; -1 when absent. */
export function columnIndex(header: readonly string[], name: string): number {
  const target = name.toLowerCase()
  return header.findIndex((cell) => cell.toLowerCase() === target)
}
