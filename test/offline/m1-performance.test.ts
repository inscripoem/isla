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
  preparedAudioSchema,
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
import {
  M1_KOKORO_PROVIDER_VOICE_ID,
  M1_KOKORO_SAMPLE_COUNT,
  M1_KOKORO_SAMPLE_RATE,
  M1_KOKORO_SPEED,
  createFakeKokoroProvider,
  createFixedRefFactory,
  createKokoroRawAudio,
  createM1KokoroSynthesisKit,
  createRegistryPlayerKit,
  createSequentialRefFactory,
  decodeMonoFloat32Wav,
  defaultKokoroProfile,
} from '../support/m1-kokoro-kit'
import type { KokoroRawAudio, KokoroVoiceProfile } from '../../src/performance/kokoro-types'
import { KokoroProviderError } from '../../src/performance/kokoro-types'
import type { AudioResourceRegistration } from '../../src/performance/audio-resources'
import {
  AudioResourceError,
  createAudioResourceRegistry,
} from '../../src/performance/audio-resources'
import { createKokoroSynthesis } from '../../src/performance/kokoro-synthesis'
import { encodeMonoFloat32Wav } from '../../src/performance/wav'
import {
  createGuardedTokenizer,
  type KokoroTokenizerEncoding,
} from '../../src/performance/kokoro-guard'
import {
  createKokoroProvider,
  createRealKokoroSdkLoader,
  isSupportedNodeVoiceId,
  toKokoroRawAudio,
} from '../../src/performance/kokoro-provider'
import {
  createControlledSdk,
  createControlledTokenizer,
  createMismatchedEncoding,
  createMultiBatchEncoding,
  createRankOneEncoding,
  createTokenizerEncoding,
  kokoroSdkTestConfig,
} from '../support/m1-kokoro-sdk-kit'
import {
  createKokoroWorkerProvider,
  kokoroWorkerBootstrapUrl,
} from '../../src/performance/kokoro-worker-provider'
import { isKokoroWorkerRuntime } from '../../src/performance/kokoro-worker'
import { createControlledWorkerKit } from '../support/m1-kokoro-worker-kit'
import { measureTimerCallbacks } from '../support/m1-kokoro-timing'

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

/* ------------------------------------------------------------------------- *
 * M1-02 increment A: injected Kokoro synthesis adapter (K01), cancellation
 * and the single generation slot (K03), the controlled audio-resource
 * registry (K04) and substitution through the unchanged SynthesisPort (R01).
 * ------------------------------------------------------------------------- */

const KOKORO_WAV_BYTES = 44 + M1_KOKORO_SAMPLE_COUNT * 4

describe('M1-02 Kokoro synthesis adapter (K01)', () => {
  it('prepares a WAV resource with exact identity and voice mapping and no playback effect', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider })
    const request = fixturePreparePerformance()
    const prepared = await kit.synthesis.prepare(request, createCallContext())

    expect(prepared).toMatchObject({
      ok: true,
      requestId: request.requestId,
      sessionId: request.sessionId,
      epoch: request.epoch,
      turnId: request.turnId,
      segmentId: request.segmentId,
      format: 'audio/wav',
      timing: null,
    })
    expect(preparedAudioSchema.safeParse(prepared).success).toBe(true)
    if (!prepared.ok) return
    expect(prepared.audioRef.startsWith('audio://')).toBe(true)
    expect(prepared.durationMs).toBeCloseTo(
      (M1_KOKORO_SAMPLE_COUNT / M1_KOKORO_SAMPLE_RATE) * 1000,
      9,
    )
    expect(provider.calls()).toEqual([
      { text: request.text, voiceId: M1_KOKORO_PROVIDER_VOICE_ID, speed: M1_KOKORO_SPEED },
    ])
    expect(kit.registry.snapshot().activeCount).toBe(1)
    expect(kit.gate.bindCount()).toBe(1)
    expect(kit.gate.releaseCount()).toBe(1)
  })

  it('encodes deterministic mono IEEE-float WAV bytes that independently decode to the provider samples', async () => {
    const samples = createKokoroRawAudio().samples
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve({ samples, sampleRate: M1_KOKORO_SAMPLE_RATE })
    const kit = createM1KokoroSynthesisKit({ provider })
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const lease = await kit.registry.resolve(prepared.audioRef, createCallContext().signal)
    const bytes = new Uint8Array(await lease.blob.arrayBuffer())
    lease.release()

    const decoded = decodeMonoFloat32Wav(bytes)
    expect(decoded).toMatchObject({
      riff: 'RIFF',
      wave: 'WAVE',
      audioFormat: 3,
      channels: 1,
      sampleRateHz: M1_KOKORO_SAMPLE_RATE,
      bitsPerSample: 32,
      dataByteLength: M1_KOKORO_SAMPLE_COUNT * 4,
      frameCount: M1_KOKORO_SAMPLE_COUNT,
    })
    expect(decoded.durationMs).toBeCloseTo(
      (M1_KOKORO_SAMPLE_COUNT / M1_KOKORO_SAMPLE_RATE) * 1000,
      9,
    )
    expect(decoded.samples).toHaveLength(M1_KOKORO_SAMPLE_COUNT)
    decoded.samples.forEach((value, index) => {
      expect(value).toBeCloseTo(samples[index], 6)
    })
    expect(lease.blob.type).toBe('audio/wav')
  })

  it('snapshots the configured profile and request so later caller mutation cannot alter retained data', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const profile = defaultKokoroProfile()
    const kit = createM1KokoroSynthesisKit({ provider, profiles: [profile] })
    ;(profile as unknown as { providerVoiceId: string }).providerVoiceId = 'mutated'
    ;(profile as unknown as { speed: number }).speed = 9

    const request = fixturePreparePerformance()
    const pending = kit.synthesis.prepare(request, createCallContext())
    ;(request as unknown as { text: string }).text = 'mutated text'
    ;(request as unknown as { requestId: string }).requestId = 'mutated'
    const prepared = await pending

    expect(provider.calls()).toEqual([
      { text: 'We talked about the concert.', voiceId: M1_KOKORO_PROVIDER_VOICE_ID, speed: M1_KOKORO_SPEED },
    ])
    expect(prepared).toMatchObject({ ok: true, requestId: 'prepare-req-1' })
  })

  it('returns unknown_voice_profile with zero generation for an unknown voice or version', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve()
    const kit = createM1KokoroSynthesisKit({ provider })
    for (const override of [{ voiceProfileId: 'unknown-voice' }, { voiceProfileVersion: '9' }]) {
      const prepared = await kit.synthesis.prepare(
        fixturePreparePerformance(override),
        createCallContext(),
      )
      expect(prepared).toMatchObject({
        ok: false,
        reasonCode: 'unknown_voice_profile',
        requestId: 'prepare-req-1',
      })
    }
    expect(provider.calls()).toEqual([])
    expect(kit.registry.snapshot().activeCount).toBe(0)
  })

  it('rejects a malformed identity-bearing request without any provider or resource effect', async () => {
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider })
    const malformed: PreparePerformance[] = [
      fixturePreparePerformance({ requestId: '' }),
      fixturePreparePerformance({ sessionId: '' }),
      fixturePreparePerformance({ epoch: -1 }),
      fixturePreparePerformance({ turnId: '' }),
      fixturePreparePerformance({ segmentId: '' }),
      fixturePreparePerformance({ text: '' }),
    ]
    for (const request of malformed) {
      await expect(kit.synthesis.prepare(request, createCallContext())).rejects.toThrow()
    }
    expect(provider.calls()).toEqual([])
    expect(kit.registry.snapshot().activeCount).toBe(0)
  })

  it('forwards a long text verbatim without a character limit or segmentation', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve()
    const kit = createM1KokoroSynthesisKit({ provider })
    const text = 'sentence one. '.repeat(400).trim()
    const prepared = await kit.synthesis.prepare(
      fixturePreparePerformance({ text }),
      createCallContext(),
    )
    expect(prepared.ok).toBe(true)
    expect(provider.calls()).toEqual([
      { text, voiceId: M1_KOKORO_PROVIDER_VOICE_ID, speed: M1_KOKORO_SPEED },
    ])
  })

  it('rejects empty, malformed and non-finite provider audio as invalid_audio', async () => {
    const cases: unknown[] = [
      createKokoroRawAudio(0),
      { samples: 'not-samples', sampleRate: M1_KOKORO_SAMPLE_RATE },
      { samples: new Float32Array([0, 1]), sampleRate: 0 },
      { samples: new Float32Array([0, 1]), sampleRate: Number.NaN },
      { samples: new Float32Array([0, Number.NaN]), sampleRate: M1_KOKORO_SAMPLE_RATE },
      { samples: new Float32Array([0, Number.POSITIVE_INFINITY]), sampleRate: M1_KOKORO_SAMPLE_RATE },
      null,
    ]
    for (const audio of cases) {
      const provider = createFakeKokoroProvider()
      provider.setAutoResolve(audio as KokoroRawAudio)
      const kit = createM1KokoroSynthesisKit({ provider })
      const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
      expect(prepared).toMatchObject({ ok: false, reasonCode: 'invalid_audio' })
      expect(kit.registry.snapshot().activeCount).toBe(0)
    }
  })

  it('forwards a controlled provider input_too_long refusal as an honest failure', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoReject(new KokoroProviderError('input_too_long'))
    const kit = createM1KokoroSynthesisKit({ provider })
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toMatchObject({
      ok: false,
      reasonCode: 'input_too_long',
      requestId: 'prepare-req-1',
    })
    expect(kit.registry.snapshot().activeCount).toBe(0)
  })
})

