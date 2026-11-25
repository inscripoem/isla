import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PerformanceCommand } from '../../src/contracts/app'
import type {
  MediaEvent,
  MediaHandle,
  MouthPlaybackKey,
  MouthPlaybackSample,
} from '../../src/performance/browser/types'
import { createDomMediaDriver } from '../../src/performance/browser/dom-driver'
import { createPlaybackController } from '../../src/performance/browser/player'
import { createEnvelopePlayback } from '../../src/performance/lipsync/envelope-playback'
import { createTestReceiptTools } from '../support/m1-kit'

/**
 * Focused evidence for the approved M1 Kokoro envelope path:
 *
 * - `createEnvelopePlayback` maps an admitted output's actual media position
 *   onto a 20 ms raw-RMS envelope and performs the simple opening gain.
 * - The browser DOM driver reports true `HTMLMediaElement.currentTime`
 *   positions and never observes volume or mute.
 * - The player passes its validated command to `media.create(command?)`.
 *
 * Neither test suite touches a desktop, VTS, network or audio device.
 */

const SESSION_ID = 'session-envelope'
const TURN_ID = 'turn-envelope'
const SEGMENT_A = 'segment-a'
const SEGMENT_B = 'segment-b'
const AUDIO_A = 'audio://envelope/a'
const AUDIO_B = 'audio://envelope/b'
const OUTPUT_A = 'output-a'
const OUTPUT_B = 'output-b'

interface TestEnvelope {
  readonly audioRef: string
  readonly sessionId: string
  readonly epoch: number
  readonly turnId: string
  readonly segmentId: string
  readonly stepMs: 20
  readonly durationMs: number
  readonly levels: readonly number[]
}

function envelope(overrides: Partial<TestEnvelope> = {}): TestEnvelope {
  return {
    audioRef: AUDIO_A,
    sessionId: SESSION_ID,
    epoch: 0,
    turnId: TURN_ID,
    segmentId: SEGMENT_A,
    stepMs: 20,
    durationMs: 100,
    levels: [0, 0.02, 0.1, 0.3, 1],
    ...overrides,
  }
}

function key(overrides: Partial<MouthPlaybackKey> = {}): MouthPlaybackKey {
  return {
    audioRef: AUDIO_A,
    sessionId: SESSION_ID,
    epoch: 0,
    turnId: TURN_ID,
    segmentId: SEGMENT_A,
    outputId: OUTPUT_A,
    ...overrides,
  }
}

function playing(positionMs: number, overrides: Partial<MouthPlaybackKey> = {}): MouthPlaybackSample {
  return { key: key(overrides), state: 'playing', positionMs }
}

function stateSample(
  state: MouthPlaybackSample['state'],
  positionMs = 0,
  overrides: Partial<MouthPlaybackKey> = {},
): MouthPlaybackSample {
  return { key: key(overrides), state, positionMs }
}

interface TestWriter {
  readonly write: (opening: number, signal: AbortSignal) => void | Promise<void>
  readonly calls: Array<{ opening: number; signal: AbortSignal }>
  readonly pendingCount: () => number
  setManual(value: boolean): void
  resolveNext(): void
  rejectNext(error?: unknown): void
}

/**
 * A tiny controllable opening sink. Synchronous by default; manual mode holds
 * each call until the test resolves or rejects it, so slow-VTS pressure and
 * stale acknowledgements are observable without timers.
 */
