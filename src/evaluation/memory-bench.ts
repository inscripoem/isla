import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { percentile } from './metrics'

/**
 * M6 evaluation — memory benchmark (ADR pending reservation in #25).
 *
 * A separate artifact from the frozen selection-run report: the recorded-run schema
 * has no field for recall@k, precision@k or answer accuracy. The runner is injected,
 * so M6 measures and M4/M5 execute; unlabelled items are `unassessed` and unexecuted
 * items are `not-run`, never zero (INV-16).
 */

export const MEMORY_REPORT_VERSION = 1
export const DEFAULT_K = 3

export type ProbeKind = 'recall' | 'temporal' | 'contradiction' | 'persona'

export interface MemoryProbe {
  readonly question: string
  readonly expected: readonly string[]
  readonly kind: ProbeKind
  readonly k?: number
  /** Present only when a human-reviewed answer label exists. */
  readonly expectedAnswer?: string
}

export interface MemorySession {
  readonly sessionId: string
  /** M4's turn fixtures; opaque to M6, counted only for tokens-per-turn. */
  readonly turns: readonly unknown[]
}

export interface MemoryCase {
  readonly id: string
  readonly sessions: readonly MemorySession[]
  readonly probes: readonly MemoryProbe[]
}

export type ProbeRun =
  | {
      readonly ran: true
      readonly retrieved: readonly string[]
      readonly answer?: string
      readonly tokens: number
      readonly latencyMs: number
    }
  | { readonly ran: false; readonly reason: string }

export type RunMemoryProbe = (evalCase: MemoryCase, probe: MemoryProbe) => Promise<ProbeRun>

export type ProbeStatus = 'scored' | 'unassessed' | 'not-run'

export interface ProbeReport {
  readonly question: string
  readonly kind: ProbeKind
  readonly status: ProbeStatus
  readonly recallAtK: number | null
  readonly precisionAtK: number | null
  readonly answerAccuracy: number | null
  readonly reason?: string
}

export interface CaseReport {
  readonly caseId: string
  readonly turns: number
  readonly probes: readonly ProbeReport[]
}

export interface KindAggregate {
  readonly scored: number
  readonly recallAtK: number | null
  readonly precisionAtK: number | null
  readonly answerAccuracy: number | null
}

export interface MemoryReport {
  readonly memoryReportVersion: typeof MEMORY_REPORT_VERSION
  readonly generatedAt: string
  readonly k: number
  readonly cases: readonly CaseReport[]
  readonly byKind: Readonly<Record<ProbeKind, KindAggregate>>
  readonly aggregates: {
    readonly recallAtK: number | null
    readonly precisionAtK: number | null
    readonly answerAccuracy: number | null
    readonly tokensPerTurn: number | null
    readonly p95LatencyMs: number | null
    readonly excludedCount: number
  }
}

const KINDS: readonly ProbeKind[] = ['recall', 'temporal', 'contradiction', 'persona']

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

function score(
  probe: MemoryProbe,
  run: ProbeRun,
  defaultK: number,
): Omit<ProbeReport, 'question' | 'kind'> {
  if (!run.ran) {
    return {
      status: 'not-run',
      recallAtK: null,
      precisionAtK: null,
      answerAccuracy: null,
      reason: run.reason,
    }
  }
  const k = probe.k ?? defaultK
  const expected = new Set(probe.expected)
  const top = run.retrieved.slice(0, k)
  const hits = top.filter((id) => expected.has(id)).length
  const recallAtK = probe.expected.length === 0 ? null : hits / probe.expected.length
  const precisionAtK = hits / k
  const answerAccuracy =
    probe.expectedAnswer === undefined ? null : run.answer === probe.expectedAnswer ? 1 : 0
  const status: ProbeStatus =
    recallAtK === null && answerAccuracy === null ? 'unassessed' : 'scored'
  return { status, recallAtK, precisionAtK, answerAccuracy }
}

