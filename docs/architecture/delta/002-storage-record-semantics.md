# Delta Specification 002 — Storage record semantics

Status: under review (M6). Date: 2026-10-13. ADR: ADR-002. Requirements: FR-06.
Invariants: INV-04, INV-05, INV-07, INV-08. Cases: C-19, C-23, C-24, C-25, C-38.
Revision type: ADD-R (PR #9 review; structure passed, contract semantics corrected).

## OBSOLETED

| Item | Old location |
| --- | --- |
| Global event lookup `eventById(eventId)` | `src/storage/backend.ts` |
| `eventsById` keyed by `eventId` alone | `src/storage/in-memory-backend.ts` |
| `EventStore.deliveries` (unordered, mutable view) | `src/storage/event-store.ts` |
| `createHistoryQuery(deliveries)` (filter only) | `src/storage/history-query.ts` |

Zero imports of the old signatures remain.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| `eventById(sessionId, eventId)` | `src/storage/backend.ts` | `event-store.ts` |
| `storedDeliveries()` + `StoredDelivery` (`record`, `eventSeq`) | `src/storage/backend.ts` | `history-query.ts`, tests |
| Deep-copy isolation boundary | `src/storage/in-memory-backend.ts` | backend reads/writes |
| Session-scoped identity conformance check | `test/conformance/storage.conformance.ts` | M6 test |
| Batch preparation before publication (`PreparedMutation`, `prepare`/`publish`) | `src/storage/in-memory-backend.ts` | `backend.ts` contract |
| Atomicity regression (later unpublishable mutation leaves no partial state) | `test/offline/m6-storage.test.ts` | M6 test |

## MODIFIED

| Item | Change |
| --- | --- |
| `src/storage/backend.ts` | contract: `commit` must complete fallible preparation of the whole batch before publishing any mutation (INV-05/D4) |
| `src/storage/in-memory-backend.ts` | key by `sessionId:eventId`; copy on write/read; `commit` prepares the whole batch, then publishes |
| `src/storage/event-store.ts` | pass `sessionId` to `eventById`; delivery mutation carries `eventSeq` |
| `src/storage/history-query.ts` | takes the backend; filters + sorts by `eventSeq` |
| `test/support/correct-ports.ts` | session-scoped event identity (reference matches C7) |
| `test/offline/m6-storage.test.ts` | cross-session, isolation, ordering and batch-atomicity regressions |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged by this revision |
| Other modules (`src/runtime`, `src/console`, ...) | Other owners; untouched |
| `EventStorePort`, `HistoryQueryPort` | Public port signatures unchanged |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts`.
Tier 2 regression: `pnpm test` (all prior suites).
Tier 3 behavioral: pending. Original findings: PR #9 review items 1–3, plus the follow-up
batch-atomicity finding (INV-05 / D4 / C-38).
