/**
 * M6 storage — public surface.
 *
 * Re-exports the four storage ports implemented in this directory
 * (`EventStorePort`, `MemoryProjectionPort`, `ReplayReaderPort`,
 * `HistoryQueryPort`) plus the persistence backend seam (FR-06).
 */
export * from './backend'
export * from './event-store'
export * from './history-query'
export * from './in-memory-backend'
export * from './memory-projection'
export * from './payload'
export * from './recovery-view'
export * from './replay-reader'
