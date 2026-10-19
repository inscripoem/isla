import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Demo-local Vite configuration. It sets this directory as the root, applies the
 * React JSX transform and allows Vite to serve the repository's browser-safe
 * source imports from outside the root. The root tooling configuration is
 * intentionally untouched.
 */
const demoRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const LOOP_RUNTIME_ORIGIN = 'http://127.0.0.1:4317'

export default defineConfig({
  plugins: [react()],
  root: demoRoot,
  server: {
    host: '127.0.0.1',
    fs: {
      allow: [repoRoot],
    },
    // The I1 loop page proxies the application socket and the operator
    // bootstrap to the demo runtime. The M1-only page ignores these.
    proxy: {
      '/app': { target: LOOP_RUNTIME_ORIGIN, ws: true },
      '/operator': { target: LOOP_RUNTIME_ORIGIN },
      '/health': { target: LOOP_RUNTIME_ORIGIN },
    },
  },
})
