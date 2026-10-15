import { describe, expect, it, vi } from 'vitest'
import type {
  CapabilitySnapshot,
  ClockPort,
  PerformanceCommand,
  PerformanceReceipt,
  PreparePerformance,
} from '../../src/contracts'
import {
  APPLICATION_CONTRACT_VERSION,
  NO_OP_ACTION,
  performanceReceiptMessageSchema,
  performanceReceiptSchema,
} from '../../src/contracts'
import {
  collectPerformanceViolations,
  collectPlayerCancellationViolations,
} from '../conformance/performance.conformance'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'
import { createCallContext } from '../support/context'
import {
  FIXTURE_SESSION_ID,
  fixtureCapabilitySnapshot,
  fixturePerformanceCommand,
  fixturePreparePerformance,
} from '../support/fixture-data'
import {
  M1_ACTUAL_SEGMENT_0_DURATION_MS,
  M1_ACTUAL_SEGMENT_0_REF,
  M1_ACTUAL_SEGMENT_1_DURATION_MS,
  M1_ACTUAL_SEGMENT_1_REF,
  M1_ACTUAL_WAV_EXPECTED,
  M1_FIXTURE_DURATION_MS,
  M1_FIXTURE_FORMAT,
  M1_FIXTURE_SEGMENT_0_REF,
  M1_FIXTURE_SEGMENT_1_REF,
  createActualCompletingPlayerKit,
  createActualHoldingPlayerKit,
  createActualPlayerKit,
  createControlledMediaDriver,
  createControlledResolver,
  createExpiringDeadlineGate,
  createM1ActualAssetEntries,
  createM1ActualBlobMap,
  createM1FixtureEntries,
  createM1FixtureMappedRenderer,
  createM1FixtureSynthesisKit,
  createM1NoOpReactionPort,
  createRecordingRendererDriver,
  createRegistryResolver,
  createTestDeadlineGate,
  createTestReceiptTools,
  parseM1Wav,
  readM1ActualWavAssets,
  sha256Hex,
} from '../support/m1-kit'
import type { RendererDriver, RendererObservation } from '../../src/performance/mapped-renderer'
import type { DeadlineGate } from '../../src/performance/browser/types'
import { PlayerDispatchError } from '../../src/performance/browser/types'
import { createFixedSynthesis, type FixedAudioEntry } from '../../src/performance/fixed-synthesis'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import { createPlaybackController } from '../../src/performance/browser/player'
import { createPlayerPort } from '../../src/performance/browser/player-port'
import { createFixtureRunner } from '../support/runner-factories'
import { createVirtualClock } from '../support/virtual-clock'

/** Deterministically drain queued microtasks without wall-clock waits. */
async function microtasks(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve()
}

/** Terminal performance facts, excluding non-terminal admission/start stages. */
function terminalFacts(receipts: readonly PerformanceReceipt[]): PerformanceReceipt[] {
  return receipts.filter(
    (receipt) => receipt.stage === 'completed' || receipt.stage === 'cancelled' || receipt.stage === 'failed',
  )
}

describe('M1 performance conformance', () => {
  it('accepts the correct fixture kit', async () => {
    const violations = await collectPerformanceViolations(() => ({
      synthesis: correct.createFixtureSynthesisPort(),
      renderer: correct.createFixtureRendererPort(),
      player: correct.createFixturePlayer(),
    }))
    expect(violations).toEqual([])
  })

  it('rejects faulty renderer, synthesis and player adapters', async () => {
    const violations = await collectPerformanceViolations(() => ({
      synthesis: faulty.createFaultySynthesisPort(),
      renderer: faulty.createFaultyRendererPort(),
      player: faulty.createFaultyPlayer(),
    }))
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('capabilities-unique')
    expect(codes).toContain('audio-ref-opaque')
    expect(codes).toContain('receipt-output-match')
  })

  it('accepts cancellation evidence from the correct hold player', async () => {
    const violations = await collectPlayerCancellationViolations(() =>
      correct.createFixturePlayer({ hold: true }),
    )
    expect(violations).toEqual([])
  })

  it('rejects a hold player that cancels without evidence', async () => {
    const violations = await collectPlayerCancellationViolations(() =>
      faulty.createFaultyPlayer({ hold: true }),
    )
    expect(violations.map((violation) => violation.code)).toContain('cancel-evidence-present')
  })
})

describe('M1 fixed-synthesis adapter', () => {
  it('returns the registered metadata for an exact tuple', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const prepared = await synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toEqual({
      ok: true,
      requestId: 'prepare-req-1',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      turnId: 'turn-fixture-1',
      segmentId: 'segment-fixture-0',
      audioRef: M1_FIXTURE_SEGMENT_0_REF,
      format: 'audio/wav',
      durationMs: 1200,
      timing: { startMs: 0, endMs: 1200 },
    })
  })

  it('returns fixed_audio_missing for an unknown tuple', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const prepared = await synthesis.prepare(
      fixturePreparePerformance({ text: 'no such catalogued phrase' }),
      createCallContext(),
    )
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'fixed_audio_missing' })
  })

  it('matches the tuple exactly, treating case, whitespace and voice fields distinctly', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const mismatches = [
      { text: 'we talked about the concert.' },
      { text: '  We talked about the concert.  ' },
      { voiceProfileId: 'voice-other' },
      { voiceProfileVersion: '2' },
    ]
    for (const override of mismatches) {
      const prepared = await synthesis.prepare(fixturePreparePerformance(override), createCallContext())
      expect(prepared).toMatchObject({ ok: false, reasonCode: 'fixed_audio_missing' })
    }
  })

  it('cancels when the original signal is aborted', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const context = createCallContext()
    context.abort()
    const prepared = await synthesis.prepare(fixturePreparePerformance(), context)
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
  })

  it('expires at the earlier of the request and context deadline in the clock domain', async () => {
    const { synthesis, clock } = createM1FixtureSynthesisKit()
    clock.set(50)
    const requestFirst = await synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 50 } }),
      createCallContext(100),
    )
    expect(requestFirst).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })

    clock.set(0)
    const contextFirst = await synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 100 } }),
      createCallContext(60),
    )
    clock.set(60)
    const contextExpired = await synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 100 } }),
      createCallContext(60),
    )
    expect(contextFirst).toMatchObject({ ok: true })
    expect(contextExpired).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
  })

  it('rejects duplicate tuples, duplicate refs and non-controlled refs at construction', () => {
    const entries = createM1FixtureEntries()
    const sameEntry = entries[0]
    expect(() =>
      createFixedSynthesis({ entries: [...entries, sameEntry], clock: createVirtualClock() }),
    ).toThrow()

    const duplicateRef: FixedAudioEntry[] = [
      ...entries,
      { ...entries[1], text: 'another phrase' },
    ]
    expect(() =>
      createFixedSynthesis({ entries: duplicateRef, clock: createVirtualClock() }),
    ).toThrow()

    const badRef: FixedAudioEntry[] = [
      { ...entries[0], audioRef: '/Users/local/secret/audio.wav' },
    ]
    expect(() =>
      createFixedSynthesis({ entries: badRef, clock: createVirtualClock() }),
    ).toThrow()

    const externalRef: FixedAudioEntry[] = [
      { ...entries[0], audioRef: 'https://cdn.example.com/a.wav' },
    ]
    expect(() =>
      createFixedSynthesis({ entries: externalRef, clock: createVirtualClock() }),
    ).toThrow()
  })

  it('rejects invalid metadata at construction', () => {
    const entries = createM1FixtureEntries()
    const negative = [...entries, { ...entries[0], durationMs: -1 }]
    expect(() =>
      createFixedSynthesis({ entries: negative, clock: createVirtualClock() }),
    ).toThrow()
    const reversedTiming = [...entries, { ...entries[0], timing: { startMs: 900, endMs: 10 } }]
    expect(() =>
      createFixedSynthesis({ entries: reversedTiming, clock: createVirtualClock() }),
    ).toThrow()
  })

  it('isolates the retained catalog from caller mutation', async () => {
    const entries = createM1FixtureEntries()
    const { synthesis } = createM1FixtureSynthesisKit(entries)
    ;(entries[0] as { text: string }).text = 'mutated phrase'
    ;(entries[0].timing as { startMs: number }).startMs = 999
    const prepared = await synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toMatchObject({ ok: true })
    expect(prepared.ok && prepared.timing?.startMs).toBe(0)
    const second = createM1FixtureEntries()[1]
    expect(second.audioRef).toBe(M1_FIXTURE_SEGMENT_1_REF)
  })

  it('performs only clock reads and signal checks, with no timer or signal subscription side effects', async () => {
    let clockReads = 0
    const clock: ClockPort = {
      nowMs: () => {
        clockReads += 1
        return 0
      },
    }
    const synthesis = createFixedSynthesis({ entries: createM1FixtureEntries(), clock })
    let subscribed = 0
    let unsubscribed = 0
    const signal = {
      get aborted() {
        return false
      },
      addEventListener: () => {
        subscribed += 1
      },
      removeEventListener: () => {
        unsubscribed += 1
      },
    } as unknown as AbortSignal

    const timerSpies = {
      setTimeout: vi.spyOn(globalThis, 'setTimeout'),
      clearTimeout: vi.spyOn(globalThis, 'clearTimeout'),
      setInterval: vi.spyOn(globalThis, 'setInterval'),
      clearInterval: vi.spyOn(globalThis, 'clearInterval'),
    }
    const pending = synthesis.prepare(fixturePreparePerformance(), {
      signal,
      deadline: { atMs: 60_000 },
    })
    const timerCallCounts = Object.fromEntries(
      Object.entries(timerSpies).map(([name, spy]) => [name, spy.mock.calls.length]),
    )
    for (const spy of Object.values(timerSpies)) spy.mockRestore()
    const prepared = await pending

    expect(prepared).toMatchObject({ ok: true })
    expect(clockReads).toBe(2)
    expect(subscribed).toBe(0)
    expect(unsubscribed).toBe(0)
    expect(timerCallCounts).toEqual({
      setTimeout: 0,
      clearTimeout: 0,
      setInterval: 0,
      clearInterval: 0,
    })
  })
})

