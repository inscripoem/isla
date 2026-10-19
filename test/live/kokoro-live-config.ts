/**
 * Shared constants and path helpers for the M1-02 Kokoro live setup/smoke
 * entrypoints. These are explicit, local-only public-asset experiments: every
 * cached model and generated WAV stays under the checkout's ignored `.cache`
 * subtree. The checkout root is derived from this module's own URL rather than
 * hardcoding a machine-specific drive, so no absolute workspace path is tracked
 * in source. Nothing here runs under `pnpm test`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIVE_DIR = dirname(fileURLToPath(import.meta.url))

/** Repository checkout root, derived from `test/live/` without hardcoding. */
export const WORKSPACE_ROOT = resolve(LIVE_DIR, '..', '..')
export const MODELS_ROOT = join(WORKSPACE_ROOT, '.cache', 'models')
/** SDK download cache (the SDK's own repoId/revision FileCache lives here). */
export const KOKORO_CACHE_DIR = join(MODELS_ROOT, 'kokoro-cache')
/** Generated WAV output directory. */
export const AUDIO_DIR = join(WORKSPACE_ROOT, '.cache', 'audio')

/** Pinned public model repository and revision for both setup and smoke. */
export const REPO_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const REPO_BASENAME = 'Kokoro-82M-v1.0-ONNX'
export const REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'

/**
 * An explicit, revision-specific, deliberately unpopulated local fallback root.
 * It must not contain a hand-staged flat model: the pinned FileCache under
 * {@link KOKORO_CACHE_DIR} satisfies required reads, and a missing required
 * asset fails honestly in local-only mode.
 */
export const KOKORO_LOCAL_FALLBACK_ROOT = join(MODELS_ROOT, 'kokoro-local-fallback', REVISION)

/** Advertised q8 ONNX facts to verify against, not assumed local facts. */
export const EXPECTED_Q8_SHA256 = 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'
export const EXPECTED_Q8_BYTES = 92361116

/** Guard limit and the smoke fixture voice/speed (not a product decision). */
export const MAX_TOKENS = 512
export const VOICE_ID = 'af_heart'
export const SPEED = 1

/**
 * The single source-verified q8 ONNX cache path: the SDK's revision-addressed
 * FileCache key for the pinned repo/revision/filename. Derived from the
 * controlled literal pieces, never from a directory listing.
 */
export function q8OnnxPath(): string {
  return join(KOKORO_CACHE_DIR, 'onnx-community', REPO_BASENAME, REVISION, 'onnx', 'model_quantized.onnx')
}

/** Render a Windows path with forward slashes for stable JSON evidence. */
export function displayPath(path: string): string {
  return path.replaceAll('\\', '/')
}
