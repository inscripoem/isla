# Trace matrix

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
M5 coordination pending. Date: 2026-10-12.

Every requirement maps to its enforcing component, interface, test/evidence and runtime monitor.

| Requirement | Consequence | Enforcing component | Interface | Case | Test / evidence | Runtime monitor | ADR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FR-06 | Durable, ordered, replayable records; delivery + supporting event commit atomically | `src/storage/event-store.ts` | `EventStorePort` | C-17, C-19 | `test/conformance/storage.conformance.ts` (`atomic-commits-both`, `read-ordered`, `export-matches`) | `failed` acks (`storage_unavailable`) | ADR-001 | in review |
| FR-06 | Confirmed history excludes partial/unspoken records | `src/storage/history-query.ts` | `HistoryQueryPort` | C-17, C-21 | storage conformance `history-fully-delivered-only`; `m6-storage.test.ts` (confirmed-history tests) | count of `fully-delivered` | — | in review |
| FR-06 | JSONL export carries event version attribution (`versions`) | `src/storage/event-store.ts` (`exportJsonl`) | `EventStorePort` | C-22 | `test/offline/m6-storage.test.ts` (version attribution) | — | — | in review |
| FR-06 / C-12 | Replay never mutates live state and calls no live provider | `src/storage/replay-reader.ts` | `ReplayReaderPort` | C-12 | `m6-storage.test.ts` (replay-isolation test) | — | — | in review |
| INV-04 | Event identity is session-scoped; identity and session sequence are unique within a session | `src/storage/event-store.ts` + `backend.ts` | `StorageBackend` | C-18, C-23 | `m6-storage.test.ts`; conformance `append-seq-unique`, `append-session-scoped-identity` | `conflict` acks | ADR-002 | in review |
| INV-05 | A delivery and its supporting event commit together or not at all | `src/storage/backend.ts` (`commit`) + `event-store.ts` | `StorageBackend` | C-19 | `m6-storage.test.ts::INV-05`; conformance `atomic-no-partial-mutation` | `storage_unavailable` acks | ADR-001 | in review |
| INV-06 | A memory projection never advances across a gap | `src/storage/memory-projection.ts` | `MemoryProjectionPort` | C-20 | `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim` | `appliedSeq` | — | in review |
| INV-07 | Committed records are isolated from caller mutation | `src/storage/in-memory-backend.ts` | `StorageBackend` | C-24 | `m6-storage.test.ts` (isolation tests) | — | ADR-002 | in review |

Other requirements (FR-01..FR-05, NFR-01..NFR-06) remain governed by `docs/req/trace.en.md` and are
pending their owners' rows here.
