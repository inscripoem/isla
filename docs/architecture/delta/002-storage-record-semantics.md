# Delta Specification 002 — Storage record semantics

Status: under review (M6). Date: 2026-10-13. ADR: ADR-002. Requirements: FR-06.
Invariants: INV-04, INV-05, INV-07, INV-08; C-66 amendment: INV-06. Cases: C-19, C-23, C-24, C-25, C-38, C-39, C-40, C-41, C-43, C-44; C-66 amendment: C-20, C-66. The C-66 amendment leaves the frozen ports unchanged.
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
| Conflict-cause report on both acknowledgements (`conflict` vs `storage_unavailable`) | `src/storage/event-store.ts` | runtime-policy catalog |
| Conflict-cause regression | `test/offline/m6-storage.test.ts` | M6 test |
| Canonical content equality + payload contract (`jsonValueIssue`, `canonicalJson`) | `src/storage/payload.ts` | `event-store.ts`; ADR-002 D1 |
| Payload-contract regressions (unsupported payload rejected; sparse array not conflated with `[]`) | `test/offline/m6-storage.test.ts` | M6 test |

## MODIFIED

| Item | Change |
| --- | --- |
| `src/storage/backend.ts` | contract: `commit` must complete fallible preparation of the whole batch before publishing any mutation (INV-05/D4) |
| `src/storage/in-memory-backend.ts` | key by `sessionId:eventId`; copy on write/read; `commit` prepares the whole batch, then publishes |
| `src/storage/event-store.ts` | pass `sessionId` to `eventById`; delivery mutation carries `eventSeq`; a failed atomic commit reports the actual cause (`conflict` / `unsupported_payload` / `storage_unavailable`) on both sides; validates the payload (JSON-value contract) before publication; content equality via `canonicalJson` (key order irrelevant, array order significant) |
| `src/storage/history-query.ts` | takes the backend; filters + sorts by `eventSeq` |
| `test/support/correct-ports.ts` | session-scoped event identity (reference matches C7) |
| `test/offline/m6-storage.test.ts` | cross-session, isolation, ordering, batch-atomicity and payload-contract regressions |
| `docs/architecture/{option-ledger,memory-design}.md` | record the rejected "keep patching the serializer" option (OL-005) and the JSON-payload write rule |
| `docs/team/REQUIREMENTS.en.md` | INV-04 row: canonical equality + JSON payload contract |
| M6 invariant renumbering | `INV-09..13 -> INV-10..14` (M5 keeps `INV-09` for delivery attribution): config `INV-10`, migration `INV-11`, recovery `INV-12`, trace-gate `INV-13`, log-gate `INV-14` — registries, traces, ADR/delta updated together |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged by the original revision and by C-66 |
| Other modules (`src/runtime`, `src/console`, ...) | Other owners; untouched |
| `EventStorePort`, `HistoryQueryPort` | Public port signatures unchanged |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts`.
Tier 2 regression: `pnpm test` (all prior suites).
Tier 3 behavioral: pending. Original findings: PR #9 review items 1–3, plus the follow-up
batch-atomicity finding (INV-05 / D4 / C-38).

## C-66 amendment — session-scoped projection bookmark (2026-10-20, under review)

| Item | Change |
| --- | --- |
| `src/storage/memory-projection.ts` | one `appliedSeq` per session internally; `apply` returns that session’s position; gap/idempotence rules remain per session |
| `src/contracts/app/ports.ts` | unchanged; frozen public `MemoryProjectionPort` signature preserved |
| `test/support/{correct,faulty}-ports.ts` | fixtures carry per-session state; the faulty fixture remains deliberately non-idempotent/gap-claiming |
| `test/offline/m6-storage.test.ts` | C-66 independent-session regression; existing INV-06 regression retained |
| `test/offline/m6-recovery.test.ts` | reads the bookmark for its known session |
| Traceability | C-66 registered; INV-06, FR-06 and trace rows updated |

FROZEN: `MemoryProjectionPort`, `EventStorePort`, `HistoryQueryPort` and M5 sequence authority. This amendment does not
introduce a production caller or a dependency.

Verification: focused `m6-storage.test.ts` **64/64** and `m6-recovery.test.ts` **4/4**; role/full/
verify results are recorded in the handoff. A session-blind mutation is the required negative control.
