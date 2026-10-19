# Verification constraints

Status: under review. Owned by M6. Date: 2026-10-12.

The rules the verification agent applies and the QA records the team maintains.

## Rules

1. Every fit criterion has at least one test.
2. Every invariant has at least one test that **fails when the invariant is violated**
   (a test that always passes proves nothing).
3. Every test references the requirement or invariant it verifies.
4. Every new round of work runs all previous rounds' test suites with **zero regressions**.

## Three-tier verification (gated; no skipping)

| Tier | Applies | Command / evidence |
| --- | --- | --- |
| 1 — Structural | imports, module boundaries, permissions, architectural fitness functions | `pnpm test:readiness` (`contracts`, `requirements`, `boundaries`); `pnpm lint`; `pnpm typecheck` |
| 2 — Regression | all prior suites pass | `pnpm test` (all offline suites) |
| 3 — Behavioral | quality thresholds (faithfulness/relevance; zero safety escapes) | pending (semantic eval; provider access required) — NFR-03 |

## Reviewer's five questions (author first, then reviewer)

These five checks are what a review actually looks for here. Each one caught a real defect in a change
that was already CI-green — every one of them in the **wiring or the claims**, not in the core logic,
which is exactly where the cheapest defects hide.

| # | Question | What it prevents |
| --- | --- | --- |
| 1 | **Does each gate actually run in CI?** Which command, with which inputs, on which events? | A gate that passes because it never received the input it needs to fail. A unit test of a pure function is not the pipeline. |
| 2 | **Does a failure go red?** No `\|\| true`, no swallowed error, no fallback that converts a broken check into a pass. | A fail-open check: an acquisition error silently yielding "no changes", and therefore a pass. |
| 3 | **Do the claims match the facts?** Do the description's counts and commands equal this head's actual run? Does a file's prose agree with its data? | A stale test count; a register whose header and `Owner` cells disagree. |
| 4 | **Does documented behaviour match the mechanism?** Is every promise in a document executable? | "CI re-runs when the label is added" set against a workflow trigger that does not include `labeled`. |
| 5 | **Did you run it yourself?** Frozen install, the role command and `verify`, plus each gate CLI with a valid, an invalid and an empty input. | Approving a number or a behaviour that was never observed. |

**Rule: the author runs all five before requesting review, and the reviewer repeats them. A review
confirms; it does not discover.**

## M6 coverage map (requirement/invariant → case → test)

| Invariant / requirement | Case | Test that would fail if violated |
| --- | --- | --- |
| INV-04 (session-scoped identity/sequence uniqueness) | C-18, C-23, C-39, C-40, C-41, C-43, C-44, C-51 | `m6-storage.test.ts`; conformance `append-duplicate`, `append-changed-content`, `append-seq-unique`, `append-session-scoped-identity`; conflicting commit reports `conflict` on both sides; canonical content equality (key order irrelevant, array order significant); a non-JSON payload is rejected with `unsupported_payload` (incl. sparse arrays) |
| INV-05 (atomic delivery + event) | C-19, C-38, C-42 | `m6-storage.test.ts::INV-05` (failed commit persists nothing; a later unpublishable mutation leaves no partial state); `m6-sqlite-backend.test.ts` (batch rollback); conformance `atomic-failure-reported`, `atomic-no-partial-mutation` |
| INV-06 (projection no gap / idempotent) | C-20 | `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim`, `projection-idempotent` |
| INV-07 (record isolation) | C-24, C-29 | `m6-storage.test.ts` (isolation tests); conformance `input-isolation`, `read-isolation` → runs over **both** in-memory and SQLite |
| INV-08 (history ordering) | C-25, C-29 | `m6-storage.test.ts` (ordering test); conformance `history-ordered` → over **both** backends |
| INV-09 (delivery attribution and consistent evidence) | C-46, C-47 | `m5-attribution.test.ts` (capture and persistence); conformance `delivery-invalid-combination:*`, `delivery-invalid-event:*`, `delivery-correlation:*`, `delivery-provenance:*`; negative adapters `createCombinationNormalizingEventStore`, `createProvenanceIgnoringEventStore` |
| INV-15 (M5 within-turn reconstruction) | C-47 | `m5-attribution.test.ts`, existing ordering regression: exact session/turn filtering, known indices ascending, unknowns last, stable ties, preserved nulls and unchanged input |
| INV-10 (config + schema version validated) | C-26, C-27 | `m6-sqlite.test.ts` (config + migrations) |
| INV-11 (migration recoverable) | C-27, C-28, C-48 | `m6-sqlite.test.ts` (backup before apply; rollback on failure; legacy attribution migrated/refused) |
| FR-06 (SQLite conformance) | C-29 | `m6-sqlite-backend.test.ts` (conformance suite over SQLite) |
| FR-06 (SQLite persistence/reopen) | C-30 | `m6-sqlite-backend.test.ts` (reopen + isolation) |
| FR-06 (delivery terminal outcome persisted) | C-31 | `m6-sqlite-backend.test.ts` (terminal outcome for recovery) |
| INV-12 (restart restores only confirmed history; no replay) | C-32, C-33 | `m6-recovery.test.ts` (recovery view; restart + isolation) |
| INV-13 (traceability chain machine-checked) | C-34, C-35, C-37 | `trace-fitness.test.ts` (valid repo → no violations; injected defect or missing owner → violation; a changed frozen path passes only on a verified default-branch restoration and fails for a content/mode change, deletion, not-frozen-at-baseline, or unavailable/non-ancestor baseline); `pnpm test:trace` |
| INV-14 (G6 AI-use log) | C-36 | `ai-use-log-gate.test.ts`; `pnpm gate:ai-use-log` over the PR diff |
| INV-16 (every executed attempt accounted for; missing usage unknown; empty failure rate unknown) | C-52, C-53, C-54, C-55 | `m6-02-metrics.test.ts` (failed/cancelled counted; incomplete usage unknown, never a partial total; an empty sample has no failure-rate claim); `m6-02-comparison.test.ts` (a thrown variant is a failure with a reason); `m6-02-report.test.ts` (a fixture source is refused; a zero-attempt variant prints `—`; a not-run entry without a reason is refused) |
| FR-06 (history excludes non-delivered) | C-17, C-21 | `m6-storage.test.ts` (confirmed-history tests); conformance `history-fully-delivered-only` |
| FR-06 (JSONL export carries `versions`) | C-22 | `m6-storage.test.ts` (version attribution) |
| FR-06 (in-memory vs SQLite agreement) | C-45 | `m6-sqlite-backend.test.ts` (cross-backend integration: state, export, history, payload rejection) |
| FR-06 / C-12 (replay isolation) | C-12 | `m6-storage.test.ts` (replay-isolation test) |

