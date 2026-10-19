/**
 * Private M1-02 synthesis interfaces for a Kokoro-compatible raw-audio provider.
 *
 * These declarations are an M1-proposed composition seam for M5 review. They are
 * deliberately narrower than any SDK: a provider returns its actual Promise of
 * raw mono samples and a sample rate. There is no fictitious SDK `AbortSignal`
 * parameter and the provider contract makes no claim that inference stops.
 */

import type { SynthesisPort } from '../contracts/app'

/** Raw mono audio returned by a provider, copied and validated by the adapter. */
export interface KokoroRawAudio {
  readonly samples: Float32Array
  readonly sampleRate: number
}

/** The exact configured request forwarded to the provider for one text. */
export interface KokoroProviderInput {
  readonly text: string
  readonly voiceId: string
  readonly speed: number
}

/** Provider refusals the adapter can map without guessing. */
export type KokoroProviderFailureCode = 'input_too_long'

/**
 * A provider-declared failure. A guarded facade must raise `input_too_long`
 * before physical inference rather than silently truncating the input. This
 * adapter forwards such a refusal; it does not implement tokenizer-length or
 * SDK truncation checks itself.
 */
export class KokoroProviderError extends Error {
  readonly code: KokoroProviderFailureCode

  constructor(code: KokoroProviderFailureCode) {
    super(`m1-kokoro-provider: ${code}`)
    this.name = 'KokoroProviderError'
    this.code = code
  }
}

/**
 * Injected raw-audio provider. `generate` must either resolve with complete
 * audio for the exact text or reject with {@link KokoroProviderError} carrying
 * `input_too_long` before running physical inference. It must not accept a
 * fictitious abort signal and must not claim to stop inference. The returned
 * Promise represents the real in-flight generation that occupies the adapter's
 * single slot until it settles.
 *
 * The provider is a long-lived dependency. Composition retains exactly one
 * `SynthesisPort` adapter per provider and reuses it; the returned Promise is the
 * physical settlement signal, which the adapter exposes only through its private
 * {@link KokoroSynthesis.whenIdle} observation, so an adapter-level `busy` result
 * or a logical abort does not prove that this generation finished. See the
 * performance README for the composition and replacement sequence.
 */
export interface KokoroProvider {
  generate(input: KokoroProviderInput): Promise<KokoroRawAudio>
}

/**
 * A configured voice profile mapping an exact public voice profile id/version
 * to the private provider voice id and a positive finite speed. Nothing is
 * selected from audience text or environment files by this adapter.
 */
export interface KokoroVoiceProfile {
  readonly voiceProfileId: string
  readonly voiceProfileVersion: string
  readonly providerVoiceId: string
  readonly speed: number
}

/**
 * The M1-only adapter returned by `createKokoroSynthesis`: the unchanged
 * {@link SynthesisPort} plus one private, composition-only observation.
 *
 * `whenIdle()` observes the physical provider settlement of the generation that
 * is active when it is called. It resolves when that generation's original
 * provider Promise settles — fulfillment or rejection — and resolves promptly
 * when no generation is active at call time. It never rejects with the
 * generation's failure, and each generation owns an independent observation, so
 * an earlier settlement never releases a later wait and a distinct later
 * generation gets its own pending observation.
 *
 * This is deliberately not a global mutex, queue, cancellation API or general
 * lifecycle framework. It does not lock admission, does not prove that a
 * registry or playback resource was cleaned up, and is not a substitute for the
 * owner's own replacement sequence. See the performance README.
 */
export interface KokoroSynthesis extends SynthesisPort {
  whenIdle(): Promise<void>
}
