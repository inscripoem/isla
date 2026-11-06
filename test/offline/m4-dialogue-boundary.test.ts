import { describe, expect, it } from 'vitest'
import { createCallContext, createGate } from '../support/context'
import { fixtureDialogueRequest } from '../support/fixture-data'
import { createDialoguePort, createIntentTextSource } from '../../src/dialogue'
import type { DialogueOutcomeReport, DialogueTextSource } from '../../src/dialogue'
import type { ClockPort, DialogueSegment, DialogueSink } from '../../src/contracts'

/**
 * M5 review regression tests for the M4 dialogue outcome boundary.
 *
 * These tests reproduce four producer defects on the imported M4 revision
 * `a678b619e3c4002eae6a79425479f38f3d2cd5e6` (task M4-03, issue #44):
 *
 *   1. an empty `compose` result after Stop or deadline folded to `completed`;
 *   2. early and exceptional terminal paths returned without an outcome report;
 *   3. candidates dropped by the segment cap were absent from the accounting;
 *   4. a throwing outcome observer changed the generation result.
 *
 * The companion fixes in `src/dialogue/dialogue-port.ts` are M5-authored local
 * proposals for M4 review, not approved M4 work. The published M4 tests remain
 * unchanged; this file is the consumer-side evidence that the boundary holds.
 */

/**
 * Fixture deadlines such as `atMs: 60_000` live in the injected clock's domain,
 * so every port under test shares this clock. See DialoguePortOptions.clock.
 */
const FIXTURE_CLOCK: ClockPort = { nowMs: () => 1_000 }

function sinkOf(collected: DialogueSegment[]): DialogueSink {
  return {
    segment: async (segment) => {
      collected.push(segment)
    },
  }
}

function collectingSource(compose: DialogueTextSource['compose']): DialogueTextSource {
  return { model: 'test-source', modelVersion: 'test-v1', resolvedModel: null, compose }
}