describe('M1 mapped-renderer adapter', () => {
  it('maps a valid action to its driver dispatch and reports the observed stage', async () => {
    const kit = createM1FixtureMappedRenderer()
    kit.receipts.setNow(5000)
    kit.driver.setAuto({ stage: 'started', reasonCode: 'tick', localTimeMs: 5100 })
    const context = createCallContext()
    const receipt = await kit.renderer.execute(fixturePerformanceCommand(), context)
    expect(kit.driver.calls()).toEqual([{ driverAction: 'driver:smile', signal: context.signal }])
    expect(receipt).toMatchObject({
      stage: 'started',
      reasonCode: 'tick',
      localTimeMs: 5100,
      modality: 'avatar',
      source: 'm1-mapped-renderer',
      outputId: 'output-fixture-1',
    })
  })

  it('returns a defensive failed receipt for an unknown action with zero dispatches', async () => {
    const kit = createM1FixtureMappedRenderer()
    const receipt = await kit.renderer.execute(
      fixturePerformanceCommand({ actionId: 'unadvertised-action' }),
      createCallContext(),
    )
    expect(kit.driver.calls()).toEqual([])
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'unsupported_action' })
    expect(performanceReceiptSchema.safeParse(receipt).success).toBe(true)
  })

  it('treats a no-op action as non-dispatched', async () => {
    const kit = createM1FixtureMappedRenderer()
    const receipt = await kit.renderer.execute(
      fixturePerformanceCommand({ actionId: NO_OP_ACTION }),
      createCallContext(),
    )
    expect(kit.driver.calls()).toEqual([])
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'no_op_not_dispatched' })
  })

  it('treats a stale capability revision as non-dispatched', async () => {
    const kit = createM1FixtureMappedRenderer()
    const receipt = await kit.renderer.execute(
      fixturePerformanceCommand({ capabilityRevision: 9 }),
      createCallContext(),
    )
    expect(kit.driver.calls()).toEqual([])
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'stale_capability' })
  })

  it('cancels without dispatch when the bound signal is already aborted', async () => {
    const kit = createM1FixtureMappedRenderer()
    const context = createCallContext()
    context.abort()
    const receipt = await kit.renderer.execute(fixturePerformanceCommand(), context)
    expect(kit.driver.calls()).toEqual([])
    expect(receipt).toMatchObject({ stage: 'cancelled', reasonCode: null })
    expect(kit.gate.bindCount()).toBe(1)
    expect(kit.gate.releaseCount()).toBe(1)
  })

  it('settles unknown when the abort fires after dispatch with no established outcome', async () => {
    const kit = createM1FixtureMappedRenderer()
    const context = createCallContext()
    const executePromise = kit.renderer.execute(fixturePerformanceCommand(), context)
    expect(kit.driver.pendingCount()).toBe(1)
    context.abort()
    const receipt = await executePromise
    expect(receipt).toMatchObject({ stage: 'unknown', reasonCode: 'aborted_without_outcome' })
    expect(kit.gate.releaseCount()).toBe(1)
  })

  it('ignores a late driver resolution after abort without a second result', async () => {
    const kit = createM1FixtureMappedRenderer()
    const context = createCallContext()
    const executePromise = kit.renderer.execute(fixturePerformanceCommand(), context)
    context.abort()
    await expect(executePromise).resolves.toMatchObject({ stage: 'unknown' })
    kit.driver.resolveCurrent({ stage: 'completed', reasonCode: null, localTimeMs: null })
    await expect(executePromise).resolves.toMatchObject({ stage: 'unknown' })
    expect(kit.receipts.issued()).toHaveLength(1)
    expect(kit.driver.pendingCount()).toBe(0)
  })

  it('settles failed when the driver rejects, with the binding released', async () => {
    const kit = createM1FixtureMappedRenderer()
    kit.driver.setAutoReject(new Error('driver boom'))
    const receipt = await kit.renderer.execute(fixturePerformanceCommand(), createCallContext())
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'driver_error' })
    expect(kit.gate.releaseCount()).toBe(1)
  })

  it('settles failed/driver_error when the driver throws before returning, releasing once', async () => {
    let dispatchCount = 0
    const throwingDriver: RendererDriver = {
      dispatch: (_action, _signal) => {
        dispatchCount += 1
        throw new Error('sync driver boom')
      },
    }
    let releaseInvocations = 0
    const gate: DeadlineGate = {
      bind: (context) => ({
        signal: context.signal,
        release: () => {
          releaseInvocations += 1
        },
      }),
    }
    const receipts = createTestReceiptTools()
    const renderer = createMappedRenderer({
      snapshot: fixtureCapabilitySnapshot(),
      bindings: [
        { actionId: 'neutral', driverAction: 'driver:neutral' },
        { actionId: 'smile', driverAction: 'driver:smile' },
      ],
      driver: throwingDriver,
      deadlineGate: gate,
      receipts,
    })
    const command = fixturePerformanceCommand()
    const receipt = await renderer.execute(command, createCallContext())
    expect(receipt).toMatchObject({
      stage: 'failed',
      reasonCode: 'driver_error',
      modality: 'avatar',
      source: 'm1-mapped-renderer',
      outputId: command.outputId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      turnId: command.turnId,
      segmentId: command.segmentId,
    })
    expect(performanceReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(dispatchCount).toBe(1)
    expect(releaseInvocations).toBe(1)
  })

  it('turns an acceptance-only completion observation into unknown', async () => {
    const kit = createM1FixtureMappedRenderer({
      snapshot: fixtureCapabilitySnapshot({
        actions: [
          { actionId: 'neutral', description: 'neutral', observability: 'observable', parameterBounds: [] },
          { actionId: 'smile', description: 'smile', observability: 'acceptance-only', parameterBounds: [] },
        ],
      }),
    })
    kit.driver.setAuto({ stage: 'completed', reasonCode: null, localTimeMs: null })
    const receipt = await kit.renderer.execute(
      fixturePerformanceCommand({ actionId: 'smile' }),
      createCallContext(),
    )
    expect(receipt).toMatchObject({ stage: 'unknown', reasonCode: 'acceptance_only_cannot_complete' })
  })

  it('maps an invalid or observability-label stage to unknown', async () => {
    const kit = createM1FixtureMappedRenderer()
    kit.driver.setAuto({ stage: 'observable' } as unknown as RendererObservation)
    const receipt = await kit.renderer.execute(fixturePerformanceCommand(), createCallContext())
    expect(receipt).toMatchObject({ stage: 'unknown', reasonCode: 'invalid_stage' })
  })

  it('rejects a malformed command without dispatch or binding', async () => {
    const kit = createM1FixtureMappedRenderer()
    const malformed = { ...fixturePerformanceCommand(), outputId: '' } as unknown as PerformanceCommand
    await expect(kit.renderer.execute(malformed, createCallContext())).rejects.toThrow()
    expect(kit.driver.calls()).toEqual([])
    expect(kit.gate.bindCount()).toBe(0)
  })

  it('returns a protected copy of capabilities that is not mutated by callers', () => {
    const kit = createM1FixtureMappedRenderer()
    const first = kit.renderer.capabilities()
    first.actions[0].description = 'mutated'
    const second = kit.renderer.capabilities()
    expect(second.actions[0].description).toBe('neutral face')
    expect(first).not.toBe(second)
  })

  it('rejects missing, duplicate, unadvertised and no-op bindings at construction', () => {
    const snapshot = fixtureCapabilitySnapshot()
    const driver = createRecordingRendererDriver()
    const gate = createTestDeadlineGate()
    const receipts = createTestReceiptTools()
    const build = (bindings: { actionId: string; driverAction: string }[]) =>
      createMappedRenderer({ snapshot, bindings, driver, deadlineGate: gate, receipts })

    expect(() => build([{ actionId: 'neutral', driverAction: 'd:neutral' }])).toThrow()
    expect(() =>
      build([
        { actionId: 'neutral', driverAction: 'd:neutral' },
        { actionId: 'neutral', driverAction: 'd:neutral-2' },
      ]),
    ).toThrow()
    expect(() =>
      build([
        { actionId: 'neutral', driverAction: 'd:neutral' },
        { actionId: 'smile', driverAction: 'd:smile' },
        { actionId: 'wave', driverAction: 'd:wave' },
      ]),
    ).toThrow()
    expect(() =>
      build([
        { actionId: 'neutral', driverAction: NO_OP_ACTION },
        { actionId: 'smile', driverAction: 'd:smile' },
      ]),
    ).toThrow()
  })

  it('keeps independent instances isolated and never reuses receipt ids', async () => {
    const a = createM1FixtureMappedRenderer()
    const b = createM1FixtureMappedRenderer()
    a.driver.setAuto({ stage: 'accepted', reasonCode: null, localTimeMs: null })
    b.driver.setAuto({ stage: 'accepted', reasonCode: null, localTimeMs: null })
    const r1 = await a.renderer.execute(
      fixturePerformanceCommand({ outputId: 'out-shared' }),
      createCallContext(),
    )
    const r2 = await b.renderer.execute(
      fixturePerformanceCommand({ outputId: 'out-shared' }),
      createCallContext(),
    )
    expect(r1.outputId).toBe('out-shared')
    expect(r2.outputId).toBe('out-shared')
    expect(r1.receiptId).not.toBe(r2.receiptId)
  })
})

