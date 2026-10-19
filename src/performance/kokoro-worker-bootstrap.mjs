/**
 * M1-02 Kokoro worker bootstrap.
 *
 * The project runs TypeScript through the `tsx` development runtime. Node cannot
 * import the TypeScript worker entry directly, so this explicit `.mjs` entry
 * registers the documented `tsx/esm/api` loader inside the worker and only then
 * imports the real TypeScript worker. It is created with an explicit file URL
 * and `execArgv: []` by the host so a parent tsx/pnpm process cannot silently
 * preload its hooks a second time.
 *
 * The registration is intentionally left active for the worker's lifetime: the
 * worker resolves its SDK imports lazily during initialization. This is a
 * development/demo runtime dependency; production packaging and dependency
 * approval remain an M5/M6 decision.
 */
import { register } from 'tsx/esm/api'

// A worker-entry marker so importing the TypeScript worker in any other worker
// thread (for example the test runner's own pool) stays inert.
globalThis.__islaKokoroWorker = true

register()
await import('./kokoro-worker.ts')
