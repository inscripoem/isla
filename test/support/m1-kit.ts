import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  CapabilitySnapshot,
  PerformanceReceipt,
  PlayerPort,
  ReactionPort,
  RendererPort,
  SynthesisPort,
} from '../../src/contracts'
import { NO_OP_ACTION, decisionResultSchema } from '../../src/contracts'
import type { ActionBinding, RendererDriver, RendererObservation } from '../../src/performance/mapped-renderer'
import type { FixedAudioEntry } from '../../src/performance/fixed-synthesis'
import type {
  AudioLease,
  AudioResolver,
  DeadlineBinding,
  DeadlineGate,
  MediaDriver,
  MediaEvent,
  MediaHandle,
  PlaybackController,
  ReceiptTools,
} from '../../src/performance/browser/types'
import { createFixedSynthesis } from '../../src/performance/fixed-synthesis'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import { createPlaybackController } from '../../src/performance/browser/player'
import { createPlayerPort } from '../../src/performance/browser/player-port'
import { createVirtualClock } from './virtual-clock'
import { FIXTURE_SESSION_ID, fixtureCapabilitySnapshot, fixtureUsage } from './fixture-data'

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

/* ------------------------------------------------------------------------- *
 * Increment B: measured fixed audio, controlled media/resolver, expiring
 * deadline gate and the real single-output browser player.
 * ------------------------------------------------------------------------- */

/** Measured WAV metadata for the two prepared fixed assets (see asset manifest). */
export const M1_ACTUAL_SEGMENT_0_REF = M1_FIXTURE_SEGMENT_0_REF
export const M1_ACTUAL_SEGMENT_1_REF = M1_FIXTURE_SEGMENT_1_REF
export const M1_ACTUAL_SEGMENT_0_DURATION_MS = 2344.081632653061
export const M1_ACTUAL_SEGMENT_1_DURATION_MS = 2029.251700680272

/**
 * The increment B catalog uses the measured WAV durations, not increment A's
 * historical 1200/1000 ms placeholders. Refs and voice tuple match the prepared
 * fixed assets exactly.
 */
export function createM1ActualAssetEntries(): FixedAudioEntry[] {
  return [
    {
      text: M1_FIXTURE_SEGMENT_0_TEXT,
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
      audioRef: M1_ACTUAL_SEGMENT_0_REF,
      format: M1_FIXTURE_FORMAT,
      durationMs: M1_ACTUAL_SEGMENT_0_DURATION_MS,
      timing: { startMs: 0, endMs: M1_ACTUAL_SEGMENT_0_DURATION_MS },
    },
    {
      text: M1_FIXTURE_SEGMENT_1_TEXT,
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
      audioRef: M1_ACTUAL_SEGMENT_1_REF,
      format: M1_FIXTURE_FORMAT,
      durationMs: M1_ACTUAL_SEGMENT_1_DURATION_MS,
      timing: { startMs: 0, endMs: M1_ACTUAL_SEGMENT_1_DURATION_MS },
    },
  ]
}

/**
 * The prepared fixed WAV assets copied into `test/browser/assets`. The bounded
 * actual composition reads these exact files so its Blob bytes, RIFF header and
 * frame-derived duration match the registered catalog and the expected hashes.
 * This is controlled-media evidence; it never decodes or plays the bytes.
 */
export interface M1ActualWavAsset {
  readonly ref: string
  readonly file: string
  readonly path: string
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly sha256: string
}

/** Expected asset facts bound to the prepared material and its manifest. */
export const M1_ACTUAL_WAV_EXPECTED = [
  {
    ref: M1_ACTUAL_SEGMENT_0_REF,
    file: 'segment-0.wav',
    sha256: 'c758ea8bce12e75c670bada318d1a372984b5298fc706a8e275e5c7101c0b8b6',
    sizeBytes: 103420,
    channels: 1,
    sampleRateHz: 22050,
    bitsPerSample: 16,
    frameCount: 51687,
  },
  {
    ref: M1_ACTUAL_SEGMENT_1_REF,
    file: 'segment-1.wav',
    sha256: '92a7f9e0ef8b47ad34cbe0ab7721d88cf5d313a99b1483a7f0a67ac72f5606e0',
    sizeBytes: 89536,
    channels: 1,
    sampleRateHz: 22050,
    bitsPerSample: 16,
    frameCount: 44745,
  },
] as const