describe('M1 fixed-synthesis controlled reference and request validation', () => {
  it('rejects any non-audio scheme for a control reference at construction', () => {
    const entries = createM1FixtureEntries()
    const schemes = ['ftp://cdn.example.com/a.wav', 'arbitraryscheme://x/a.wav', 'blob:abc', 'data:text/plain,x']
    for (const audioRef of schemes) {
      expect(() =>
        createFixedSynthesis({ entries: [{ ...entries[0], audioRef }], clock: createVirtualClock() }),
      ).toThrow()
    }
  })

  it('accepts only the exact registered audio:// reference', () => {
    const entries = createM1FixtureEntries()
    const exact: FixedAudioEntry[] = [
      { ...entries[0], audioRef: 'audio://fixed/segment-0' },
    ]
    const synthesis = createFixedSynthesis({ entries: exact, clock: createVirtualClock() })
    expect(synthesis).toBeDefined()
  })

  it('rechecks expiry after the lookup for a missing tuple, returning cancelled_or_expired', async () => {
    const reads: number[] = []
    const clock: ClockPort = {
      nowMs: () => {
        const value = reads.length === 0 ? 0 : 60_000
        reads.push(reads.length)
        return value
      },
    }
    const synthesis = createFixedSynthesis({ entries: createM1FixtureEntries(), clock })
    const prepared = await synthesis.prepare(
      fixturePreparePerformance({ text: 'no such phrase' }),
      createCallContext(60_000),
    )
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(reads).toHaveLength(2)
  })

  it('rechecks expiry after the lookup for a matched tuple, returning cancelled_or_expired', async () => {
    const reads: number[] = []
    const clock: ClockPort = {
      nowMs: () => {
        const value = reads.length === 0 ? 0 : 60_000
        reads.push(reads.length)
        return value
      },
    }
    const synthesis = createFixedSynthesis({ entries: createM1FixtureEntries(), clock })
    const prepared = await synthesis.prepare(fixturePreparePerformance(), createCallContext(60_000))
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(reads).toHaveLength(2)
  })

  it('uses the earlier of the request and context deadline for the post-lookup expiry check', async () => {
    const { synthesis, clock } = createM1FixtureSynthesisKit()
    clock.set(50)
    const missing = await synthesis.prepare(
      fixturePreparePerformance({ text: 'nothing', deadline: { atMs: 40 } }),
      createCallContext(30),
    )
    expect(missing).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    clock.set(0)
    const present = await synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 100 } }),
      createCallContext(60),
    )
    expect(present).toMatchObject({ ok: true })
  })

  it('rejects a malformed identity-bearing prepare request without a receipt', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const malformed: PreparePerformance[] = [
      fixturePreparePerformance({ requestId: '' }),
      fixturePreparePerformance({ sessionId: '' }),
      fixturePreparePerformance({ epoch: -1 }),
      fixturePreparePerformance({ turnId: '' }),
      fixturePreparePerformance({ segmentId: '' }),
      fixturePreparePerformance({ voiceProfileId: '' }),
    ]
    for (const request of malformed) {
      await expect(synthesis.prepare(request, createCallContext())).rejects.toThrow()
    }
  })

  it('retains valid original identity on success and failure, and isolates returned timing', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const request = fixturePreparePerformance()
    const success = await synthesis.prepare(request, createCallContext())
    expect(success).toMatchObject({
      ok: true,
      requestId: request.requestId,
      sessionId: request.sessionId,
      epoch: request.epoch,
      turnId: request.turnId,
      segmentId: request.segmentId,
    })
    if (success.ok && success.timing) {
      success.timing.startMs = 9999
    }
    const again = await synthesis.prepare(request, createCallContext())
    expect(again.ok && again.timing?.startMs).toBe(0)
    const missing = await synthesis.prepare(
      fixturePreparePerformance({ text: 'nothing' }),
      createCallContext(),
    )
    expect(missing).toMatchObject({
      ok: false,
      requestId: request.requestId,
      sessionId: request.sessionId,
      epoch: request.epoch,
      turnId: request.turnId,
      segmentId: request.segmentId,
    })
  })
})

describe('M1 mapped-renderer validated command snapshot', () => {
  it('keeps original identity and observability after caller mutation during a held dispatch', async () => {
    const kit = createM1FixtureMappedRenderer({
      snapshot: fixtureCapabilitySnapshot({
        actions: [
          { actionId: 'neutral', description: 'neutral', observability: 'observable', parameterBounds: [] },
          { actionId: 'smile', description: 'smile', observability: 'acceptance-only', parameterBounds: [] },
        ],
      }),
    })
    const command = fixturePerformanceCommand({ actionId: 'smile' })
    const execution = kit.renderer.execute(command, createCallContext())
    expect(kit.driver.pendingCount()).toBe(1)
    command.outputId = 'mutated-output'
    command.sessionId = 'mutated-session'
    command.actionId = 'neutral'
    command.capabilityRevision = 9
    kit.driver.resolveCurrent({ stage: 'completed', reasonCode: 'r', localTimeMs: 7 })
    const receipt = await execution
    expect(receipt).toMatchObject({
      outputId: 'output-fixture-1',
      sessionId: 'session-fixture',
      stage: 'unknown',
      reasonCode: 'acceptance_only_cannot_complete',
    })
    expect(performanceReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(kit.receipts.issued()).toHaveLength(1)
  })

  it('distinguishes independent sessions that reuse an output id', async () => {
    const kit = createM1FixtureMappedRenderer()
    kit.driver.setAuto({ stage: 'started', reasonCode: 'ok', localTimeMs: null })
    const first = await kit.renderer.execute(
      fixturePerformanceCommand({ outputId: 'out-shared', sessionId: 'session-a' }),
      createCallContext(),
    )
    const second = await kit.renderer.execute(
      fixturePerformanceCommand({ outputId: 'out-shared', sessionId: 'session-b' }),
      createCallContext(),
    )
    expect(first.sessionId).toBe('session-a')
    expect(second.sessionId).toBe('session-b')
    expect(first.receiptId).not.toBe(second.receiptId)
  })
})

describe('M1 mapped-renderer complete observation validation', () => {
  it('settles null, non-object and invalid-stage observations to a schema-valid unknown', async () => {
    for (const malformed of [null, 'text', { stage: 'observable' }]) {
      const kit = createM1FixtureMappedRenderer()
      kit.driver.setAuto(malformed as unknown as RendererObservation)
      const receipt = await kit.renderer.execute(fixturePerformanceCommand(), createCallContext())
      expect(performanceReceiptSchema.safeParse(receipt).success).toBe(true)
      expect(receipt.stage).toBe('unknown')
      if (malformed === null || malformed === 'text') {
        expect(receipt.reasonCode).toBe('invalid_observation')
      } else {
        expect(receipt.reasonCode).toBe('invalid_stage')
      }
      expect(receipt.localTimeMs).toBeNull()
      expect(kit.gate.releaseCount()).toBe(1)
    }
  })

  it('settles a malformed reasonCode or localTimeMs observation to a schema-valid unknown', async () => {
    const cases: Array<{ stage: string; reasonCode: unknown; localTimeMs: unknown; expectReason: string }> = [
      { stage: 'started', reasonCode: '', localTimeMs: 5, expectReason: 'invalid_reason_code' },
      { stage: 'completed', reasonCode: 'ok', localTimeMs: -3, expectReason: 'invalid_local_time' },
      { stage: 'started', reasonCode: 'ok', localTimeMs: Number.NaN, expectReason: 'invalid_local_time' },
      { stage: 'ended', reasonCode: 'ok', localTimeMs: 5, expectReason: 'invalid_stage' },
    ]
    for (const entry of cases) {
      const kit = createM1FixtureMappedRenderer()
      kit.driver.setAuto(entry as unknown as RendererObservation)
      const receipt = await kit.renderer.execute(fixturePerformanceCommand(), createCallContext())
      expect(performanceReceiptSchema.safeParse(receipt).success).toBe(true)
      expect(receipt.stage).toBe('unknown')
      expect(receipt.reasonCode).toBe(entry.expectReason)
      expect(receipt.localTimeMs).toBeNull()
      expect(kit.gate.releaseCount()).toBe(1)
    }
  })

  it('produces no new receipt and no unhandled rejection from a late malformed resolution after abort', async () => {
    const kit = createM1FixtureMappedRenderer()
    const context = createCallContext()
    const execution = kit.renderer.execute(fixturePerformanceCommand(), context)
    context.abort()
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    const before = kit.receipts.issued().length
    kit.driver.resolveCurrent(null as unknown as RendererObservation)
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    expect(kit.receipts.issued()).toHaveLength(before)
  })

  it('produces no new receipt and no unhandled rejection from a late rejection after abort', async () => {
    const kit = createM1FixtureMappedRenderer()
    const context = createCallContext()
    const execution = kit.renderer.execute(fixturePerformanceCommand(), context)
    context.abort()
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    const before = kit.receipts.issued().length
    kit.driver.rejectCurrent(new Error('late boom'))
    await expect(execution).resolves.toMatchObject({ stage: 'unknown' })
    expect(kit.receipts.issued()).toHaveLength(before)
  })
})

describe('M1 mapped-renderer full capability schema validation', () => {
  it('rejects malformed capability schema fields at construction', () => {
    const driver = createRecordingRendererDriver()
    const gate = createTestDeadlineGate()
    const receipts = createTestReceiptTools()
    const fullSnapshot = fixtureCapabilitySnapshot()
    const build = (snapshot: CapabilitySnapshot) =>
      createMappedRenderer({
        snapshot,
        bindings: [
          { actionId: 'neutral', driverAction: 'd:n' },
          { actionId: 'smile', driverAction: 'd:s' },
        ],
        driver,
        deadlineGate: gate,
        receipts,
      })

    expect(() => build(fullSnapshot)).not.toThrow()

    expect(() => build({ ...fullSnapshot, rendererId: '' })).toThrow()
    expect(() => build({ ...fullSnapshot, characterId: '' })).toThrow()
    expect(() => build({ ...fullSnapshot, capabilityRevision: -1 })).toThrow()

    expect(() =>
      build({
        ...fullSnapshot,
        actions: [
          { actionId: 'neutral', description: 'x', observability: 'bogus', parameterBounds: [] },
          { actionId: 'smile', description: 'y', observability: 'observable', parameterBounds: [] },
        ] as unknown as CapabilitySnapshot['actions'],
      }),
    ).toThrow()

    expect(() =>
      build({
        ...fullSnapshot,
        actions: [
          {
            actionId: 'neutral',
            description: 'x',
            observability: 'observable',
            parameterBounds: [{ name: 'p', minimum: Number.NaN, maximum: 1 }],
          },
          { actionId: 'smile', description: 'y', observability: 'observable', parameterBounds: [] },
        ],
      }),
    ).toThrow()
  })

  it('rejects an advertised no-op actionId bound to a nonzero driver action', () => {
    const snapshot = fixtureCapabilitySnapshot({
      actions: [{ actionId: NO_OP_ACTION, description: 'no-op', observability: 'observable', parameterBounds: [] }],
    })
    const driver = createRecordingRendererDriver()
    const gate = createTestDeadlineGate()
    const receipts = createTestReceiptTools()
    expect(() =>
      createMappedRenderer({
        snapshot,
        bindings: [{ actionId: NO_OP_ACTION, driverAction: 'driver:something' }],
        driver,
        deadlineGate: gate,
        receipts,
      }),
    ).toThrow()
  })
})

describe('M1 actual adapters through the shared collector', () => {
  it('accepts the real fixed-synthesis and mapped-renderer kit with the fixture player', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const { renderer, driver } = createM1FixtureMappedRenderer()
    driver.setAuto({ stage: 'accepted', reasonCode: 'fixture-ok', localTimeMs: null })
    const violations = await collectPerformanceViolations(() => ({
      synthesis,
      renderer,
      player: correct.createFixturePlayer(),
    }))
    expect(violations).toEqual([])
  })

  it('substitutes two configured real adapters with the fixture player remaining identified', async () => {
    const first = createM1FixtureMappedRenderer()
    first.driver.setAuto({ stage: 'accepted', reasonCode: 'one', localTimeMs: null })
    const second = createM1FixtureMappedRenderer({
      snapshot: fixtureCapabilitySnapshot({
        rendererId: 'renderer-alt',
        capabilityRevision: 2,
        actions: [{ actionId: 'listening', description: 'listening', observability: 'observable', parameterBounds: [] }],
      }),
      bindings: [{ actionId: 'listening', driverAction: 'driver:listening' }],
    })
    second.driver.setAuto({ stage: 'accepted', reasonCode: 'two', localTimeMs: null })
    const firstReceipt = await first.renderer.execute(
      fixturePerformanceCommand({ outputId: 'out-first' }),
      createCallContext(),
    )
    const secondReceipt = await second.renderer.execute(
      fixturePerformanceCommand({ outputId: 'out-second', actionId: 'listening', capabilityRevision: 2 }),
      createCallContext(),
    )
    expect(firstReceipt).toMatchObject({ outputId: 'out-first', source: 'm1-mapped-renderer' })
    expect(secondReceipt).toMatchObject({ outputId: 'out-second', source: 'm1-mapped-renderer' })
    expect(second.renderer.capabilities().rendererId).toBe('renderer-alt')
    expect(performanceReceiptSchema.safeParse(secondReceipt).success).toBe(true)
  })
})

