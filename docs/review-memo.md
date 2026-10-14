# Review memo

Status: under review. Owner: R3 / M6 tooling (D4). Every pull request reviewer adds an entry covering
**spec alignment**, **architecture alignment**, **code and test quality**, **operational metadata**,
with **security and efficiency** checked throughout, ending in a verdict: **APPROVE**,
**CHANGES REQUIRED**, or **REJECT**.

## PR #9 — M6-01 storage ports, backend seam and traceability artifacts

- Date: 2026-10-13 · Reviewer: M5 (`inscripoem`) · Verdict: **CHANGES REQUIRED**
- Spec alignment: the in-memory slice and the future SQLite backend are clearly separated; the storage
  ports match the candidate requirements (FR-06).
- Architecture alignment: the persistence seam matches ADR-001; the store is the sole SQL writer.
- Code/test quality: CI green, but three gaps against the contract — (1) **High** event identity must be
  session-scoped (`INTERFACES` C7); (2) **Medium** committed records must be isolated from caller
  mutation; (3) **Medium** `confirmedHistory` must order by the supporting event `seq`.
- Operational metadata: branch `m6-storage`, commit reviewed `6117997`; CI green at review time.
- Security/efficiency: no credentials or tokens; linear lookups noted as a scale concern.
- Response: all three addressed in `b4decf3` / `b5da14e` / `b52e12e` with ADR-002, Delta-002, cases
  C-23/24/25, and the shared fixture corrected. Re-review pending.

## M6 self-review — B1/B2/B3 (SQLite, on `m6-sqlite`)

- Date: 2026-10-14 · Reviewer: M6 (self) · Verdict: **CHANGES MADE (fixed before handoff)**
- Findings: WAL backup could miss `-wal` data (fixed — checkpoint first); per-migration transactions
  were not atomic as a unit (fixed — one transaction); the register was missing INV-01..03 and INV-11
  (found by the new fitness function; fixed).
- Result: ADR-003/004/005, Delta-003/004/005, INV-09/10/11, cases C-26..C-33.

## M6 self-review — R3 gate tooling (on `m6-r3-gates`)

- Date: 2026-10-14 · Reviewer: M6 (self) · Verdict: **OK for handoff**
- Findings: the fitness functions caught a real register gap (INV-12 unregistered) — fixed; G6 gate
  behaves correctly (exit 1 on violation, 0 when the log is updated).
- Result: ADR-006, Delta-006, INV-12/13, cases C-34/35/36.

## M6 self-review — owner indicators on shared tables (on `m6-r3-gates`)

- Date: 2026-10-14 · Reviewer: M6 (self) · Verdict: **OK for handoff**
- Trigger: cross-branch validation under review. Finding (**Medium**): the shared governed tables
  (`invariants.md`, `trace-matrix.md`) carried rows from several roles but **no owner indicator**, so
  classification during merge was manual.
- Fix: explicit **`Owner`** column on both tables; the trace fitness function now rejects a governed
  table without an Owner column or an empty owner per row; case **C-37**; INV-12 acceptance extended.
- Result: ADR-006 (D1 check 8), Delta-006, INV-12 + C-37. Verified: `test:trace` 9, `verify` 302.