export function actualWavAssetPath(file: string): string {
  return fileURLToPath(new URL(`../browser/assets/${file}`, import.meta.url))
}

export function readM1ActualWavAsset(entry: (typeof M1_ACTUAL_WAV_EXPECTED)[number]): M1ActualWavAsset {
  const path = actualWavAssetPath(entry.file)
  const fileBuffer = readFileSync(path)
  const bytes = new Uint8Array(fileBuffer.byteLength)
  bytes.set(fileBuffer)
  return { ref: entry.ref, file: entry.file, path, bytes, sha256: sha256Hex(bytes) }
}

export function readM1ActualWavAssets(): M1ActualWavAsset[] {
  return M1_ACTUAL_WAV_EXPECTED.map((entry) => readM1ActualWavAsset(entry))
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Parsed RIFF/WAVE header and frame-derived duration for a prepared asset. */
export interface M1WavInfo {
  readonly channels: number
  readonly sampleRateHz: number
  readonly bitsPerSample: number
  readonly dataByteLength: number
  readonly frameCount: number
  readonly durationMs: number
}

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}

/**
 * Parses the RIFF/WAVE header of a prepared fixed asset. It reads only the
 * `fmt ` and `data` chunk facts needed to derive the frame count and duration;
 * it performs no decoding.
 */
export function parseM1Wav(bytes: Uint8Array): M1WavInfo {
  if (readTag(bytes, 0) !== 'RIFF' || readTag(bytes, 8) !== 'WAVE') {
    throw new Error('m1-kit: not a RIFF/WAVE file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let channels = 0
  let sampleRateHz = 0
  let bitsPerSample = 0
  let dataByteLength = 0
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = readTag(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true)
      sampleRateHz = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataByteLength = size
    }
    offset = body + size + (size % 2)
  }
  const bytesPerFrame = channels * (bitsPerSample / 8)
  const frameCount = bytesPerFrame === 0 ? 0 : dataByteLength / bytesPerFrame
  const durationMs = sampleRateHz === 0 ? 0 : (frameCount / sampleRateHz) * 1000
  return { channels, sampleRateHz, bitsPerSample, dataByteLength, frameCount, durationMs }
}

/**
 * Blob map built from the copied prepared WAV bytes, keyed by the exact
 * registered refs. Test media never decodes the bytes, but the keys, sizes and
 * bytes now match the catalog and the prepared material.
 */
export function createM1ActualBlobMap(): Map<string, Blob> {
  return new Map<string, Blob>(
    readM1ActualWavAssets().map((asset) => [
      asset.ref,
      new Blob([asset.bytes], { type: M1_FIXTURE_FORMAT }),
    ]),
  )
}

export interface TrackedLease extends AudioLease {
  releaseCount(): number
}

export function createTrackedLease(blob: Blob = new Blob([new Uint8Array([0])])): TrackedLease {
  let releases = 0
  let released = false
  return {
    blob,
    releaseCount: () => releases,
    release() {
      if (released) return
      released = true
      releases += 1
    },
  }
}

export interface ResolverCall {
  audioRef: string
  signal: AbortSignal
}

export interface ControlledResolver extends AudioResolver {
  calls(): ResolverCall[]
  pendingCount(): number
  leases(): TrackedLease[]
  setAutoResolve(blob?: Blob): void
  setAutoReject(error: unknown): void
  resolveNext(lease?: TrackedLease): void
  rejectNext(error: unknown): void
}

type AutoResolver = { kind: 'resolve'; blob?: Blob } | { kind: 'reject'; error: unknown }

