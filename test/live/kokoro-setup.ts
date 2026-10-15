/**
 * Explicit, separate acquisition step for the pinned Kokoro model.
 *
 * This is the only entrypoint allowed to reach the network. It uses the normal
 * SDK loaders (`AutoTokenizer` / `StyleTextToSpeech2Model`) with the pinned
 * public repo id, revision and q8 dtype so the SDK's own revision-addressed
 * FileCache acquires every auxiliary asset itself. It then verifies exactly one
 * known-safe binary path by size and SHA-256; it never walks, lists or copies
 * the model tree (which could touch protected-name assets). The later local-only
 * smoke never downloads and fails honestly on a missing asset.
 *
 * Run: pnpm exec tsx test/live/kokoro-setup.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { env, AutoTokenizer, StyleTextToSpeech2Model } from '@huggingface/transformers'
import {
  EXPECTED_Q8_BYTES,
  EXPECTED_Q8_SHA256,
  KOKORO_CACHE_DIR,
  KOKORO_LOCAL_FALLBACK_ROOT,
  REPO_ID,
  REVISION,
  displayPath,
  q8OnnxPath,
} from './kokoro-live-config'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function main(): Promise<void> {
  // The explicit acquisition boundary: the only place networking is permitted.
  env.allowRemoteModels = true
  env.allowLocalModels = true
  env.useFSCache = true
  env.useBrowserCache = false
  env.useCustomCache = false
  env.cacheDir = KOKORO_CACHE_DIR
  // The same explicit revision-specific unpopulated local root the offline
  // loader uses, so an unversioned default local directory cannot take priority
  // over the pinned FileCache during setup.
  env.localModelPath = KOKORO_LOCAL_FALLBACK_ROOT

  const loadOptions = { revision: REVISION, cache_dir: KOKORO_CACHE_DIR }
  await AutoTokenizer.from_pretrained(REPO_ID, loadOptions)
  const model = await StyleTextToSpeech2Model.from_pretrained(REPO_ID, {
    dtype: 'q8',
    device: 'cpu',
    ...loadOptions,
  })

  try {
    const onnxPath = q8OnnxPath()
    if (!existsSync(onnxPath)) {
      throw new Error(`m1-kokoro-setup: cached q8 model was not produced: ${displayPath(onnxPath)}`)
    }
    const bytes = statSync(onnxPath).size
    const sha256Hex = sha256(onnxPath)
    const matchesAdvertisedSize = bytes === EXPECTED_Q8_BYTES
    const matchesAdvertisedSha256 = sha256Hex === EXPECTED_Q8_SHA256

    const report: Record<string, unknown> = {
      step: 'kokoro-setup',
      repoId: REPO_ID,
      revision: REVISION,
      dtype: 'q8',
      device: 'cpu',
      cacheDir: displayPath(KOKORO_CACHE_DIR),
      q8Onnx: {
        path: displayPath(onnxPath),
        bytes,
        sha256: sha256Hex,
        matchesAdvertisedSize,
        matchesAdvertisedSha256,
      },
    }
    console.log(JSON.stringify(report, null, 2))

    if (!matchesAdvertisedSize || !matchesAdvertisedSha256) {
      throw new Error('m1-kokoro-setup: cached q8 model does not match the advertised size/SHA-256')
    }
  } finally {
    // Release the loaded model's initialization resources through its public
    // API after verification, including on a verification failure.
    await model.dispose()
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ step: 'kokoro-setup', ok: false, error: String(error) }))
  process.exitCode = 1
})