describe('M1-02 Kokoro cancellation, expiry and the generation slot (K03)', () => {
  it('fails at the earliest request/context deadline before invoking the provider', async () => {
    const provider = createFakeKokoroProvider()
    const clock = createVirtualClock(50)
    const kit = createM1KokoroSynthesisKit({ provider, clock })
    const requestFirst = await kit.synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 50 } }),
      createCallContext(100),
    )
    expect(requestFirst).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })

    clock.set(40)
    const contextFirst = await kit.synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 100 } }),
      createCallContext(40),
    )
    expect(contextFirst).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })

    expect(provider.calls()).toEqual([])
    expect(kit.gate.bindCount()).toBe(0)
  })

  it('fails an already-aborted context with zero generation', async () => {
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider })
    const context = createCallContext()
    context.abort()
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), context)
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(provider.calls()).toEqual([])
  })

  it('maps a synchronous provider throw and an asynchronous rejection to provider_failed and frees the slot', async () => {
    const syncProvider = createFakeKokoroProvider()
    syncProvider.setAutoThrow(new Error('sync boom'))
    const syncKit = createM1KokoroSynthesisKit({ provider: syncProvider })
    const syncResult = await syncKit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(syncResult).toMatchObject({ ok: false, reasonCode: 'provider_failed' })
    expect(syncKit.gate.releaseCount()).toBe(1)

    const asyncProvider = createFakeKokoroProvider()
    asyncProvider.setAutoReject(new Error('async boom'))
    const asyncKit = createM1KokoroSynthesisKit({ provider: asyncProvider })
    const asyncResult = await asyncKit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(asyncResult).toMatchObject({ ok: false, reasonCode: 'provider_failed' })

    asyncProvider.setAutoResolve(createKokoroRawAudio())
    const recovered = await asyncKit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(recovered.ok).toBe(true)
  })

  it('resolves a prompt failure on abort while the slot stays busy until physical settlement', async () => {
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider })
    const context = createCallContext()
    const first = kit.synthesis.prepare(fixturePreparePerformance(), context)
    expect(provider.pendingCount()).toBe(1)
    context.abort()
    await expect(first).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(kit.gate.releaseCount()).toBe(1)

    const busy = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'busy-attempt' }),
      createCallContext(),
    )
    expect(busy).toMatchObject({ ok: false, reasonCode: 'busy' })
    expect(provider.pendingCount()).toBe(1)
    expect(kit.registry.snapshot().activeCount).toBe(0)

    provider.resolveNext(createKokoroRawAudio())
    await microtasks()
    expect(kit.registry.snapshot().activeCount).toBe(0)

    provider.setAutoResolve(createKokoroRawAudio())
    const third = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'third' }),
      createCallContext(),
    )
    expect(third.ok).toBe(true)
    expect(kit.registry.snapshot().activeCount).toBe(1)
  })

  it('consumes a late rejection without an unhandled rejection and frees the slot', async () => {
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider })
    const context = createCallContext()
    const first = kit.synthesis.prepare(fixturePreparePerformance(), context)
    context.abort()
    await expect(first).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    provider.rejectNext(new Error('late boom'))
    await microtasks()
    expect(kit.registry.snapshot().activeCount).toBe(0)

    provider.setAutoResolve(createKokoroRawAudio())
    const next = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'after-late-reject' }),
      createCallContext(),
    )
    expect(next.ok).toBe(true)
  })

  it('aborts pending generation through an expiring virtual deadline gate', async () => {
    const gate = createExpiringDeadlineGate(0)
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider, gate })
    const pending = kit.synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 1000 } }),
      createCallContext(1000),
    )
    expect(provider.pendingCount()).toBe(1)
    gate.advance(1000)
    await expect(pending).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(kit.gate.releaseCount()).toBe(1)
    provider.resolveNext(createKokoroRawAudio())
    await microtasks()
    expect(kit.registry.snapshot().activeCount).toBe(0)
  })

  it('retires a fresh resource when a reentrant dependency aborts during registration', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider })
    const context = createCallContext()
    const registry = kit.registry
    const originalRegister = registry.register.bind(registry)
    registry.register = (request) => {
      context.abort()
      return originalRegister(request)
    }

    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), context)
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(registry.snapshot().activeCount).toBe(0)
    expect(registry.snapshot().usedBytes).toBe(0)
  })

  it('returns resource_closed when the registry was disposed before registration', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider })
    kit.registry.dispose()
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'resource_closed' })
    expect(provider.calls()).toHaveLength(1)
  })

  it('returns session_retired when a trusted owner invalidated the session before registration', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider })
    kit.registry.retireBefore(FIXTURE_SESSION_ID, 5)
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'session_retired' })
    expect(kit.registry.snapshot().usedBytes).toBe(0)
  })
})

describe('M1-02 provider ownership and replacement lifecycle (K03 ownership)', () => {
  it('retains one adapter slot across a logically cancelled generation: one provider call, busy on reuse, reuse only after settlement', async () => {
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider })
    const firstContext = createCallContext()
    const first = kit.synthesis.prepare(fixturePreparePerformance(), firstContext)
    expect(provider.calls()).toHaveLength(1)
    expect(provider.inFlight()).toBe(1)

    firstContext.abort()
    const firstResult = await first
    expect(firstResult).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    if (firstResult.ok) throw new Error('expected a failed cancelled result')
    expect('audioRef' in firstResult).toBe(false)

    // The same retained adapter is still physically busy: a fresh independent
    // request and context report busy and the provider is not invoked again.
    const busy = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'reuse-while-pending' }),
      createCallContext(),
    )
    expect(busy).toMatchObject({ ok: false, reasonCode: 'busy' })
    expect(provider.calls()).toHaveLength(1)
    expect(provider.inFlight()).toBe(1)
    expect(kit.registry.snapshot().activeCount).toBe(0)

    // A late fulfillment after logical cancellation publishes no reference.
    provider.resolveNext(createKokoroRawAudio())
    await microtasks()
    expect(kit.registry.snapshot().activeCount).toBe(0)
    expect(provider.inFlight()).toBe(0)

    // Only after physical settlement does the retained adapter accept the next
    // generation, still with a single simultaneous physical generation.
    provider.setAutoResolve(createKokoroRawAudio())
    const reused = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'after-settlement' }),
      createCallContext(),
    )
    expect(reused.ok).toBe(true)
    expect(kit.registry.snapshot().activeCount).toBe(1)
    expect(provider.calls()).toHaveLength(2)
    expect(provider.maxInFlight()).toBe(1)
  })

  it('does not release busy when a cancelled prepare resolves, releasing only after the underlying rejection', async () => {
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const context = createCallContext()
      const first = kit.synthesis.prepare(fixturePreparePerformance(), context)
      context.abort()
      await expect(first).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })

      // The logical prepare resolved, yet the physical generation is still
      // pending, so the slot must remain busy for a fresh independent request.
      expect(provider.inFlight()).toBe(1)
      const busy = await kit.synthesis.prepare(
        fixturePreparePerformance({ requestId: 'busy-before-reject-settles' }),
        createCallContext(),
      )
      expect(busy).toMatchObject({ ok: false, reasonCode: 'busy' })
      expect(provider.calls()).toHaveLength(1)

      provider.rejectNext(new Error('late boom'))
      await microtasks()
      expect(provider.inFlight()).toBe(0)
      expect(unhandled).toEqual([])

      // The same retained adapter is reusable once the rejection settled.
      provider.setAutoResolve(createKokoroRawAudio())
      const reused = await kit.synthesis.prepare(
        fixturePreparePerformance({ requestId: 'after-late-reject' }),
        createCallContext(),
      )
      expect(reused.ok).toBe(true)
      expect(kit.registry.snapshot().activeCount).toBe(1)
      expect(provider.calls()).toHaveLength(2)
      expect(provider.maxInFlight()).toBe(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('constructs a replacement adapter for the same provider only after the first generation physically settles', async () => {
    const provider = createFakeKokoroProvider()
    const firstKit = createM1KokoroSynthesisKit({ provider })
    const context = createCallContext()
    const first = firstKit.synthesis.prepare(fixturePreparePerformance(), context)
    expect(provider.inFlight()).toBe(1)
    context.abort()
    await expect(first).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })

    // This is the caller's compliant sequence, not an adapter guard: physical
    // work is still in flight, so a premature replacement is not constructed.
    expect(provider.inFlight()).toBe(1)

    provider.resolveNext(createKokoroRawAudio())
    await microtasks()
    expect(provider.inFlight()).toBe(0)

    const replacementKit = createM1KokoroSynthesisKit({ provider })
    provider.setAutoResolve(createKokoroRawAudio())
    const replaced = await replacementKit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'replacement' }),
      createCallContext(),
    )
    expect(replaced.ok).toBe(true)
    expect(provider.calls()).toHaveLength(2)
    expect(provider.maxInFlight()).toBe(1)
    expect(replacementKit.registry.snapshot().activeCount).toBe(1)
    expect(firstKit.registry.snapshot().activeCount).toBe(0)
  })
})