export async function runMemoryBench(
  cases: readonly MemoryCase[],
  runProbe: RunMemoryProbe,
  options: { readonly generatedAt: string; readonly k?: number },
): Promise<MemoryReport> {
  const k = options.k ?? DEFAULT_K
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer')
  const caseReports: CaseReport[] = []
  let totalTokens = 0
  let ranCount = 0
  const latencies: number[] = []
  for (const evalCase of cases) {
    if (evalCase.id.trim().length === 0) throw new Error('memory case id must be non-empty')
    if (evalCase.probes.length === 0) {
      throw new Error(`memory case ${evalCase.id} has no probes`)
    }
    const probes: ProbeReport[] = []
    for (const probe of evalCase.probes) {
      const run = await runProbe(evalCase, probe)
      if (run.ran) {
        totalTokens += run.tokens
        ranCount += 1
        latencies.push(run.latencyMs)
      }
      probes.push({ question: probe.question, kind: probe.kind, ...score(probe, run, k) })
    }
    caseReports.push({
      caseId: evalCase.id,
      turns: evalCase.sessions.reduce((sum, session) => sum + session.turns.length, 0),
      probes,
    })
  }

  const allProbes = caseReports.flatMap((report) => report.probes)
  const byKind = Object.fromEntries(
    KINDS.map((kind) => {
      const probes = allProbes.filter((probe) => probe.kind === kind)
      return [
        kind,
        {
          scored: probes.filter((probe) => probe.status === 'scored').length,
          recallAtK: mean(probes.map((probe) => probe.recallAtK)),
          precisionAtK: mean(probes.map((probe) => probe.precisionAtK)),
          answerAccuracy: mean(probes.map((probe) => probe.answerAccuracy)),
        },
      ]
    }),
  ) as Record<ProbeKind, KindAggregate>

  // The runner owns the observations; the bench counts only what it was given.
  const turns = caseReports.reduce((sum, report) => sum + report.turns, 0)

  return {
    memoryReportVersion: MEMORY_REPORT_VERSION,
    generatedAt: options.generatedAt,
    k,
    cases: caseReports,
    byKind,
    aggregates: {
      recallAtK: mean(allProbes.map((probe) => probe.recallAtK)),
      precisionAtK: mean(allProbes.map((probe) => probe.precisionAtK)),
      answerAccuracy: mean(allProbes.map((probe) => probe.answerAccuracy)),
      tokensPerTurn: ranCount === 0 || turns === 0 ? null : totalTokens / turns,
      p95LatencyMs: percentile(latencies, 0.95),
      excludedCount: allProbes.filter((probe) => probe.status === 'not-run').length,
    },
  }
}


export function compareMemoryReports(
  baseline: MemoryReport,
  current: MemoryReport,
): readonly ProbeKind[] {
  return KINDS.filter((kind) => {
    const before = baseline.byKind[kind].recallAtK
    const after = current.byKind[kind].recallAtK
    return before !== null && after !== null && after < before
  })
}

export function writeMemoryReport(
  report: MemoryReport,
  jsonPath: string,
  summaryPath: string,
): void {
  mkdirSync(dirname(jsonPath), { recursive: true })
  const temporary = `${jsonPath}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  renameSync(temporary, jsonPath)

  const lines = [
    `Memory report ${report.generatedAt} (k=${report.k})`,
    `recall@${report.k}: ${report.aggregates.recallAtK ?? '—'}`,
    `precision@${report.k}: ${report.aggregates.precisionAtK ?? '—'}`,
    `answer accuracy: ${report.aggregates.answerAccuracy ?? '—'}`,
    `tokens per turn: ${report.aggregates.tokensPerTurn ?? '—'}`,
    `excluded (not run): ${report.aggregates.excludedCount}`,
    '',
    'By kind:',
    ...KINDS.map(
      (kind) =>
        `${kind}: recall ${report.byKind[kind].recallAtK ?? '—'} over ${report.byKind[kind].scored} scored probe(s)`,
    ),
    '',
  ]
  const temporarySummary = `${summaryPath}.tmp`
  writeFileSync(temporarySummary, `${lines.join('\n')}\n`, 'utf8')
  renameSync(temporarySummary, summaryPath)
}
