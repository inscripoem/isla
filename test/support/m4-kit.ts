import type { AssembledDialogueContext, DialogueTextSource } from '../../src/dialogue'
import type { StorageBackend, StorageMutation } from '../../src/storage/backend'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import { M1_FIXTURE_SEGMENT_0_TEXT, M1_FIXTURE_SEGMENT_1_TEXT } from './m1-kit'

/**
 * Deterministic dialogue text source for the local completion demo and the
 * M4/M5/M1/M6 integration and loopback tests.
 *
 * The production M4 text source emits the resolved character's intent templates,
 * which are arbitrary text. M1's fixed synthesis, however, is keyed by the exact
 * `(text, voiceProfileId, voiceProfileVersion)` tuple, so arbitrary generated
 * text would not resolve to audio and would be paired with unrelated sound. This
 * substitute returns exactly the catalogued WAV text, so real M4
 * context/generation/memory runs against real M1 audio without inventing a
 * sentence that has no matching asset.
 *
 * It is a clearly labeled provider substitute, not a live-model claim, and is
 * never imported by production code.
 */
export const M4_CATALOG_TEXT_SOURCE_MODEL = 'dialogue-catalog-substitute'
export const M4_CATALOG_TEXT_SOURCE_MODEL_VERSION = 'm1-catalog-v1'

const CATALOG_LINES: readonly string[] = [
  M1_FIXTURE_SEGMENT_0_TEXT,
  M1_FIXTURE_SEGMENT_1_TEXT,
]

export function createCatalogDialogueTextSource(
  lines: readonly string[] = CATALOG_LINES,
): DialogueTextSource {
  return {
    model: M4_CATALOG_TEXT_SOURCE_MODEL,
    modelVersion: M4_CATALOG_TEXT_SOURCE_MODEL_VERSION,
    resolvedModel: null,
    async compose(_view, maxSegments) {
      return lines.slice(0, Math.max(0, maxSegments))
    },
  }
}

/**
 * The catalog text source that also records the assembled context it received,
 * so an integration test can observe what real M4 fed the provider without
 * changing the emitted catalog text.
 */
export function createCapturingCatalogDialogueTextSource(
  capture: { view: AssembledDialogueContext | null },
  lines: readonly string[] = CATALOG_LINES,
): DialogueTextSource {
  const base = createCatalogDialogueTextSource(lines)
  return {
    model: base.model,
    modelVersion: base.modelVersion,
    resolvedModel: base.resolvedModel,
    async compose(view, maxSegments) {
      capture.view = view
      return base.compose(view, maxSegments)
    },
  }
}

/**
 * An in-memory backend whose next atomic commit containing a delivery mutation
 * throws once. Used to prove that a failed M6 atomic commit never reaches M4
 * memory admission. Test-only; production exposes no failure switch.
 */
export function createDeliveryFailingBackend(): {
  backend: StorageBackend
  failNextDelivery: () => void
} {
  const base = createInMemoryBackend()
  let fail = false
  return {
    backend: {
      ...base,
      commit: (mutations: readonly StorageMutation[]) => {
        if (fail && mutations.some((mutation) => mutation.kind === 'delivery')) {
          fail = false
          throw new Error('simulated delivery commit failure')
        }
        base.commit(mutations)
      },
    },
    failNextDelivery: () => {
      fail = true
    },
  }
}