Generated and durability suites (same invariants, wider evidence):

- `test/offline/m6-storage-properties.test.ts` — INV-04/07/08 across many **seeded** operation
  sequences applied **out of sequence order**, so insertion order cannot stand in for the sequence; then
  the same sequence replayed over the in-memory and SQLite backends with identical export and history
  (generalising the single cross-backend case C-45). Runnable: `npx vitest run test/offline/m6-storage-properties.test.ts`.
- `test/offline/m6-durability.test.ts` — INV-12 / FR-06: recovery from a **crash-state copy** of the
  database files that carries a non-empty `-wal` (every committed row recovered, the schema version
  intact), and a committed row visible to a second handle **without a clean close**. Both suites are
  mutation-checked: dropping the `-wal` copy and letting arrival order stand in for `seq` each fail.
  Both run in `pnpm test:m6`.
  **Not covered:** an uncommitted WAL tail. SQLite keeps a small uncommitted transaction's dirty pages
  in the page cache and only writes frames at COMMIT or on a cache spill, so a one-row `BEGIN`/`INSERT`
  leaves the `-wal` byte-identical (review #42 verified the same size and SHA-256 on this
  fixture). Proving that case needs a cache-spill fixture or a killed subprocess; neither
  is asserted here.
- Case ids for these suites are **pending allocation** (see `structural-constraints.md` §3).

`docs/req/case-registry.yaml` links each implemented case to its verifier file and test string; the
readiness suite (`src/evaluation/requirements-registry.ts` via `test/offline/requirements.test.ts`)
rejects a missing file or absent test string.

## M6-02 evaluation report (S4)

- `test/offline/m6-02-report.test.ts` — the report refuses a fixture text source, latency from an injected
  clock (stage or total), zero attempts, a declared sample size that differs from the recorded attempts, a
  blank condition, an undeclared variant, a negative/non-finite duration or usage, a failed attempt with no
  reason, and an impossible calendar date. An unobserved stage prints `—`; usage stays `unknown`; table
  cells are escaped. `writeEvaluationReport` is the only writer and validates before touching the
  filesystem. Gate **G4** reads the generated table, and the table is **not** produced without provider
  access.

## Honest limitations

- Fixtures do not prove live providers, browser audio or durable SQLite recovery.
- Fault injection for storage failure is supplied by the **test adapter** (READINESS-KITS:26); the
  production API exposes no failure switch (ADR-001).
- Tier 3 behavioral thresholds and full-course gates remain pending.
