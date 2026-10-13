import type { CapabilitySnapshot, RendererPort, SynthesisPort } from '../../src/contracts'
import type { ActionBinding, RendererDriver, RendererObservation } from '../../src/performance/mapped-renderer'
import type { FixedAudioEntry } from '../../src/performance/fixed-synthesis'
import type { DeadlineBinding, DeadlineGate, ReceiptTools } from '../../src/performance/browser/types'
import { createFixedSynthesis } from '../../src/performance/fixed-synthesis'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import { createVirtualClock } from './virtual-clock'
import { fixtureCapabilitySnapshot } from './fixture-data'

/**
 * Test-only dependencies and factories for the M1 fixed synthesis and mapped
 * renderer adapters. Controls are exposed as test hooks; they must never reach
 * production code.
 */

export const M1_FIXTURE_VOICE_ID = 'voice-fixture'
export const M1_FIXTURE_VOICE_VERSION = '1'

export const M1_FIXTURE_SEGMENT_0_REF = 'audio://fixture/segment-0'
export const M1_FIXTURE_SEGMENT_1_REF = 'audio://fixture/segment-1'
export const M1_FIXTURE_SEGMENT_0_TEXT = 'We talked about the concert.'
export const M1_FIXTURE_SEGMENT_1_TEXT = 'It was loud and fun.'

export const M1_FIXTURE_FORMAT = 'audio/wav'
export const M1_FIXTURE_DURATION_MS = 1200

export function createM1FixtureEntries(): FixedAudioEntry[] {
  return [
    {
      text: M1_FIXTURE_SEGMENT_0_TEXT,
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
      audioRef: M1_FIXTURE_SEGMENT_0_REF,
      format: M1_FIXTURE_FORMAT,
      durationMs: M1_FIXTURE_DURATION_MS,
      timing: { startMs: 0, endMs: M1_FIXTURE_DURATION_MS },
    },
    {
      text: M1_FIXTURE_SEGMENT_1_TEXT,
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
      audioRef: M1_FIXTURE_SEGMENT_1_REF,
      format: M1_FIXTURE_FORMAT,
      durationMs: 1000,
      timing: { startMs: 0, endMs: 1000 },
    },
  ]
}

export interface FixtureSynthesisKit {
  readonly synthesis: SynthesisPort
  readonly clock: ReturnType<typeof createVirtualClock>
}

export function createM1FixtureSynthesisKit(
  entries: readonly FixedAudioEntry[] = createM1FixtureEntries(),
  clock: ReturnType<typeof createVirtualClock> = createVirtualClock(0),
): FixtureSynthesisKit {
  return { synthesis: createFixedSynthesis({ entries, clock }), clock }
}

/** A driver that records dispatches and can hold or auto-resolve each call. */
export interface RecordingRendererDriver extends RendererDriver {
  calls(): Array<{ driverAction: string; signal: AbortSignal }>
  pendingCount(): number
  setAuto(observation: RendererObservation): void
  setAutoReject(error: unknown): void
  resolveCurrent(observation: RendererObservation): void
  rejectCurrent(error: unknown): void
}

interface PendingDispatch {
  action: string
  signal: AbortSignal
  resolve: (observation: RendererObservation) => void
  reject: (error: unknown) => void
}

export function createRecordingRendererDriver(): RecordingRendererDriver {
  const calls: Array<{ driverAction: string; signal: AbortSignal }> = []
  const pending: PendingDispatch[] = []
  let autoObservation: RendererObservation | null = null
  let autoReject: unknown | null = null
  let hasAuto = false
  return {
    calls: () => calls.slice(),
    pendingCount: () => pending.length,
    setAuto: (observation) => {
      autoObservation = observation
      autoReject = null
      hasAuto = true
    },
    setAutoReject: (error) => {
      autoReject = error
      autoObservation = null
      hasAuto = true
    },
    async dispatch(action, signal) {
      calls.push({ driverAction: action, signal })
      if (hasAuto) {
        if (autoReject !== null) throw autoReject
        return autoObservation as RendererObservation
      }
      return new Promise<RendererObservation>((resolve, reject) => {
        pending.push({ action, signal, resolve, reject })
      })
    },
    resolveCurrent: (observation) => {
      const entry = pending.shift()
      if (entry !== undefined) entry.resolve(observation)
    },
    rejectCurrent: (error) => {
      const entry = pending.shift()
      if (entry !== undefined) entry.reject(error)
    },
  }
}

/** A gate whose bound signal mirrors the previous CallContext's signal. */
export interface TestDeadlineGate extends DeadlineGate {
  bindCount(): number
  releaseCount(): number
}

export function createTestDeadlineGate(): TestDeadlineGate {
  let bound = 0
  let released = 0
  return {
    bindCount: () => bound,
    releaseCount: () => released,
    bind(context) {
      bound += 1
      let releasedOnce = false
      const binding: DeadlineBinding = {
        signal: context.signal,
        release() {
          if (releasedOnce) return
          releasedOnce = true
          released += 1
        },
      }
      return binding
    },
  }
}

export interface TestReceiptTools extends ReceiptTools {
  issued(): string[]
  setNow(value: number | null): void
  failures(): number
}

let receiptCounter = 0

export function createTestReceiptTools(prefix = 'rx'): TestReceiptTools {
  receiptCounter += 1
  const instance = receiptCounter
  let counter = 0
  let now: number | null = 1000
  const issued: string[] = []
  return {
    issued: () => issued.slice(),
    setNow: (value) => {
      now = value
    },
    newReceiptId() {
      counter += 1
      const id = `receipt-${prefix}-${instance}-${counter}`
      issued.push(id)
      return id
    },
    localNowMs: () => now,
    failures: () => counter,
  }
}

export interface MappedRendererKit {
  readonly renderer: RendererPort
  readonly driver: RecordingRendererDriver
  readonly gate: TestDeadlineGate
  readonly receipts: TestReceiptTools
}

export function createM1FixtureMappedRenderer(
  overrides: Partial<{
    snapshot: CapabilitySnapshot
    bindings: readonly ActionBinding[]
    driver: RecordingRendererDriver
    gate: TestDeadlineGate
    receipts: TestReceiptTools
  }> = {},
): MappedRendererKit {
  const driver = overrides.driver ?? createRecordingRendererDriver()
  const gate = overrides.gate ?? createTestDeadlineGate()
  const receipts = overrides.receipts ?? createTestReceiptTools()
  const renderer = createMappedRenderer({
    snapshot: overrides.snapshot ?? fixtureCapabilitySnapshot(),
    bindings: overrides.bindings ?? [
      { actionId: 'neutral', driverAction: 'driver:neutral' },
      { actionId: 'smile', driverAction: 'driver:smile' },
    ],
    driver,
    deadlineGate: gate,
    receipts,
  })
  return { renderer, driver, gate, receipts }
}