describe('M1-02 controlled audio-resource registry (K04)', () => {
  const registrationFor = (
    bytes: Uint8Array,
    overrides: Partial<AudioResourceRegistration> = {},
  ): AudioResourceRegistration => ({
    requestId: 'req-k',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: 'turn-k',
    segmentId: 'seg-k',
    voiceProfileId: 'voice-k',
    voiceProfileVersion: '1',
    format: 'audio/wav',
    bytes,
    ...overrides,
  })

  const makeRegistry = (overrides: {
    byteBudget?: number
    retentionMs?: number
    newRef?: () => string
    clock?: ReturnType<typeof createVirtualClock>
  } = {}) =>
    createAudioResourceRegistry({
      clock: overrides.clock ?? createVirtualClock(0),
      byteBudget: overrides.byteBudget ?? 1000,
      retentionMs: overrides.retentionMs ?? 1000,
      newRef: overrides.newRef ?? createSequentialRefFactory(),
    })

  it('registers opaque refs, resolves owned blobs and rejects arbitrary or unknown refs', async () => {
    const registry = makeRegistry()
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3, 4])))
    expect(registration.audioRef.startsWith('audio://')).toBe(true)

    for (const ref of ['/abs/path.wav', 'https://cdn.example.com/a.wav', 'file:///audio', 'audio://missing']) {
      await expect(registry.resolve(ref, createCallContext().signal)).rejects.toThrow()
    }

    const lease = await registry.resolve(registration.audioRef, createCallContext().signal)
    expect(lease.blob).toBeInstanceOf(Blob)
    expect(lease.blob.size).toBe(4)
    lease.release()
    lease.release()
    expect(registry.snapshot().usedBytes).toBe(0)

    // A released reference is never reusable.
    await expect(registry.resolve(registration.audioRef, createCallContext().signal)).rejects.toThrow()
  })

  it('enforces the byte budget exactly, leaves no partial entry and recovers bytes on retire', () => {
    const registry = makeRegistry({ byteBudget: 4 })
    const first = registry.register(registrationFor(new Uint8Array([0, 0, 0, 0])))
    expect(() => registry.register(registrationFor(new Uint8Array([1])))).toThrow(AudioResourceError)
    expect(registry.snapshot()).toMatchObject({ usedBytes: 4, activeCount: 1 })

    expect(registry.retire(first.audioRef)).toBe(true)
    expect(registry.snapshot()).toMatchObject({ usedBytes: 0, activeCount: 0 })

    registry.register(registrationFor(new Uint8Array([1, 2])))
    expect(registry.snapshot().usedBytes).toBe(2)
  })

  it('rejects a colliding reference atomically without overwriting the existing resource', async () => {
    const registry = makeRegistry({ newRef: createFixedRefFactory('audio://fixed/one') })
    registry.register(registrationFor(new Uint8Array([1, 2])))
    let collision: unknown = null
    try {
      registry.register(registrationFor(new Uint8Array([3, 4, 5])))
    } catch (error) {
      collision = error
    }
    expect(collision).toBeInstanceOf(AudioResourceError)
    expect((collision as AudioResourceError).code).toBe('ref_collision')
    const snapshot = registry.snapshot()
    expect(snapshot).toMatchObject({ usedBytes: 2, activeCount: 1 })
  })

  it('rejects a factory that returns a non-audio or path-like reference', () => {
    for (const ref of ['/abs/path.wav', 'https://cdn.example.com/a.wav', 'file:///x', 'audio://']) {
      const registry = makeRegistry({ newRef: createFixedRefFactory(ref) })
      expect(() => registry.register(registrationFor(new Uint8Array([1, 2])))).toThrow(AudioResourceError)
      expect(registry.snapshot()).toMatchObject({ usedBytes: 0, activeCount: 0 })
    }
  })

  it('reclaims expired unleased resources and refuses aborted or expired resolves', async () => {
    const clock = createVirtualClock(0)
    const registry = makeRegistry({ clock, retentionMs: 100 })
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    clock.set(100)

    const aborted = createCallContext()
    aborted.abort()
    await expect(registry.resolve(registration.audioRef, aborted.signal)).rejects.toThrow()
    await expect(registry.resolve(registration.audioRef, createCallContext().signal)).rejects.toThrow()
    expect(registry.snapshot()).toMatchObject({ usedBytes: 0, activeCount: 0 })
  })

  it('reclaims expired unleased resources through the explicit collectExpired hook', () => {
    const clock = createVirtualClock(0)
    const registry = makeRegistry({ clock, retentionMs: 100 })
    registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    clock.set(150)
    expect(registry.collectExpired()).toBe(1)
    expect(registry.snapshot().usedBytes).toBe(0)
  })

  it('blocks new acquisition and late registration after session retirement while a held lease stays valid', async () => {
    const registry = makeRegistry()
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3, 4])))
    const lease = await registry.resolve(registration.audioRef, createCallContext().signal)
    expect(registry.snapshot()).toMatchObject({ activeCount: 1, leasedCount: 1 })

    expect(registry.retireBefore(FIXTURE_SESSION_ID, 2)).toBe(1)
    await expect(registry.resolve(registration.audioRef, createCallContext().signal)).rejects.toThrow()
    expect(() => registry.register(registrationFor(new Uint8Array([9])))).toThrow(AudioResourceError)

    expect(lease.blob.size).toBe(4)
    lease.release()
    expect(registry.snapshot()).toMatchObject({ usedBytes: 0, activeCount: 0 })
  })

  it('retireSession retires every session resource and refuses later epochs', async () => {
    const registry = makeRegistry()
    const registration = registry.register(registrationFor(new Uint8Array([1, 2])))
    const lease = await registry.resolve(registration.audioRef, createCallContext().signal)
    expect(registry.retireSession(FIXTURE_SESSION_ID)).toBe(1)
    expect(() => registry.register(registrationFor(new Uint8Array([3]), { epoch: 9 }))).toThrow(
      AudioResourceError,
    )
    lease.release()
    expect(registry.snapshot().activeCount).toBe(0)
  })

  it('rejects new work on dispose, pins leased bytes until the last release, then reclaims', async () => {
    const registry = makeRegistry()
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3, 4])))
    const lease = await registry.resolve(registration.audioRef, createCallContext().signal)
    registry.dispose()

    expect(registry.snapshot()).toMatchObject({ disposed: true, activeCount: 1, usedBytes: 4 })
    expect(() => registry.register(registrationFor(new Uint8Array([1])))).toThrow(AudioResourceError)
    await expect(registry.resolve(registration.audioRef, createCallContext().signal)).rejects.toThrow()

    lease.release()
    expect(registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0 })
  })

  it('lets two leases release independently and reclaims on the last release only', async () => {
    const registry = makeRegistry()
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3, 4])))
    const first = await registry.resolve(registration.audioRef, createCallContext().signal)
    const second = await registry.resolve(registration.audioRef, createCallContext().signal)
    expect(registry.snapshot()).toMatchObject({ activeCount: 1, usedBytes: 4 })

    first.release()
    expect(registry.snapshot()).toMatchObject({ activeCount: 1, usedBytes: 4 })
    second.release()
    expect(registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0 })
  })

  it('returns a protected metadata view that cannot mutate registry state', () => {
    const registry = makeRegistry()
    const registration = registry.register(registrationFor(new Uint8Array([1, 2])))
    const snapshot = registry.snapshot()
    const view = snapshot.resources[0] as unknown as { audioRef: string; byteLength: number }
    view.audioRef = 'mutated'
    view.byteLength = 999
    const again = registry.snapshot()
    expect(again.resources[0]?.audioRef).toBe(registration.audioRef)
    expect(again.usedBytes).toBe(2)
  })

  it('retires a prepared-but-never-dispatched resource explicitly and by expiry, recovering bytes', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const clock = createVirtualClock(0)
    const kit = createM1KokoroSynthesisKit({ provider, clock, retentionMs: 100 })

    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(kit.registry.snapshot().usedBytes).toBe(KOKORO_WAV_BYTES)
    expect(kit.registry.retire(prepared.audioRef)).toBe(true)
    expect(kit.registry.snapshot().usedBytes).toBe(0)

    const second = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'expiring' }),
      createCallContext(),
    )
    expect(second.ok).toBe(true)
    clock.set(100)
    expect(kit.registry.collectExpired()).toBe(1)
    expect(kit.registry.snapshot().usedBytes).toBe(0)
  })

  it('generates 20 sequential outputs without an epoch quota and allows a new output after reclamation', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider, byteBudget: 200 })
    const refs = new Set<string>()
    for (let index = 0; index < 20; index += 1) {
      const prepared = await kit.synthesis.prepare(
        fixturePreparePerformance({ requestId: `p-${index}`, segmentId: `seg-${index}` }),
        createCallContext(),
      )
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      refs.add(prepared.audioRef)
      const lease = await kit.registry.resolve(prepared.audioRef, createCallContext().signal)
      lease.release()
    }
    expect(refs.size).toBe(20)

    const final = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'final', segmentId: 'final' }),
      createCallContext(),
    )
    expect(final.ok).toBe(true)
    expect(kit.registry.snapshot().usedBytes).toBe(KOKORO_WAV_BYTES)
  })
})

