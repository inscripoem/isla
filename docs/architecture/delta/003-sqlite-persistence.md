# Delta Specification 003 — SQLite persistence and migrations

Status: under review (M6). Date: 2026-10-14. ADR: ADR-003. Requirements: FR-06.
Invariants: INV-09, INV-10. Cases: C-26, C-27. Revision type: ADD (new capability).

## OBSOLETED

None. This change adds a new capability; it does not remove prior behaviour.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| `resolveStorageConfig` | `src/storage/config.ts` | composition root / tests |
| `openDatabase` | `src/storage/sqlite/database.ts` | B2 backend / tests |
| `migrate`, `readSchemaVersion`, `LATEST_SCHEMA_VERSION` | `src/storage/sqlite/migrations.ts` | composition root / tests |
| node-only barrel | `src/storage/sqlite/index.ts` | tests / composition |
| B1 tests | `test/offline/m6-sqlite.test.ts` | `test:m6` |

## MODIFIED

| Item | Change |
| --- | --- |
| `package.json` | `test:m6` now also runs `m6-sqlite.test.ts` |
| `src/storage/sqlite/migrations.ts` | migration 2: add `segment_index`, `persona_profile_id`, `persona_profile_version` to `deliveries` (legacy `NULL`; re-runnable) |
| `src/storage/sqlite/codec.ts`, `backend.ts` | map the three attribution fields on insert and read |
| `docs/architecture/{invariants,trace-matrix}.md`, `docs/req/{requirements,trace.en}.yaml`/`.md`, `docs/team/REQUIREMENTS.en.md` | M6 invariants renumbered `INV-09..13 -> INV-10..14` (M5 keeps `INV-09`) |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged |
| `src/storage/{backend,event-store,in-memory-backend,history-query,memory-projection,replay-reader}.ts` | In-memory slice frozen; SQLite plugs in behind `StorageBackend` |
| `src/storage/index.ts` | Main barrel stays free of Node/database imports |
| Other modules (`src/runtime`, `src/console`, ...) | Other owners; untouched |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts`.
Tier 2 regression: `pnpm test` (all prior suites).
Tier 3 behavioral: pending.
Original scope: sub-issue #10 (B1). No production behaviour changed; new capability added.