function createTestWriter(): TestWriter {
  const calls: Array<{ opening: number; signal: AbortSignal }> = []
  const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  let manual = false
  return {
    calls,
    write(opening, signal) {
      calls.push({ opening, signal })
      if (!manual) return
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
    pendingCount: () => pending.length,
    setManual(value) {
      manual = value
    },
    resolveNext() {
      pending.shift()?.resolve()
    },
    rejectNext(error = new Error('sink failed')) {
      pending.shift()?.reject(error)
    },
  }
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('M1 Kokoro envelope playback', () => {
  it('validates once, ignores malformed envelopes and never writes on supply alone', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope())).toBe(true)
    expect(writer.calls).toHaveLength(0)

    const malformed = [
      { ...envelope(), stepMs: 10 },
      { ...envelope(), durationMs: 100, levels: [0, 0, 0, 0] },
      { ...envelope(), durationMs: -1, levels: [] },
      { ...envelope(), durationMs: Number.NaN, levels: [] },
      { ...envelope(), levels: [0, 0, Number.NaN, 0, 0] },
      { ...envelope(), levels: [0, 0, -0.1, 0, 0] },
      { ...envelope(), levels: [0, 0, 1.1, 0, 0] },
      { ...envelope(), audioRef: '' },
    ]
    for (const candidate of malformed) {
      expect(playback.supply(candidate as TestEnvelope)).toBe(false)
    }

    expect(playback.supply(envelope({ segmentId: 'zero-duration', durationMs: 0, levels: [] }))).toBe(true)
    expect(writer.calls).toHaveLength(0)
  })

  it('maps actual positions through half-open 20 ms windows and the simple gain', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope())).toBe(true)

    for (const positionMs of [0, 19.999, 20, 39.999, 40, 80, 99.999, 100, -5]) {
      playback.observe(playing(positionMs))
    }

    expect(writer.calls.map((call) => call.opening)).toEqual([0, 0, 0.1, 0.1, 0.5, 1, 1, 0, 0])
  })

  it('keeps exact zero silent, uses the final partial window and samples changing positions', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(
      playback.supply(envelope({ durationMs: 50, levels: [0.02, 0.1, 0.2] })),
    ).toBe(true)

    playback.observe(playing(1))
    playback.observe(playing(21))
    playback.observe(playing(41))
    playback.observe(playing(49.999))
    playback.observe(playing(50))

    expect(writer.calls.map((call) => call.opening)).toEqual([0.1, 0.5, 1, 1, 0])
  })

  it('zeroes on pause/waiting and resumes only on a new actual playing sample', async () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope({ levels: [1, 1, 1, 1, 1] }))).toBe(true)

    playback.observe(playing(0))
    playback.observe(stateSample('paused'))
    playback.observe(stateSample('waiting'))
    expect(writer.calls.map((call) => call.opening)).toEqual([1, 0, 0])

    const pausedCount = writer.calls.length
    await settleMicrotasks()
    expect(writer.calls).toHaveLength(pausedCount)

    playback.observe(playing(20))
    expect(writer.calls.map((call) => call.opening)).toEqual([1, 0, 0, 1])
  })

  it('ignores unmatched, invalid and late-envelope samples; a later supply can sample on the next tick', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    playback.observe(playing(20))
    expect(writer.calls).toHaveLength(0)

    expect(playback.supply(envelope())).toBe(true)
    expect(writer.calls).toHaveLength(0)

    playback.observe(playing(20, { audioRef: AUDIO_B }))
    playback.observe(playing(Number.NaN))
    playback.observe(playing(20, { epoch: 1 }))
    playback.observe(playing(20, { outputId: OUTPUT_B, segmentId: SEGMENT_B }))
    expect(writer.calls).toHaveLength(0)

    playback.observe(playing(20))
    expect(writer.calls.map((call) => call.opening)).toEqual([0.1])
  })

  it('keeps consecutive segments distinct: B playing retires A, and late A cannot mute B', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope({ levels: [1, 1, 1, 1, 1] }))).toBe(true)
    expect(playback.supply(envelope({
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      levels: [1, 1, 1, 1, 1],
    }))).toBe(true)

    playback.observe(playing(0))
    const afterA = writer.calls.length
    expect(writer.calls.at(-1)?.opening).toBe(1)

    playback.observe(playing(20, { segmentId: SEGMENT_B, audioRef: AUDIO_B }))
    expect(writer.calls.at(-1)?.opening).toBe(1)
    expect(writer.calls.length).toBe(afterA + 1)

    const afterB = writer.calls.length
    playback.observe(stateSample('waiting', 0, { segmentId: SEGMENT_A }))
    playback.observe(stateSample('ended', 0, { segmentId: SEGMENT_A }))
    playback.observe(playing(40, { epoch: 0 }))
    expect(writer.calls).toHaveLength(afterB)

    playback.observe(playing(40, { segmentId: SEGMENT_B, audioRef: AUDIO_B }))
    expect(writer.calls.at(-1)?.opening).toBe(1)
    expect(playback.supply(envelope())).toBe(false)
  })

  it('lets a newer epoch invalidate the old output immediately and rejects late old supply', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope({ levels: [1, 1, 1, 1, 1] }))).toBe(true)
    playback.observe(playing(0))
    expect(writer.calls.at(-1)?.opening).toBe(1)

    expect(playback.supply(envelope({
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      levels: [0.2, 0.2, 0.2, 0.2, 0.2],
    }))).toBe(true)
    expect(writer.calls.at(-1)?.opening).toBe(0)

    const afterEpoch = writer.calls.length
    playback.observe(playing(20))
    expect(writer.calls).toHaveLength(afterEpoch)

    playback.observe(playing(0, { epoch: 1, audioRef: AUDIO_B, segmentId: SEGMENT_B }))
    expect(writer.calls.at(-1)?.opening).toBe(1)
    expect(playback.supply(envelope())).toBe(false)
  })

  it('rejects late supply after a terminal and does not resurrect a closed output', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope())).toBe(true)
    playback.observe(playing(0))
    playback.observe(stateSample('ended'))
    const calls = writer.calls.length
    expect(writer.calls.at(-1)?.opening).toBe(0)

    expect(playback.supply(envelope())).toBe(false)
    expect(playback.supply(envelope({ levels: [1, 1, 1, 1, 1] }))).toBe(false)
    playback.observe(playing(20))
    playback.observe(stateSample('ended'))
    expect(writer.calls).toHaveLength(calls)
  })

  it('preserves admission order on duplicate supply and refreshes an active envelope', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope({ levels: [0, 0, 0, 0, 0] }))).toBe(true)
    expect(playback.supply(envelope({
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      levels: [1, 1, 1, 1, 1],
    }))).toBe(true)

    playback.observe(playing(0))
    expect(writer.calls.at(-1)?.opening).toBe(0)

    expect(playback.supply(envelope({ levels: [0, 0.2, 0.2, 0.2, 0.2] }))).toBe(true)
    expect(writer.calls).toHaveLength(1)
    playback.observe(playing(20))
    expect(writer.calls.at(-1)?.opening).toBe(1)

    playback.observe(playing(0, { audioRef: AUDIO_B, segmentId: SEGMENT_B }))
    expect(playback.supply(envelope())).toBe(false)
  })

  it('retains a finite pending set so later segments still win', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write, { maxEnvelopes: 2 })

    for (let index = 0; index < 5; index += 1) {
      expect(playback.supply(envelope({
        segmentId: `segment-${index}`,
        levels: [1, 1, 1, 1, 1],
      }))).toBe(true)
    }

    playback.observe(playing(0, { segmentId: 'segment-0' }))
    expect(writer.calls).toHaveLength(0)

    playback.observe(playing(0, { segmentId: 'segment-4' }))
    expect(writer.calls.map((call) => call.opening)).toEqual([1])
  })

  it('keeps one ordinary write in flight plus one latest value, and aborts for a neutral zero', async () => {
    const writer = createTestWriter()
    writer.setManual(true)
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope({ levels: [0.1, 0.2, 0.4, 0.6, 0.8] }))).toBe(true)
    playback.observe(playing(0))
    expect(writer.calls.map((call) => call.opening)).toEqual([0.5])
    expect(writer.pendingCount()).toBe(1)

    playback.observe(playing(20))
    playback.observe(playing(40))
    expect(writer.calls).toHaveLength(1)
    expect(writer.pendingCount()).toBe(1)

    writer.resolveNext()
    await settleMicrotasks()
    expect(writer.calls.map((call) => call.opening)).toEqual([0.5, 1])
    expect(writer.pendingCount()).toBe(1)

    const inFlight = writer.calls[1]?.signal
    playback.observe(stateSample('paused'))
    expect(writer.calls.map((call) => call.opening)).toEqual([0.5, 1, 0])
    expect(inFlight?.aborted).toBe(true)
    expect(writer.calls[2]?.signal.aborted).toBe(false)

    writer.resolveNext()
    await settleMicrotasks()
    expect(writer.calls).toHaveLength(3)

    writer.resolveNext()
    await playback.flush()
    expect(writer.calls).toHaveLength(3)
  })

  it('flush awaits the current and coalesced valid writes, not a superseded acknowledgement', async () => {
    const writer = createTestWriter()
    writer.setManual(true)
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope())).toBe(true)
    playback.observe(playing(0))
    playback.observe(playing(20))

    let flushed = false
    const flushing = playback.flush().then(() => {
      flushed = true
    })
    await settleMicrotasks()
    expect(flushed).toBe(false)

    writer.resolveNext()
    await settleMicrotasks()
    expect(writer.calls).toHaveLength(2)
    expect(flushed).toBe(false)

    writer.resolveNext()
    await flushing
    expect(flushed).toBe(true)

    const second = createTestWriter()
    second.setManual(true)
    const controller = createEnvelopePlayback(second.write)
    expect(controller.supply(envelope({ levels: [1, 1, 1, 1, 1] }))).toBe(true)
    controller.observe(playing(0))
    const secondFlush = controller.flush()
    let secondFlushed = false
    void secondFlush.then(() => {
      secondFlushed = true
    })
    controller.observe(stateSample('paused'))
    expect(second.calls.map((call) => call.opening)).toEqual([1, 0])
    second.resolveNext()
    second.resolveNext()
    await secondFlush
    expect(secondFlushed).toBe(true)
  })

  it('close and disconnect force zero once, forget state and never revive old data', async () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)

    expect(playback.supply(envelope({ levels: [1, 1, 1, 1, 1] }))).toBe(true)
    playback.observe(playing(0))
    expect(writer.calls.at(-1)?.opening).toBe(1)

    const closing = playback.close()
    expect(writer.calls.at(-1)?.opening).toBe(0)
    const callsAtClose = writer.calls.length
    await closing
    await playback.close()
    await playback.disconnect()
    expect(writer.calls).toHaveLength(callsAtClose)

    playback.observe(playing(20))
    expect(playback.supply(envelope())).toBe(false)
    await playback.flush()
    expect(writer.calls).toHaveLength(callsAtClose)

    const freshWriter = createTestWriter()
    const fresh = createEnvelopePlayback(freshWriter.write)
    expect(freshWriter.calls).toHaveLength(0)
    expect(fresh.supply(envelope())).toBe(true)
    fresh.observe(playing(0))
    expect(freshWriter.calls.map((call) => call.opening)).toEqual([0])
    await fresh.disconnect()
    expect(freshWriter.calls.at(-1)?.opening).toBe(0)
  })

  it('survives a throwing or rejecting sink without unhandled rejections', async () => {
    const openings: number[] = []
    const playback = createEnvelopePlayback((opening) => {
      openings.push(opening)
      if (openings.length === 1) throw new Error('synchronous sink failure')
      if (openings.length === 2) return Promise.reject(new Error('asynchronous sink failure'))
    })

    expect(playback.supply(envelope())).toBe(true)
    expect(() => playback.observe(playing(0))).not.toThrow()
    playback.observe(playing(20))
    await expect(playback.flush()).resolves.toBeUndefined()
    expect(openings).toHaveLength(2)
  })

  it('accepts a zero-duration envelope without activity and keeps it silent', async () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope({ durationMs: 0, levels: [] }))).toBe(true)
    expect(writer.calls).toHaveLength(0)

    playback.observe(playing(0))
    expect(writer.calls.map((call) => call.opening)).toEqual([0])
    await playback.flush()
  })

  it('fences a terminal before supply and a staged terminal before first playing', () => {
    const earlyWriter = createTestWriter()
    const early = createEnvelopePlayback(earlyWriter.write)
    early.observe(stateSample('stopped'))
    expect(early.supply(envelope())).toBe(false)
    early.observe(playing(0))
    expect(earlyWriter.calls).toHaveLength(0)

    const stagedWriter = createTestWriter()
    const staged = createEnvelopePlayback(stagedWriter.write)
    expect(staged.supply(envelope())).toBe(true)
    staged.observe(stateSample('error'))
    expect(staged.supply(envelope())).toBe(false)
    staged.observe(playing(0))
    expect(stagedWriter.calls).toHaveLength(0)
  })

  it('pins an active envelope to its first output and ignores foreign output frames', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope({ levels: [0.08, 0.16, 0.24, 0.32, 0.4] }))).toBe(true)

    playback.observe(playing(0))
    expect(writer.calls.map((call) => call.opening)).toEqual([0.4])

    const before = writer.calls.length
    playback.observe(playing(20, { outputId: OUTPUT_B }))
    playback.observe(stateSample('stopped', 20, { outputId: OUTPUT_B }))
    expect(writer.calls).toHaveLength(before)

    // The foreign tombstone cannot block a refresh of the pinned legitimate output.
    expect(playback.supply(envelope({ levels: [0.08, 0.16, 0.24, 0.32, 0.4] }))).toBe(true)
    playback.observe(playing(20))
    expect(writer.calls.at(-1)?.opening).toBe(0.8)
    expect(writer.calls).toHaveLength(before + 1)
  })

  it('scopes epochs per session and fences a replaced session after B terminates', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    const oldKey = key({
      sessionId: 'session-old',
      epoch: 5,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      outputId: OUTPUT_A,
    })
    const nextKey = key({
      sessionId: 'session-new',
      epoch: 0,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      outputId: OUTPUT_B,
    })

    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 5,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      levels: [1, 1, 1, 1, 1],
    }))).toBe(true)
    playback.observe({ key: oldKey, state: 'playing', positionMs: 0 })
    expect(writer.calls.at(-1)?.opening).toBe(1)

    expect(playback.supply(envelope({
      sessionId: 'session-new',
      epoch: 0,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      levels: [0.2, 0.2, 0.2, 0.2, 0.2],
    }))).toBe(true)
    expect(writer.calls).toHaveLength(1)
    playback.observe({ key: nextKey, state: 'playing', positionMs: 0 })
    expect(writer.calls.at(-1)?.opening).toBe(1)

    const afterSwitch = writer.calls.length
    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 5,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      levels: [1, 1, 1, 1, 1],
    }))).toBe(false)
    playback.observe({ key: oldKey, state: 'playing', positionMs: 20 })
    expect(writer.calls).toHaveLength(afterSwitch)

    playback.observe({ key: nextKey, state: 'ended', positionMs: 100 })
    const afterEnd = writer.calls.length
    expect(writer.calls.at(-1)?.opening).toBe(0)
    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 5,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      levels: [1, 1, 1, 1, 1],
    }))).toBe(false)
    playback.observe({ key: oldKey, state: 'playing', positionMs: 20 })
    expect(writer.calls).toHaveLength(afterEnd)
  })

  it('does not let a late old-session segment steal a new session that actually plays', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    const oldKey = key({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      outputId: OUTPUT_A,
    })
    const lateKey = key({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: 'audio://envelope/late',
      segmentId: 'segment-late',
      outputId: 'output-late',
    })
    const nextKey = key({
      sessionId: 'session-new',
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      outputId: OUTPUT_B,
    })

    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      durationMs: 20,
      levels: [0.04],
    }))).toBe(true)
    playback.observe({ key: oldKey, state: 'playing', positionMs: 5 })
    playback.observe({ key: oldKey, state: 'ended', positionMs: 20 })
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2, 0])

    expect(playback.supply(envelope({
      sessionId: 'session-new',
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      durationMs: 20,
      levels: [0.18],
    }))).toBe(true)
    expect(writer.calls).toHaveLength(2)
    playback.observe({ key: nextKey, state: 'playing', positionMs: 5 })
    expect(writer.calls.at(-1)?.opening).toBeCloseTo(0.9, 12)

    const afterNewSession = writer.calls.length
    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: 'audio://envelope/late',
      segmentId: 'segment-late',
      durationMs: 20,
      levels: [0.06],
    }))).toBe(false)
    playback.observe({ key: lateKey, state: 'playing', positionMs: 5 })
    playback.observe({ key: lateKey, state: 'error', positionMs: 20 })
    expect(writer.calls).toHaveLength(afterNewSession)
  })

  it('keeps a pre-supplied future session staged across the old session segment gap', () => {
    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    const nextKey = key({
      sessionId: 'session-new',
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      outputId: OUTPUT_B,
    })
    const firstKey = key({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      outputId: OUTPUT_A,
    })
    const secondKey = key({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: 'audio://envelope/a2',
      segmentId: 'segment-a2',
      outputId: 'output-a2',
    })

    // Synthesis arrived for the future session first; actual playback belongs
    // to the old session until the future session really starts.
    expect(playback.supply(envelope({
      sessionId: 'session-new',
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      durationMs: 20,
      levels: [0.18],
    }))).toBe(true)
    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      durationMs: 20,
      levels: [0.04],
    }))).toBe(true)

    playback.observe({ key: firstKey, state: 'playing', positionMs: 5 })
    playback.observe({ key: firstKey, state: 'ended', positionMs: 20 })
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2, 0])

    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: 'audio://envelope/a2',
      segmentId: 'segment-a2',
      durationMs: 20,
      levels: [0.06],
    }))).toBe(true)
    playback.observe({ key: secondKey, state: 'playing', positionMs: 5 })
    playback.observe({ key: secondKey, state: 'ended', positionMs: 20 })
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2, 0, 0.3, 0])

    playback.observe({ key: nextKey, state: 'playing', positionMs: 5 })
    expect(writer.calls.at(-1)?.opening).toBeCloseTo(0.9, 12)

    const afterTakeover = writer.calls.length
    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: 'audio://envelope/a3',
      segmentId: 'segment-a3',
      durationMs: 20,
      levels: [0.2],
    }))).toBe(false)
    expect(writer.calls).toHaveLength(afterTakeover)
  })

  it('supersedes a held terminal zero when a new session actually starts', async () => {
    const writer = createTestWriter()
    writer.setManual(true)
    const playback = createEnvelopePlayback(writer.write)
    const oldKey = key({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      outputId: OUTPUT_A,
    })
    const nextKey = key({
      sessionId: 'session-new',
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      outputId: OUTPUT_B,
    })

    expect(playback.supply(envelope({
      sessionId: 'session-old',
      epoch: 8,
      audioRef: AUDIO_A,
      segmentId: SEGMENT_A,
      durationMs: 20,
      levels: [0.04],
    }))).toBe(true)
    playback.observe({ key: oldKey, state: 'playing', positionMs: 5 })
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2])

    writer.resolveNext()
    await settleMicrotasks()
    playback.observe({ key: oldKey, state: 'ended', positionMs: 20 })
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2, 0])

    expect(playback.supply(envelope({
      sessionId: 'session-new',
      epoch: 1,
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      durationMs: 20,
      levels: [0.16],
    }))).toBe(true)
    expect(writer.calls).toHaveLength(2)

    playback.observe({ key: nextKey, state: 'playing', positionMs: 5 })
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2, 0, 0.8])
    expect(writer.calls[1]?.signal.aborted).toBe(true)
    expect(writer.calls[2]?.signal.aborted).toBe(false)

    writer.resolveNext()
    await settleMicrotasks()
    writer.resolveNext()
    await playback.flush()
    expect(writer.calls.map((call) => call.opening)).toEqual([0.2, 0, 0.8])

    const closing = playback.close()
    writer.resolveNext()
    await closing
  })

  it('immediately replaces a held writer when a different bound output plays', async () => {
    const writer = createTestWriter()
    writer.setManual(true)
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope({ levels: [0.08, 0.16, 0.24, 0.32, 0.4] }))).toBe(true)
    expect(playback.supply(envelope({
      audioRef: AUDIO_B,
      segmentId: SEGMENT_B,
      levels: [0.16, 0.32, 0.48, 0.64, 0.8],
    }))).toBe(true)

    playback.observe(playing(0))
    expect(writer.calls.map((call) => call.opening)).toEqual([0.4])
    const oldSignal = writer.calls[0]?.signal

    playback.observe(playing(0, { audioRef: AUDIO_B, segmentId: SEGMENT_B }))
    expect(writer.calls.map((call) => call.opening)).toEqual([0.4, 0.8])
    expect(oldSignal?.aborted).toBe(true)
    expect(writer.calls[1]?.signal.aborted).toBe(false)

    writer.resolveNext()
    await settleMicrotasks()
    expect(writer.calls).toHaveLength(2)
    writer.resolveNext()
    await playback.flush()
    expect(writer.calls).toHaveLength(2)
  })

  it('keeps close idempotent when the sink reenters close during its forced zero', async () => {
    const openings: number[] = []
    const playback = createEnvelopePlayback((opening) => {
      openings.push(opening)
      if (openings.length === 1) void playback.close()
    })

    await playback.close()
    expect(openings).toEqual([0])
    await playback.close()
    await playback.disconnect()
    expect(openings).toEqual([0])
  })
})

