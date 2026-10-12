# Delta Specification 001 — Storage backend injection

Status: under review (M6). Date: 2026-10-12. ADR: ADR-001. Requirements: FR-06.
Invariants: INV-04, INV-05, INV-06. Revision type: ADD-R (structure passed, one governance defect fixed).

Change tracking for the architecture, per the visibility playbook. Exactly four lists.

## OBSOLETED

| Item | Old location |
| --- | --- |
| `EventStoreOptions` fault hooks (`beforeAppend`, `beforeCommit`) | `src/storage/event-store.ts` |
| Failure injection through the production factory | `src/storage/event-store.ts` |

Zero imports of the removed options remain.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| `StorageBackend` interface, `StorageMutation`, `deliveryKey` | `src/storage/backend.ts` | `event-store.ts`, `in-memory-backend.ts` |
| `createInMemoryBackend` | `src/storage/in-memory-backend.ts` | `event-store.ts` (default), `index.ts`, test adapter |
| Failing-backend test adapter | `test/offline/m6-storage.test.ts` | that test only |

Callers match the declaration (no other module imports these).

## MODIFIED

| Item | Change |
| --- | --- |
| `src/storage/event-store.ts` | Store logic now reads/writes through `StorageBackend`; factory takes a backend; behaviour unchanged |
| `src/storage/index.ts` | Exports the backend seam |
| `test/offline/m6-storage.test.ts` | Fault injection moved into the test adapter |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged by this revision |
| Other modules (`src/runtime`, `src/console`, ...) | Another owner's work; untouched |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts` (no fault flags in
`src/`). Tier 2 regression: `pnpm test` (all prior suites). Tier 3 behavioral: pending.
Original failing condition: a fault-injection control exposed as production API (READINESS-KITS:26).
