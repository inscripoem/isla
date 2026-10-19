/**
 * Node-only M1-02 Kokoro provider over the real pinned `kokoro-js` /
 * `@huggingface/transformers` SDK.
 *
 * This module is deliberately not part of the browser graph: it imports Node
 * builtins for the bundled Node voice path and loads the SDK only when the real
 * loader runs. Injecting an alternate {@link KokoroSdkLoader} keeps the offline
 * tests deterministic and SDK-free, so `test:m1` never initializes a model or
 * downloads assets. The default loader lazily imports the same resolved SDK
 * instances the composition pins.
 *
 * Loading is a single explicit initialization boundary: the environment is
 * configured once with explicit local paths and `local_files_only`, and the
 * provider is long-lived. `generate` forwards the exact configured text and
 * voice/speed to `KokoroTTS.generate`, whose RawAudio `audio`/`sampling_rate`
 * fields map to the existing {@link KokoroRawAudio} `samples`/`sampleRate` seam.
 * The SDK does not accept an `AbortSignal` and this provider makes no claim that
 * inference stops.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { KokoroProvider, KokoroProviderInput, KokoroRawAudio } from './kokoro-types'
import {
  createGuardedTokenizer,
  type KokoroCallableTokenizer,
} from './kokoro-guard'

/**
 * The verified fixed-model token ceiling for the pinned 512-context Kokoro
 * model. This is an independent literal, not an alias of the guard's default, so
 * a future change to that default cannot silently raise the ceiling a trusted
 * configuration was validated against. A deliberate lower limit is allowed but
 * a larger one is rejected before any load.
 */
export const VERIFIED_MODEL_MAX_TOKENS = 512

/**
 * A plain bundled Node voice basename such as `af_heart`: lowercase letters, a
 * single separator underscore and lowercase letters/digits. This rejects path
 * separators, drive letters, traversal (`..`), dots and NUL before any
 * filesystem lookup, so a configured id can never name an arbitrary path.
 */
const SUPPORTED_NODE_VOICE_PATTERN = /^[a-z]+_[a-z0-9_]+$/

export function isSupportedNodeVoiceId(voiceId: unknown): voiceId is string {
  return typeof voiceId === 'string' && SUPPORTED_NODE_VOICE_PATTERN.test(voiceId)
}

/** Documented `RawAudio` shape returned by the real SDK `generate`. */
export interface KokoroRawAudioLike {
  readonly audio: Float32Array
  readonly sampling_rate: number
}

/** The fixed documented `KokoroTTS.generate` surface this provider calls. */
export interface KokoroTtsLike {
  generate(text: string, options: { voice: string; speed: number }): Promise<KokoroRawAudioLike>
}

/** Explicit local environment paths for the single initialization boundary. */
export interface KokoroEnvironmentConfig {
  readonly localModelPath: string
  readonly cacheDir: string
}

/** Configuration for one long-lived provider instance. */
export interface KokoroProviderConfig {
  /** Local model root: the pinned revision directory, or a repo id under a cache. */
  readonly modelRoot: string
  readonly revision: string
  readonly maxTokens: number
  readonly voiceId: string
  readonly speed: number
  readonly environment: KokoroEnvironmentConfig
}

/**
 * Seam over the real SDK. The default implementation is the only one that
 * imports `kokoro-js` / `@huggingface/transformers`; tests inject deterministic
 * small callable and model controls instead.
 */
export interface KokoroSdkLoader {
  configureEnvironment(config: KokoroProviderConfig): Promise<void> | void
  loadTokenizer(config: KokoroProviderConfig): Promise<KokoroCallableTokenizer>
  loadModel(config: KokoroProviderConfig): Promise<unknown>
  createTts(model: unknown, tokenizer: KokoroCallableTokenizer): KokoroTtsLike
  /** Throw when `voiceId` is not a bundled, supported Node voice. */
  ensureVoice(voiceId: string): void
}