/* ------------------------------------------------------------------------- *
 * Browser DOM driver: true media positions, no volume/mute, opt-in samples.
 * ------------------------------------------------------------------------- */

const COMMAND: PerformanceCommand = {
  outputId: OUTPUT_A,
  sessionId: SESSION_ID,
  epoch: 0,
  turnId: TURN_ID,
  segmentId: SEGMENT_A,
  audioRef: AUDIO_A,
  subtitleText: 'Envelope fixture.',
  actionId: 'neutral',
  capabilityRevision: 1,
}

function command(overrides: Partial<PerformanceCommand> = {}): PerformanceCommand {
  return { ...COMMAND, ...overrides }
}

function expectedKey(overrides: Partial<MouthPlaybackKey> = {}): MouthPlaybackKey {
  return {
    audioRef: AUDIO_A,
    sessionId: SESSION_ID,
    epoch: 0,
    turnId: TURN_ID,
    segmentId: SEGMENT_A,
    outputId: OUTPUT_A,
    ...overrides,
  }
}

class FakeAudioElement extends EventTarget {
  preload = ''
  src = ''
  currentTime = 0
  seeking = false
  paused = false
  error: { readonly code?: number } | null = null
  loadCount = 0
  pauseCount = 0
  playCount = 0
  removedAttributeCount = 0
  volumeReads = 0
  mutedReads = 0
  private pauseThrows = false
  private playRejects = false

