import { describe, expect, it } from 'vitest'
import { createFixtureRunner } from '../support/runner-factories'
import { createFixtureEventStore } from '../support/correct-ports'
import {
  FIXTURE_SESSION_ID,
  fixtureOperatorContext,
  fixturePerformanceReceipt,
} from '../support/fixture-data'

describe('offline composition (fixture contract runner)', () => {
  it('C-01/C-13: selection-to-delivery preserves identities and ordering', async () => {
    const runner = createFixtureRunner()
    await runner.resume()
    await runner.accept('What did you say about the concert?')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('completed')
    expect(turn.plan?.selectedEventIds).toHaveLength(1)
    expect(turn.plan?.replyIntent).toBe('answer')
    const deliveries = runner.deliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      sessionId: FIXTURE_SESSION_ID,
      modality: 'audio',
      classification: 'fully-delivered',
      terminalOutcome: 'completed',
    })
    const seqs = runner.events().map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('C-03: a result arriving after Stop is stale and never delivered', async () => {
    const runner = createFixtureRunner()
    await runner.resume()
    await runner.accept('late question')
    runner.hooks.beforeSelect = async () => {
      await runner.stop()
    }
    const turn = await runner.runTurn()
    expect(turn.status).toBe('stale')
    expect(runner.deliveries()).toHaveLength(0)
    expect(runner.rejectedLate()).toBeGreaterThanOrEqual(1)
  })

  it('C-04: Stop during the second segment keeps the first and dispatches no more', async () => {
    const runner = createFixtureRunner({ segmentCount: 2 })
    await runner.resume()
    await runner.accept('two segments')
    runner.hooks.afterSegmentDispatch = async (index) => {
      if (index === 0) await runner.stop()
    }
    const turn = await runner.runTurn()
    const deliveries = runner.deliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.segmentId).toContain('seg-0')
    expect(deliveries[0]?.classification).toBe('fully-delivered')
    expect(turn.status).toBe('cancelled')
  })

  it('C-02: duplicate input and duplicate control are idempotent', async () => {
    const runner = createFixtureRunner()
    await runner.resume()
    await runner.accept('hello', 'm-compose-1')
    expect((await runner.accept('hello', 'm-compose-1')).status).toBe('duplicate')
    const stop = {
      protocolVersion: '0.2' as const,
      kind: 'control.stop' as const,
      messageId: 'm-compose-stop',
      sessionId: FIXTURE_SESSION_ID,
      epoch: runner.epoch(),
      payload: { requestId: 'r-compose-stop' },
    }
    const first = await runner.controlWith(stop, fixtureOperatorContext())
    const second = await runner.controlWith(stop, fixtureOperatorContext())
    expect(first.status).toBe('applied')
    expect(second.status).toBe('duplicate')
    expect(runner.epoch()).toBe(first.epoch)
  })

  it('C-10: a receipt for an unregistered output is rejected', async () => {
    const runner = createFixtureRunner()
    await runner.resume()
    const before = runner.rejectedReceipts()
    await runner.endpoint.handlePlayerMessage({
      protocolVersion: '0.2',
      messageId: 'm-ghost',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'performance.receipt',
      payload: fixturePerformanceReceipt({ outputId: 'output-ghost' }),
    })
    expect(runner.rejectedReceipts()).toBeGreaterThan(before)
    expect(runner.deliveries()).toHaveLength(0)
  })

  it('C-17: a storage failure degrades the session, blocks work and keeps Stop responsive', async () => {
    const store = createFixtureEventStore()
    const runner = createFixtureRunner({ store })
    await runner.resume()
    store.failNextCommit = true
    await runner.accept('this delivery will fail to persist')
    const turn = await runner.runTurn()
    expect(turn.status).toBe('degraded')
    expect(runner.lifecycle()).toBe('degraded')
    expect((await runner.runTurn()).status).toBe('degraded')
    expect((await runner.stop()).status).toBe('applied')
  })
})