/** A resolver whose resolution is driven explicitly, or auto-resolved/rejected. */
export function createControlledResolver(): ControlledResolver {
  const calls: ResolverCall[] = []
  const pending: Array<{ resolve: (lease: AudioLease) => void; reject: (error: unknown) => void }> = []
  const leases: TrackedLease[] = []
  let auto: AutoResolver | null = null

  const makeLease = (blob?: Blob): TrackedLease => {
    const lease = createTrackedLease(blob)
    leases.push(lease)
    return lease
  }

  return {
    calls: () => calls.slice(),
    pendingCount: () => pending.length,
    leases: () => leases.slice(),
    setAutoResolve(blob) {
      auto = blob === undefined ? { kind: 'resolve' } : { kind: 'resolve', blob }
    },
    setAutoReject(error) {
      auto = { kind: 'reject', error }
    },
    resolveNext(lease) {
      const entry = pending.shift()
      if (entry !== undefined) entry.resolve(lease ?? makeLease())
    },
    rejectNext(error) {
      const entry = pending.shift()
      if (entry !== undefined) entry.reject(error)
    },
    resolve(audioRef, signal) {
      calls.push({ audioRef, signal })
      if (auto !== null) {
        if (auto.kind === 'reject') return Promise.reject(auto.error)
        return Promise.resolve(makeLease(auto.blob))
      }
      return new Promise<AudioLease>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
  }
}

export interface RegistryResolver extends AudioResolver {
  calls(): string[]
  unknownRefs(): string[]
  leases(): TrackedLease[]
}

/** Resolves only exact registered refs; every other ref is rejected. */
export function createRegistryResolver(blobs: Map<string, Blob>): RegistryResolver {
  const calls: string[] = []
  const unknown: string[] = []
  const leases: TrackedLease[] = []
  return {
    calls: () => calls.slice(),
    unknownRefs: () => unknown.slice(),
    leases: () => leases.slice(),
    resolve(audioRef) {
      calls.push(audioRef)
      const blob = blobs.get(audioRef)
      if (blob === undefined) {
        unknown.push(audioRef)
        return Promise.reject(new Error(`unregistered audio ref: ${audioRef}`))
      }
      const lease = createTrackedLease(blob)
      leases.push(lease)
      return Promise.resolve(lease)
    },
  }
}

export interface ControlledMediaHandle extends MediaHandle {
  emitPlaying(): void
  emitEnded(): void
  emitError(reasonCode: string): void
  subscribeCount(): number
  unsubscribeCount(): number
  loadCount(): number
  playCount(): number
  detachCount(): number
  detached(): boolean
  started(): boolean
  setLoadThrows(value: boolean): void
  setPlayThrows(value: boolean): void
  setPlayRejects(value: boolean): void
  playSettled(): boolean
  resolvePlay(): void
  rejectPlay(error?: unknown): void
}

export interface ControlledMediaDriver extends MediaDriver {
  createCount(): number
  handles(): ControlledMediaHandle[]
  current(): ControlledMediaHandle | null
  setDetachResult(value: boolean): void
  setAutoEvents(value: boolean): void
  holdEndedFrom(index: number): void
  startedGate(index: number): Promise<void>
  setHoldPlay(value: boolean): void
  setEmitOnSubscribe(event: MediaEvent | null): void
  setEmitOnLoad(event: MediaEvent | null): void
  setOnSubscribe(hook: (() => void) | null): void
  setOnLoad(hook: (() => void) | null): void
  setOnCreate(hook: (() => void) | null): void
}

/**
 * A fully controlled media driver. It never uses wall-clock timers; auto events
 * are scheduled on microtasks so the driver's `playing` emission is independent
 * of any awaiting hook.
 */
export function createControlledMediaDriver(
  options: {
    loadThrows?: boolean
    playThrows?: boolean
    playRejects?: boolean
    detachResult?: boolean
    autoEvents?: boolean
    holdEndedFrom?: number
    holdPlay?: boolean
    emitOnSubscribe?: MediaEvent | null
    emitOnLoad?: MediaEvent | null
    onSubscribe?: (() => void) | null
    onLoad?: (() => void) | null
    onCreate?: (() => void) | null
  } = {},
): ControlledMediaDriver {
  let createCount = 0
  let detachResult = options.detachResult ?? true
  let autoEvents = options.autoEvents ?? false
  let holdEndedFromIndex = options.holdEndedFrom ?? Number.POSITIVE_INFINITY
  let holdPlay = options.holdPlay ?? false
  let emitOnSubscribe = options.emitOnSubscribe ?? null
  let emitOnLoad = options.emitOnLoad ?? null
  let onSubscribe = options.onSubscribe ?? null
  let onLoad = options.onLoad ?? null
  let onCreate = options.onCreate ?? null
  const handles: ControlledMediaHandle[] = []
  const startedGates = new Map<number, { promise: Promise<void>; release: () => void }>()

  const gateFor = (index: number): { promise: Promise<void>; release: () => void } => {
    let gate = startedGates.get(index)
    if (gate === undefined) {
      let release: () => void = () => {}
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      gate = { promise, release }
      startedGates.set(index, gate)
    }
    return gate
  }

  const makeHandle = (index: number): ControlledMediaHandle => {
    const listeners = new Set<(event: MediaEvent) => void>()
    let subscribed = 0
    let unsubscribed = 0
    let loads = 0
    let plays = 0
    let detaches = 0
    let detached = false
    let started = false
    let loadThrows = options.loadThrows ?? false
    let playThrows = options.playThrows ?? false
    let playRejects = options.playRejects ?? false
    let playSettled = true
    let resolvePlayFn: (() => void) | null = null
    let rejectPlayFn: ((error: unknown) => void) | null = null

    const emit = (event: MediaEvent): void => {
      for (const listener of [...listeners]) listener(event)
    }
    const emitPlaying = (): void => {
      if (!started) {
        started = true
        gateFor(index).release()
      }
      emit({ type: 'playing' })
    }
    const emitEnded = (): void => {
      emit({ type: 'ended' })
    }

    return {
      emitPlaying,
      emitEnded,
      emitError(reasonCode) {
        emit({ type: 'error', reasonCode })
      },
      subscribeCount: () => subscribed,
      unsubscribeCount: () => unsubscribed,
      loadCount: () => loads,
      playCount: () => plays,
      detachCount: () => detaches,
      detached: () => detached,
      started: () => started,
      setLoadThrows(value) {
        loadThrows = value
      },
      setPlayThrows(value) {
        playThrows = value
      },
      setPlayRejects(value) {
        playRejects = value
      },
      playSettled: () => playSettled,
      resolvePlay() {
        const resolve = resolvePlayFn
        resolvePlayFn = null
        rejectPlayFn = null
        if (resolve !== null) resolve()
      },
      rejectPlay(error) {
        const reject = rejectPlayFn
        resolvePlayFn = null
        rejectPlayFn = null
        if (reject !== null) reject(error ?? new Error('controlled media: late play rejection'))
      },
      subscribe(listener) {
        subscribed += 1
        listeners.add(listener)
        if (onSubscribe !== null) onSubscribe()
        if (emitOnSubscribe !== null) emit(emitOnSubscribe)
        return () => {
          unsubscribed += 1
          listeners.delete(listener)
        }
      },
      load() {
        loads += 1
        if (loadThrows) throw new Error('controlled media: load failed')
        if (onLoad !== null) onLoad()
        if (emitOnLoad !== null) emit(emitOnLoad)
      },
      play() {
        plays += 1
        if (playThrows) throw new Error('controlled media: play threw')
        if (holdPlay) {
          playSettled = false
          return new Promise<void>((resolve, reject) => {
            resolvePlayFn = () => {
              playSettled = true
              resolve()
            }
            rejectPlayFn = (error) => {
              playSettled = true
              reject(error)
            }
          })
        }
        if (playRejects) return Promise.reject(new Error('controlled media: play rejected'))
        if (autoEvents) {
          queueMicrotask(() => {
            emitPlaying()
            if (index < holdEndedFromIndex) queueMicrotask(() => emitEnded())
          })
        }
        return Promise.resolve()
      },
      detach() {
        detaches += 1
        if (!detachResult) return false
        detached = true
        return true
      },
    }
  }

  return {
    createCount: () => createCount,
    handles: () => handles.slice(),
    current: () => handles[handles.length - 1] ?? null,
    setDetachResult(value) {
      detachResult = value
    },
    setAutoEvents(value) {
      autoEvents = value
    },
    holdEndedFrom(index) {
      holdEndedFromIndex = index
    },
    setHoldPlay(value) {
      holdPlay = value
    },
    setEmitOnSubscribe(event) {
      emitOnSubscribe = event
    },
    setEmitOnLoad(event) {
      emitOnLoad = event
    },
    setOnSubscribe(hook) {
      onSubscribe = hook
    },
    setOnLoad(hook) {
      onLoad = hook
    },
    setOnCreate(hook) {
      onCreate = hook
    },
    startedGate: (index) => gateFor(index).promise,
    create() {
      const handle = makeHandle(createCount)
      createCount += 1
      handles.push(handle)
      if (onCreate !== null) onCreate()
      return handle
    },
  }
}

export interface ExpiringDeadlineGate extends DeadlineGate {
  bindCount(): number
  releaseCount(): number
  advance(ms: number): void
  nowMs(): number
}

/**
 * A genuinely expiring virtual deadline gate in the injected clock domain. It
 * aborts a bound signal once the virtual clock reaches the CallContext deadline
 * (or immediately when that deadline has already passed), so it is evidence of
 * expiry rather than a mirror of the caller's signal.
 */
export function createExpiringDeadlineGate(startMs = 0): ExpiringDeadlineGate {
  let now = startMs
  let bound = 0
  let released = 0
  const active = new Map<AbortController, number>()

  const expire = (): void => {
    for (const [controller, atMs] of [...active]) {
      if (now >= atMs && !controller.signal.aborted) controller.abort()
    }
  }

  return {
    bindCount: () => bound,
    releaseCount: () => released,
    nowMs: () => now,
    advance(ms) {
      now += ms
      expire()
    },
    bind(context) {
      bound += 1
      const controller = new AbortController()
      const atMs = context.deadline.atMs
      active.set(controller, atMs)
      const onAbort = (): void => {
        if (!controller.signal.aborted) controller.abort()
      }
      if (context.signal.aborted) controller.abort()
      else context.signal.addEventListener('abort', onAbort, { once: true })
      if (now >= atMs && !controller.signal.aborted) controller.abort()
      let releasedOnce = false
      return {
        signal: controller.signal,
        release() {
          if (releasedOnce) return
          releasedOnce = true
          released += 1
          active.delete(controller)
          context.signal.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}

export interface ActualPlayerKit {
  readonly controller: PlaybackController
  readonly player: PlayerPort
  readonly resolver: ControlledResolver
  readonly media: ControlledMediaDriver
  readonly gate: ExpiringDeadlineGate
  readonly observed: PerformanceReceipt[]
  readonly faults: unknown[]
  readonly receipts: TestReceiptTools
}

/** A real browser playback controller plus its PlayerPort adapter and controls. */
export function createActualPlayerKit(
  overrides: {
    sessionId?: string
    initialEpoch?: number
    resolver?: ControlledResolver
    media?: ControlledMediaDriver
    gate?: ExpiringDeadlineGate
    receipts?: TestReceiptTools
  } = {},
): ActualPlayerKit {
  const resolver = overrides.resolver ?? createControlledResolver()
  const media = overrides.media ?? createControlledMediaDriver()
  const gate = overrides.gate ?? createExpiringDeadlineGate()
  const receipts = overrides.receipts ?? createTestReceiptTools('player')
  const observed: PerformanceReceipt[] = []
  const faults: unknown[] = []
  const controller = createPlaybackController({
    sessionId: overrides.sessionId ?? FIXTURE_SESSION_ID,
    initialEpoch: overrides.initialEpoch ?? 1,
    resolver,
    media,
    receipts,
    onReceipt: (receipt) => {
      observed.push(receipt)
    },
    reportFault: (error) => {
      faults.push(error)
    },
  })
  const player = createPlayerPort({ controller, deadlineGate: gate })
  return { controller, player, resolver, media, gate, observed, faults, receipts }
}

/** An actual player whose controlled media auto-emits playing then ended. */
export function createActualCompletingPlayerKit(initialEpoch = 1): ActualPlayerKit {
  const resolver = createControlledResolver()
  resolver.setAutoResolve()
  const media = createControlledMediaDriver()
  media.setAutoEvents(true)
  return createActualPlayerKit({ resolver, media, initialEpoch })
}

/** An actual player whose resolver is held, so execute stays active until cancel. */
export function createActualHoldingPlayerKit(initialEpoch = 1): ActualPlayerKit {
  return createActualPlayerKit({
    resolver: createControlledResolver(),
    media: createControlledMediaDriver(),
    initialEpoch,
  })
}

/**
 * A reaction port that always selects the no-op action. The M5 caller must make
 * zero `RendererPort.execute` calls for it while otherwise-valid audio continues.
 */
export function createM1NoOpReactionPort(): ReactionPort {
  return {
    async decide(request) {
      return decisionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        snapshotRevision: request.snapshotRevision,
        capabilityRevision: request.capabilityRevision,
        status: 'selected',
        actionId: NO_OP_ACTION,
        provider: 'm1-kit',
        modelVersion: 'm1-kit',
        reasonCode: 'm1-no-op',
        confidence: null,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}