  get volume(): number {
    this.volumeReads += 1
    throw new Error('the media volume must never be read')
  }

  set volume(_value: number) {
    this.volumeReads += 1
    throw new Error('the media volume must never be written')
  }

  get muted(): boolean {
    this.mutedReads += 1
    throw new Error('the media mute flag must never be read')
  }

  set muted(_value: boolean) {
    this.mutedReads += 1
    throw new Error('the media mute flag must never be written')
  }

  setPauseThrows(): void {
    this.pauseThrows = true
  }

  setPlayRejects(): void {
    this.playRejects = true
  }

  load(): void {
    this.loadCount += 1
  }

  play(): Promise<void> {
    this.playCount += 1
    return this.playRejects
      ? Promise.reject(new Error('fixture play rejection'))
      : Promise.resolve()
  }

  pause(): void {
    this.pauseCount += 1
    this.paused = true
    if (this.pauseThrows) {
      this.pauseThrows = false
      throw new Error('fixture pause failure')
    }
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.removedAttributeCount += 1
      this.src = ''
    }
  }
}

function installDomFakes(): { elements: FakeAudioElement[]; revoked: string[] } {
  const elements: FakeAudioElement[] = []
  const revoked: string[] = []
  let urlSequence = 0
  vi.stubGlobal('document', {
    createElement(tagName: string) {
      expect(tagName).toBe('audio')
      const element = new FakeAudioElement()
      elements.push(element)
      return element as unknown as HTMLAudioElement
    },
  })
  vi.stubGlobal('URL', {
    createObjectURL() {
      urlSequence += 1
      return `blob:envelope-${urlSequence}`
    },
    revokeObjectURL(url: string) {
      revoked.push(url)
    },
  })
  return { elements, revoked }
}