describe('M1-02 increment A independent-review regressions', () => {
  const registrationFor = (
    bytes: Uint8Array,
    overrides: Partial<AudioResourceRegistration> = {},
  ): AudioResourceRegistration => ({
    requestId: 'req-k',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: 'turn-k',
    segmentId: 'seg-k',
    voiceProfileId: 'voice-k',
    voiceProfileVersion: '1',
    format: 'audio/wav',
    bytes,
    ...overrides,
  })

  const makeRegistry = (overrides: {
    byteBudget?: number
    retentionMs?: number
    newRef?: () => string
    clock?: ReturnType<typeof createVirtualClock>
  } = {}) =>
    createAudioResourceRegistry({
      clock: overrides.clock ?? createVirtualClock(0),
      byteBudget: overrides.byteBudget ?? 1000,
      retentionMs: overrides.retentionMs ?? 1000,
      newRef: overrides.newRef ?? createSequentialRefFactory(),
    })

  it('keeps distinct public voice tuples distinct with embedded NUL characters', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const configured: KokoroVoiceProfile = {
      ...defaultKokoroProfile(),
      voiceProfileId: 'public\u0000part',
      voiceProfileVersion: 'v1',
    }
    const kit = createM1KokoroSynthesisKit({ provider, profiles: [configured] })
    const collision = await kit.synthesis.prepare(
      fixturePreparePerformance({ voiceProfileId: 'public', voiceProfileVersion: 'part\u0000v1' }),
      createCallContext(),
    )
    expect(collision).toMatchObject({ ok: false, reasonCode: 'unknown_voice_profile' })
    const matched = await kit.synthesis.prepare(
      fixturePreparePerformance({ voiceProfileId: 'public\u0000part', voiceProfileVersion: 'v1' }),
      createCallContext(),
    )
    expect(matched).toMatchObject({ ok: true })
    expect(provider.calls()).toHaveLength(1)
  })

  it('rejects non-string or non-numeric profile fields before any effect', () => {
    const overrides: Array<Record<string, unknown>> = [
      { voiceProfileId: 5 },
      { voiceProfileVersion: null },
      { providerVoiceId: 7 },
      { speed: 'fast' },
      { speed: Number.NaN },
      { speed: 0 },
    ]
    for (const override of overrides) {
      expect(() =>
        createM1KokoroSynthesisKit({
          profiles: [{ ...defaultKokoroProfile(), ...override } as unknown as KokoroVoiceProfile],
        }),
      ).toThrow()
    }
  })

  it('preserves a synchronous input_too_long refusal and releases the slot and binding', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoThrow(new KokoroProviderError('input_too_long'))
    const kit = createM1KokoroSynthesisKit({ provider })
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared).toMatchObject({
      ok: false,
      reasonCode: 'input_too_long',
      requestId: 'prepare-req-1',
    })
    expect(kit.gate.releaseCount()).toBe(1)
    expect(kit.registry.snapshot().activeCount).toBe(0)

    provider.setAutoResolve(createKokoroRawAudio())
    const recovered = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'after-refusal' }),
      createCallContext(),
    )
    expect(recovered.ok).toBe(true)
    expect(kit.gate.releaseCount()).toBe(2)
  })

  it('retires a fresh resource when the final publication clock observation aborts', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const clock = createVirtualClock(0)
    const kit = createM1KokoroSynthesisKit({ provider, clock })
    const context = createCallContext()
    const realNowMs = clock.nowMs.bind(clock)
    let abortedInsideClock = false
    clock.nowMs = () => {
      const value = realNowMs()
      if (!abortedInsideClock && kit.registry.snapshot().activeCount > 0) {
        abortedInsideClock = true
        context.abort()
      }
      return value
    }

    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), context)
    expect(abortedInsideClock).toBe(true)
    expect(prepared).toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(kit.registry.snapshot().activeCount).toBe(0)
    expect(kit.registry.snapshot().usedBytes).toBe(0)
  })

  it('returns a correlated failure when the final clock observation retires the original session', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const clock = createVirtualClock(0)
    const kit = createM1KokoroSynthesisKit({ provider, clock })
    const realNowMs = clock.nowMs.bind(clock)
    let invalidated = false
    clock.nowMs = () => {
      const value = realNowMs()
      if (!invalidated && kit.registry.snapshot().activeCount > 0) {
        invalidated = true
        kit.registry.retireSession(FIXTURE_SESSION_ID)
      }
      return value
    }

    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(invalidated).toBe(true)
    expect(prepared).toMatchObject({
      ok: false,
      reasonCode: 'session_retired',
      requestId: 'prepare-req-1',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
    })
    expect(kit.registry.snapshot().activeCount).toBe(0)
    expect(kit.registry.snapshot().usedBytes).toBe(0)
  })

  it('returns a correlated failure when the final clock observation disposes the registry', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const clock = createVirtualClock(0)
    const kit = createM1KokoroSynthesisKit({ provider, clock })
    const realNowMs = clock.nowMs.bind(clock)
    let invalidated = false
    clock.nowMs = () => {
      const value = realNowMs()
      if (!invalidated && kit.registry.snapshot().activeCount > 0) {
        invalidated = true
        kit.registry.dispose()
      }
      return value
    }

    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(invalidated).toBe(true)
    expect(prepared).toMatchObject({
      ok: false,
      reasonCode: 'resource_closed',
      requestId: 'prepare-req-1',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
    })
    expect(kit.registry.snapshot().activeCount).toBe(0)
    expect(kit.registry.snapshot().usedBytes).toBe(0)
  })

  it('uses the earlier request deadline for a pending generation and retains the physical slot', async () => {
    const gate = createExpiringDeadlineGate(0)
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider, gate })
    const pending = kit.synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 100 } }),
      createCallContext(1000),
    )
    expect(provider.pendingCount()).toBe(1)
    gate.advance(100)
    await expect(pending).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(kit.gate.releaseCount()).toBe(1)

    const busy = await kit.synthesis.prepare(
      fixturePreparePerformance({ requestId: 'busy', deadline: { atMs: 1000 } }),
      createCallContext(1000),
    )
    expect(busy).toMatchObject({ ok: false, reasonCode: 'busy' })
    expect(provider.pendingCount()).toBe(1)

    provider.resolveNext(createKokoroRawAudio())
    await microtasks()
    expect(kit.registry.snapshot().activeCount).toBe(0)
  })

  it('uses the earlier context deadline for a pending generation and releases exactly once', async () => {
    const gate = createExpiringDeadlineGate(0)
    const provider = createFakeKokoroProvider()
    const kit = createM1KokoroSynthesisKit({ provider, gate })
    const pending = kit.synthesis.prepare(
      fixturePreparePerformance({ deadline: { atMs: 1000 } }),
      createCallContext(100),
    )
    expect(provider.pendingCount()).toBe(1)
    gate.advance(100)
    await expect(pending).resolves.toMatchObject({ ok: false, reasonCode: 'cancelled_or_expired' })
    expect(kit.gate.releaseCount()).toBe(1)
    provider.resolveNext(createKokoroRawAudio())
    await microtasks()
    expect(kit.registry.snapshot().activeCount).toBe(0)
  })

  it('snapshots validated identity and owned bytes before a reentrant ref factory can mutate them', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const request = registrationFor(bytes)
    let registry!: ReturnType<typeof createAudioResourceRegistry>
    const newRef = (): string => {
      ;(request as { requestId: string }).requestId = 'mutated'
      ;(request as { sessionId: string }).sessionId = ''
      ;(request as { epoch: number }).epoch = -1
      bytes[0] = 99
      return 'audio://kokoro/reentrant-snapshot'
    }
    registry = makeRegistry({ newRef })
    const registered = registry.register(request)
    expect(registry.snapshot().resources[0]).toMatchObject({
      requestId: 'req-k',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
    })
    const lease = await registry.resolve(registered.audioRef, createCallContext().signal)
    const owned = new Uint8Array(await lease.blob.arrayBuffer())
    lease.release()
    expect([...owned]).toEqual([1, 2, 3, 4])
  })

  it('retains the original requestId through registration and synthesis and protects the view', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider })
    const request = fixturePreparePerformance({ requestId: 'orig-req' })
    const prepared = await kit.synthesis.prepare(request, createCallContext())
    expect(prepared.ok).toBe(true)

    const view = kit.registry.snapshot().resources[0] as unknown as { requestId: string }
    expect(view.requestId).toBe('orig-req')
    view.requestId = 'mutated'
    expect(kit.registry.snapshot().resources[0]?.requestId).toBe('orig-req')
  })

  it('rejects a registration whose ref factory retires the session, with no entry or bytes', () => {
    let registry!: ReturnType<typeof createAudioResourceRegistry>
    const newRef = (): string => {
      registry.retireSession(FIXTURE_SESSION_ID)
      return 'audio://kokoro/session-retired'
    }
    registry = makeRegistry({ newRef })
    let caught: AudioResourceError | null = null
    try {
      registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    } catch (error) {
      caught = error as AudioResourceError
    }
    expect(caught?.code).toBe('session_retired')
    expect(registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0 })
  })

  it('rejects a registration whose ref factory disposes the registry, with no entry or bytes', () => {
    let registry!: ReturnType<typeof createAudioResourceRegistry>
    const newRef = (): string => {
      registry.dispose()
      return 'audio://kokoro/disposed'
    }
    registry = makeRegistry({ newRef })
    let caught: AudioResourceError | null = null
    try {
      registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    } catch (error) {
      caught = error as AudioResourceError
    }
    expect(caught?.code).toBe('disposed')
    expect(registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0 })
  })

  it('revalidates admission after the registration clock boundary and rejects a stale registration', () => {
    let registry!: ReturnType<typeof createAudioResourceRegistry>
    let refIssued = false
    const clock = createVirtualClock(0)
    const realNowMs = clock.nowMs.bind(clock)
    clock.nowMs = () => {
      const value = realNowMs()
      if (refIssued) registry.retireSession(FIXTURE_SESSION_ID)
      return value
    }
    const newRef = (): string => {
      refIssued = true
      return 'audio://kokoro/clock-retired'
    }
    registry = makeRegistry({ clock, newRef })
    let caught: AudioResourceError | null = null
    try {
      registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    } catch (error) {
      caught = error as AudioResourceError
    }
    expect(caught?.code).toBe('session_retired')
    expect(registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0 })
  })

  it('rejects a reentrant resolve whose clock disposes the registry, with no lease or leaked accounting', async () => {
    let registry!: ReturnType<typeof createAudioResourceRegistry>
    const clock = createVirtualClock(0)
    const realNowMs = clock.nowMs.bind(clock)
    let disposeOnNext = false
    clock.nowMs = () => {
      const value = realNowMs()
      if (disposeOnNext) registry.dispose()
      return value
    }
    registry = makeRegistry({ clock })
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    disposeOnNext = true
    await expect(registry.resolve(registration.audioRef, createCallContext().signal)).rejects.toThrow()
    expect(registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0, leasedCount: 0 })
  })

  it('rejects a reentrant resolve whose clock aborts the caller signal, without a lease', async () => {
    let registry!: ReturnType<typeof createAudioResourceRegistry>
    const clock = createVirtualClock(0)
    const realNowMs = clock.nowMs.bind(clock)
    const context = createCallContext()
    let abortOnNext = false
    clock.nowMs = () => {
      const value = realNowMs()
      if (abortOnNext) context.abort()
      return value
    }
    registry = makeRegistry({ clock })
    const registration = registry.register(registrationFor(new Uint8Array([1, 2, 3])))
    abortOnNext = true
    await expect(registry.resolve(registration.audioRef, context.signal)).rejects.toThrow()
    expect(registry.snapshot()).toMatchObject({ activeCount: 1, usedBytes: 3, leasedCount: 0 })
  })

  it('preserves a legal __proto__ session id as an own key in the protection snapshot', () => {
    const registry = makeRegistry()
    expect(registry.retireSession('__proto__')).toBe(0)
    const snapshot = registry.snapshot()
    expect(Object.hasOwn(snapshot.retiredSessions, '__proto__')).toBe(true)
    expect((snapshot.retiredSessions as Record<string, number>)['__proto__']).toBe(
      Number.POSITIVE_INFINITY,
    )
    ;(snapshot.retiredSessions as Record<string, number>)['__proto__'] = 0
    expect((registry.snapshot().retiredSessions as Record<string, number>)['__proto__']).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  it('rejects non-integer or unrepresentable sample rates before publishing a ref', async () => {
    for (const sampleRate of [24000.5, 2 ** 30, 2 ** 32]) {
      const provider = createFakeKokoroProvider()
      provider.setAutoResolve(createKokoroRawAudio(2, sampleRate))
      const kit = createM1KokoroSynthesisKit({ provider })
      const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
      expect(prepared).toMatchObject({ ok: false, reasonCode: 'invalid_audio' })
      expect(kit.registry.snapshot()).toMatchObject({ activeCount: 0, usedBytes: 0 })
    }
  })

  it('rejects unrepresentable sample rates at the WAV encoder boundary', () => {
    for (const sampleRate of [24000.5, 0, -1, Number.NaN, 2 ** 30, 2 ** 32]) {
      expect(() => encodeMonoFloat32Wav(new Float32Array([0, 1]), sampleRate)).toThrow()
    }
  })

  it('encodes a canonical representable sample rate into a consistent parsed header and duration', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio(4, 24000))
    const kit = createM1KokoroSynthesisKit({ provider })
    const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const lease = await kit.registry.resolve(prepared.audioRef, createCallContext().signal)
    const bytes = new Uint8Array(await lease.blob.arrayBuffer())
    lease.release()
    const decoded = decodeMonoFloat32Wav(bytes)
    expect(decoded.sampleRateHz).toBe(24000)
    expect(decoded.dataByteLength).toBe(16)
    expect(decoded.durationMs).toBeCloseTo((4 / 24000) * 1000, 9)
  })
})

