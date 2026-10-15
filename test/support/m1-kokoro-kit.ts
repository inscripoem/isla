import type { PerformanceReceipt, PlayerPort, SynthesisPort } from '../../src/contracts'
import type {
  KokoroProvider,
  KokoroProviderInput,
  KokoroRawAudio,
  KokoroVoiceProfile,
} from '../../src/performance/kokoro-types'
import type { AudioResourceRegistry } from '../../src/performance/audio-resources'
import { createAudioResourceRegistry } from '../../src/performance/audio-resources'
import { createKokoroSynthesis } from '../../src/performance/kokoro-synthesis'
import type { AudioResolver } from '../../src/performance/browser/types'
import { createPlaybackController } from '../../src/performance/browser/player'
import type { PlaybackController } from '../../src/performance/browser/types'
import { createPlayerPort } from '../../src/performance/browser/player-port'
import {
  M1_FIXTURE_VOICE_ID,
  M1_FIXTURE_VOICE_VERSION,
  createControlledMediaDriver,
  createExpiringDeadlineGate,
  createTestReceiptTools,
  type ControlledMediaDriver,
  type ExpiringDeadlineGate,
  type TestReceiptTools,
} from './m1-kit'
import type { VirtualClock } from './virtual-clock'
import { createVirtualClock } from './virtual-clock'

/**
 * Test-only controls for the M1-02 Kokoro synthesis adapter and the controlled
 * audio-resource registry. These hooks never reach production code, use no
 * wall-clock sleeps and drive every dependency explicitly.
 */

export const M1_KOKORO_VOICE_ID = M1_FIXTURE_VOICE_ID
export const M1_KOKORO_VOICE_VERSION = M1_FIXTURE_VOICE_VERSION
export const M1_KOKORO_PROVIDER_VOICE_ID = 'af-test'
export const M1_KOKORO_SPEED = 1.25
export const M1_KOKORO_SAMPLE_RATE = 24000
export const M1_KOKORO_SAMPLE_COUNT = 8

/** A deterministic mono sample set so tests can compare exact decoded values. */
export function createKokoroRawAudio(
  sampleCount = M1_KOKORO_SAMPLE_COUNT,
  sampleRate = M1_KOKORO_SAMPLE_RATE,
  value: (index: number) => number = (index) => Math.sin(index) * 0.5,
): KokoroRawAudio {
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) samples[index] = value(index)
  return { samples, sampleRate }
}

export function defaultKokoroProfile(): KokoroVoiceProfile {
  return {
    voiceProfileId: M1_KOKORO_VOICE_ID,
    voiceProfileVersion: M1_KOKORO_VOICE_VERSION,
    providerVoiceId: M1_KOKORO_PROVIDER_VOICE_ID,
    speed: M1_KOKORO_SPEED,
  }
}

export interface KokoroProviderCall {
  text: string
  voiceId: string
  speed: number
}

export interface FakeKokoroProvider extends KokoroProvider {
  calls(): KokoroProviderCall[]
  pendingCount(): number
  setAutoResolve(audio?: KokoroRawAudio): void
  setAutoReject(error: unknown): void
  setAutoThrow(error: unknown): void
  resolveNext(audio?: KokoroRawAudio): void
  rejectNext(error: unknown): void
}

type FakeAuto =
  | { kind: 'resolve'; audio?: KokoroRawAudio }
  | { kind: 'reject'; error: unknown }
  | { kind: 'throw'; error: unknown }

/**
 * A fully controlled Kokoro-compatible provider. It records the exact configured
 * request, can hold a generation open, and can throw synchronously, reject
 * asynchronously or resolve with arbitrary (including malformed) audio.
 */