function dispatch(element: FakeAudioElement, type: string): void {
  element.dispatchEvent(new Event(type))
}

describe('M1 DOM media mouth observations', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('emits the immediate true position and 16 ms actual positions only while playing', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([1])]))
    const element = dom.elements[0]
    expect(element).toBeDefined()
    if (element === undefined) return

    element.currentTime = 1.234
    dispatch(element, 'playing')
    expect(samples).toHaveLength(1)
    expect(samples[0]?.state).toBe('playing')
    expect(samples[0]?.key).toEqual(expectedKey())
    expect(samples[0]?.positionMs).toBeCloseTo(1234, 6)

    element.currentTime = 1.25
    vi.advanceTimersByTime(15)
    expect(samples).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(samples).toHaveLength(2)
    expect(samples[1]?.positionMs).toBeCloseTo(1250, 6)

    element.currentTime = 2
    dispatch(element, 'pause')
    expect(samples.at(-1)?.state).toBe('paused')
    expect(samples.at(-1)?.positionMs).toBeCloseTo(2000, 6)
    vi.advanceTimersByTime(100)
    expect(samples).toHaveLength(3)

    element.currentTime = 2.5
    dispatch(element, 'playing')
    expect(samples.at(-1)?.state).toBe('playing')
    expect(samples.at(-1)?.positionMs).toBeCloseTo(2500, 6)
    vi.advanceTimersByTime(16)
    expect(samples).toHaveLength(5)

    expect(handle.detach()).toBe(true)
  })

  it('reports waiting/seeking as nonplaying and stops the timer until an actual playing event', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([2])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.5
    dispatch(element, 'playing')
    expect(samples).toHaveLength(1)

    element.currentTime = 0.75
    dispatch(element, 'waiting')
    expect(samples.at(-1)).toMatchObject({ state: 'waiting', positionMs: 750 })
    const afterWaiting = samples.length
    vi.advanceTimersByTime(64)
    expect(samples).toHaveLength(afterWaiting)

    dispatch(element, 'playing')
    expect(samples.at(-1)?.state).toBe('playing')
    element.currentTime = 0.9
    dispatch(element, 'seeking')
    expect(samples.at(-1)).toMatchObject({ state: 'waiting', positionMs: 900 })
    const afterSeeking = samples.length
    vi.advanceTimersByTime(64)
    expect(samples).toHaveLength(afterSeeking)

    element.currentTime = 1
    dispatch(element, 'playing')
    element.currentTime = 1.1
    vi.advanceTimersByTime(16)
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 1100 })

    expect(handle.detach()).toBe(true)
  })

  it('never fabricates an active zero for a nonfinite currentTime but still resets on terminal', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([3])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = Number.NaN
    dispatch(element, 'playing')
    expect(samples).toHaveLength(0)

    vi.advanceTimersByTime(16)
    expect(samples).toHaveLength(0)

    element.currentTime = 0.5
    vi.advanceTimersByTime(16)
    expect(samples).toHaveLength(1)
    expect(samples[0]?.positionMs).toBe(500)

    element.currentTime = Number.POSITIVE_INFINITY
    vi.advanceTimersByTime(16)
    expect(samples).toHaveLength(1)

    element.currentTime = Number.NaN
    dispatch(element, 'ended')
    expect(samples.at(-1)).toMatchObject({ state: 'ended', positionMs: 0 })
    const afterEnded = samples.length
    vi.advanceTimersByTime(64)
    expect(samples).toHaveLength(afterEnded)

    expect(handle.detach()).toBe(true)
  })

  it('delivers at most one mouth terminal while media receipts stay independent', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const mediaEvents: MediaEvent[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.subscribe((event) => mediaEvents.push(event))
    handle.load(new Blob([new Uint8Array([4])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.2
    dispatch(element, 'playing')
    element.currentTime = 0.4
    dispatch(element, 'ended')
    dispatch(element, 'ended')
    dispatch(element, 'error')
    element.error = { code: 4 }
    dispatch(element, 'error')

    expect(samples.map((sample) => sample.state)).toEqual(['playing', 'ended'])
    expect(mediaEvents).toEqual([
      { type: 'playing' },
      { type: 'ended' },
      { type: 'ended' },
      { type: 'error', reasonCode: 'media_error' },
      { type: 'error', reasonCode: 'media_error_4' },
    ])
    expect(handle.detach()).toBe(true)
  })

  it('lets a reentrant detach keep the current media receipt without a second Stop', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const mediaEvents: MediaEvent[] = []
    let handle: MediaHandle | null = null
    handle = createDomMediaDriver({
      onMouthPlayback: (sample) => {
        samples.push(sample)
        if (sample.state === 'ended') handle?.detach()
      },
    }).create(command())
    handle.subscribe((event) => mediaEvents.push(event))
    handle.load(new Blob([new Uint8Array([12])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.2
    dispatch(element, 'playing')
    element.currentTime = 0.4
    dispatch(element, 'ended')

    expect(samples.map((sample) => sample.state)).toEqual(['playing', 'ended'])
    expect(mediaEvents).toEqual([{ type: 'playing' }, { type: 'ended' }])
    expect(handle.detach()).toBe(true)
  })

  it('reports a failed detach as one Stop and cannot reopen the mouth on a retry', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([5])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.3
    dispatch(element, 'playing')
    element.setPauseThrows()
    expect(handle.detach()).toBe(false)
    expect(samples.map((sample) => sample.state)).toEqual(['playing', 'stopped'])

    dispatch(element, 'playing')
    vi.advanceTimersByTime(64)
    expect(samples.map((sample) => sample.state)).toEqual(['playing', 'stopped'])

    expect(handle.detach()).toBe(true)
    expect(samples.map((sample) => sample.state)).toEqual(['playing', 'stopped'])
  })

  it('never reads or writes the media volume or mute flag', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([6])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.5
    dispatch(element, 'playing')
    vi.advanceTimersByTime(32)
    element.currentTime = 0.75
    dispatch(element, 'waiting')
    dispatch(element, 'playing')
    dispatch(element, 'pause')
    dispatch(element, 'playing')
    element.currentTime = 0.9
    dispatch(element, 'ended')
    vi.advanceTimersByTime(64)

    expect(samples.length).toBeGreaterThan(0)
    expect(element.volumeReads).toBe(0)
    expect(element.mutedReads).toBe(0)
    expect(handle.detach()).toBe(true)
  })

  it('never lets a cancelled pre-wait timer callback speak after a resumed playing event', () => {
    const dom = installDomFakes()
    const ticks: Array<() => void> = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      ticks.push(handler)
      return ticks.length
    })
    vi.stubGlobal('clearInterval', () => {})

    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([15])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.1
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 100 })
    expect(ticks).toHaveLength(1)

    element.currentTime = 0.2
    ticks[0]?.()
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 200 })

    dispatch(element, 'waiting')
    expect(samples.at(-1)?.state).toBe('waiting')

    element.currentTime = 0.5
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 500 })
    expect(ticks).toHaveLength(2)

    const beforeStaleTick = samples.length
    ticks[0]?.()
    expect(samples).toHaveLength(beforeStaleTick)

    element.currentTime = 0.6
    ticks[1]?.()
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 600 })
    expect(samples).toHaveLength(beforeStaleTick + 1)
    expect(handle.detach()).toBe(true)
  })

  it('keeps the mouth closed on a stray playing event or poll while the element seeks', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const mediaEvents: MediaEvent[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.subscribe((event) => mediaEvents.push(event))
    handle.load(new Blob([new Uint8Array([16])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.seeking = true
    element.currentTime = 0.5
    dispatch(element, 'playing')
    expect(samples).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(64)
    expect(samples).toHaveLength(0)

    element.seeking = false
    element.currentTime = 0.6
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 600 })
    expect(vi.getTimerCount()).toBe(1)

    element.seeking = true
    element.currentTime = 0.7
    vi.advanceTimersByTime(16)
    expect(samples.at(-1)).toMatchObject({ state: 'waiting', positionMs: 700 })
    expect(vi.getTimerCount()).toBe(0)

    element.seeking = false
    element.currentTime = 0.8
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 800 })
    expect(mediaEvents).toEqual([
      { type: 'playing' },
      { type: 'playing' },
      { type: 'playing' },
    ])
    expect(handle.detach()).toBe(true)
  })

  it('does not reopen a paused mouth from a late queued playing event', () => {
    const dom = installDomFakes()
    const ticks: Array<() => void> = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      ticks.push(handler)
      return ticks.length
    })
    vi.stubGlobal('clearInterval', () => {})

    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope({
      durationMs: 2000,
      levels: Array.from({ length: 100 }, () => 0.15),
    }))).toBe(true)
    const samples: MouthPlaybackSample[] = []
    const mediaEvents: MediaEvent[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => {
        samples.push(sample)
        playback.observe(sample)
      },
    }).create(command())
    handle.subscribe((event) => mediaEvents.push(event))
    handle.load(new Blob([new Uint8Array([18])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.5
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 500 })
    expect(writer.calls.at(-1)?.opening).toBeCloseTo(0.75, 12)
    expect(ticks).toHaveLength(1)

    element.paused = true
    element.currentTime = 0.6
    dispatch(element, 'pause')
    expect(samples.at(-1)).toMatchObject({ state: 'paused', positionMs: 600 })
    expect(writer.calls.at(-1)?.opening).toBe(0)
    const writesAtPause = writer.calls.length

    element.currentTime = 1.2
    dispatch(element, 'playing')
    ticks[0]?.()
    expect(samples.map((sample) => sample.state)).toEqual(['playing', 'paused'])
    expect(writer.calls).toHaveLength(writesAtPause)
    expect(ticks).toHaveLength(1)
    expect(mediaEvents.filter((event) => event.type === 'playing')).toHaveLength(2)

    element.paused = false
    element.currentTime = 1.5
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 1500 })
    expect(writer.calls.at(-1)?.opening).toBeCloseTo(0.75, 12)
    expect(ticks).toHaveLength(2)
    expect(handle.detach()).toBe(true)
  })

  it('publishes one waiting neutral when polling discovers seeking before the native event', () => {
    const dom = installDomFakes()
    const ticks: Array<() => void> = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      ticks.push(handler)
      return ticks.length
    })
    vi.stubGlobal('clearInterval', () => {})

    const writer = createTestWriter()
    const playback = createEnvelopePlayback(writer.write)
    expect(playback.supply(envelope({
      durationMs: 2000,
      levels: Array.from({ length: 100 }, () => 0.15),
    }))).toBe(true)
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => {
        samples.push(sample)
        playback.observe(sample)
      },
    }).create(command())
    handle.load(new Blob([new Uint8Array([19])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.5
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 500 })
    expect(writer.calls.at(-1)?.opening).toBeCloseTo(0.75, 12)
    expect(ticks).toHaveLength(1)

    // The browser flag changes before the native seeking callback reaches JS.
    element.seeking = true
    element.currentTime = 0.52
    ticks[0]?.()
    expect(samples.at(-1)).toMatchObject({ state: 'waiting', positionMs: 520 })
    expect(writer.calls.at(-1)?.opening).toBe(0)
    const samplesAfterDiscovery = samples.length
    const writesAfterDiscovery = writer.calls.length
    expect(ticks).toHaveLength(1)

    // The cancelled tick cannot repeat the neutral or reopen the mouth.
    ticks[0]?.()
    expect(samples).toHaveLength(samplesAfterDiscovery)
    expect(writer.calls).toHaveLength(writesAfterDiscovery)

    // A real seeking event after discovery is the same blocked state.
    dispatch(element, 'seeking')
    expect(samples).toHaveLength(samplesAfterDiscovery)
    expect(writer.calls).toHaveLength(writesAfterDiscovery)

    element.seeking = false
    element.currentTime = 0.8
    dispatch(element, 'playing')
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 800 })
    expect(writer.calls.at(-1)?.opening).toBeCloseTo(0.75, 12)
    expect(ticks).toHaveLength(2)
    element.currentTime = 0.85
    ticks[1]?.()
    expect(samples.at(-1)).toMatchObject({ state: 'playing', positionMs: 850 })
    expect(handle.detach()).toBe(true)
  })

  it('does not invoke the shared observer or any mouth timer for an uncommanded preview', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create()
    handle.load(new Blob([new Uint8Array([7])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 1
    dispatch(element, 'playing')
    dispatch(element, 'waiting')
    dispatch(element, 'pause')
    vi.advanceTimersByTime(128)
    expect(samples).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(handle.detach()).toBe(true)
  })

  it('requires both an admitted command and an observer for mouth sampling', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const handle = createDomMediaDriver().create(command())
    handle.load(new Blob([new Uint8Array([8])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 1
    dispatch(element, 'playing')
    vi.advanceTimersByTime(128)
    expect(vi.getTimerCount()).toBe(0)
    expect(handle.detach()).toBe(true)
  })

  it('resolves the transport observer getter only for a commanded handle', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const sent: string[] = []
    const sockets: Array<{ readyState: number }> = []
    class FakeWebSocket {
      readyState = 1
      bufferedAmount = 0

      constructor() {
        sockets.push(this)
      }

      send(data: string): void {
        sent.push(data)
      }

      close(): void {
        this.readyState = 3
      }

      addEventListener(): void {}
    }
    vi.stubGlobal('location', {
      hash: `#isla-mouth=${'A'.repeat(43)}`,
      protocol: 'http:',
      hostname: '127.0.0.1',
      host: '127.0.0.1:5173',
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)

    const preview = createDomMediaDriver().create()
    preview.load(new Blob([new Uint8Array([13])]))
    const previewElement = dom.elements[0]
    if (previewElement === undefined) return
    previewElement.currentTime = 0.5
    dispatch(previewElement, 'playing')
    vi.advanceTimersByTime(64)
    expect(sockets).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(preview.detach()).toBe(true)

    const explicitSamples: MouthPlaybackSample[] = []
    const explicit = createDomMediaDriver({
      onMouthPlayback: (sample) => explicitSamples.push(sample),
    }).create(command())
    explicit.load(new Blob([new Uint8Array([17])]))
    const explicitElement = dom.elements[1]
    if (explicitElement === undefined) return
    explicitElement.currentTime = 0.25
    dispatch(explicitElement, 'playing')
    expect(sockets).toHaveLength(0)
    expect(explicitSamples.at(-1)).toMatchObject({ state: 'playing', positionMs: 250 })
    expect(explicit.detach()).toBe(true)

    const handle = createDomMediaDriver().create(command())
    handle.load(new Blob([new Uint8Array([14])]))
    const element = dom.elements[2]
    if (element === undefined) return
    element.currentTime = 0.5
    dispatch(element, 'playing')
    expect(sockets).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({
      key: expectedKey(),
      state: 'playing',
      positionMs: 500,
    })

    element.currentTime = 0.75
    vi.advanceTimersByTime(16)
    expect(JSON.parse(sent[1] ?? '{}')).toMatchObject({ state: 'playing', positionMs: 750 })

    expect(handle.detach()).toBe(true)
    expect(JSON.parse(sent[2] ?? '{}')).toMatchObject({ state: 'stopped' })
  })

  it('fences an early rejected play and emits one Stop only on detach', async () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const samples: MouthPlaybackSample[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: (sample) => samples.push(sample),
    }).create(command())
    handle.load(new Blob([new Uint8Array([9])]))
    const element = dom.elements[0]
    if (element === undefined) return
    element.setPlayRejects()

    await expect(handle.play()).rejects.toThrow()
    expect(samples).toHaveLength(0)
    vi.advanceTimersByTime(64)
    expect(samples).toHaveLength(0)
    expect(handle.detach()).toBe(true)
    expect(samples.map((sample) => sample.state)).toEqual(['stopped'])
  })

  it('keeps audio receipts independent of a throwing mouth observer', () => {
    vi.useFakeTimers()
    const dom = installDomFakes()
    const events: MediaEvent[] = []
    const handle = createDomMediaDriver({
      onMouthPlayback: () => {
        throw new Error('observer failure')
      },
    }).create(command())
    handle.subscribe((event) => events.push(event))
    handle.load(new Blob([new Uint8Array([10])]))
    const element = dom.elements[0]
    if (element === undefined) return

    element.currentTime = 0.1
    dispatch(element, 'playing')
    element.currentTime = 0.2
    dispatch(element, 'ended')
    expect(events).toEqual([{ type: 'playing' }, { type: 'ended' }])
    expect(handle.detach()).toBe(true)
  })
})