describe('M1-02 substitution through the unchanged SynthesisPort (R01)', () => {
  it('substitutes fixed and injected Kokoro synthesis through the same port', async () => {
    const fixed = createFixedSynthesis({ entries: createM1ActualAssetEntries(), clock: createVirtualClock(0) })
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider })

    const fixedResult = await fixed.prepare(fixturePreparePerformance(), createCallContext())
    const kokoroResult = await kit.synthesis.prepare(fixturePreparePerformance(), createCallContext())

    expect(fixedResult).toMatchObject({ ok: true, audioRef: M1_ACTUAL_SEGMENT_0_REF })
    expect(kokoroResult).toMatchObject({ ok: true, timing: null })
    if (!kokoroResult.ok) return
    expect(kokoroResult.audioRef.startsWith('audio://')).toBe(true)
    expect(kokoroResult.durationMs).not.toBe(M1_ACTUAL_SEGMENT_0_DURATION_MS)
  })

  it('passes the shared performance collector with the real Kokoro synthesis and registry-backed player', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const registry = createAudioResourceRegistry({
      clock: createVirtualClock(0),
      byteBudget: 1_000_000,
      retentionMs: 60_000,
      newRef: createFixedRefFactory(M1_FIXTURE_SEGMENT_0_REF),
    })
    const synthesis = createKokoroSynthesis({
      provider,
      profiles: [defaultKokoroProfile()],
      registry,
      clock: createVirtualClock(0),
      deadlineGate: createExpiringDeadlineGate(0),
    })
    const media = createControlledMediaDriver()
    media.setAutoEvents(true)
    const playerKit = createRegistryPlayerKit(registry, { media })
    const { renderer, driver } = createM1FixtureMappedRenderer()
    driver.setAuto({ stage: 'accepted', reasonCode: 'kokoro-ok', localTimeMs: null })

    const violations = await collectPerformanceViolations(() => ({
      synthesis,
      renderer,
      player: playerKit.player,
    }))
    expect(violations).toEqual([])
  })

  it('plays valid registry refs, applies Stop mid-second output and reclaims leases through the real player', async () => {
    const provider = createFakeKokoroProvider()
    provider.setAutoResolve(createKokoroRawAudio())
    const kit = createM1KokoroSynthesisKit({ provider, byteBudget: 1_000_000 })
    const media = createControlledMediaDriver({ autoEvents: true, holdEndedFrom: 1 })
    const playerKit = createRegistryPlayerKit(kit.registry, { media })
    const rendererKit = createM1FixtureMappedRenderer()
    rendererKit.driver.setAuto({ stage: 'accepted', reasonCode: 'ok', localTimeMs: null })

    const runner = createFixtureRunner({
      synthesis: kit.synthesis,
      player: playerKit.player,
      renderer: rendererKit.renderer,
      segmentCount: 2,
    })
    let firstOutputId = ''
    let secondOutputId = ''
    runner.hooks.onPlaybackStart = async (index, outputId) => {
      if (index === 0) firstOutputId = outputId
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
    const completed = playerKit.observed.filter((receipt) => receipt.stage === 'completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.outputId).toBe(firstOutputId)
    expect(
      playerKit.observed.some((receipt) => receipt.stage === 'started' && receipt.outputId === secondOutputId),
    ).toBe(true)
    expect(
      playerKit.observed.some((receipt) => receipt.stage === 'cancelled' && receipt.outputId === secondOutputId),
    ).toBe(true)
    expect(completed.some((receipt) => receipt.outputId === secondOutputId)).toBe(false)
    expect(media.handles()[1]?.detached()).toBe(true)

    const deliveries = runner.deliveries()
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]?.classification).toBe('fully-delivered')
    expect(deliveries[1]?.classification).toBe('partial-unknown')

    await microtasks()
    expect(kit.registry.snapshot().usedBytes).toBe(0)
  })
})

/* ------------------------------------------------------------------------- *
 * M1-02 increment B: the real SDK provider assembly, its apply-only
 * no-truncation guard and the RawAudio field mapping. The SDK itself is
 * replaced by deterministic small callable/model controls so these tests use
 * the actual guard, mapping and factory without initializing or downloading a
 * model. Real-SDK evidence lives in test/live.
 * ------------------------------------------------------------------------- */

