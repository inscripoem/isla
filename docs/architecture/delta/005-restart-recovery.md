# Delta Specification 005 — Restart and recovery semantics

Status: under review (M6). Date: 2026-10-14. ADR: ADR-005. Requirements: FR-06.
Invariants: INV-11. Cases: C-32, C-33. Revision type: ADD.

## OBSOLETED

None.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| `createRecoveryView`, `RecoveryView` | `src/storage/recovery-view.ts` | tests / composition (M5) |
| `StoredDelivery.terminalOutcome` (read-back) | `src/storage/backend.ts` | recovery view, codecs |
| B3 tests | `test/offline/m6-recovery.test.ts` | `test:m6` |

## MODIFIED

| Item | Change |
| --- | --- |
| `src/storage/in-memory-backend.ts` | carries `terminalOutcome` on the stored delivery |
| `src/storage/sqlite/codec.ts` | `rowToDelivery` reads `terminal_outcome` |
| `src/storage/index.ts` | exports the recovery view |
| `package.json` | `test:m6` runs the B3 test (M5-owned manifest — flag) |
| `test/offline/m6-storage.test.ts` | faulty-history fixture supplies the new field |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged |
| `src/storage/sqlite/migrations.ts` schema | B1 schema unchanged |
| Store behaviour (`event-store`, `history-query`) | Unchanged; recovery is an added read |
| Other modules (`src/runtime`, `src/console`, ...) | Other owners; untouched |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts`.
Tier 2 regression: `pnpm test` (all prior suites).
Tier 3 behavioral: pending. Scope: sub-issue #12 (B3).
