/**
 * Test-only deterministic controls for the M1-02 Kokoro Node provider.
 *
 * These controls stand in for the real SDK: a small callable tokenizer that
 * returns documented-shape `input_ids` tensors and a controlled loader whose
 * `createTts` invokes the guard-wrapped tokenizer exactly as the real
 * `KokoroTTS.generate` path does. They exercise the actual guard, mapping and
 * provider assembly without importing or initializing the SDK. No hook here
 * reaches production code.
 */
import type {
  KokoroProviderConfig,
  KokoroRawAudioLike,
  KokoroSdkLoader,
  KokoroTtsLike,
} from '../../src/performance/kokoro-provider'
import type {
  KokoroCallableTokenizer,
  KokoroTokenizerEncoding,
} from '../../src/performance/kokoro-guard'

/** A documented-shape single-batch `input_ids` control. */
export function createTokenizerEncoding(
  sequenceLength: number,
  batch = 1,
): KokoroTokenizerEncoding {
  return { input_ids: { data: new Float32Array(sequenceLength * batch), dims: [batch, sequenceLength] } }
}

/** A tensor whose declared length disagrees with its data size. */
export function createMismatchedEncoding(): KokoroTokenizerEncoding {
  return { input_ids: { data: new Float32Array(3), dims: [1, 5] } }
}

/** A tensor with more than one batch. */
export function createMultiBatchEncoding(): KokoroTokenizerEncoding {
  return { input_ids: { data: new Float32Array(8), dims: [2, 4] } }
}

/** A rank-one tensor (no batch dimension). */
export function createRankOneEncoding(): KokoroTokenizerEncoding {
  return { input_ids: { data: new Float32Array(4), dims: [4] } }
}

export interface TokenizerCall {
  readonly text: string
  readonly options: Record<string, unknown>
}

export interface ControlledTokenizer {
  (text: string, options?: Record<string, unknown>): KokoroTokenizerEncoding
  calls(): TokenizerCall[]
  encoding(): KokoroTokenizerEncoding
  setEncoding(encoding: KokoroTokenizerEncoding): void
  setThrow(error: unknown): void
  clearThrow(): void
  readonly tag: string
}

/**
 * A callable tokenizer control that records the exact forwarded call. It mirrors
 * the real SDK boundary by returning its encoding synchronously (and throwing
 * synchronously) rather than resolving a Promise.
 */
export function createControlledTokenizer(initialLength = 4): ControlledTokenizer {
  const calls: TokenizerCall[] = []
  let current = createTokenizerEncoding(initialLength)
  let thrown: unknown = null
  const fn = (text: string, options?: Record<string, unknown>): KokoroTokenizerEncoding => {
    calls.push({ text, options: options === undefined ? {} : { ...options } })
    if (thrown !== null) throw thrown
    return current
  }
  const controlled = fn as ControlledTokenizer
  Object.assign(controlled, {
    tag: 'controlled-tokenizer',
    calls: () => calls.slice(),
    encoding: () => current,
    setEncoding: (encoding: KokoroTokenizerEncoding) => {
      current = encoding
    },
    setThrow: (error: unknown) => {
      thrown = error
    },
    clearThrow: () => {
      thrown = null
    },
  })
  return controlled
}

export interface ControlledSdk extends KokoroSdkLoader {
  readonly tokenizer: ControlledTokenizer
  configureCalls(): number
  modelCalls(): number
  ttsGenerateCalls(): number
  setRawAudio(raw: unknown): void
  setVoices(voices: readonly string[]): void
  configured(): KokoroProviderConfig | null
}

/** A controlled loader whose TTS path tokenizes first, then reaches the model. */
export function createControlledSdk(
  overrides: {
    voices?: readonly string[]
    rawAudio?: unknown
    tokenizer?: ControlledTokenizer
  } = {},
): ControlledSdk {
  const tokenizer = overrides.tokenizer ?? createControlledTokenizer()
  let voices = new Set(overrides.voices ?? ['af_heart'])
  let rawAudio: unknown = overrides.rawAudio ?? {
    audio: new Float32Array([0.25, -0.5, 0.75, 0]),
    sampling_rate: 24000,
  }
  let configureCount = 0
  let modelCount = 0
  let ttsCount = 0
  let configuredConfig: KokoroProviderConfig | null = null
  const modelValue = { kind: 'controlled-model' }

  return {
    tokenizer,
    configureCalls: () => configureCount,
    modelCalls: () => modelCount,
    ttsGenerateCalls: () => ttsCount,
    setRawAudio: (raw) => {
      rawAudio = raw
    },
    setVoices: (ids) => {
      voices = new Set(ids)
    },
    configured: () => configuredConfig,
    configureEnvironment(config) {
      configureCount += 1
      configuredConfig = config
    },
    loadTokenizer() {
      return Promise.resolve(tokenizer)
    },
    loadModel() {
      return Promise.resolve(modelValue)
    },
    createTts(_model: unknown, guarded: KokoroCallableTokenizer): KokoroTtsLike {
      return {
        generate(text, _options) {
          ttsCount += 1
          // Mirror the real SDK path exactly: the tokenizer is called and its
          // encoding destructured synchronously, so an over-limit guard refusal
          // propagates synchronously instead of a Promise the SDK never awaits.
          // The model is only reached when the guard accepts the encoding.
          guarded(text, { truncation: true, padding: true })
          modelCount += 1
          return Promise.resolve(rawAudio as KokoroRawAudioLike)
        },
      }
    },
    ensureVoice(voiceId) {
      if (!voices.has(voiceId)) {
        throw new Error(`m1-kokoro-sdk-kit: unsupported voice ${voiceId}`)
      }
    },
  }
}

export const KOKORO_SDK_TEST_CONFIG: KokoroProviderConfig = {
  modelRoot: 'test-model-root',
  revision: 'test-revision',
  maxTokens: 512,
  voiceId: 'af_heart',
  speed: 1,
  environment: { localModelPath: 'test-local-models', cacheDir: 'test-cache' },
}

export function kokoroSdkTestConfig(
  overrides: Partial<KokoroProviderConfig> = {},
): KokoroProviderConfig {
  return {
    ...KOKORO_SDK_TEST_CONFIG,
    ...overrides,
    environment: { ...KOKORO_SDK_TEST_CONFIG.environment, ...(overrides.environment ?? {}) },
  }
}
