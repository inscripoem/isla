import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareMemoryReports,
  runMemoryBench,
  writeMemoryReport,
  type MemoryCase,
  type ProbeRun,
} from '../../src/evaluation/memory-bench'

const CASES: readonly MemoryCase[] = [
  {
    id: 'c1',
    sessions: [{ sessionId: 's1', turns: [{}, {}] }],
    probes: [
      { question: 'q1', expected: ['a', 'b'], kind: 'recall', k: 2 },
      { question: 'q2', expected: [], kind: 'recall' },
      { question: 'q3', expected: ['a'], kind: 'persona', expectedAnswer: 'yes' },
      { question: 'q4', expected: ['x'], kind: 'contradiction' },
    ],
  },
]

const runGood = async (_case: MemoryCase, probe: { question: string }): Promise<ProbeRun> => {
  if (probe.question === 'q1') {
    return { ran: true, retrieved: ['a', 'c'], tokens: 10, latencyMs: 10 }
  }
  if (probe.question === 'q2') {
    return { ran: true, retrieved: [], tokens: 5, latencyMs: 20 }
  }
  if (probe.question === 'q3') {
    return { ran: true, retrieved: ['a'], answer: 'yes', tokens: 25, latencyMs: 100 }
  }
  return { ran: false, reason: 'no corpus' }
}

const runBad = async (evalCase: MemoryCase, probe: { question: string }): Promise<ProbeRun> => {
  if (probe.question === 'q1') return { ran: true, retrieved: [], tokens: 10, latencyMs: 10 }
  if (probe.question === 'q3') {
    return { ran: true, retrieved: [], answer: 'no', tokens: 25, latencyMs: 100 }
  }
  return runGood(evalCase, probe)
}

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('M6 memory benchmark', () => {
  it('scores recall and precision, keeps unassessed and not-run distinct', async () => {
    const report = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10' })
    expect(report.memoryReportVersion).toBe(1)
    const probes = report.cases[0]!.probes
    expect(probes.map((probe) => probe.status)).toEqual(['scored', 'unassessed', 'scored', 'not-run'])
    expect(probes[0]?.recallAtK).toBe(0.5)
    expect(probes[0]?.precisionAtK).toBe(0.5)
    expect(probes[2]?.answerAccuracy).toBe(1)
    expect(probes[3]?.reason).toBe('no corpus')
  })

  it('aggregates tokens per turn, p95 latency and the excluded count', async () => {
    const report = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10' })
    expect(report.aggregates.recallAtK).toBeCloseTo(0.75)
    expect(report.aggregates.precisionAtK).toBeCloseTo(0.2778, 3)
    expect(report.aggregates.answerAccuracy).toBe(1)
    expect(report.aggregates.tokensPerTurn).toBe(20)
    expect(report.aggregates.p95LatencyMs).toBe(100)
    expect(report.aggregates.excludedCount).toBe(1)
  })

  it('is deterministic for the same input and generatedAt', async () => {
    const first = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10' })
    const second = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10' })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('names the regressed probe kinds', async () => {
    const good = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10' })
    const bad = await runMemoryBench(CASES, runBad, { generatedAt: '2026-11-10' })
    expect(compareMemoryReports(good, bad)).toEqual(['recall', 'persona'])
    expect(compareMemoryReports(bad, good)).toEqual([])
  })

  it('writes the JSON report and a summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'isla-memory-report-'))
    directories.push(dir)
    const json = join(dir, 'memory-report.json')
    const summary = join(dir, 'summary.txt')
    const report = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10' })
    writeMemoryReport(report, json, summary)
    expect(JSON.parse(readFileSync(json, 'utf8')).memoryReportVersion).toBe(1)
    const text = readFileSync(summary, 'utf8')
    expect(text).toContain('recall@3')
    expect(text).toContain('excluded (not run): 1')
  })

  it('refuses a case without probes', async () => {
    await expect(
      runMemoryBench([{ id: 'empty', sessions: [], probes: [] }], runGood, {
        generatedAt: '2026-11-10',
      }),
    ).rejects.toThrow('has no probes')
  })
})