describe('M1 actual browser player through the shared collectors (T01)', () => {
  it('accepts the real synthesis, mapped renderer and browser player kit', async () => {
    const { synthesis } = createM1FixtureSynthesisKit()
    const { renderer, driver } = createM1FixtureMappedRenderer()
    driver.setAuto({ stage: 'accepted', reasonCode: 'fixture-ok', localTimeMs: null })
    const kit = createActualCompletingPlayerKit()
    const violations = await collectPerformanceViolations(() => ({
      synthesis,
      renderer,
      player: kit.player,
    }))
    expect(violations).toEqual([])
  })

  it('accepts actual cancellation evidence from the holding player', async () => {
    const kit = createActualHoldingPlayerKit()
    const violations = await collectPlayerCancellationViolations(() => kit.player)
    expect(violations).toEqual([])
  })
})

describe('M1 increment B fixed audio catalog (T02)', () => {
  it('prepares the measured catalog with exact identities and no media effects', async () => {
    const synthesis = createFixedSynthesis({ entries: createM1ActualAssetEntries(), clock: createVirtualClock(0) })
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver()
    const prepared = await synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toEqual({
      ok: true,
      requestId: 'prepare-req-1',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      turnId: 'turn-fixture-1',
      segmentId: 'segment-fixture-0',
      audioRef: M1_ACTUAL_SEGMENT_0_REF,
      format: 'audio/wav',
      durationMs: M1_ACTUAL_SEGMENT_0_DURATION_MS,
      timing: { startMs: 0, endMs: M1_ACTUAL_SEGMENT_0_DURATION_MS },
    })
    expect(M1_ACTUAL_SEGMENT_0_DURATION_MS).not.toBe(M1_FIXTURE_DURATION_MS)
    expect(resolver.calls()).toEqual([])
    expect(media.createCount()).toBe(0)
  })

  it('uses the measured segment-1 duration and the exact registered blob refs', async () => {
    const entries = createM1ActualAssetEntries()
    const blobs = createM1ActualBlobMap()
    expect(entries[1]?.durationMs).toBe(M1_ACTUAL_SEGMENT_1_DURATION_MS)
    expect(new Set(blobs.keys())).toEqual(new Set(entries.map((entry) => entry.audioRef)))
    const synthesis = createFixedSynthesis({ entries, clock: createVirtualClock(0) })
    const prepared = await synthesis.prepare(
      fixturePreparePerformance({ text: 'It was loud and fun.', segmentId: 'segment-fixture-1' }),
      createCallContext(),
    )
    expect(prepared).toMatchObject({
      ok: true,
      audioRef: 'audio://fixture/segment-1',
      durationMs: M1_ACTUAL_SEGMENT_1_DURATION_MS,
    })
  })

  it('composes the actual Blob map from the copied WAV bytes with verified header, frames and hashes', () => {
    const assets = readM1ActualWavAssets()
    expect(assets.map((asset) => asset.ref)).toEqual([
      M1_ACTUAL_SEGMENT_0_REF,
      M1_ACTUAL_SEGMENT_1_REF,
    ])
    const blobs = createM1ActualBlobMap()
    assets.forEach((asset, index) => {
      const expected = M1_ACTUAL_WAV_EXPECTED[index]
      expect(expected).toBeDefined()
      if (expected === undefined) return
      expect(asset.file).toBe(expected.file)
      expect(asset.bytes.byteLength).toBe(expected.sizeBytes)
      expect(sha256Hex(asset.bytes)).toBe(expected.sha256)
      const info = parseM1Wav(asset.bytes)
      expect(info).toMatchObject({
        channels: expected.channels,
        sampleRateHz: expected.sampleRateHz,
        bitsPerSample: expected.bitsPerSample,
        frameCount: expected.frameCount,
      })
      const blob = blobs.get(asset.ref)
      expect(blob).toBeInstanceOf(Blob)
      expect(blob?.size).toBe(expected.sizeBytes)
      expect(blob?.type).toBe(M1_FIXTURE_FORMAT)
    })
    // Frame-derived durations equal the measured catalog metadata.
    expect(parseM1Wav(assets[0]?.bytes as Uint8Array).durationMs).toBeCloseTo(
      M1_ACTUAL_SEGMENT_0_DURATION_MS,
      6,
    )
    expect(parseM1Wav(assets[1]?.bytes as Uint8Array).durationMs).toBeCloseTo(
      M1_ACTUAL_SEGMENT_1_DURATION_MS,
      6,
    )
    const entries = createM1ActualAssetEntries()
    expect(new Set(blobs.keys())).toEqual(new Set(entries.map((entry) => entry.audioRef)))
  })

  it('isolates the measured catalog from caller mutation', async () => {
    const entries = createM1ActualAssetEntries()
    const synthesis = createFixedSynthesis({ entries, clock: createVirtualClock(0) })
    ;(entries[0] as { text: string }).text = 'mutated'
    const prepared = await synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared.ok).toBe(true)
  })

  it('resolves only exact registered refs and releases leases idempotently', async () => {
    const resolver = createRegistryResolver(createM1ActualBlobMap())
    await expect(
      resolver.resolve('audio://fixture/not-registered', createCallContext().signal),
    ).rejects.toThrow()
    expect(resolver.unknownRefs()).toEqual(['audio://fixture/not-registered'])

    await resolver.resolve(M1_ACTUAL_SEGMENT_0_REF, createCallContext().signal)
    const lease = resolver.leases()[0]
    expect(lease?.blob).toBeInstanceOf(Blob)
    lease?.release()
    lease?.release()
    expect(lease?.releaseCount()).toBe(1)
  })
})

describe('M1 actual player lifecycle observations (T03)', () => {
  it('reports accepted, one actual started and one completed, then idle', async () => {
    const kit = createActualPlayerKit()
    const command = fixturePerformanceCommand()
    const context = createCallContext()
    const execution = kit.controller.execute(command, { signal: context.signal })
    expect(kit.controller.status()).toMatchObject({
      idle: false,
      activeOutputId: command.outputId,
      lastStage: 'accepted',
    })
    let settled = false
    void execution.then(() => {
      settled = true
    })

    expect(kit.resolver.calls()).toHaveLength(1)
    kit.resolver.resolveNext()
    await microtasks()
    const handle = kit.media.current()
    expect(handle).not.toBeNull()
    expect(handle?.loadCount()).toBe(1)
    expect(handle?.playCount()).toBe(1)
    expect(settled).toBe(false)
    expect(kit.controller.status().lastStage).toBe('accepted')

    handle?.emitPlaying()
    handle?.emitPlaying()
    expect(kit.controller.status().lastStage).toBe('started')
    handle?.emitEnded()

    const receipt = await execution
    expect(receipt).toMatchObject({
      stage: 'completed',
      modality: 'audio',
      source: 'm1-player',
      outputId: command.outputId,
      reasonCode: null,
    })
    await microtasks()
    expect(kit.observed.map((r) => r.stage)).toEqual(['accepted', 'started', 'completed'])
    expect(kit.observed[1]?.receiptId).not.toBe(kit.observed[0]?.receiptId)
    expect(kit.controller.status().idle).toBe(true)
    expect(handle?.detached()).toBe(true)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
  })
})

