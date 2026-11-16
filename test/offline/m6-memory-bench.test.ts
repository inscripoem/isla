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

const IDENTITY = {
  qaSetId: 'qa-1',
  qaSetSha256: 'b'.repeat(64),
  snapshotId: 'snapshot-1',
  chunking: 'turn',
  embedding: 'none',
  retrieval: 'keyword',
  llm: 'fixture',
} as const

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

const runSwap = async (evalCase: MemoryCase, probe: { question: string }): Promise<ProbeRun> => {
  if (probe.question === 'q1') {
    return { ran: true, retrieved: ['c', 'd'], tokens: 10, latencyMs: 10 }
  }
  return runGood(evalCase, probe)
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
    const report = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10', identity: IDENTITY })
    expect(report.memoryReportVersion).toBe(1)
    const probes = report.cases[0]!.probes
    expect(probes.map((probe) => probe.status)).toEqual(['scored', 'unassessed', 'scored', 'not-run'])
    expect(probes[0]?.recallAtK).toBe(0.5)
    expect(probes[0]?.precisionAtK).toBe(0.5)
    expect(probes[0]?.retrievedCount).toBe(2)
    expect(probes[1]?.retrievedCount).toBe(0)
    expect(probes[2]?.precisionAtK).toBe(1)
    expect(probes[2]?.retrievedCount).toBe(1)
    expect(probes[2]?.answerAccuracy).toBe(1)
    expect(probes[3]?.reason).toBe('no corpus')
    expect(report.identity).toEqual(IDENTITY)
  })

  it('aggregates tokens per turn, p95 latency and the excluded count', async () => {
    const report = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10', identity: IDENTITY })
    expect(report.aggregates.recallAtK).toBeCloseTo(0.75)
    expect(report.aggregates.precisionAtK).toBeCloseTo(0.75, 3)
    expect(report.aggregates.answerAccuracy).toBe(1)
    expect(report.aggregates.tokensPerTurn).toBe(20)
    expect(report.aggregates.p95LatencyMs).toBe(100)
    expect(report.aggregates.excludedCount).toBe(1)
    expect(report.byKind.recall.recallAtK).toBe(0.5)
    expect(report.byKind.persona.recallAtK).toBe(1)
    expect(report.byKind.contradiction.scored).toBe(0)
  })

  it('is deterministic for the same input and generatedAt', async () => {
    const first = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10', identity: IDENTITY })
    const second = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10', identity: IDENTITY })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('scores precision against the retrieved count, not k', async () => {
    const cases: readonly MemoryCase[] = [
      {
        id: 'sparse',
        sessions: [{ sessionId: 's1', turns: [{}] }],
        probes: [{ question: 'q', expected: ['a', 'b', 'c'], kind: 'recall', k: 3 }],
      },
    ]
    const report = await runMemoryBench(
      cases,
      async () => ({ ran: true, retrieved: ['a'], tokens: 1, latencyMs: 1 }),
      { generatedAt: '2026-11-10', identity: IDENTITY },
    )
    const probe = report.cases[0]!.probes[0]!
    expect(probe.retrievedCount).toBe(1)
    expect(probe.recallAtK).toBeCloseTo(1 / 3)
    expect(probe.precisionAtK).toBe(1)
  })

  it('gates precision and accuracy regressions, not only recall', async () => {
    const good = await runMemoryBench(CASES, runGood, {
      generatedAt: '2026-11-10',
      identity: IDENTITY,
    })
    const precisionOnly = {
      ...good,
      byKind: {
        ...good.byKind,
        recall: { ...good.byKind.recall, precisionAtK: 0.1 },
      },
    }
    const accuracyOnly = {
      ...good,
      byKind: {
        ...good.byKind,
        persona: { ...good.byKind.persona, answerAccuracy: 0 },
      },
    }
    expect(compareMemoryReports(good, precisionOnly)).toContain('recall')
    expect(compareMemoryReports(good, accuracyOnly)).toContain('persona')
  })

  it('changes recall when the retrieval strategy changes', async () => {
    const good = await runMemoryBench(CASES, runGood, {
      generatedAt: '2026-11-10',
      identity: IDENTITY,
    })
    const swapped = await runMemoryBench(CASES, runSwap, {
      generatedAt: '2026-11-10',
      identity: IDENTITY,
    })
    expect(swapped.byKind.recall.recallAtK).not.toBe(good.byKind.recall.recallAtK)
    expect(compareMemoryReports(good, swapped)).toContain('recall')
  })

  it('is identical across a rebuilt case fixture (fixture-level restart proxy)', async () => {
    const first = await runMemoryBench(CASES, runGood, {
      generatedAt: '2026-11-10',
      identity: IDENTITY,
    })
    const rebuilt = JSON.parse(JSON.stringify(CASES)) as MemoryCase[]
    const second = await runMemoryBench(rebuilt, runGood, {
      generatedAt: '2026-11-10',
      identity: IDENTITY,
    })
    // Fixture-level proxy only: real restart/rebuild invariance awaits M4/M5 store wiring.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('names the regressed probe kinds', async () => {
    const good = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10', identity: IDENTITY })
    const bad = await runMemoryBench(CASES, runBad, { generatedAt: '2026-11-10', identity: IDENTITY })
    expect(compareMemoryReports(good, bad)).toEqual(['recall', 'persona'])
    expect(compareMemoryReports(bad, good)).toEqual([])
  })

  it('writes the JSON report and a summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'isla-memory-report-'))
    directories.push(dir)
    const json = join(dir, 'memory-report.json')
    const summary = join(dir, 'summary.txt')
    const report = await runMemoryBench(CASES, runGood, { generatedAt: '2026-11-10', identity: IDENTITY })
    writeMemoryReport(report, json, summary)
    expect(JSON.parse(readFileSync(json, 'utf8')).memoryReportVersion).toBe(1)
    const text = readFileSync(summary, 'utf8')
    expect(text).toContain('recall@3')
    expect(text).toContain('excluded (not run): 1')
    expect(text).toContain('qa set: qa-1')
  })

  it('refuses a case without probes', async () => {
    await expect(
      runMemoryBench([{ id: 'empty', sessions: [], probes: [] }], runGood, {
        generatedAt: '2026-11-10',
        identity: IDENTITY,
      }),
    ).rejects.toThrow('has no probes')
  })
})
