import { createRuleSelectionPort } from '../../src/decision'
import type { ProductionDeployment, ProductionDeploymentContext } from '../../src/runtime/production'
import { createTestProductionDeployment } from './production-kit'

/**
 * Explicitly selected test-only deployment entry that uses M3's real rule
 * selection port over the existing controlled production deployment.
 *
 * It composes `createTestProductionDeployment` — the same controlled deployment
 * the CLI loads from `test/support/production-deployment.ts` — and replaces only
 * `peers.selection`. Every other peer, factory, option and the optional
 * deployment-owned `release` stay exactly as the base deployment built them, so
 * a later audio integration that supplies `audioResources` or `createSynthesis`
 * remains independent of this file.
 *
 * The rule port is bound to the deployment's own runtime clock. The CLI passes
 * that one clock instance to the deployment factory and to
 * `createProductionApplication`, and the coordinator builds selection deadlines
 * from it, so a live rule call is never compared against a second clock domain.
 * Supplying any other clock here makes the port reject its own deadline and the
 * turn falls back to the M5 plan rather than recording an M3 decision.
 *
 * `ReactionPort` remains the base deployment's explicit fixture substitute until
 * M3 delivers its rule reaction (#89). Test-only: production code never imports
 * this module; it is loaded by path through `ISLA_DEPLOYMENT_MODULE`.
 */
export function createProductionDeployment(
  context: ProductionDeploymentContext,
): ProductionDeployment {
  const base = createTestProductionDeployment(context)
  return {
    ...base,
    peers: {
      ...base.peers,
      selection: createRuleSelectionPort({ clock: context.clock }),
    },
  }
}

export default createProductionDeployment