/** Map the real SDK RawAudio fields onto the existing raw-audio seam. */
export function toKokoroRawAudio(raw: unknown): KokoroRawAudio {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('m1-kokoro-provider: RawAudio is not an object')
  }
  const audio = (raw as { audio?: unknown }).audio
  const samplingRate = (raw as { sampling_rate?: unknown }).sampling_rate
  if (!(audio instanceof Float32Array)) {
    throw new Error('m1-kokoro-provider: RawAudio.audio must be a Float32Array')
  }
  if (typeof samplingRate !== 'number' || !Number.isFinite(samplingRate) || samplingRate <= 0) {
    throw new Error('m1-kokoro-provider: RawAudio.sampling_rate must be a finite positive number')
  }
  return { samples: new Float32Array(audio), sampleRate: samplingRate }
}

/** The bundled Node voice path: `<kokoro-js dist>/../voices/<voiceId>.bin`. */
function resolveKokoroVoicePath(voiceId: string): string {
  const require = createRequire(import.meta.url)
  const distEntry = require.resolve('kokoro-js')
  return join(dirname(distEntry), '..', 'voices', `${voiceId}.bin`)
}

/**
 * The default {@link KokoroSdkLoader}: real ESM `kokoro-js` and the same
 * resolved `@huggingface/transformers@3.5.1` instance. The SDK is imported on
 * first use so ordinary module import and `test:m1` stay inert.
 */
export function createRealKokoroSdkLoader(): KokoroSdkLoader {
  // The synchronous `KokoroTTS` constructor is resolved during the awaited
  // environment boundary so `createTts` needs no per-call dynamic lookup.
  let kokoroTtsCtor: (new (model: unknown, tokenizer: unknown) => unknown) | null = null
  return {
    async configureEnvironment(config) {
      const [{ env }, kokoro] = await Promise.all([
        import('@huggingface/transformers'),
        import('kokoro-js'),
      ])
      env.allowRemoteModels = false
      env.allowLocalModels = true
      env.localModelPath = config.environment.localModelPath
      env.cacheDir = config.environment.cacheDir
      env.useFSCache = true
      env.useBrowserCache = false
      env.useCustomCache = false
      kokoroTtsCtor = kokoro.KokoroTTS as new (model: unknown, tokenizer: unknown) => unknown
    },
    async loadTokenizer(config) {
      const { AutoTokenizer } = await import('@huggingface/transformers')
      const tokenizer = await AutoTokenizer.from_pretrained(config.modelRoot, {
        local_files_only: true,
        cache_dir: config.environment.cacheDir,
        revision: config.revision,
      })
      return tokenizer as unknown as KokoroCallableTokenizer
    },
    async loadModel(config) {
      const { StyleTextToSpeech2Model } = await import('@huggingface/transformers')
      return StyleTextToSpeech2Model.from_pretrained(config.modelRoot, {
        dtype: 'q8',
        device: 'cpu',
        local_files_only: true,
        cache_dir: config.environment.cacheDir,
        revision: config.revision,
      })
    },
    createTts(model, tokenizer) {
      if (kokoroTtsCtor === null) {
        throw new Error('m1-kokoro-provider: environment must be configured before TTS construction')
      }
      return new kokoroTtsCtor(model, tokenizer) as unknown as KokoroTtsLike
    },
    ensureVoice(voiceId) {
      if (!isSupportedNodeVoiceId(voiceId)) {
        throw new Error(`m1-kokoro-provider: unsupported Node voice: ${String(voiceId)}`)
      }
      if (!existsSync(resolveKokoroVoicePath(voiceId))) {
        throw new Error(`m1-kokoro-provider: unsupported Node voice: ${voiceId}`)
      }
    },
  }
}

/**
 * Validate and freeze one provider configuration before any asynchronous work.
 *
 * Exported so the worker host can snapshot and validate exactly the same
 * configuration it forwards to the worker without loading the SDK on the main
 * thread. Every caller-owned scalar and the nested environment are copied
 * synchronously, before the first await, so a caller mutation during
 * configuration/loading cannot change the revision or paths that are loaded and
 * cannot raise the token ceiling that was validated here.
 */
