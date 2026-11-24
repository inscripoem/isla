import type { RendererDriver } from '../../src/performance/mapped-renderer'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import type { ProductionDeployment, ProductionDeploymentContext } from '../../src/runtime/production'
import type {
  ReferenceLiveFactories,
  ReferenceRendererHandle,
} from '../../src/runtime/deployments/reference-live'
import { buildReferenceDeployment } from '../../src/runtime/deployments/reference-live'
import { parseReferenceLiveConfig } from '../../src/runtime/deployments/reference-live-config'
import { createCatalogDialogueTextSource } from './m4-kit'

/**
 * Test-only deployment for the console voice-selection browser acceptance.
 *
 * It is loaded by `src/runtime/production-cli.ts` through
 * `ISLA_DEPLOYMENT_MODULE`, never imported by production code. The default
 * reference deployment remains in charge of synthesis, the audio registry,
 * storage, session identity and profile wiring; only the two peers that would
 * otherwise need a live text provider or VTube Studio are replaced:
 *
 * - the dialogue text source emits the deterministic M1 catalog lines;
 * - the renderer reports a local acceptance and never claims avatar completion.
 *
 * Real Kokoro still performs synthesis from the local-only model directory, the
 * browser still plays the resulting WAV through the product player, and the
 * runtime still persists through the configured SQLite database. The resolved
 * database path is passed to the reference deployment, so the adopted voice
 * sidecar (`<database>.voices.json`) persists across a real restart that uses
 * the same ISLA_STORAGE_DB_PATH. The VTS and text-provider environment values
 * are parse-only here: the reference config parser requires them, but the
 * substituted peers never use them.
 */

const RENDERER_ID = 'console-voice-selection-test-renderer'
const RENDERER_CHARACTER_ID = 'console-voice-selection-test-character'

function createLocalRendererDriver(): RendererDriver {
  return {
    async dispatch(_driverAction, _signal) {
      return { stage: 'accepted', reasonCode: 'local-test-acceptance', localTimeMs: null }
    },
  }
}

export async function createProductionDeployment(
  context: ProductionDeploymentContext,
): Promise<ProductionDeployment> {
  const config = parseReferenceLiveConfig(context.env)
  let receiptCounter = 0

  const factories: ReferenceLiveFactories = {
    createTextSource: () => createCatalogDialogueTextSource(),
    createRenderer: ({ gate, mappings }): ReferenceRendererHandle => {
      const renderer = createMappedRenderer({
        snapshot: {
          rendererId: RENDERER_ID,
          characterId: RENDERER_CHARACTER_ID,
          capabilityRevision: 1,
          actions: mappings.map((mapping) => ({
            actionId: mapping.actionId,
            description: `${mapping.actionId} local acceptance`,
            observability: 'acceptance-only' as const,
            parameterBounds: [],
          })),
        },
        bindings: mappings.map((mapping) => ({
          actionId: mapping.actionId,
          driverAction: mapping.actionId,
        })),
        driver: createLocalRendererDriver(),
        deadlineGate: gate,
        receipts: {
          newReceiptId: () => `voice-selection-avatar-${(receiptCounter += 1)}`,
          localNowMs: () => null,
        },
      })
      return { renderer, dispose() {} }
    },
  }

  return buildReferenceDeployment(config, factories, context.clock, context.databasePath)
}

export default createProductionDeployment