describe('M1 player command binding', () => {
  it('passes the validated admitted command to a command-aware media driver', async () => {
    const createCalls: Array<PerformanceCommand | undefined> = []
    const listeners = new Set<(event: MediaEvent) => void>()
    const handle: MediaHandle = {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      load() {},
      play() {
        return Promise.resolve()
      },
      detach() {
        return true
      },
    }
    const controller = createPlaybackController({
      sessionId: SESSION_ID,
      initialEpoch: 0,
      resolver: {
        resolve() {
          return Promise.resolve({
            blob: new Blob([new Uint8Array([11])]),
            release() {},
          })
        },
      },
      media: {
        create(admitted?: PerformanceCommand) {
          createCalls.push(admitted)
          return handle
        },
      },
      receipts: createTestReceiptTools('envelope'),
      onReceipt: () => {},
      reportFault: () => {},
    })

    const execution = controller.execute(command(), {
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => {
      expect(createCalls).toHaveLength(1)
    })
    expect(createCalls[0]).toEqual(command())

    for (const listener of [...listeners]) listener({ type: 'playing' })
    for (const listener of [...listeners]) listener({ type: 'ended' })
    await expect(execution).resolves.toMatchObject({ stage: 'completed', outputId: OUTPUT_A })
    controller.dispose()
  })
})
