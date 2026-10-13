import { describe, expect, it, vi } from 'vitest'
import type { CapabilitySnapshot, ClockPort, PerformanceCommand, PreparePerformance } from '../../src/contracts'
import { NO_OP_ACTION, performanceReceiptSchema } from '../../src/contracts'
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
  M1_FIXTURE_SEGMENT_0_REF,
  M1_FIXTURE_SEGMENT_1_REF,
  createM1FixtureEntries,
  createM1FixtureMappedRenderer,
  createM1FixtureSynthesisKit,
  createRecordingRendererDriver,
  createTestDeadlineGate,
  createTestReceiptTools,
} from '../support/m1-kit'
import type { RendererObservation } from '../../src/performance/mapped-renderer'
import { createFixedSynthesis, type FixedAudioEntry } from '../../src/performance/fixed-synthesis'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import { createVirtualClock } from '../support/virtual-clock'

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
