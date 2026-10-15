# ADR-003 — SQLite persistence and schema migrations

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-14 · Owner: M6 · Requirements: FR-06 · Invariants: INV-10, INV-11 · Cases: C-26, C-27.
Relates to: ADR-001 (persistence seam), ADR-002 (record semantics). Revision type: ADD (new capability).

## Context

B1 (sub-issue #10): the in-memory slice is proven; the storage layer now needs durable SQLite. The
`StorageBackend` seam (ADR-001/ADR-002) already defines the store contract, so B1 adds the database
handle, the configuration and a schema-migration runner. The blueprint states SQLite owns persistent
records; the database stays outside OneDrive; the schema version is independent of the application
contract version (`0.2`) and the diagnostic protocol version (1).

## Decisions

### D1 — SQLite via `node:sqlite`, configured fail-fast
- `openDatabase` uses `DatabaseSync`; pragmas `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout`.
- `resolveStorageConfig`: `ISLA_STORAGE_DB_PATH` override; default `.cache/isla/isla.db` (ignored local
  storage, outside OneDrive); an **empty override is rejected** (never a silent default).
- Enabled by `INV-09` (config/version); verified by `C-26`.

### D2 — `schema_version` table + migration runner
- A single-row `schema_version` table, separate from contract/protocol versions.
- **Migration 2 (#22 attribution).** Adds `segment_index`, `persona_profile_id` and
  `persona_profile_version` to `deliveries`; genuine legacy unknowns stay `NULL` (never inferred). The
  migration is guarded by a `PRAGMA table_info` introspection so it is safe to re-run.
- `migrate`: reject an **unsupported (newer)** version; **back up** an existing database before
  applying pending migrations; apply each migration in a transaction with **rollback** on failure;
  **idempotent** when already current.
- Enabled by `INV-10`; verified by `C-27`.

## Alternatives considered

1. **`PRAGMA user_version`** instead of a table — rejected (less explicit, harder to audit/back up).
2. **Full JSON blob per event** — rejected (weak uniqueness/indexing); scalar columns + JSON for
   `payload`/`versions` chosen.
3. **No persistence (file JSONL only)** — rejected (JSONL is export/replay, not the authoritative store).

## Consequences

- Durable, versioned store with auditable backups; the store stays database-agnostic (B2 implements
  `StorageBackend` over this schema).
- `persona_version` and `terminal_outcome` columns are created now (M4 interop, `facts/08`).

## Design process (ADD)

1. **Review inputs** — FR-06; blueprint (SQLite owns persistent records); AGENTS.md (DB outside OneDrive).
2. **Select drivers** — durability, recoverability, replaceable persistence.
3. **Decompose** — database handle vs configuration vs migration runner.
4. **Choose concepts** — port/adapter (backend), Information Hiding (config), versioned schema.
5. **Instantiate** — `config.ts`, `sqlite/{database,migrations,index}.ts`.
6. **Record** — this ADR + trace rows + INV-09/10 + C-26/27 + Delta-003.
7. **Evaluate** — 3-tier verify (structural → regression → behavioral).

## Re-open triggers

- A different driver is adopted (e.g. `better-sqlite3`) or the `node:sqlite` API changes.
- A migration cannot be expressed idempotently or atomically.

## References

- `src/storage/config.ts`, `src/storage/sqlite/{database,migrations,index}.ts`
- `test/offline/m6-sqlite.test.ts`; `docs/architecture/{invariants,trace-matrix,memory-design,runtime-policy-catalog}.md`
- Blueprint; `M6_KB/sqlite-b1-design.md`