describe('M1 actual player bootstrap configuration validation (T03)', () => {
  it('rejects an empty or nonstring session before any effect', () => {
    for (const sessionId of ['', 0, null, undefined]) {
      const resolver = createControlledResolver()
      const media = createControlledMediaDriver()
      expect(() =>
        createPlaybackController({
          sessionId: sessionId as unknown as string,
          initialEpoch: 1,
          resolver,
          media,
          receipts: createTestReceiptTools('bad-session'),
          onReceipt: () => {},
          reportFault: () => {},
        }),
      ).toThrow()
      expect(resolver.calls()).toEqual([])
      expect(media.createCount()).toBe(0)
    }
  })

  it('rejects nonfinite, fractional and negative initial epochs before any effect', () => {
    const invalidEpochs = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      '1',
    ]
    for (const initialEpoch of invalidEpochs) {
      const resolver = createControlledResolver()
      const media = createControlledMediaDriver()
      expect(() =>
        createPlaybackController({
          sessionId: FIXTURE_SESSION_ID,
          initialEpoch: initialEpoch as unknown as number,
          resolver,
          media,
          receipts: createTestReceiptTools('bad-epoch'),
          onReceipt: () => {},
          reportFault: () => {},
        }),
      ).toThrow()
      expect(resolver.calls()).toEqual([])
      expect(media.createCount()).toBe(0)
    }
  })

  it('accepts a nonempty session and a nonnegative integer epoch', () => {
    const kit = createActualPlayerKit({ initialEpoch: 0 })
    expect(kit.controller.status()).toMatchObject({ idle: true, lastStage: null })
  })
})

describe('M1 actual player failure paths (T04)', () => {
  it('fails when the resolver rejects and never creates media', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoReject(new Error('missing resource'))
    const kit = createActualPlayerKit({ resolver })
    const receipt = await kit.player.execute(fixturePerformanceCommand(), createCallContext())
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'resolver_failed' })
    expect(kit.media.createCount()).toBe(0)
  })

  it('fails when load throws and releases the lease after detaching', async () => {
    const kit = createActualPlayerKit({ media: createControlledMediaDriver({ loadThrows: true }) })
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    const receipt = await execution
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'load_failed' })
    expect(kit.media.current()?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
  })

  it('fails when play rejects', async () => {
    const kit = createActualPlayerKit({ media: createControlledMediaDriver({ playRejects: true }) })
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    await expect(execution).resolves.toMatchObject({ stage: 'failed', reasonCode: 'play_failed' })
  })

  it('fails on a media error event', async () => {
    const kit = createActualPlayerKit()
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    kit.media.current()?.emitError('decode_failed')
    await expect(execution).resolves.toMatchObject({ stage: 'failed', reasonCode: 'decode_failed' })
  })

  it('fails with start_unobserved when ended arrives before any start', async () => {
    const kit = createActualPlayerKit()
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    kit.media.current()?.emitEnded()
    await expect(execution).resolves.toMatchObject({ stage: 'failed', reasonCode: 'start_unobserved' })
  })

  it('quarantines on detach failure and refuses the next output', async () => {
    const media = createControlledMediaDriver({ detachResult: false, autoEvents: true })
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const kit = createActualPlayerKit({ media, resolver })
    const completed = await kit.player.execute(
      fixturePerformanceCommand({ outputId: 'quarantine-1' }),
      createCallContext(),
    )
    expect(completed).toMatchObject({ stage: 'completed' })
    expect(kit.faults.length).toBeGreaterThan(0)
    expect(kit.controller.status().idle).toBe(false)
    await expect(
      kit.player.execute(fixturePerformanceCommand({ outputId: 'quarantine-2' }), createCallContext()),
    ).rejects.toMatchObject({ code: 'busy' })
  })

  it('reports failed/cleanup_failed when an active cancel cannot detach', async () => {
    const kit = createActualPlayerKit({ media: createControlledMediaDriver({ detachResult: false }) })
    const execution = kit.controller.execute(
      fixturePerformanceCommand({ outputId: 'cancel-quarantine' }),
      { signal: createCallContext().signal },
    )
    kit.resolver.resolveNext()
    await microtasks()
    const cancelled = await kit.controller.cancel({ requestId: 'c-q', revokedEpoch: 1, newEpoch: 2 })
    expect(cancelled).toMatchObject({ stage: 'failed', reasonCode: 'cleanup_failed' })
    await expect(execution).resolves.toBe(cancelled)
    expect(kit.controller.status().idle).toBe(false)
    kit.controller.dispose()
  })
})

