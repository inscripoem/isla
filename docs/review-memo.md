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

## PR #26 — M6-01 B1–B3 SQLite persistence, migrations, backend and restart recovery

- Date: 2026-10-16 · Reviewer: M5 (`inscripoem`) · Verdict: **APPROVED** (after changes)
- Earlier verdict: **CHANGES REQUIRED** (2026-10-14) — the pre-migration backup copied the `.db` after a
  discarded `wal_checkpoint`, so with a concurrent reader the copy was truncated while `backedUp: true` was
  reported (BUG-005).
- Re-review: the backup is a consistent `VACUUM INTO` snapshot with a pinned-WAL-reader regression, and the
  migration fails closed if the snapshot cannot be produced. Independent macOS checks: 567 tests, typecheck,
  lint and build.
- Recorded follow-up: **C-49/C-50 to M4, C-51 to M6** remain a coordinated registry/test/trace change.

## PR #27 — M6-01 R3 gate tooling

- Date: 2026-10-16 · Reviewer: M5 (`inscripoem`) · Verdict: **CHANGES REQUIRED** at `92871c2`
- Findings and fixes: the frozen check never received the diff (BUG-008); the acquisition was fail-open and
  word-split (BUG-009); the Owner column re-owned INV-01..03 (BUG-011); the G1 trigger excluded `labeled`; a
  stale test count. Fixed in `31700a5`, `a32cbec`, `c6508bf`, `4150b78`, plus the entry rule (`100bc9f`,
  `688e0c1`).
- Re-review requested at `688e0c1`.

## PR #32 — D3 structural constraints, id convention, governance index, MCP manifest

- Date: 2026-10-16 · Reviewer: M5 (`inscripoem`) · Verdict: **comments** — a recommendation, not adoption
- Points: owner-prefixed ids recommended for future allocations; include `INV-15` and keep the
  C-49/C-50/C-51 resolution explicit; name who reserves global ADR numbers and when the `AGENTS.md`
  instruction becomes operative; separate code present on a branch from protection enforced in CI; an empty
  `list_mcp_resources` cannot establish the absence of servers or tools.
- Fixes at `3c52788`: the MCP claim is scoped with the server/tool inventory recorded **unknown**, §3.5
  answers the ADR and adoption questions, §4 separates code from enforcement, `INV-15` added.

## M6 self-review — M6-01 coordinator/SQLite recovery test (on `m6-01-sqlite-app-recovery`)

- Date: 2026-10-19 · Reviewer: M6 (self) · Verdict: **OK for handoff with recorded debt**
- Spec alignment: covers M5's completed/interrupted/earlier-completed/empty matrix, SQLite close/reopen, preserved identities and evidence. Storage reopen is kept separate from application/process restart.
- Architecture alignment: M5 `createCoordinatorContractRunner` with explicit `RunnerDeps`; real SQLite event store/history/replay; controlled non-storage peers. The in-process projection is supplied but not consumed by the coordinator runner, so projection progress is not verified here; C-66 remains separate. No production code changed.
- Code/test quality: focused **3/3**, `test:m6` **99/7**, readiness **42/3**, trace **41/1**, full **812/47**, `pnpm verify` exit 0; mutation removing the `fully-delivered` filter turned two tests red and was restored; `git diff --check` clean.
- Operational metadata: branch `m6-01-sqlite-app-recovery`, base `main` `abb847c`; PR #47; M5 approved `a4af5e2`; the resolved merge head is pending M5 confirmation. C-68 is branch-local and not on `main`.
- Security/efficiency: temporary SQLite files only; no credentials, network or live provider.
- Recorded debt: AI-use `commits` remains empty; C-68 is M5-approved at `a4af5e2`; C-65/C-66/C-67 remain separate slices; C-48 traceability and the projection-scope fix remain separate. This test does not verify projection progress.
- Result: C-68 registered; FR-06, trace and INV-12 linked; #25 review requested with exact revision and evidence.

## M5 review — M6-01 coordinator/SQLite recovery test (on `m6-01-sqlite-app-recovery`)

- Date: 2026-10-19 · Reviewer: M5 (`inscripoem`) · Verdict: **APPROVED** at `a4af5e2`
- Scope: test-only C-68 storage-reopen proof. M5 confirmed the coordinator writes through the SQLite event store and fresh real history/recovery/replay ports read the reopened database; completed, interrupted, earlier-completed-segment and empty-history cases pass; identities, classifications and event evidence are preserved.
- Traceability: C-68 linked from FR-06 and INV-12; the suite is in `test:m6`.
- Independent verification: `pnpm verify` **812/47**, `test:m6` **99/7**, actual-range G6 passed on the exact head.
- Non-blocking clarification: the in-process projection is supplied but not consumed by `createCoordinatorContractRunner`; C-66 remains separate.
- Integration: main moved to `5dd5e79`; the merge conflict is confined to `docs/ai-use-log.yaml`, with both entry sets preserved. The resolved head requires M5 confirmation because approval covers `a4af5e2`.
- Limits: controlled-peer SQLite reopen only; not process-crash, live-provider, acoustic or S6 evidence.

## M6 self-review — M6-02 evaluation bench (PR #40, fixes applied)

- Date: 2026-10-19 · Reviewer: M6 (self) · Verdict: **fixes applied; M5 re-review pending**
- Scope: review fixes in `b2a6a56`, above `9e0bf81`, on `m6-02-bench`. No rebase and no force-push.
- Fixed: zero-attempt variants now report an unknown failure rate (`—`), not `0.0%`; blank not-run reasons are refused; INV-16 appears in both trace tables; `ATTEMPT_OUTCOMES` is no longer an external export; ADR-007/Delta-007 and the PR evidence are reconciled.
- Verification: focused bench suites **56 / 3**; `test:m6` **158 / 11**, composition **12 / 1**, readiness **42 / 3**, trace **41 / 1**, full **935 / 52**, `pnpm verify` exit 0 at the fix commit. Mutations: restoring `failureRate = 0` and removing the blank not-run reason check each turned the relevant tests red; both restored.
- Limits: no real provider, no evaluation table, G4 not run, no S6 claim. The zero-attempt/not-run regression is not yet registered as a case; M5 allocation is required. Branch protection remains absent.
- M5 approval at `0196c35` does not cover the fix head; re-review is requested.

## M6 self-review — M6-02 R1 recorded-run command

- Date: 2026-10-19 · Reviewer: M6 (self) · Verdict: **implementation complete; M5 review pending**
- Scope: `recorded-run.ts`, `report-command.ts`, the `evaluation:report` package script, the new R1 test and
  Delta/verification notes. No provider, runtime composition or evaluation table.
- Contract: versioned schema; unknown fields rejected; no trusted summary; report-level refusals preserved;
  atomic writer; refused input writes nothing.
- Verification: `test:m6` **167/12**, composition **12/1**, readiness **42/3**, trace **41/1**, full
  **944/53**, `pnpm verify` exit 0. Mutations: schema-version check removed and fixture refusal removed each
  turned tests red; restored.
- Traceability: NFR-01/NFR-04, INV-16, ADR-007/Delta-007, C-52…C-55. R1 has **no case ID yet**; M5 allocation
  is required. No new ID was self-assigned.
- Limits: no real provider run, no `evaluation-table.md`, G4 not run, no quality/latency/cost claim.
