import type { MediaDriver, MediaHandle, MediaEvent } from '../performance/browser'
import { createDomMediaDriver } from '../performance/browser'

/**
 * Local voice-sample audition (TA-004).
 *
 * This is the browser side of the Voice card. It owns one media handle at a
 * time, decodes only the WAV bytes the server returned for one preview, and
 * fences every asynchronous step with a local generation. Stop, replacement,
 * disconnect, unmount or real playback can therefore invalidate a slow request
 * before it reaches the speakers.
 *
 * It never writes to session history, receipts or the console event log. A
 * prepared sample is kept only in memory so a second explicit operator click can
 * satisfy the browser's user-gesture requirement after `play()` is blocked.
 */

export type VoiceAuditionPhase =
  | 'idle'
  | 'preparing'
  | 'playing'
  | 'blocked'
  | 'ended'
  | 'error'

export interface VoiceAuditionView {
  readonly phase: VoiceAuditionPhase
  readonly detail: string | null
  readonly voiceId: string | null
  readonly hasPreparedSample: boolean
}

export const IDLE_VOICE_AUDITION: VoiceAuditionView = {
  phase: 'idle',
  detail: null,
  voiceId: null,
  hasPreparedSample: false,
}

export interface VoiceAudition {
  /** Decode and start one sample returned for the current preview request. */
  playSample(voiceId: string, wavBase64: string): void
  /** Retry the prepared sample after an autoplay rejection. */
  replayPrepared(): void
  /** Stop a request or playback and release the prepared sample. */
  stop(detail?: string): void
  dispose(): void
  view(): VoiceAuditionView
}

export interface VoiceAuditionOptions {
  readonly media?: MediaDriver
  readonly onStatus?: (view: VoiceAuditionView) => void
  readonly decodeBase64?: (value: string) => Blob
}

function decodeWaveBase64(value: string): Blob {
  if (value.length === 0) throw new Error('the sample contained no audio data')
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name
  }
  return typeof error === 'string' && error.length > 0 ? error : 'unknown playback error'
}

function isNotAllowed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NotAllowedError'
  )
}

export function createVoiceAudition(options: VoiceAuditionOptions = {}): VoiceAudition {
  const media = options.media ?? createDomMediaDriver()
  const decodeBase64 = options.decodeBase64 ?? decodeWaveBase64
  let current: VoiceAuditionView = IDLE_VOICE_AUDITION
  let generation = 0
  let handle: MediaHandle | null = null
  let unsubscribe: (() => void) | null = null
  let prepared: { readonly voiceId: string; readonly blob: Blob } | null = null

  const emit = (next: VoiceAuditionView): void => {
    current = next
    try {
      options.onStatus?.(next)
    } catch {
      // A status consumer must not disturb local playback.
    }
  }

  const detach = (): void => {
    if (unsubscribe !== null) {
      unsubscribe()
      unsubscribe = null
    }
    if (handle !== null) {
      handle.detach()
      handle = null
    }
  }

  const fail = (token: number, error: unknown): void => {
    if (generation !== token) return
    detach()
    prepared = null
    emit({
      phase: 'error',
      detail: `Preview playback failed: ${describe(error)}`,
      voiceId: null,
      hasPreparedSample: false,
    })
  }

  const ended = (token: number): void => {
    if (generation !== token) return
    detach()
    prepared = null
    emit({
      phase: 'ended',
      detail: 'Preview ended.',
      voiceId: null,
      hasPreparedSample: false,
    })
  }

  const blocked = (token: number, voiceId: string): void => {
    if (generation !== token) return
    detach()
    emit({
      phase: 'blocked',
      detail: 'The browser blocked automatic sample playback. Click Preview voice again to play it.',
      voiceId,
      hasPreparedSample: true,
    })
  }

  const start = (voiceId: string, blob: Blob): void => {
    generation += 1
    const token = generation
    detach()
    prepared = { voiceId, blob }
    emit({
      phase: 'preparing',
      detail: null,
      voiceId,
      hasPreparedSample: true,
    })
    if (generation !== token) return

    let nextHandle: MediaHandle
    try {
      nextHandle = media.create()
    } catch (error) {
      fail(token, error)
      return
    }
    handle = nextHandle
    unsubscribe = nextHandle.subscribe((event: MediaEvent) => {
      if (generation !== token) return
      if (event.type === 'playing') {
        emit({ phase: 'playing', detail: null, voiceId, hasPreparedSample: true })
        return
      }
      if (event.type === 'ended') {
        ended(token)
        return
      }
      fail(token, new Error(event.reasonCode))
    })
    // A synchronous terminal event during subscribe already settled this
    // attempt; never continue loading or playing after it.
    if (generation !== token || handle !== nextHandle) return

    try {
      nextHandle.load(blob)
    } catch (error) {
      fail(token, error)
      return
    }
    if (generation !== token || handle !== nextHandle) return

    let playPromise: Promise<void>
    try {
      playPromise = nextHandle.play()
    } catch (error) {
      if (isNotAllowed(error)) blocked(token, voiceId)
      else fail(token, error)
      return
    }
    Promise.resolve(playPromise).catch((error: unknown) => {
      if (generation !== token || handle !== nextHandle) return
      if (isNotAllowed(error)) blocked(token, voiceId)
      else fail(token, error)
    })
  }

  const playSample = (voiceId: string, wavBase64: string): void => {
    let blob: Blob
    try {
      blob = decodeBase64(wavBase64)
    } catch (error) {
      generation += 1
      detach()
      prepared = null
      emit({
        phase: 'error',
        detail: `Preview audio could not be decoded: ${describe(error)}`,
        voiceId: null,
        hasPreparedSample: false,
      })
      return
    }
    start(voiceId, blob)
  }

  const replayPrepared = (): void => {
    const ready = prepared
    if (ready === null) {
      emit({
        phase: 'error',
        detail: 'No prepared sample is available. Request a preview again.',
        voiceId: null,
        hasPreparedSample: false,
      })
      return
    }
    start(ready.voiceId, ready.blob)
  }

  const stop = (detail = 'Preview stopped.'): void => {
    generation += 1
    detach()
    prepared = null
    emit({
      phase: 'idle',
      detail,
      voiceId: null,
      hasPreparedSample: false,
    })
  }

  return {
    playSample,
    replayPrepared,
    stop,
    dispose() {
      generation += 1
      detach()
      prepared = null
      current = IDLE_VOICE_AUDITION
    },
    view: () => current,
  }
}