describe('M1 actual player quarantine dispose retry (T04, T05)', () => {
  const quarantineKit = (): ReturnType<typeof createActualPlayerKit> => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ detachResult: false, autoEvents: true })
    return createActualPlayerKit({ media, resolver })
  }

  it('releases the retained lease once when a dispose retry detaches', async () => {
    const kit = quarantineKit()
    const completed = await kit.player.execute(
      fixturePerformanceCommand({ outputId: 'q-retry-1' }),
      createCallContext(),
    )
    expect(completed).toMatchObject({ stage: 'completed' })
    expect(kit.controller.status().idle).toBe(false)
    const lease = kit.resolver.leases()[0]
    expect(lease?.releaseCount()).toBe(0)

    kit.media.setDetachResult(true)
    kit.controller.dispose()
    expect(lease?.releaseCount()).toBe(1)
    expect(kit.controller.status().idle).toBe(true)

    kit.controller.dispose()
    expect(lease?.releaseCount()).toBe(1)
  })

  it('retains idle false and disables admission when a dispose retry still cannot detach', async () => {
    const kit = quarantineKit()
    await kit.player.execute(fixturePerformanceCommand({ outputId: 'q-retry-2' }), createCallContext())
    expect(kit.controller.status().idle).toBe(false)
    const lease = kit.resolver.leases()[0]

    kit.controller.dispose()
    expect(kit.controller.status().idle).toBe(false)
    expect(lease?.releaseCount()).toBe(0)
    await expect(
      kit.player.execute(fixturePerformanceCommand({ outputId: 'q-retry-3' }), createCallContext()),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('disposes while the resolver is pending without throwing and settles once', async () => {
    const kit = createActualPlayerKit()
    const command = fixturePerformanceCommand()
    const execution = kit.controller.execute(command, { signal: createCallContext().signal })
    expect(kit.resolver.pendingCount()).toBe(1)

    expect(() => kit.controller.dispose()).not.toThrow()
    const receipt = await execution
    expect(receipt).toMatchObject({ stage: 'cancelled', outputId: command.outputId })
    expect(kit.controller.status().idle).toBe(true)
    expect(kit.media.createCount()).toBe(0)
    await expect(
      kit.controller.execute(fixturePerformanceCommand({ outputId: 'after-dispose' }), {
        signal: createCallContext().signal,
      }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('M1 actual player cancellation, deadline and epoch (T05)', () => {
  it('cancels while resolving and releases a late lease without creating media', async () => {
    const kit = createActualPlayerKit()
    const command = fixturePerformanceCommand()
    const execution = kit.controller.execute(command, { signal: createCallContext().signal })
    const cancelled = await kit.controller.cancel({ requestId: 'c-resolve', revokedEpoch: 1, newEpoch: 2 })
    expect(cancelled).toMatchObject({
      stage: 'cancelled',
      epoch: 1,
      outputId: command.outputId,
      source: 'm1-player',
    })
    await expect(execution).resolves.toBe(cancelled)
    kit.resolver.resolveNext()
    await microtasks()
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(kit.media.createCount()).toBe(0)
    expect(kit.controller.status().idle).toBe(true)
  })

  it('cancels while play is fulfilled but not started, detaching and releasing', async () => {
    const kit = createActualPlayerKit()
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    const handle = kit.media.current()
    expect(handle?.playCount()).toBe(1)
    const cancelled = await kit.controller.cancel({ requestId: 'c-play', revokedEpoch: 1, newEpoch: 2 })
    expect(cancelled).toMatchObject({ stage: 'cancelled' })
    await expect(execution).resolves.toBe(cancelled)
    expect(handle?.detached()).toBe(true)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
  })

  it('cancels after a real start while ended is held', async () => {
    const kit = createActualPlayerKit({
      media: createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 }),
    })
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    expect(kit.controller.status().lastStage).toBe('started')
    const cancelled = await kit.controller.cancel({ requestId: 'c-started', revokedEpoch: 1, newEpoch: 2 })
    expect(cancelled).toMatchObject({ stage: 'cancelled' })
    await expect(execution).resolves.toBe(cancelled)
    expect(kit.observed.map((r) => r.stage)).toEqual(['accepted', 'started', 'cancelled'])
  })

  it('aborts active playback through the expiring virtual deadline gate', async () => {
    const gate = createExpiringDeadlineGate()
    const kit = createActualPlayerKit({ gate })
    const execution = kit.player.execute(fixturePerformanceCommand(), createCallContext(1000))
    expect(gate.bindCount()).toBe(1)
    gate.advance(1000)
    await expect(execution).resolves.toMatchObject({ stage: 'cancelled' })
    expect(gate.releaseCount()).toBe(1)
  })

  it('returns null for an idle cancel and then rejects the revoked command as stale', async () => {
    const kit = createActualPlayerKit()
    const idle = await kit.controller.cancel({ requestId: 'c-idle', revokedEpoch: 1, newEpoch: 2 })
    expect(idle).toBeNull()
    await expect(
      kit.controller.execute(fixturePerformanceCommand(), { signal: createCallContext().signal }),
    ).rejects.toMatchObject({ code: 'stale' })
  })

  it('forwards a cancel through an already-expired call context', async () => {
    const kit = createActualPlayerKit()
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    const expired = createCallContext()
    expired.abort()
    const cancelled = await kit.player.cancel(
      { requestId: 'c-expired', revokedEpoch: 1, newEpoch: 2 },
      expired,
    )
    expect(cancelled).toMatchObject({ stage: 'cancelled' })
    await expect(execution).resolves.toBe(cancelled)
  })
})

describe('M1 actual player terminal races and observer isolation (T06)', () => {
  it('keeps the first terminal fact across orchestrated race attempts', async () => {
    const kit = createActualPlayerKit()
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    const handle = kit.media.current()
    handle?.emitPlaying()
    handle?.emitEnded()
    handle?.emitEnded()
    handle?.emitError('late_error')
    const receipt = await execution
    expect(receipt.stage).toBe('completed')
    await microtasks()
    expect(kit.observed.map((r) => r.stage)).toEqual(['accepted', 'started', 'completed'])
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
  })

  it('ignores a late resolver lease after cancellation without creating media', async () => {
    const kit = createActualPlayerKit()
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    await kit.controller.cancel({ requestId: 'late', revokedEpoch: 1, newEpoch: 2 })
    kit.resolver.resolveNext()
    await microtasks()
    await expect(execution).resolves.toMatchObject({ stage: 'cancelled' })
    expect(kit.media.createCount()).toBe(0)
  })

  it('keeps the cancelled terminal across a controlled pending play promise fulfilled late', async () => {
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver({ holdPlay: true })
    const kit = createActualPlayerKit({ resolver, media })
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    const handle = kit.media.current()
    expect(handle?.playCount()).toBe(1)
    expect(handle?.playSettled()).toBe(false)

    const cancelled = await kit.controller.cancel({ requestId: 'c-hold', revokedEpoch: 1, newEpoch: 2 })
    expect(cancelled).toMatchObject({ stage: 'cancelled' })
    await expect(execution).resolves.toBe(cancelled)

    handle?.resolvePlay()
    await microtasks()
    expect(handle?.playSettled()).toBe(true)
    expect(kit.observed.map((r) => r.stage)).toEqual(['accepted', 'cancelled'])
    await expect(execution).resolves.toBe(cancelled)
    expect(terminalFacts(kit.observed)).toHaveLength(1)
  })

  it('ignores a late rejection of a controlled pending play promise after cancel', async () => {
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver({ holdPlay: true })
    const kit = createActualPlayerKit({ resolver, media })
    const execution = kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    kit.resolver.resolveNext()
    await microtasks()
    const handle = kit.media.current()

    const cancelled = await kit.controller.cancel({
      requestId: 'c-hold-reject',
      revokedEpoch: 1,
      newEpoch: 2,
    })
    handle?.rejectPlay(new Error('late play rejection'))
    await microtasks()
    await expect(execution).resolves.toBe(cancelled)
    expect(kit.observed.map((r) => r.stage)).toEqual(['accepted', 'cancelled'])
    expect(kit.faults).toEqual([])
  })

  it('keeps a single terminal across meaningful ended/error/cancel order permutations', async () => {
    const permute = async (
      order: Array<'playing' | 'ended' | 'error' | 'cancel'>,
    ): Promise<PerformanceReceipt['stage']> => {
      const kit = createActualPlayerKit()
      const execution = kit.controller.execute(fixturePerformanceCommand(), {
        signal: createCallContext().signal,
      })
      kit.resolver.resolveNext()
      await microtasks()
      const handle = kit.media.current()
      for (const step of order) {
        if (step === 'playing') handle?.emitPlaying()
        else if (step === 'ended') handle?.emitEnded()
        else if (step === 'error') handle?.emitError('race_error')
        else await kit.controller.cancel({ requestId: 'c-race', revokedEpoch: 1, newEpoch: 2 })
      }
      const receipt = await execution
      const after = await execution
      await microtasks()
      expect(after).toBe(receipt)
      expect(terminalFacts(kit.observed)).toHaveLength(1)
      expect(kit.observed.at(-1)?.stage).toBe(receipt.stage)
      return receipt.stage
    }

    expect(await permute(['playing', 'ended', 'error'])).toBe('completed')
    expect(await permute(['playing', 'error', 'ended'])).toBe('failed')
    expect(await permute(['playing', 'cancel', 'ended'])).toBe('cancelled')
    expect(await permute(['playing', 'ended', 'cancel'])).toBe('completed')
  })

  it('isolates observer faults from playback facts', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true })
    const faults: unknown[] = []
    const receipts: PerformanceReceipt[] = []
    const controller = createPlaybackController({
      sessionId: FIXTURE_SESSION_ID,
      initialEpoch: 1,
      resolver,
      media,
      receipts: createTestReceiptTools('obs'),
      onReceipt: (receipt) => {
        receipts.push(receipt)
        throw new Error('observer boom')
      },
      reportFault: (error) => {
        faults.push(error)
      },
    })
    const first = await controller.execute(fixturePerformanceCommand({ outputId: 'obs-1' }), {
      signal: createCallContext().signal,
    })
    const second = await controller.execute(
      fixturePerformanceCommand({ outputId: 'obs-2', segmentId: 'segment-2' }),
      { signal: createCallContext().signal },
    )
    expect(first.stage).toBe('completed')
    expect(second.stage).toBe('completed')
    await microtasks()
    expect(receipts.length).toBeGreaterThanOrEqual(6)
    expect(faults.length).toBeGreaterThanOrEqual(6)
    expect(controller.status().idle).toBe(true)
  })

  it('tolerates a reentrant observer cancel without restarting work', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true })
    const receipts: PerformanceReceipt[] = []
    let reentered = false
    let controller: ReturnType<typeof createPlaybackController>
    controller = createPlaybackController({
      sessionId: FIXTURE_SESSION_ID,
      initialEpoch: 1,
      resolver,
      media,
      receipts: createTestReceiptTools('reentrant'),
      onReceipt: (receipt) => {
        receipts.push(receipt)
        if (receipt.stage === 'accepted' && !reentered) {
          reentered = true
          void controller.cancel({ requestId: 'reentrant', revokedEpoch: 1, newEpoch: 2 })
        }
      },
      reportFault: () => {},
    })
    const execution = controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    const receipt = await execution
    expect(['cancelled', 'completed', 'failed']).toContain(receipt.stage)
    expect(controller.status().idle).toBe(true)
    expect(media.createCount()).toBeLessThanOrEqual(1)
  })
})

