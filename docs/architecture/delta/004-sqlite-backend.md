# Delta Specification 004 — SQLite backend

Status: under review (M6). Date: 2026-10-14. ADR: ADR-004. Requirements: FR-06.
Invariants: INV-05. Cases: C-29, C-30, C-42. Revision type: ADD (new capability).

## OBSOLETED

| Item | Old location |
| --- | --- |
| `deliveryByKey(key: string)` | `src/storage/backend.ts` (interface) |

Zero callers of the single-argument form remain.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| `createSqliteBackend` | `src/storage/sqlite/backend.ts` | tests / composition |
| row codecs (`eventToRow`, `rowToEvent`, `rowToDelivery`, `EventRow`, `DeliveryRow`) | `src/storage/sqlite/codec.ts` | `sqlite/backend.ts` |
| B2 tests | `test/offline/m6-sqlite-backend.test.ts` | `test:m6` |
| Batch-atomic rollback regression (C-42) | `test/offline/m6-sqlite-backend.test.ts` | `test:m6` |

## MODIFIED

| Item | Change |
| --- | --- |
| `src/storage/backend.ts` | `deliveryByKey` takes the composite parts; delivery mutation carries `terminalOutcome` |
| `src/storage/event-store.ts` | passes the composite parts and `terminalOutcome` |
| `src/storage/in-memory-backend.ts` | `deliveryByKey` implementation updated |
| `src/storage/sqlite/index.ts` | exports `backend` + `codec` |
| `package.json` | `test:m6` runs the B2 test (M5-owned manifest — flag) |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged |
| `src/storage/sqlite/migrations.ts` schema | B1 schema unchanged; B2 maps onto it |
| in-memory store behaviour | Unchanged; SQLite matches it |
| Other modules (`src/runtime`, `src/console`, ...) | Other owners; untouched |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts`.
Tier 2 regression: `pnpm test` (all prior suites), including the conformance suite over SQLite.
Tier 3 behavioral: pending. Scope: sub-issue #11 (B2).