describe('M4 dialogue outcome boundary (M5 review of revision a678b61)', () => {
  it('reports a Stop that arrives during an empty compose as cancelled, not completed', async () => {
    const entered = createGate()
    const release = createGate()
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: collectingSource(async () => {
        entered.release()
        await release.promise
        return []
      }),
      onOutcome: (report) => reports.push(report),
    })
    const context = createCallContext(5_000)
    const segments: DialogueSegment[] = []
    const pending = port.generate(fixtureDialogueRequest(), context, sinkOf(segments))
    await entered.promise
    context.abort()
    release.release()
    const end = await pending
    expect(end.status).toBe('cancelled')
    expect(end.segmentCount).toBe(0)
    expect(segments).toHaveLength(0)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'cancelled',
      usageStatus: 'cancelled',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
    expect(reports[0]?.discards).toEqual({})
  })

  it('reports a deadline that elapses during an empty compose as deadline_exceeded, not completed', async () => {
    let nowMs = 1_000
    const entered = createGate()
    const release = createGate()
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: { nowMs: () => nowMs },
      textSource: collectingSource(async () => {
        entered.release()
        await release.promise
        return []
      }),
      onOutcome: (report) => reports.push(report),
    })
    const context = createCallContext(1_500)
    const pending = port.generate(fixtureDialogueRequest(), context, sinkOf([]))
    await entered.promise
    nowMs = 2_000
    release.release()
    const end = await pending
    expect(end.status).toBe('deadline_exceeded')
    expect(end.segmentCount).toBe(0)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'deadline_exceeded',
      usageStatus: 'timeout',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('emits one outcome report on a pre-assembly Stop instead of returning silently', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: createIntentTextSource(),
      onOutcome: (report) => reports.push(report),
    })
    const context = createCallContext(5_000)
    context.abort()
    const end = await port.generate(fixtureDialogueRequest(), context, sinkOf([]))
    expect(end.status).toBe('cancelled')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'cancelled',
      usageStatus: 'cancelled',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('emits one outcome report on an expired deadline instead of returning silently', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: createIntentTextSource(),
      onOutcome: (report) => reports.push(report),
    })
    const end = await port.generate(fixtureDialogueRequest(), createCallContext(0), sinkOf([]))
    expect(end.status).toBe('deadline_exceeded')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'deadline_exceeded',
      usageStatus: 'timeout',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('emits one outcome report when the character profile is unknown', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: createIntentTextSource(),
      onOutcome: (report) => reports.push(report),
    })
    const end = await port.generate(
      fixtureDialogueRequest({ characterProfileId: 'character-unknown' }),
      createCallContext(5_000),
      sinkOf([]),
    )
    expect(end.status).toBe('failed')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'failed',
      usageStatus: 'failed',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('emits one failed outcome report when the text source throws, then still rejects', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: collectingSource(async () => {
        throw new Error('text source down')
      }),
      onOutcome: (report) => reports.push(report),
    })
    await expect(
      port.generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf([])),
    ).rejects.toThrow('text source down')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'failed',
      usageStatus: 'failed',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('counts candidates beyond the segment cap as overflow instead of dropping them from the accounting', async () => {
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: collectingSource(async () => ['one', 'two', 'three']),
      onOutcome: (report) => reports.push(report),
    })
    const segments: DialogueSegment[] = []
    const end = await port.generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf(segments))
    expect(end.status).toBe('completed')
    expect(end.segmentCount).toBe(2)
    expect(segments).toHaveLength(2)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ generated: 3, emitted: 2, discarded: 1, endStatus: 'completed' })
    expect(reports[0]?.discards).toEqual({ overflow: 1 })
  })

  it('does not let a throwing outcome observer change a completed generation', async () => {
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: collectingSource(async () => ['one', 'two']),
      onOutcome: () => {
        throw new Error('observer down')
      },
    })
    const segments: DialogueSegment[] = []
    const end = await port.generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf(segments))
    expect(end.status).toBe('completed')
    expect(end.segmentCount).toBe(2)
    expect(segments).toHaveLength(2)
  })

  it('does not let a throwing outcome observer change a cancelled generation', async () => {
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: createIntentTextSource(),
      onOutcome: () => {
        throw new Error('observer down')
      },
    })
    const context = createCallContext(5_000)
    context.abort()
    const end = await port.generate(fixtureDialogueRequest(), context, sinkOf([]))
    expect(end.status).toBe('cancelled')
  })

  it('reports a failed outcome exactly once when context assembly throws, then rethrows the original error', async () => {
    const failure = new Error('history down')
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: createIntentTextSource(),
      history: {
        confirmedHistory: async () => {
          throw failure
        },
      },
      onOutcome: (report) => reports.push(report),
    })
    await expect(
      port.generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf([])),
    ).rejects.toBe(failure)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'failed',
      usageStatus: 'failed',
      generated: 0,
      emitted: 0,
      discarded: 0,
    })
  })

  it('labels a rejected sink write as an uncertain delivery and preserves the original error', async () => {
    const failure = new Error('sink transport down')
    let calls = 0
    const delivered: DialogueSegment[] = []
    const sink: DialogueSink = {
      segment: async (segment) => {
        calls += 1
        if (calls === 2) throw failure
        delivered.push(segment)
      },
    }
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: collectingSource(async () => ['one', 'two']),
      onOutcome: (report) => reports.push(report),
    })
    await expect(
      port.generate(fixtureDialogueRequest(), createCallContext(5_000), sink),
    ).rejects.toBe(failure)
    expect(delivered).toHaveLength(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'failed',
      usageStatus: 'failed',
      generated: 2,
      emitted: 1,
      discarded: 1,
    })
    expect(reports[0]?.discards).toEqual({ 'sink-uncertain': 1 })
  })

  it('does not claim a rejected first sink write was undelivered', async () => {
    const failure = new Error('sink refused')
    const sink: DialogueSink = {
      segment: async () => {
        throw failure
      },
    }
    const reports: DialogueOutcomeReport[] = []
    const port = createDialoguePort({
      clock: FIXTURE_CLOCK,
      textSource: collectingSource(async () => ['one', 'two']),
      onOutcome: (report) => reports.push(report),
    })
    await expect(
      port.generate(fixtureDialogueRequest(), createCallContext(5_000), sink),
    ).rejects.toBe(failure)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      endStatus: 'failed',
      usageStatus: 'failed',
      generated: 2,
      emitted: 0,
      discarded: 2,
    })
    expect(reports[0]?.discards).toEqual({ 'sink-uncertain': 1, leftover: 1 })
  })

  it('does not raise an unhandled rejection when an async outcome observer rejects', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const port = createDialoguePort({
        clock: FIXTURE_CLOCK,
        textSource: collectingSource(async () => ['one', 'two']),
        onOutcome: (async () => {
          throw new Error('observer rejection')
        }) as unknown as (report: DialogueOutcomeReport) => void,
      })
      const end = await port.generate(fixtureDialogueRequest(), createCallContext(5_000), sinkOf([]))
      expect(end.status).toBe('completed')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
