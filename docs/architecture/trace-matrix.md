# Trace matrix

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
M5 coordination pending. Date: 2026-10-12.

Every requirement maps to its enforcing component, interface, test/evidence and runtime monitor.

| Requirement | Consequence | Enforcing component | Interface | Case | Test / evidence | Runtime monitor | ADR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FR-06 | Durable, ordered, replayable records; delivery + supporting event commit atomically | `src/storage/event-store.ts` | `EventStorePort` | C-17, C-19 | `test/conformance/storage.conformance.ts` (`atomic-commits-both`, `read-ordered`, `export-matches`) | `failed` acks (`storage_unavailable`) | ADR-001 | in review |
| FR-06 | Confirmed history excludes partial/unspoken records | `src/storage/history-query.ts` | `HistoryQueryPort` | C-17 | `test/offline/m6-storage.test.ts` (confirmed-history tests) | count of `fully-delivered` | — | in review |
| FR-06 / C-12 | Replay never mutates live state and calls no live provider | `src/storage/replay-reader.ts` | `ReplayReaderPort` | C-12 | `m6-storage.test.ts` (replay-isolation test) | — | — | in review |
| INV-04 | Event identity and session sequence are unique | `src/storage/event-store.ts` + `backend.ts` | `StorageBackend` | C-18 | `m6-storage.test.ts::INV-04`; conformance `append-duplicate`, `append-seq-unique` | `conflict` acks | ADR-001 | in review |
| INV-05 | A delivery and its supporting event commit together or not at all | `src/storage/backend.ts` (`commit`) + `event-store.ts` | `StorageBackend` | C-19 | `m6-storage.test.ts::INV-05`; conformance `atomic-no-partial-mutation` | `storage_unavailable` acks | ADR-001 | in review |
| INV-06 | A memory projection never advances across a gap | `src/storage/memory-projection.ts` | `MemoryProjectionPort` | C-20 | `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim` | `appliedSeq` | — | in review |

Other requirements (FR-01..FR-05, NFR-01..NFR-06) remain governed by `docs/req/trace.en.md` and are
pending their owners' rows here.