describe('M1-02 increment B SDK provider guard and RawAudio mapping (B01)', () => {
  it('forwards the complete encoding unchanged while forcing truncation:false without mutation', async () => {
    const tokenizer = createControlledTokenizer(7)
    const guarded = createGuardedTokenizer(tokenizer, 512)
    expect(typeof guarded).toBe('function')
    // An apply-only Proxy forwards ordinary properties of the real tokenizer.
    expect((guarded as unknown as { tag: string }).tag).toBe('controlled-tokenizer')

    const originalOptions = { truncation: true, padding: true }
    const encoding = await guarded('hello world', originalOptions)

    expect(tokenizer.calls()).toHaveLength(1)
    expect(tokenizer.calls()[0]?.text).toBe('hello world')
    expect(tokenizer.calls()[0]?.options).toEqual({ truncation: false, padding: true })
    // The caller's options object and the returned encoding are untouched.
    expect(originalOptions).toEqual({ truncation: true, padding: true })
    expect(encoding).toBe(tokenizer.encoding())
    expect(tokenizer.encoding().input_ids.dims).toEqual([1, 7])
  })

  it('accepts a full 512-token encoding and refuses 513 before any model call', async () => {
    const sdk = createControlledSdk()
    const provider = await createKokoroProvider(kokoroSdkTestConfig(), sdk)

    sdk.tokenizer.setEncoding(createTokenizerEncoding(512))
    const accepted = await provider.generate({ text: 'boundary', voiceId: 'af_heart', speed: 1 })
    expect(accepted.sampleRate).toBe(24000)
    expect(sdk.modelCalls()).toBe(1)

    sdk.tokenizer.setEncoding(createTokenizerEncoding(513))
    const refusal = await provider
      .generate({ text: 'boundary', voiceId: 'af_heart', speed: 1 })
      .catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(KokoroProviderError)
    expect((refusal as KokoroProviderError).code).toBe('input_too_long')
    // The over-limit encoding is refused before the model is reached.
    expect(sdk.modelCalls()).toBe(1)
  })

  it('fails honestly on a malformed tensor with no model call', async () => {
    const sdk = createControlledSdk()
    const provider = await createKokoroProvider(kokoroSdkTestConfig(), sdk)
    const controls = [createMismatchedEncoding(), createMultiBatchEncoding(), createRankOneEncoding()]
    for (const encoding of controls) {
      sdk.tokenizer.setEncoding(encoding)
      const error = await provider
        .generate({ text: 'malformed', voiceId: 'af_heart', speed: 1 })
        .catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(KokoroProviderError)
    }
    expect(sdk.modelCalls()).toBe(0)
  })

  it('maps SDK RawAudio.audio/sampling_rate and rejects malformed raw audio honestly', async () => {
    const sdk = createControlledSdk()
    const provider = await createKokoroProvider(kokoroSdkTestConfig(), sdk)

    sdk.setRawAudio({ audio: new Float32Array([0.5, -0.25, 0.125]), sampling_rate: 16000 })
    const raw = await provider.generate({ text: 'hi', voiceId: 'af_heart', speed: 1 })
    expect(Array.from(raw.samples)).toEqual([0.5, -0.25, 0.125])
    expect(raw.sampleRate).toBe(16000)

    // Wrong field names (a fake `samples`/`sampleRate`) fail rather than silently map.
    sdk.setRawAudio({ samples: new Float32Array([0]), sampleRate: 16000 })
    await expect(provider.generate({ text: 'hi', voiceId: 'af_heart', speed: 1 })).rejects.toThrow()

    // A non-float buffer or non-positive rate is refused too.
    sdk.setRawAudio({ audio: 'not-a-buffer', sampling_rate: 16000 })
    await expect(provider.generate({ text: 'hi', voiceId: 'af_heart', speed: 1 })).rejects.toThrow()
    sdk.setRawAudio({ audio: new Float32Array([0]), sampling_rate: 0 })
    await expect(provider.generate({ text: 'hi', voiceId: 'af_heart', speed: 1 })).rejects.toThrow()
  })

  it('validates the configured and requested voice and speed before generation', async () => {
    const sdk = createControlledSdk({ voices: ['af_heart'] })
    await expect(
      createKokoroProvider(kokoroSdkTestConfig({ voiceId: 'not-a-voice' }), sdk),
    ).rejects.toThrow()

    const provider = await createKokoroProvider(kokoroSdkTestConfig(), sdk)
    await expect(
      provider.generate({ text: 'x', voiceId: 'not-a-voice', speed: 1 }),
    ).rejects.toThrow()
    await expect(
      provider.generate({ text: 'x', voiceId: 'af_heart', speed: 0 }),
    ).rejects.toThrow()
    expect(sdk.modelCalls()).toBe(0)
  })

  it('configures the environment once at initialization and never per generation', async () => {
    const sdk = createControlledSdk()
    const provider = await createKokoroProvider(kokoroSdkTestConfig(), sdk)
    expect(sdk.configureCalls()).toBe(1)
    expect(sdk.configured()?.environment.cacheDir).toBe('test-cache')

    await provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 })
    await provider.generate({ text: 'b', voiceId: 'af_heart', speed: 1 })
    expect(sdk.configureCalls()).toBe(1)
  })

  it('exposes the real loader handle without importing or initializing the SDK', () => {
    const loader = createRealKokoroSdkLoader()
    expect(typeof loader.loadTokenizer).toBe('function')
    expect(typeof loader.ensureVoice).toBe('function')
  })

  it('maps a documented RawAudio shape through the pure mapper and rejects non-float samples', () => {
    const mapped = toKokoroRawAudio({ audio: new Float32Array([1, 2]), sampling_rate: 8000 })
    expect(mapped.sampleRate).toBe(8000)
    expect(mapped.samples).toBeInstanceOf(Float32Array)
    expect(Array.from(mapped.samples)).toEqual([1, 2])
    expect(() => toKokoroRawAudio({ audio: [1, 2], sampling_rate: 8000 })).toThrow()
    expect(() => toKokoroRawAudio(null)).toThrow()
  })
})

/* ------------------------------------------------------------------------- *
 * M1-02 increment B regressions requested by independent review: the guard
 * must preserve the real SDK's synchronous tokenizer boundary, initialization
 * must not observe caller mutation across awaits, and the fixed-model token
 * ceiling must not be raisable by configuration.
 * ------------------------------------------------------------------------- */

