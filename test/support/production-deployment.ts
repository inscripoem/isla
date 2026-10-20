import { createTestProductionDeployment } from './production-kit'

/**
 * Deployment module loaded by the production CLI in the smoke tests
 * (`ISLA_DEPLOYMENT_MODULE`). Test-only: production code never imports it; the
 * CLI loads it by path from the environment.
 */
export const createProductionDeployment = createTestProductionDeployment
export default createTestProductionDeployment