describe('M1 actual player synchronous dependency reentry (T06)', () => {
  const resolver = (): ReturnType<typeof createControlledResolver> => {
    const controlled = createControlledResolver()
    controlled.setAutoResolve()
    return controlled
  }

  it('releases a subscription returned after a synchronous terminal in subscribe, never loading or playing', async () => {
    const media = createControlledMediaDriver({
      emitOnSubscribe: { type: 'error', reasonCode: 'sync_subscribe_error' },
    })
    const kit = createActualPlayerKit({ media, resolver: resolver() })
    const receipt = await kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    await microtasks()
    const handle = kit.media.current()
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'sync_subscribe_error' })
    expect(handle?.subscribeCount()).toBe(1)
    expect(handle?.unsubscribeCount()).toBe(1)
    expect(handle?.loadCount()).toBe(0)
    expect(handle?.playCount()).toBe(0)
    expect(handle?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(terminalFacts(kit.observed)).toHaveLength(1)
    expect(kit.controller.status().idle).toBe(true)
  })

  it('settles cancelled when the owner aborts during subscribe, never loading or playing', async () => {
    const context = createCallContext()
    const media = createControlledMediaDriver({ onSubscribe: () => context.abort() })
    const kit = createActualPlayerKit({ media, resolver: resolver() })
    const receipt = await kit.controller.execute(fixturePerformanceCommand(), { signal: context.signal })
    await microtasks()
    const handle = kit.media.current()
    expect(receipt).toMatchObject({ stage: 'cancelled' })
    expect(handle?.subscribeCount()).toBe(1)
    expect(handle?.unsubscribeCount()).toBe(1)
    expect(handle?.loadCount()).toBe(0)
    expect(handle?.playCount()).toBe(0)
    expect(handle?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(terminalFacts(kit.observed)).toHaveLength(1)
    expect(kit.controller.status().idle).toBe(true)
  })

  it('ignores a synchronous terminal during load and never plays', async () => {
    const media = createControlledMediaDriver({
      emitOnLoad: { type: 'error', reasonCode: 'sync_load_error' },
    })
    const kit = createActualPlayerKit({ media, resolver: resolver() })
    const receipt = await kit.controller.execute(fixturePerformanceCommand(), {
      signal: createCallContext().signal,
    })
    await microtasks()
    const handle = kit.media.current()
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'sync_load_error' })
    expect(handle?.subscribeCount()).toBe(1)
    expect(handle?.unsubscribeCount()).toBe(1)
    expect(handle?.loadCount()).toBe(1)
    expect(handle?.playCount()).toBe(0)
    expect(handle?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(terminalFacts(kit.observed)).toHaveLength(1)
    expect(kit.controller.status().idle).toBe(true)
  })

  it('settles cancelled when the owner aborts during load and never plays', async () => {
    const context = createCallContext()
    const media = createControlledMediaDriver({ onLoad: () => context.abort() })
    const kit = createActualPlayerKit({ media, resolver: resolver() })
    const receipt = await kit.controller.execute(fixturePerformanceCommand(), { signal: context.signal })
    await microtasks()
    const handle = kit.media.current()
    expect(receipt).toMatchObject({ stage: 'cancelled' })
    expect(handle?.loadCount()).toBe(1)
    expect(handle?.playCount()).toBe(0)
    expect(handle?.unsubscribeCount()).toBe(1)
    expect(handle?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(terminalFacts(kit.observed)).toHaveLength(1)
    expect(kit.controller.status().idle).toBe(true)
  })

  it('quarantines a handle returned after a synchronous create abort when detach fails', async () => {
    const context = createCallContext()
    const controlledResolver = resolver()
    const media = createControlledMediaDriver({
      detachResult: false,
      onCreate: () => context.abort(),
    })
    const kit = createActualPlayerKit({ media, resolver: controlledResolver })
    const command = fixturePerformanceCommand()
    const receipt = await kit.controller.execute(command, { signal: context.signal })
    await microtasks()
    const handle = kit.media.current()

    // A synchronous abort during create, with a live handle that cannot detach,
    // must quarantine: not a successful cancellation.
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'cleanup_failed' })
    expect(handle?.subscribeCount()).toBe(0)
    expect(handle?.loadCount()).toBe(0)
    expect(handle?.playCount()).toBe(0)
    expect(handle?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(0)
    expect(kit.controller.status()).toMatchObject({ idle: false, activeOutputId: command.outputId })
    expect(
      kit.faults.map((fault) => (fault instanceof Error ? fault.message : String(fault))),
    ).toContain('m1-player: media detach failed')

    await expect(
      kit.controller.execute(fixturePerformanceCommand({ outputId: 'create-abort-next' }), {
        signal: createCallContext().signal,
      }),
    ).rejects.toMatchObject({ code: 'busy' })

    // A successful dispose retry releases the retained lease once and goes idle.
    media.setDetachResult(true)
    kit.controller.dispose()
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(kit.controller.status().idle).toBe(true)
  })

  it('settles cancelled and releases once when a synchronous create abort can detach', async () => {
    const context = createCallContext()
    const controlledResolver = resolver()
    const media = createControlledMediaDriver({ onCreate: () => context.abort() })
    const kit = createActualPlayerKit({ media, resolver: controlledResolver })
    const receipt = await kit.controller.execute(fixturePerformanceCommand(), { signal: context.signal })
    await microtasks()
    const handle = kit.media.current()
    expect(receipt).toMatchObject({ stage: 'cancelled' })
    expect(handle?.subscribeCount()).toBe(0)
    expect(handle?.loadCount()).toBe(0)
    expect(handle?.playCount()).toBe(0)
    expect(handle?.detachCount()).toBe(1)
    expect(kit.resolver.leases()[0]?.releaseCount()).toBe(1)
    expect(kit.controller.status().idle).toBe(true)
    expect(kit.faults).toEqual([])
  })

  it('defers an authoritative cancel raised inside a create boundary until the handle is registered', async () => {
    const context = createCallContext()
    const controlledResolver = resolver()
    const media = createControlledMediaDriver({ detachResult: false })
    const observed: PerformanceReceipt[] = []
    let controller: ReturnType<typeof createPlaybackController>
    let cancelPromise: Promise<PerformanceReceipt | null> | null = null
    controller = createPlaybackController({
      sessionId: FIXTURE_SESSION_ID,
      initialEpoch: 1,
      resolver: controlledResolver,
      media,
      receipts: createTestReceiptTools('sync-cancel'),
      onReceipt: (receipt) => observed.push(receipt),
      reportFault: () => {},
    })
    media.setOnCreate(() => {
      context.abort()
      cancelPromise = controller.cancel({ requestId: 'c-sync', revokedEpoch: 1, newEpoch: 2 })
    })
    const command = fixturePerformanceCommand()
    const execution = controller.execute(command, { signal: context.signal })
    const receipt = await execution
    const cancelled = await cancelPromise
    await microtasks()

    expect(cancelPromise).not.toBeNull()
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'cleanup_failed' })
    expect(cancelled).toBe(receipt)
    expect(controller.status()).toMatchObject({ idle: false, activeOutputId: command.outputId })
    expect(media.current()?.subscribeCount()).toBe(0)
    expect(media.current()?.loadCount()).toBe(0)
    expect(media.current()?.playCount()).toBe(0)
    expect(media.current()?.detachCount()).toBe(1)
    expect(controlledResolver.leases()[0]?.releaseCount()).toBe(0)
    expect(terminalFacts(observed)).toHaveLength(1)

    media.setDetachResult(true)
    controller.dispose()
    expect(controlledResolver.leases()[0]?.releaseCount()).toBe(1)
    expect(controller.status().idle).toBe(true)
  })

  it('defers a dispose raised inside a create boundary until the handle is registered', async () => {
    const context = createCallContext()
    const controlledResolver = resolver()
    const media = createControlledMediaDriver({ detachResult: false })
    let controller: ReturnType<typeof createPlaybackController>
    let disposeError: unknown = null
    controller = createPlaybackController({
      sessionId: FIXTURE_SESSION_ID,
      initialEpoch: 1,
      resolver: controlledResolver,
      media,
      receipts: createTestReceiptTools('sync-dispose'),
      onReceipt: () => {},
      reportFault: () => {},
    })
    media.setOnCreate(() => {
      context.abort()
      try {
        controller.dispose()
      } catch (error) {
        disposeError = error
      }
    })
    const receipt = await controller.execute(fixturePerformanceCommand(), { signal: context.signal })
    await microtasks()

    expect(disposeError).toBeNull()
    expect(receipt).toMatchObject({ stage: 'failed', reasonCode: 'cleanup_failed' })
    expect(controller.status().idle).toBe(false)
    expect(media.current()?.loadCount()).toBe(0)
    expect(media.current()?.playCount()).toBe(0)
    expect(controlledResolver.leases()[0]?.releaseCount()).toBe(0)

    media.setDetachResult(true)
    controller.dispose()
    expect(controlledResolver.leases()[0]?.releaseCount()).toBe(1)
    expect(controller.status().idle).toBe(true)
  })
})

describe('M1 actual player records and epoch lifetime (T07)', () => {
  it('completes 20 sequential outputs, deduplicates the first id and rejects conflicts', async () => {
    const kit = createActualCompletingPlayerKit(1)
    for (let index = 1; index <= 20; index += 1) {
      const receipt = await kit.player.execute(
        fixturePerformanceCommand({ outputId: `out-${index}`, segmentId: `segment-${index}` }),
        createCallContext(),
      )
      expect(receipt).toMatchObject({ stage: 'completed', outputId: `out-${index}`, epoch: 1 })
    }
    const completed = kit.observed.filter((r) => r.stage === 'completed')
    expect(completed).toHaveLength(20)

    const mediaCalls = kit.media.createCount()
    const receiptCount = kit.observed.length
    const retry = await kit.player.execute(
      fixturePerformanceCommand({ outputId: 'out-1', segmentId: 'segment-1' }),
      createCallContext(),
    )
    expect(retry.receiptId).toBe(completed.find((r) => r.outputId === 'out-1')?.receiptId)
    expect(kit.media.createCount()).toBe(mediaCalls)
    expect(kit.observed.length).toBe(receiptCount)

    await expect(
      kit.player.execute(
        fixturePerformanceCommand({ outputId: 'out-1', segmentId: 'changed' }),
        createCallContext(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })

    const advanced = await kit.player.execute(
      fixturePerformanceCommand({ outputId: 'out-21', segmentId: 'segment-21', epoch: 2 }),
      createCallContext(),
    )
    expect(advanced).toMatchObject({ stage: 'completed', epoch: 2 })
    await expect(
      kit.player.execute(
        fixturePerformanceCommand({ outputId: 'out-1', segmentId: 'segment-1', epoch: 1 }),
        createCallContext(),
      ),
    ).rejects.toMatchObject({ code: 'stale' })
  })

  it('adopts an identical active command, rejects busy ids and stale cancels', async () => {
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 0 })
    const kit = createActualPlayerKit({ resolver, media })
    const active = fixturePerformanceCommand({ outputId: 'hold-1', segmentId: 'seg-hold' })
    const first = kit.controller.execute(active, { signal: createCallContext().signal })
    const adopted = kit.controller.execute(
      fixturePerformanceCommand({ outputId: 'hold-1', segmentId: 'seg-hold' }),
      { signal: createCallContext().signal },
    )
    expect(adopted).toBe(first)
    await expect(
      kit.controller.execute(fixturePerformanceCommand({ outputId: 'hold-2' }), {
        signal: createCallContext().signal,
      }),
    ).rejects.toMatchObject({ code: 'busy' })
    await expect(
      kit.controller.execute(
        fixturePerformanceCommand({ outputId: 'hold-1', segmentId: 'changed' }),
        { signal: createCallContext().signal },
      ),
    ).rejects.toMatchObject({ code: 'conflict' })

    await kit.controller.cancel({ requestId: 'c-advance', revokedEpoch: 1, newEpoch: 2 })
    const higher = kit.controller.execute(
      fixturePerformanceCommand({ outputId: 'hold-3', segmentId: 'seg-3', epoch: 2 }),
      { signal: createCallContext().signal },
    )
    await expect(
      kit.controller.cancel({ requestId: 'c-stale', revokedEpoch: 1, newEpoch: 2 }),
    ).rejects.toMatchObject({ code: 'stale_cancel' })
    expect(kit.controller.status().idle).toBe(false)
    const settled = await kit.controller.cancel({ requestId: 'c-ok', revokedEpoch: 2, newEpoch: 3 })
    expect(settled).toMatchObject({ stage: 'cancelled' })
    await expect(higher).resolves.toBe(settled)
  })

  it('releases the duplicate binding immediately and the owner binding on settle', async () => {
    const kit = createActualPlayerKit()
    const command = fixturePerformanceCommand()
    const first = kit.player.execute(command, createCallContext())
    const second = kit.player.execute(fixturePerformanceCommand(), createCallContext())
    expect(second).toBe(first)
    expect(kit.gate.bindCount()).toBe(2)
    expect(kit.gate.releaseCount()).toBe(1)
    await kit.player.cancel({ requestId: 'c', revokedEpoch: 1, newEpoch: 2 }, createCallContext())
    await microtasks()
    expect(kit.gate.releaseCount()).toBe(2)
  })
})