describe('M1-02 increment B independent-review regressions (B01)', () => {
  it('returns the original encoding synchronously and forces truncation:false without mutation', () => {
    const tokenizer = createControlledTokenizer(7)
    const guarded = createGuardedTokenizer(tokenizer, 512)
    const originalOptions = { truncation: true, padding: true }

    const encoding = guarded('hello world', originalOptions)

    expect(encoding).not.toBeInstanceOf(Promise)
    expect(encoding).toBe(tokenizer.encoding())
    expect(tokenizer.calls()).toHaveLength(1)
    expect(tokenizer.calls()[0]?.options).toEqual({ truncation: false, padding: true })
    expect(originalOptions).toEqual({ truncation: true, padding: true })
  })

  it('refuses an over-limit encoding synchronously before any model dispatch', () => {
    const guarded = createGuardedTokenizer(createControlledTokenizer(513), 512)
    let caught: unknown = null
    try {
      guarded('boundary')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(KokoroProviderError)
    expect((caught as KokoroProviderError).code).toBe('input_too_long')
  })

  it('rejects a malformed empty [1,0] encoding instead of dispatching it', () => {
    const guarded = createGuardedTokenizer(() => createTokenizerEncoding(0), 512)
    expect(() => guarded('empty')).toThrow()
  })

  it('exposes a synchronous controlled tokenizer that returns its encoding directly', () => {
    const tokenizer = createControlledTokenizer(4)
    const result = tokenizer('synchronous')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toBe(tokenizer.encoding())
  })

  it('rejects a configured token ceiling above the verified fixed-model bound before any side effect', async () => {
    const sdk = createControlledSdk()
    await expect(createKokoroProvider(kokoroSdkTestConfig({ maxTokens: 1024 }), sdk)).rejects.toThrow()
    expect(sdk.configureCalls()).toBe(0)
    expect(sdk.modelCalls()).toBe(0)
  })

  it('retains validated initialization inputs while configuration awaits', async () => {
    const sdk = createControlledSdk()
    const config = kokoroSdkTestConfig()
    const initial = {
      modelRoot: config.modelRoot,
      revision: config.revision,
      maxTokens: config.maxTokens,
      environment: { ...config.environment },
    }
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    sdk.configureEnvironment = async () => {
      await barrier
    }
    let observed: unknown
    const original = sdk.loadTokenizer.bind(sdk)
    sdk.loadTokenizer = async (received) => {
      observed = {
        modelRoot: received.modelRoot,
        revision: received.revision,
        maxTokens: received.maxTokens,
        environment: { ...received.environment },
      }
      return original(received)
    }
    const pending = createKokoroProvider(config, sdk)
    ;(config as { modelRoot: string }).modelRoot = 'mutated-model'
    ;(config as { revision: string }).revision = 'mutated-revision'
    ;(config as { maxTokens: number }).maxTokens = 1024
    ;(config.environment as { localModelPath: string }).localModelPath = 'mutated-path'
    ;(config.environment as { cacheDir: string }).cacheDir = 'mutated-cache'
    release()
    await pending
    expect(observed).toEqual(initial)
  })

  it('does not weaken the validated token ceiling while configuration awaits', async () => {
    const sdk = createControlledSdk()
    const config = kokoroSdkTestConfig()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    sdk.configureEnvironment = async () => {
      await barrier
    }
    const pending = createKokoroProvider(config, sdk)
    ;(config as { maxTokens: number }).maxTokens = 1024
    release()
    const provider = await pending
    sdk.tokenizer.setEncoding(createTokenizerEncoding(513))
    let failureCode: unknown = null
    let resolved = false
    try {
      await provider.generate({ text: 'boundary', voiceId: 'af_heart', speed: 1 })
      resolved = true
    } catch (error) {
      failureCode = (error as { code?: unknown }).code
    }
    expect({ resolved, failureCode }).toEqual({ resolved: false, failureCode: 'input_too_long' })
    expect(sdk.modelCalls()).toBe(0)
  })

  it('refuses an asynchronous tokenizer result instead of adopting it', () => {
    const asyncTokenizer = (() =>
      Promise.resolve(createTokenizerEncoding(4))) as unknown as Parameters<
      typeof createGuardedTokenizer
    >[0]
    const guarded = createGuardedTokenizer(asyncTokenizer, 512)
    expect(() => guarded('async')).toThrow()
  })

  it('accepts an int64 BigInt64Array full encoding honestly', () => {
    const encoding: KokoroTokenizerEncoding = { input_ids: { data: new BigInt64Array(4), dims: [1, 4] } }
    const guarded = createGuardedTokenizer(() => encoding, 512)
    expect(guarded('int64')).toBe(encoding)
  })

  it('rejects a Node voice id that is not a plain bundled basename before any filesystem lookup', () => {
    expect(isSupportedNodeVoiceId('af_heart')).toBe(true)
    const invalid = ['../evil', 'af/../heart', 'af\\heart', 'C:/x', 'af heart', '.', '..', '', 'af_heart.bin', 'AF_HEART']
    for (const voiceId of invalid) {
      expect(isSupportedNodeVoiceId(voiceId)).toBe(false)
    }
    const loader = createRealKokoroSdkLoader()
    for (const voiceId of ['../evil', 'af/heart', '..', 'af_heart.bin']) {
      expect(() => loader.ensureVoice(voiceId)).toThrow()
    }
  })
})

/* ------------------------------------------------------------------------- *
 * M1-02 increment B worker isolation: the persistent single-worker host. The
 * worker transport is a controlled scripted dependency (no subprocess, no SDK
 * import or download); real bootstrap/startup and real CPU timing are exercised
 * only by the explicit live entrypoints.
 * ------------------------------------------------------------------------- */

describe('M1-02 increment B worker provider host (B02, controlled transport)', () => {
  async function startWorkerProvider() {
    const kit = createControlledWorkerKit()
    const pending = createKokoroWorkerProvider(kokoroSdkTestConfig(), {
      createWorker: kit.createWorker,
    })
    await microtasks()
    kit.transport.emitReady()
    const handle = await pending
    return { kit, handle }
  }

  it('stays inert on ordinary module import and does not run as a worker', async () => {
    expect(isKokoroWorkerRuntime()).toBe(false)
    const module = await import('../../src/performance/kokoro-worker-provider')
    expect(typeof module.createKokoroWorkerProvider).toBe('function')
    expect(kokoroWorkerBootstrapUrl().pathname.endsWith('/kokoro-worker-bootstrap.mjs')).toBe(true)
  })

  it('spawns exactly one worker, forwards the validated config and maps a result', async () => {
    const { kit, handle } = await startWorkerProvider()
    expect(kit.createCalls()).toBe(1)
    expect(kit.lastWorkerData()?.voiceId).toBe('af_heart')
    expect(kit.lastWorkerData()?.maxTokens).toBe(512)

    const generation = handle.provider.generate({ text: 'hello', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    const posts = kit.transport.generatePosts()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.input).toEqual({ text: 'hello', voiceId: 'af_heart', speed: 1 })

    kit.transport.emitResult({
      kind: 'result',
      jobId: posts[0]!.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.5, -0.5]),
    })
    const audio = await generation
    expect(audio.sampleRate).toBe(24000)
    expect(Array.from(audio.samples)).toEqual([0.5, -0.5])

    const closing = handle.close()
    await microtasks()
    expect(kit.transport.disposePosts()).toBe(1)
    kit.transport.emitExit(0)
    await closing
  })

  it('rejects a second concurrent generation as busy with no extra post', async () => {
    const { kit, handle } = await startWorkerProvider()
    const first = handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    await expect(
      handle.provider.generate({ text: 'b', voiceId: 'af_heart', speed: 1 }),
    ).rejects.toThrow(/busy/)
    expect(kit.transport.generatePosts()).toHaveLength(1)

    kit.transport.emitResult({
      kind: 'result',
      jobId: kit.transport.generatePosts()[0]!.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([1]),
    })
    await first
    const closing = handle.close()
    kit.transport.emitExit(0)
    await closing
  })

  it('posts nothing for a malformed request', async () => {
    const { kit, handle } = await startWorkerProvider()
    await expect(handle.provider.generate({ text: '', voiceId: 'af_heart', speed: 1 })).rejects.toThrow()
    await expect(handle.provider.generate({ text: 'x', voiceId: '', speed: 1 })).rejects.toThrow()
    await expect(handle.provider.generate({ text: 'x', voiceId: 'af_heart', speed: 0 })).rejects.toThrow()
    expect(kit.transport.generatePosts()).toHaveLength(0)
    const closing = handle.close()
    kit.transport.emitExit(0)
    await closing
  })

  it('preserves input_too_long and maps other failures honestly', async () => {
    const { kit, handle } = await startWorkerProvider()
    const refusal = handle.provider.generate({ text: 'long', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    kit.transport.emitResult({
      kind: 'result',
      jobId: kit.transport.generatePosts()[0]!.jobId,
      ok: false,
      code: 'input_too_long',
    })
    const refusalError = await refusal.catch((error: unknown) => error)
    expect(refusalError).toBeInstanceOf(KokoroProviderError)
    expect((refusalError as KokoroProviderError).code).toBe('input_too_long')

    const failure = handle.provider.generate({ text: 'oops', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    kit.transport.emitResult({
      kind: 'result',
      jobId: kit.transport.generatePosts()[1]!.jobId,
      ok: false,
      error: 'sdk exploded',
    })
    await expect(failure).rejects.toThrow(/sdk exploded/)

    const closing = handle.close()
    kit.transport.emitExit(0)
    await closing
  })

  it('ignores old and duplicate job ids and settles only the matching job', async () => {
    const { kit, handle } = await startWorkerProvider()
    const first = handle.provider.generate({ text: 'one', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    const job1 = kit.transport.generatePosts()[0]!.jobId
    kit.transport.emitResult({
      kind: 'result',
      jobId: job1,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([1]),
    })
    await first

    const second = handle.provider.generate({ text: 'two', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    const job2 = kit.transport.generatePosts()[1]!.jobId
    let settled = false
    second.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    // An old id from the previous job and an unknown id cannot settle the current job.
    kit.transport.emitResult({
      kind: 'result',
      jobId: job1,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([9]),
    })
    kit.transport.emitResult({
      kind: 'result',
      jobId: job2 + 100,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([9]),
    })
    await microtasks()
    expect(settled).toBe(false)

    kit.transport.emitResult({
      kind: 'result',
      jobId: job2,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([2]),
    })
    const audio = await second
    expect(Array.from(audio.samples)).toEqual([2])

    // A duplicate reply for an already-settled job is ignored without throwing.
    kit.transport.emitResult({
      kind: 'result',
      jobId: job2,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([3]),
    })
    await microtasks()

    const closing = handle.close()
    kit.transport.emitExit(0)
    await closing
  })

  it('keeps occupancy on a worker error and rejects only on exit (error and exit distinct)', async () => {
    const { kit, handle } = await startWorkerProvider()
    const generation = handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    let settled = false
    generation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    kit.transport.emitError(new Error('worker boom'))
    await microtasks()
    // The error closed admission but did not settle the physical job.
    expect(settled).toBe(false)
    await expect(
      handle.provider.generate({ text: 'b', voiceId: 'af_heart', speed: 1 }),
    ).rejects.toThrow(/closed/)

    kit.transport.emitExit(1)
    await expect(generation).rejects.toThrow(/worker boom/)
    expect(settled).toBe(true)
  })

  it('rejects initialization and waits for actual exit before reporting failure', async () => {
    const kit = createControlledWorkerKit()
    const pending = createKokoroWorkerProvider(kokoroSdkTestConfig(), {
      createWorker: kit.createWorker,
    })
    await microtasks()
    kit.transport.emitInitError('no voice')
    await microtasks()
    expect(kit.transport.terminateCount()).toBe(1)
    let rejected = false
    pending.catch(() => {
      rejected = true
    })
    await microtasks()
    // Still not rejected until the worker actually exits.
    expect(rejected).toBe(false)
    kit.transport.emitExit(1)
    await expect(pending).rejects.toThrow(/initialization failed/)
  })

  it('does not accept a queued ready after a fatal error until the worker exits', async () => {
    const kit = createControlledWorkerKit()
    const pending = createKokoroWorkerProvider(kokoroSdkTestConfig(), {
      createWorker: kit.createWorker,
    })
    let outcome = 'pending'
    pending.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )
    kit.transport.emitError(new Error('startup failure'))
    kit.transport.emitReady()
    await microtasks()
    // A ready queued behind the fatal error must not resolve initialization.
    expect(outcome).toBe('pending')
    kit.transport.emitExit(1)
    await microtasks()
    expect(outcome).toBe('rejected')
  })

  it('does not accept a queued ready after init_error until the worker exits', async () => {
    const kit = createControlledWorkerKit()
    const pending = createKokoroWorkerProvider(kokoroSdkTestConfig(), {
      createWorker: kit.createWorker,
    })
    let outcome = 'pending'
    pending.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )
    await microtasks()
    kit.transport.emitInitError('no voice')
    kit.transport.emitReady()
    await microtasks()
    expect(outcome).toBe('pending')
    kit.transport.emitExit(1)
    await microtasks()
    expect(outcome).toBe('rejected')
  })

  it('ignores a matching result after a fatal error and rejects only on exit', async () => {
    const { kit, handle } = await startWorkerProvider()
    const generation = handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    const jobId = kit.transport.generatePosts()[0]!.jobId
    let outcome = 'pending'
    generation.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )

    kit.transport.emitError(new Error('fatal worker error'))
    kit.transport.emitResult({
      kind: 'result',
      jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([1]),
    })
    await microtasks()
    // A matching result after a fatal error must not fulfil before exit, and a
    // native error does not request logical termination.
    expect(outcome).toBe('pending')
    expect(kit.transport.terminateCount()).toBe(0)
    await expect(
      handle.provider.generate({ text: 'b', voiceId: 'af_heart', speed: 1 }),
    ).rejects.toThrow(/closed/)

    kit.transport.emitExit(1)
    await microtasks()
    expect(outcome).toBe('rejected')
    expect(kit.transport.generatePosts()).toHaveLength(1)
    expect(kit.transport.disposePosts()).toBe(0)
  })

  it('ignores a matching result after a messageerror and requests termination once', async () => {
    const { kit, handle } = await startWorkerProvider()
    const generation = handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    const jobId = kit.transport.generatePosts()[0]!.jobId
    let outcome = 'pending'
    generation.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )

    kit.transport.emitMessageError(new Error('bad worker message'))
    kit.transport.emitResult({
      kind: 'result',
      jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([1]),
    })
    await microtasks()
    expect(outcome).toBe('pending')
    expect(kit.transport.terminateCount()).toBe(1)

    kit.transport.emitExit(1)
    await microtasks()
    expect(outcome).toBe('rejected')
    expect(kit.transport.generatePosts()).toHaveLength(1)
  })

  it('requests termination once on messageerror without a result and close waits for exit', async () => {
    const { kit, handle } = await startWorkerProvider()
    const generation = handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 })
    await microtasks()
    generation.catch(() => {})

    kit.transport.emitMessageError(new Error('bad worker message'))
    await microtasks()
    expect(kit.transport.terminateCount()).toBe(1)

    const closing = handle.close()
    await microtasks()
    // Occupancy is preserved; close does not post dispose while a physical job is pending.
    expect(kit.transport.disposePosts()).toBe(0)
    let closed = false
    closing.then(() => {
      closed = true
    })
    await microtasks()
    expect(closed).toBe(false)

    kit.transport.emitExit(1)
    await closing
    expect(closed).toBe(true)
    await expect(generation).rejects.toThrow(/bad worker message/)
  })

  it('cleans up an initialization messageerror and rejects only after exit', async () => {
    const kit = createControlledWorkerKit()
    const pending = createKokoroWorkerProvider(kokoroSdkTestConfig(), {
      createWorker: kit.createWorker,
    })
    let outcome = 'pending'
    pending.then(
      () => {
        outcome = 'resolved'
      },
      () => {
        outcome = 'rejected'
      },
    )
    await microtasks()
    kit.transport.emitMessageError(new Error('init messageerror'))
    await microtasks()
    expect(kit.transport.terminateCount()).toBe(1)
    expect(outcome).toBe('pending')
    kit.transport.emitExit(1)
    await microtasks()
    expect(outcome).toBe('rejected')
  })

  it('drains a pending job before disposing, then resolves close only after exit', async () => {
    const { kit, handle } = await startWorkerProvider()
    handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 }).catch(() => {})
    await microtasks()
    const closing = handle.close()
    await microtasks()
    // close has not posted dispose while the physical job is still pending.
    expect(kit.transport.disposePosts()).toBe(0)

    kit.transport.emitResult({
      kind: 'result',
      jobId: kit.transport.generatePosts()[0]!.jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([1]),
    })
    await microtasks()
    expect(kit.transport.disposePosts()).toBe(1)

    let closed = false
    closing.then(() => {
      closed = true
    })
    await microtasks()
    expect(closed).toBe(false)
    kit.transport.emitExit(0)
    await closing
    expect(closed).toBe(true)
  })

  it('posts dispose once for repeated close and refuses generation during and after close', async () => {
    const { kit, handle } = await startWorkerProvider()
    const first = handle.close()
    const second = handle.close()
    expect(second).toBe(first)
    await microtasks()
    await expect(
      handle.provider.generate({ text: 'a', voiceId: 'af_heart', speed: 1 }),
    ).rejects.toThrow(/closed/)
    kit.transport.emitExit(0)
    await first
    expect(kit.transport.disposePosts()).toBe(1)
    await expect(
      handle.provider.generate({ text: 'b', voiceId: 'af_heart', speed: 1 }),
    ).rejects.toThrow(/closed/)
  })
})

