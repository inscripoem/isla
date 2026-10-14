import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Demo-local Vite configuration. It sets this directory as the root and allows
 * Vite to serve the repository's browser-safe source imports from outside the
 * root. The root tooling configuration is intentionally untouched.
 */
const demoRoot = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  root: demoRoot,
  server: {
    host: '127.0.0.1',
    fs: {
      allow: [repoRoot],
    },
  },
})
