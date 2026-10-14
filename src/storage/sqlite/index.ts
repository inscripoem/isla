/**
 * M6 storage — SQLite (node-only) surface (B1/B2).
 *
 * Node-only: imports `node:sqlite`/`node:fs`. Kept out of `src/storage/index.ts`
 * so the main storage barrel stays free of Node/database imports; composition
 * roots and tests import this module directly.
 */
export * from '../config'
export * from './backend'
export * from './codec'
export * from './database'
export * from './migrations'