describe('M1 player-port ownership identity (T07)', () => {
  it('survives a same-id conflict rejection and releases a later identical retry binding at once', async () => {
    const kit = createActualPlayerKit()
    const command = fixturePerformanceCommand()
    const first = kit.player.execute(command, createCallContext())
    expect(kit.gate.bindCount()).toBe(1)
    expect(kit.gate.releaseCount()).toBe(0)

    await expect(
      kit.player.execute(
        fixturePerformanceCommand({ outputId: command.outputId, segmentId: 'changed' }),
        createCallContext(),
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
    // The conflict's own binding is released; the original owner is untouched.
    expect(kit.gate.bindCount()).toBe(2)
    expect(kit.gate.releaseCount()).toBe(1)

    const retry = kit.player.execute(fixturePerformanceCommand(), createCallContext())
    expect(retry).toBe(first)
    expect(kit.gate.bindCount()).toBe(3)
    // The retry does not own the operation, so its binding is released at once
    // while the original owner stays alive until terminal.
    expect(kit.gate.releaseCount()).toBe(2)

    const cancelled = await kit.player.cancel(
      { requestId: 'c-owner', revokedEpoch: 1, newEpoch: 2 },
      createCallContext(),
    )
    await microtasks()
    expect(cancelled).toMatchObject({ stage: 'cancelled', outputId: command.outputId })
    expect(kit.gate.releaseCount()).toBe(3)
  })

  it('ignores an already-aborted duplicate context and preserves the original cancellation owner', async () => {
    const kit = createActualHoldingPlayerKit()
    const command = fixturePerformanceCommand()
    const first = kit.player.execute(command, createCallContext())

    const expired = createCallContext()
    expired.abort()
    const duplicate = kit.player.execute(fixturePerformanceCommand(), expired)
    expect(duplicate).toBe(first)
    expect(kit.controller.status()).toMatchObject({ idle: false, activeOutputId: command.outputId })

    const cancelled = await kit.player.cancel(
      { requestId: 'c-dup', revokedEpoch: 1, newEpoch: 2 },
      createCallContext(),
    )
    expect(cancelled).toMatchObject({ stage: 'cancelled', outputId: command.outputId })
    await expect(first).resolves.toBe(cancelled)
    expect(kit.controller.status().idle).toBe(true)
  })
})

describe('M1 actual player receipt ownership and no-op composition (T09, T10)', () => {
  it('emits one correlated schema-valid receipt per fact and never resends results', async () => {
    const kit = createActualCompletingPlayerKit(1)
    const command = fixturePerformanceCommand()
    const receipt = await kit.player.execute(command, createCallContext())
    await microtasks()
    for (const observed of kit.observed) {
      expect(performanceReceiptSchema.safeParse(observed).success).toBe(true)
      expect(observed.outputId).toBe(command.outputId)
      expect(observed.sessionId).toBe(command.sessionId)
      expect(observed.modality).toBe('audio')
      expect(observed.source).toBe('m1-player')
      expect(observed.chunkIds).toBeNull()
    }
    const ids = new Set(kit.observed.map((r) => r.receiptId))
    expect(ids.size).toBe(kit.observed.length)
    const terminalFacts = kit.observed.filter((r) => r.stage === 'completed')
    expect(terminalFacts).toHaveLength(1)
    expect(terminalFacts[0]?.receiptId).toBe(receipt.receiptId)

    const before = kit.observed.length
    await expect(
      kit.player.execute(
        fixturePerformanceCommand({ outputId: command.outputId, segmentId: 'changed' }),
        createCallContext(),
      ),
    ).rejects.toBeInstanceOf(PlayerDispatchError)
    expect(kit.observed.length).toBe(before)
  })

  it('T10: a single observer sender forwards each fact once over the receipt contract', async () => {
    const messages: Array<{ receiptId: string; stage: string }> = []
    const raw: unknown[] = []
    const resolver = createControlledResolver()
    resolver.setAutoResolve()
    const media = createControlledMediaDriver({ autoEvents: true })
    const controller = createPlaybackController({
      sessionId: FIXTURE_SESSION_ID,
      initialEpoch: 1,
      resolver,
      media,
      receipts: createTestReceiptTools('t10-sender'),
      onReceipt: (receipt) => {
        const message = performanceReceiptMessageSchema.parse({
          protocolVersion: APPLICATION_CONTRACT_VERSION,
          messageId: `wire-${raw.length + 1}`,
          sessionId: receipt.sessionId,
          epoch: receipt.epoch,
          kind: 'performance.receipt',
          payload: receipt,
        })
        raw.push(message)
        messages.push({ receiptId: message.payload.receiptId, stage: message.payload.stage })
      },
      reportFault: () => {},
    })
    const command = fixturePerformanceCommand()
    const receipt = await controller.execute(command, { signal: createCallContext().signal })
    await microtasks()
    expect(messages.map((message) => message.stage)).toEqual(['accepted', 'started', 'completed'])
    // The execute return value is the already-sent terminal fact, not a resend.
    expect(messages.filter((message) => message.stage === 'completed')).toHaveLength(1)
    expect(messages.at(-1)?.receiptId).toBe(receipt.receiptId)

    const before = messages.length
    await expect(
      controller.execute(fixturePerformanceCommand({ outputId: command.outputId, segmentId: 'changed' }), {
        signal: createCallContext().signal,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await microtasks()
    // Admission rejection creates no fabricated performance receipt.
    expect(messages).toHaveLength(before)
  })

  it('T10: a same-process diagnostic observer returns terminal evidence without re-sending it', async () => {
    const kit = createActualCompletingPlayerKit(1)
    const terminal = await kit.player.execute(fixturePerformanceCommand(), createCallContext())
    await microtasks()
    expect(terminal).toMatchObject({ stage: 'completed' })
    expect(kit.observed.map((r) => r.stage)).toEqual(['accepted', 'started', 'completed'])
    expect(kit.observed.filter((r) => r.receiptId === terminal.receiptId)).toHaveLength(1)
  })

  it('T09: a no-op reaction makes zero RendererPort.execute calls while audio completes', async () => {
    const kit = createActualCompletingPlayerKit(1)
    const counting = correct.createCountingRenderer(correct.createFixtureRendererPort())
    const runner = createFixtureRunner({
      player: kit.player,
      renderer: counting,
      reaction: createM1NoOpReactionPort(),
      segmentCount: 1,
    })
    await runner.resume()
    await runner.accept('no-op reaction')
    const outcome = await runner.runTurn()
    expect(counting.calls()).toBe(0)
    expect(outcome.deliveries).toHaveLength(1)
    expect(outcome.deliveries[0]?.classification).toBe('fully-delivered')
  })
})

describe('M1 actual adapter substitution and Stop composition (T11, T12)', () => {
  it('T11: substitutes two configured fixed catalogs through the shared port', async () => {
    const baseline = createFixedSynthesis({ entries: createM1FixtureEntries(), clock: createVirtualClock(0) })
    const measured = createFixedSynthesis({ entries: createM1ActualAssetEntries(), clock: createVirtualClock(0) })
    const first = await baseline.prepare(fixturePreparePerformance(), createCallContext())
    const second = await measured.prepare(fixturePreparePerformance(), createCallContext())
    expect(first.ok && first.durationMs).toBe(1200)
    expect(second.ok && second.durationMs).toBe(M1_ACTUAL_SEGMENT_0_DURATION_MS)
  })

  it('T12: completes output 0, starts output 1, then applies Stop at that output gate', async () => {
    const synthesis = createFixedSynthesis({
      entries: createM1ActualAssetEntries(),
      clock: createVirtualClock(0),
    })
    const resolver = createRegistryResolver(createM1ActualBlobMap())
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 1 })
    const observed: PerformanceReceipt[] = []
    const controller = createPlaybackController({
      sessionId: FIXTURE_SESSION_ID,
      initialEpoch: 1,
      resolver,
      media,
      receipts: createTestReceiptTools('t12'),
      onReceipt: (receipt) => {
        observed.push(receipt)
      },
      reportFault: () => {},
    })
    const player = createPlayerPort({ controller, deadlineGate: createExpiringDeadlineGate() })
    const rendererKit = createM1FixtureMappedRenderer()
    rendererKit.driver.setAuto({ stage: 'accepted', reasonCode: 'ok', localTimeMs: null })
    const runner = createFixtureRunner({
      synthesis,
      player,
      renderer: rendererKit.renderer,
      segmentCount: 2,
    })
    let firstOutputId = ''
    let secondOutputId = ''
    runner.hooks.onPlaybackStart = async (index, outputId) => {
      if (index === 0) {
        firstOutputId = outputId
      }
      if (index === 1) {
        secondOutputId = outputId
        await media.startedGate(1)
        await runner.stop()
      }
    }
    await runner.resume()
    await runner.accept('What did you say about the concert?')
    await runner.runTurn()
    await microtasks()

    expect(media.createCount()).toBe(2)
    const completed = observed.filter((r) => r.stage === 'completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.outputId).toBe(firstOutputId)
    expect(observed.some((r) => r.stage === 'started' && r.outputId === secondOutputId)).toBe(true)
    expect(observed.some((r) => r.stage === 'cancelled' && r.outputId === secondOutputId)).toBe(true)
    expect(completed.some((r) => r.outputId === secondOutputId)).toBe(false)
    expect(media.handles()[1]?.detached()).toBe(true)

    const deliveries = runner.deliveries()
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]?.classification).toBe('fully-delivered')
    expect(deliveries[1]?.classification).toBe('partial-unknown')
  })
})
