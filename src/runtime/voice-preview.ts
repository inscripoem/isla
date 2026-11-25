/**
 * Fixed-sentence voice preview over the existing Kokoro provider and WAV
 * encoder.
 *
 * The preview service owns one caller-specified sentence and speed for its whole
 * lifetime. It performs no persistence and keeps no WAV bytes after a result is
 * returned. A single physical preview may be in flight; an identical voice
 * request joins that job, while a request for another voice is refused as
 * `busy` rather than starting a second generation. This is admission refusal,
 * not cancellation, and it does not claim to stop provider inference.
 */
import type { KokoroProvider, KokoroRawAudio } from '../performance/kokoro-types'
import { encodeMonoFloat32Wav } from '../performance/wav'

export type VoicePreviewFailureCode = 'busy' | 'invalid_audio' | 'invalid_voice'

/** Typed preview refusal. */
export class VoicePreviewError extends Error {
  readonly code: VoicePreviewFailureCode

  constructor(
    code: VoicePreviewFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'VoicePreviewError'
    this.code = code
  }
}

/** One encoded preview sample returned to the caller. */
export interface VoicePreviewSample {
  readonly voiceId: string
  readonly wav: Uint8Array
}

export interface VoicePreview {
  synthesize(voiceId: string): Promise<VoicePreviewSample>
}

export interface VoicePreviewOptions {
  readonly provider: KokoroProvider
  readonly text: string
  readonly speed: number
}

function encodePreview(voiceId: string, audio: KokoroRawAudio): VoicePreviewSample {
  if (!(audio.samples instanceof Float32Array) || audio.samples.length === 0) {
    throw new VoicePreviewError('invalid_audio', 'voice-preview: provider returned no samples')
  }
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new VoicePreviewError(
      'invalid_audio',
      'voice-preview: provider returned an invalid sample rate',
    )
  }
  for (let index = 0; index < audio.samples.length; index += 1) {
    if (!Number.isFinite(audio.samples[index])) {
      throw new VoicePreviewError(
        'invalid_audio',
        'voice-preview: provider returned a non-finite sample',
      )
    }
  }
  try {
    return Object.freeze({
      voiceId,
      wav: encodeMonoFloat32Wav(audio.samples, audio.sampleRate),
    })
  } catch (error) {
    throw new VoicePreviewError(
      'invalid_audio',
      'voice-preview: provider audio could not be encoded',
      { cause: error },
    )
  }
}

/**
 * Create one preview service. The factory validates its fixed configuration
 * synchronously; no provider work happens until `synthesize` is called.
 */
export function createVoicePreview(options: VoicePreviewOptions): VoicePreview {
  if (options === null || typeof options !== 'object') {
    throw new Error('voice-preview: options are required')
  }
  if (
    options.provider === null ||
    typeof options.provider !== 'object' ||
    typeof options.provider.generate !== 'function'
  ) {
    throw new Error('voice-preview: a provider with generate is required')
  }
  if (typeof options.text !== 'string' || options.text.length === 0) {
    throw new Error('voice-preview: fixed preview text is required')
  }
  if (
    typeof options.speed !== 'number' ||
    !Number.isFinite(options.speed) ||
    options.speed <= 0
  ) {
    throw new Error('voice-preview: speed must be a finite positive number')
  }

  const provider = options.provider
  const text = options.text
  const speed = options.speed
  let active: { voiceId: string; promise: Promise<VoicePreviewSample> } | null = null

  async function run(voiceId: string): Promise<VoicePreviewSample> {
    const audio = await provider.generate({ text, voiceId, speed })
    return encodePreview(voiceId, audio)
  }

  function synthesize(voiceId: string): Promise<VoicePreviewSample> {
    if (typeof voiceId !== 'string' || voiceId.length === 0) {
      return Promise.reject(
        new VoicePreviewError('invalid_voice', 'voice-preview: a voice id is required'),
      )
    }
    if (active !== null) {
      if (active.voiceId === voiceId) return active.promise
      return Promise.reject(
        new VoicePreviewError('busy', 'voice-preview: another preview is already running'),
      )
    }
    const promise = run(voiceId)
    const job = { voiceId, promise }
    active = job
    void promise.then(
      () => {
        if (active === job) active = null
      },
      () => {
        if (active === job) active = null
      },
    )
    return promise
  }

  return Object.freeze({ synthesize })
}
