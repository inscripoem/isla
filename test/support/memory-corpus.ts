import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Test-only loader for the M4 memory corpora (M4-X07).
 *
 * Corpus file schema — one JSON object per file, stored as
 * `test/fixtures/memory/<corpusId>.json`:
 *
 *   CorpusFile = { corpusId: string, corpusVersion: 1,
 *                  heldOutCaseIds: string[], cases: MemoryCase[] }
 *   MemoryCase = { id: string,
 *                  sessions: [{ sessionId: string, turns: TurnFixture[] }],
 *                  probes: [{ question: string, expected: string[], kind }] }
 *   TurnFixture = { id: string, speaker: "character" | "audience",
 *                   text: string, atMs: number }
 *
 * `expected` ids reference turn ids inside the same corpus file.
 *
 * These corpora are consumer-facing regression fixtures. No producer is wired
 * this round: they are not consumed by `src/dialogue/derived-memory.ts` yet,
 * and the harness runner belongs to M6 and is out of scope. A passing test
 * validates the corpus structure, not dialogue quality.
 *
 * The loader reads and parses only; every structural rule is asserted by
 * `test/offline/m4-memory-corpus.test.ts`. Tests never import JSON directly
 * because `tsconfig.test.json` has no `resolveJsonModule`.
 */

export type ProbeKind = 'recall' | 'temporal' | 'contradiction'
export type Speaker = 'character' | 'audience'

export interface TurnFixture {
  id: string
  speaker: Speaker
  text: string
  atMs: number
}

export interface SessionFixture {
  sessionId: string
  turns: TurnFixture[]
}

export interface Probe {
  question: string
  expected: string[]
  kind: ProbeKind
}

export interface MemoryCase {
  id: string
  sessions: SessionFixture[]
  probes: Probe[]
}

export interface CorpusFile {
  corpusId: string
  corpusVersion: 1
  heldOutCaseIds: string[]
  cases: MemoryCase[]
}

export const MEMORY_FIXTURE_DIR = resolve(process.cwd(), 'test/fixtures/memory')

export function loadMemoryCorpus(fileName: string): CorpusFile {
  return JSON.parse(readFileSync(resolve(MEMORY_FIXTURE_DIR, fileName), 'utf8')) as CorpusFile
}