export function createFakeKokoroProvider(): FakeKokoroProvider {
  const calls: KokoroProviderCall[] = []
  const pending: Array<{ resolve: (audio: KokoroRawAudio) => void; reject: (error: unknown) => void }> = []
  let auto: FakeAuto | null = null

  return {
    calls: () => calls.slice(),
    pendingCount: () => pending.length,
    setAutoResolve(audio) {
      auto = audio === undefined ? { kind: 'resolve' } : { kind: 'resolve', audio }
    },
    setAutoReject(error) {
      auto = { kind: 'reject', error }
    },
    setAutoThrow(error) {
      auto = { kind: 'throw', error }
    },
    resolveNext(audio) {
      const entry = pending.shift()
      if (entry !== undefined) entry.resolve(audio ?? createKokoroRawAudio())
    },
    rejectNext(error) {
      const entry = pending.shift()
      if (entry !== undefined) entry.reject(error)
    },
    generate(input: KokoroProviderInput) {
      calls.push({ text: input.text, voiceId: input.voiceId, speed: input.speed })
      if (auto !== null) {
        if (auto.kind === 'throw') throw auto.error
        if (auto.kind === 'reject') return Promise.reject(auto.error)
        // A configured resolve value is returned verbatim, including malformed
        // values used to exercise adapter validation; only an absent value
        // falls back to a default sample set.
        const configured = auto.audio
        if (configured !== undefined) return Promise.resolve(configured)
        return Promise.resolve(createKokoroRawAudio())
      }
      return new Promise<KokoroRawAudio>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
  }
}

/** An independent RIFF/WAVE reader used as a test oracle, not the encoder. */
export interface DecodedKokoroWav {
  riff: string
  wave: string
  audioFormat: number
  channels: number
  sampleRateHz: number
  bitsPerSample: number
  dataByteLength: number
  frameCount: number
  durationMs: number
  samples: number[]
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
 * Parse a mono IEEE-float WAV snapshot and decode its samples. It reads the
 * `fmt ` and `data` chunks independently of the production encoder so header,
 * format, rate, length, content and duration can be asserted as real facts.
 */
export function decodeMonoFloat32Wav(bytes: Uint8Array): DecodedKokoroWav {
  const riff = readTag(bytes, 0)
  const wave = readTag(bytes, 8)
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('m1-kokoro-kit: not a RIFF/WAVE file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let audioFormat = 0
  let channels = 0
  let sampleRateHz = 0
  let bitsPerSample = 0
  let dataByteLength = 0
  let dataOffset = 0
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = readTag(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRateHz = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataByteLength = size
      dataOffset = body
    }
    offset = body + size + (size % 2)
  }
  const bytesPerFrame = channels * (bitsPerSample / 8)
  const frameCount = bytesPerFrame === 0 ? 0 : dataByteLength / bytesPerFrame
  const durationMs = sampleRateHz === 0 ? 0 : (frameCount / sampleRateHz) * 1000
  const samples: number[] = []
  for (let index = 0; index < frameCount; index += 1) {
    samples.push(view.getFloat32(dataOffset + index * bytesPerFrame, true))
  }
  return {
    riff,
    wave,
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    dataByteLength,
    frameCount,
    durationMs,
    samples,
  }
}

/** A unique sequential reference factory for tests. */
export function createSequentialRefFactory(prefix = 'audio://kokoro/test'): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `${prefix}/${counter}`
  }
}

/** A collision/refusal factory that always returns the same opaque token. */
export function createFixedRefFactory(ref: string): () => string {
  return () => ref
}

export interface M1KokoroSynthesisKit {
  readonly synthesis: SynthesisPort
  readonly provider: FakeKokoroProvider
  readonly registry: AudioResourceRegistry
  readonly clock: VirtualClock
  readonly gate: ExpiringDeadlineGate
  readonly refFactory: () => string
}

export function createM1KokoroSynthesisKit(
  overrides: {
    profiles?: readonly KokoroVoiceProfile[]
    byteBudget?: number
    retentionMs?: number
    newRef?: () => string
    clock?: VirtualClock
    gate?: ExpiringDeadlineGate
    provider?: FakeKokoroProvider
  } = {},
): M1KokoroSynthesisKit {
  const provider = overrides.provider ?? createFakeKokoroProvider()
  const clock = overrides.clock ?? createVirtualClock(0)
  const gate = overrides.gate ?? createExpiringDeadlineGate(0)
  const refFactory = overrides.newRef ?? createSequentialRefFactory()
  const registry = createAudioResourceRegistry({
    clock,
    byteBudget: overrides.byteBudget ?? 1_000_000,
    retentionMs: overrides.retentionMs ?? 60_000,
    newRef: refFactory,
  })
  const synthesis = createKokoroSynthesis({
    provider,
    profiles: overrides.profiles ?? [defaultKokoroProfile()],
    registry,
    clock,
    deadlineGate: gate,
  })
  return { synthesis, provider, registry, clock, gate, refFactory }
}

export interface RegistryPlayerKit {
  readonly controller: PlaybackController
  readonly player: PlayerPort
  readonly media: ControlledMediaDriver
  readonly gate: ExpiringDeadlineGate
  readonly observed: PerformanceReceipt[]
  readonly faults: unknown[]
  readonly receipts: TestReceiptTools
}

/**
 * A real browser playback controller and its `PlayerPort` adapter whose resolver
 * is an actual controlled registry. Controlled media and an expiring virtual
 * deadline gate keep playback deterministic without wall-clock waits.
 */
export function createRegistryPlayerKit(
  resolver: AudioResolver,
  overrides: {
    sessionId?: string
    initialEpoch?: number
    media?: ControlledMediaDriver
    gate?: ExpiringDeadlineGate
    receipts?: TestReceiptTools
  } = {},
): RegistryPlayerKit {
  const media = overrides.media ?? createControlledMediaDriver()
  const gate = overrides.gate ?? createExpiringDeadlineGate(0)
  const receipts = overrides.receipts ?? createTestReceiptTools('kokoro-player')
  const observed: PerformanceReceipt[] = []
  const faults: unknown[] = []
  const controller = createPlaybackController({
    sessionId: overrides.sessionId ?? 'session-fixture',
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
  return { controller, player, media, gate, observed, faults, receipts }
}
