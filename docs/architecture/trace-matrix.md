# Trace matrix

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
Step A coordination under review. Updated: 2026-10-15.

Every requirement maps to its enforcing component, interface, test/evidence and runtime monitor.

| Requirement | Consequence | Enforcing component | Interface | Case | Test / evidence | Runtime monitor | ADR | Status | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FR-06 | Durable, ordered, replayable records; delivery + supporting event commit atomically | `src/storage/event-store.ts` | `EventStorePort` | C-17, C-19 | `test/conformance/storage.conformance.ts` (`atomic-commits-both`, `read-ordered`, `export-matches`) | `failed` acks (`storage_unavailable`) | ADR-001 | in review | M6 |
| FR-06 | Confirmed history excludes partial/unspoken records | `src/storage/history-query.ts` | `HistoryQueryPort` | C-17, C-21 | storage conformance `history-fully-delivered-only`; `m6-storage.test.ts` (confirmed-history tests) | count of `fully-delivered` | — | in review | M6 |
| FR-06 | JSONL export carries event version attribution (`versions`) | `src/storage/event-store.ts` (`exportJsonl`) | `EventStorePort` | C-22 | `test/offline/m6-storage.test.ts` (version attribution) | — | — | in review | M6 |
| FR-06 / C-12 | Replay never mutates live state and calls no live provider | `src/storage/replay-reader.ts` | `ReplayReaderPort` | C-12 | `m6-storage.test.ts` (replay-isolation test) | — | — | in review | M6 |
| INV-04 | Event identity is session-scoped; identity and session sequence are unique within a session; content equality is canonical (key order irrelevant, array order significant) and a payload must be a JSON value | `src/storage/event-store.ts` + `payload.ts` + `backend.ts` | `StorageBackend` | C-18, C-23, C-39, C-40, C-41, C-43, C-44, C-51 | `m6-storage.test.ts`; conformance `append-seq-unique`, `append-session-scoped-identity` | `conflict` / `unsupported_payload` acks | ADR-002 | in review | M6 |
| INV-05 | A delivery and its supporting event commit together or not at all; a failed commit leaves no partial state (in-memory prepares before publishing; SQLite applies one transaction + rollback) | `src/storage/backend.ts` (`commit`) + `event-store.ts` | `StorageBackend` | C-19, C-38, C-42 | `m6-storage.test.ts::INV-05` (failed commit persists nothing; a later unpublishable mutation leaves no partial state); `m6-sqlite-backend.test.ts` (batch rollback); conformance `atomic-no-partial-mutation` | `storage_unavailable` acks | ADR-001, ADR-002 | in review | M6 |
| INV-06 | A memory projection never advances across a gap | `src/storage/memory-projection.ts` | `MemoryProjectionPort` | C-20 | `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim` | `appliedSeq` | — | in review | M6 |
| INV-07 | Committed records are isolated from caller mutation | `src/storage/in-memory-backend.ts` | `StorageBackend` | C-24 | `m6-storage.test.ts` (isolation tests) | — | ADR-002 | in review | M6 |
| INV-08 | Confirmed history is ordered by the supporting event seq | `src/storage/history-query.ts` | `HistoryQueryPort` | C-25 | `m6-storage.test.ts` (ordering test) | — | ADR-002 | in review | M6 |
| INV-09 / FR-06 | Original index/persona survive delivery and history reads | `coordinator.ts`, `storage.ts`, `event-store.ts` | C6/C7 | C-46, C-47 | `m5-attribution.test.ts` (production M5 + in-memory M6) | delivery conflict acknowledgement | ADR-002 Step A amendment | under review | M6 |
| INV-10 | Storage configuration and schema version are validated before use | `src/storage/config.ts`, `src/storage/sqlite/migrations.ts` | `StorageConfig` / migrations | C-26, C-27 | `m6-sqlite.test.ts` (config + migrations) | — | ADR-003 | in review | M6 |
| INV-11 | A schema migration is recoverable (backup before apply; rollback) | `src/storage/sqlite/migrations.ts` | migrations | C-27, C-28, C-48 | `m6-sqlite.test.ts` (backup + rollback; legacy attribution) | — | ADR-003 | in review | M6 |
| FR-06 | Durable SQLite persistence with the same store contract | `src/storage/sqlite/backend.ts` | `StorageBackend` | C-29 | `m6-sqlite-backend.test.ts` (conformance over SQLite) | — | ADR-004 | in review | M6 |
| FR-06 | Committed data survives reopen (session isolation, ordered history) | `src/storage/sqlite/backend.ts` | `EventStorePort` | C-30 | `m6-sqlite-backend.test.ts` (reopen/isolation) | — | ADR-004 | in review | M6 |
| FR-06 | Delivery terminal outcome persisted for recovery | `src/storage/sqlite/backend.ts` | `StorageBackend` | C-31 | `m6-sqlite-backend.test.ts` (terminal outcome) | — | ADR-004 | in review | M6 |
| FR-06 | In-memory and SQLite backends agree end-to-end (committed state, export, history, payload rejection) | `src/storage/sqlite/backend.ts` + `in-memory-backend.ts` | `StorageBackend` | C-45 | `m6-sqlite-backend.test.ts` (cross-backend integration) | — | ADR-004 | in review | M6 |
| INV-12 | Restart restores only confirmed history; unresolved stays unknown, no replay | `src/storage/recovery-view.ts` | `RecoveryView` (M6 helper) | C-32, C-33 | `m6-recovery.test.ts` | — | ADR-005 | in review | M6 |
| INV-13 | The traceability chain is machine-checked; a broken link fails the gate | `src/evaluation/trace-fitness.ts` | `collectTraceViolations` | C-34, C-35 | `trace-fitness.test.ts` | — | ADR-006 | in review | M6 |
| INV-14 | A code/prompt change updates the AI-use log (gate G6) | `src/evaluation/ai-use-log-gate.ts` | `collectAiUseLogViolations` | C-36 | `ai-use-log-gate.test.ts` | — | ADR-006 | in review | M6 |

Other requirements (FR-01..FR-05, NFR-01..NFR-06) remain governed by `docs/req/trace.en.md` and are
pending their owners' rows here.
