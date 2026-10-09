import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/offline/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