export function snapshotKokoroProviderConfig(config: KokoroProviderConfig): KokoroProviderConfig {
  if (config === null || typeof config !== 'object') {
    throw new Error('m1-kokoro-provider: invalid configuration')
  }
  if (
    config.environment === null ||
    typeof config.environment !== 'object' ||
    typeof config.environment.localModelPath !== 'string' ||
    typeof config.environment.cacheDir !== 'string'
  ) {
    throw new Error('m1-kokoro-provider: environment paths are required')
  }

  const snapshot: KokoroProviderConfig = Object.freeze({
    modelRoot: config.modelRoot,
    revision: config.revision,
    maxTokens: config.maxTokens,
    voiceId: config.voiceId,
    speed: config.speed,
    environment: Object.freeze({
      localModelPath: config.environment.localModelPath,
      cacheDir: config.environment.cacheDir,
    }),
  })
  if (typeof snapshot.modelRoot !== 'string' || snapshot.modelRoot.length === 0) {
    throw new Error('m1-kokoro-provider: modelRoot must be a nonempty string')
  }
  if (typeof snapshot.revision !== 'string' || snapshot.revision.length === 0) {
    throw new Error('m1-kokoro-provider: revision must be a nonempty string')
  }
  if (!Number.isInteger(snapshot.maxTokens) || snapshot.maxTokens <= 0) {
    throw new Error('m1-kokoro-provider: maxTokens must be a positive integer')
  }
  if (snapshot.maxTokens > VERIFIED_MODEL_MAX_TOKENS) {
    throw new Error(
      `m1-kokoro-provider: maxTokens must not exceed the verified model ceiling of ${VERIFIED_MODEL_MAX_TOKENS}`,
    )
  }
  if (typeof snapshot.voiceId !== 'string' || snapshot.voiceId.length === 0) {
    throw new Error('m1-kokoro-provider: voiceId must be a nonempty string')
  }
  if (typeof snapshot.speed !== 'number' || !Number.isFinite(snapshot.speed) || snapshot.speed <= 0) {
    throw new Error('m1-kokoro-provider: speed must be a finite positive number')
  }
  return snapshot
}

/**
 * Create and initialize one long-lived real Node provider. The voice is
 * validated against the loader's supported voices and the whole initialization
 * runs once; no download or model initialization happens on module import.
 */
export async function createKokoroProvider(
  config: KokoroProviderConfig,
  loader: KokoroSdkLoader = createRealKokoroSdkLoader(),
): Promise<KokoroProvider> {
  const snapshot = snapshotKokoroProviderConfig(config)

  loader.ensureVoice(snapshot.voiceId)
  await loader.configureEnvironment(snapshot)
  const tokenizer = await loader.loadTokenizer(snapshot)
  const guardedTokenizer = createGuardedTokenizer(tokenizer, snapshot.maxTokens)
  const model = await loader.loadModel(snapshot)
  const tts = loader.createTts(model, guardedTokenizer)

  return {
    async generate(input: KokoroProviderInput): Promise<KokoroRawAudio> {
      if (input === null || typeof input !== 'object') {
        throw new Error('m1-kokoro-provider: malformed provider input')
      }
      if (typeof input.text !== 'string' || input.text.length === 0) {
        throw new Error('m1-kokoro-provider: text must be a nonempty string')
      }
      if (typeof input.voiceId !== 'string' || input.voiceId.length === 0) {
        throw new Error('m1-kokoro-provider: voice id must be a nonempty string')
      }
      if (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed <= 0) {
        throw new Error('m1-kokoro-provider: speed must be a finite positive number')
      }
      loader.ensureVoice(input.voiceId)
      const raw = await tts.generate(input.text, { voice: input.voiceId, speed: input.speed })
      return toKokoroRawAudio(raw)
    },
  }
}
