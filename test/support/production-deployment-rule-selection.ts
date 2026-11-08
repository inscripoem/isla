import { createRuleReactionPort, createRuleSelectionPort } from '../../src/decision'
import type { ProductionDeployment, ProductionDeploymentContext } from '../../src/runtime/production'
import { createTestProductionDeployment } from './production-kit'

/**
 * Explicitly selected test-only deployment entry that uses M3's real rule
 * selection and reaction ports over the existing controlled production
 * deployment.
 *
 * It composes `createTestProductionDeployment` — the same controlled deployment
 * the CLI loads from `test/support/production-deployment.ts` — and replaces only
 * `peers.selection` and `peers.reaction`. Every other peer, factory, option and
 * the optional deployment-owned `release` stay exactly as the base deployment
 * built them, so a later audio integration that supplies `audioResources` or
 * `createSynthesis` remains independent of this file. The base deployment keeps
 * its fixture ports; this module is the explicit override.
 *
 * Both rule ports are bound to the deployment's own runtime clock. The CLI
 * passes that one clock instance to the deployment factory and to
 * `createProductionApplication`, and the coordinator builds selection and
 * reaction deadlines from it, so a live rule call is never compared against a
 * second clock domain. A mismatched clock is not intrinsically detected: the
 * ports compare the request deadline against whatever clock they were given, so
 * a foreign origin can make an otherwise live call look expired (timing out the
 * turn or the reaction) or make an expired one look live. Binding to the
 * deployment clock is what keeps those comparisons meaningful.
 *
 * Test-only: production code never imports this module; it is loaded by path
 * through `ISLA_DEPLOYMENT_MODULE`.
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
      reaction: createRuleReactionPort({ clock: context.clock }),
    },
  }
}

export default createProductionDeployment