/* ------------------------------------------------------------------------- *
 * M1-02 increment B worker cancellation: the real SynthesisPort adapter over
 * the worker host. The controlled transport holds the physical job so the
 * adapter's logical abort behavior and late-result suppression can be observed.
 * ------------------------------------------------------------------------- */

describe('M1-02 increment B worker cancellation through the real adapter (B02, controlled transport)', () => {
  function buildWorkerSynthesisKit() {
    const kit = createControlledWorkerKit()
    const clock = createVirtualClock(0)
    const gate = createExpiringDeadlineGate(0)
    const registry = createAudioResourceRegistry({ clock, byteBudget: 1_000_000, retentionMs: 60_000 })
    return { kit, clock, gate, registry }
  }

  async function startSynthesis() {
    const { kit, clock, gate, registry } = buildWorkerSynthesisKit()
    const pending = createKokoroWorkerProvider(kokoroSdkTestConfig(), {
      createWorker: kit.createWorker,
    })
    await microtasks()
    kit.transport.emitReady()
    const handle = await pending
    const synthesis = createKokoroSynthesis({
      provider: handle.provider,
      profiles: [defaultKokoroProfile()],
      registry,
      clock,
      deadlineGate: gate,
    })
    return { kit, synthesis, handle, registry }
  }

  it('stays busy and publishes nothing after a logical abort, then reuses after settlement', async () => {
    const { kit, synthesis, handle, registry } = await startSynthesis()
    const context = createCallContext()
    const preparing = synthesis.prepare(fixturePreparePerformance(), context)
    await microtasks()
    expect(kit.transport.generatePosts()).toHaveLength(1)
    const jobId = kit.transport.generatePosts()[0]!.jobId

    context.abort()
    const prepared = await preparing
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.reasonCode).toBe('cancelled_or_expired')

    // The physical worker job is still held, so the retained adapter is busy.
    await expect(
      synthesis.prepare(fixturePreparePerformance({ requestId: 'busy-check' }), createCallContext()),
    ).resolves.toMatchObject({ ok: false, reasonCode: 'busy' })

    // A late success cannot publish a reference.
    kit.transport.emitResult({
      kind: 'result',
      jobId,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([1, 2, 3]),
    })
    await microtasks()
    expect(registry.snapshot().usedBytes).toBe(0)

    // Physical settlement frees the slot: a new prepare succeeds and registers audio.
    const retry = synthesis.prepare(fixturePreparePerformance({ requestId: 'retry' }), createCallContext())
    await microtasks()
    const retryJob = kit.transport.generatePosts()[1]!.jobId
    kit.transport.emitResult({
      kind: 'result',
      jobId: retryJob,
      ok: true,
      sampleRate: 24000,
      samples: new Float32Array([0.1, 0.2]),
    })
    const retried = await retry
    expect(retried.ok).toBe(true)
    if (retried.ok) {
      const lease = await registry.resolve(retried.audioRef, createCallContext().signal)
      const bytes = new Uint8Array(await lease.blob.arrayBuffer())
      lease.release()
      registry.retire(retried.audioRef)
      const decoded = decodeMonoFloat32Wav(bytes)
      expect(decoded.sampleRateHz).toBe(24000)
      expect(decoded.frameCount).toBe(2)
      expect(decoded.durationMs).toBeCloseTo((2 / 24000) * 1000, 9)
    }

    const closing = handle.close()
    kit.transport.emitExit(0)
    await closing
  })

  it('settles a late worker refusal without leaving a stale reference', async () => {
    const { kit, synthesis, handle, registry } = await startSynthesis()
    const context = createCallContext()
    const preparing = synthesis.prepare(fixturePreparePerformance(), context)
    await microtasks()
    const jobId = kit.transport.generatePosts()[0]!.jobId
    context.abort()
    await preparing
    kit.transport.emitResult({ kind: 'result', jobId, ok: false, code: 'input_too_long' })
    await microtasks()
    expect(registry.snapshot().usedBytes).toBe(0)
    const closing = handle.close()
    kit.transport.emitExit(0)
    await closing
  })
})

/* ------------------------------------------------------------------------- *
 * M1-02 increment B worker timer statistic: per-callback delay is distinct from
 * cumulative cadence drift. This is a pure, SDK-free definition test for the
 * live smoke's responsiveness metric.
 * ------------------------------------------------------------------------- */

describe('M1-02 increment B worker timer statistic (B02)', () => {
  it('separates per-callback delay from cumulative cadence drift', () => {
    const measurement = measureTimerCallbacks(
      [
        { offsetMs: 15, pending: true },
        { offsetMs: 30, pending: true },
        { offsetMs: 610, pending: false },
      ],
      10,
    )
    expect(measurement.callbacks.map((callback) => callback.delayMs)).toEqual([5, 5, 570])
    expect(measurement.callbacks.map((callback) => callback.cumulativeDriftMs)).toEqual([5, 10, 580])
    expect(measurement.maxPendingDelayMs).toBe(5)
    expect(measurement.maxDelayMs).toBe(570)
    expect(measurement.maxCumulativeDriftMs).toBe(580)
    expect(measurement.pendingCallbacks).toBe(2)
  })

  it('treats a healthy but slower cadence as small individual delay and large cumulative drift', () => {
    const samples = Array.from({ length: 106 }, (_unused, index) => ({
      offsetMs: (index + 1) * 15,
      pending: true,
    }))
    const measurement = measureTimerCallbacks(samples, 10)
    // Every individual delay is the constant 5 ms cadence offset, not the
    // accumulated ~600 ms drift a `count * interval` metric would report.
    expect(measurement.maxPendingDelayMs).toBe(5)
    expect(measurement.maxDelayMs).toBe(5)
    expect(measurement.maxCumulativeDriftMs).toBe(106 * 5)
    expect(measurement.pendingCallbacks).toBe(106)
  })

  it('handles an early callback and an empty sample set without negative delays', () => {
    const early = measureTimerCallbacks([{ offsetMs: 4, pending: true }], 10)
    expect(early.callbacks[0]?.delayMs).toBe(0)
    expect(early.callbacks[0]?.cumulativeDriftMs).toBe(-6)

    const empty = measureTimerCallbacks([], 10)
    expect(empty.callbacks).toEqual([])
    expect(empty.maxDelayMs).toBe(0)
    expect(empty.maxPendingDelayMs).toBe(0)
    expect(empty.pendingCallbacks).toBe(0)
  })
})
