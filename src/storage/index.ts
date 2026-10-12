/**
 * M6 storage — public surface.
 *
 * Re-exports the four storage ports implemented in this directory:
 * `EventStorePort`, `MemoryProjectionPort`, `ReplayReaderPort` and
 * `HistoryQueryPort` (see src/contracts/app/ports.ts and FR-06).
 */
export * from './event-store'
export * from './history-query'
export * from './memory-projection'
export * from './replay-reader'
