import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/*
 * Live suite for provider-dependent tests. It is intentionally NOT part of the
 * offline gate: the root `vitest.config.ts` includes only `test/offline/**`, so
 * `pnpm test` never collects anything from this directory. This config is
 * opt-in:
 *
 *   pnpm exec vitest run --config test/live/vitest.config.ts
 *
 * Vitest resolves the include globs against its root, which defaults to the
 * process working directory - the repository root, where the offline suites
 * live. Pinning `root` to this file's directory keeps the glob scoped to the
 * live tests beside it and unable to reach into test/offline.
 */
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // Live providers are remote services: one call can legitimately take
    // longer than the offline 10 s budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
