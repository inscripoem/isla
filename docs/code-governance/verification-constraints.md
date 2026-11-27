# Verification constraints

Status: under review. Owned by M6. Date: 2026-10-12; taxonomy, mutation rule and gate truth updated
2026-11-25; pull-request base acquisition updated 2026-11-27.

The rules the verification agent applies and the QA records the team maintains. The canonical
requirement-to-component-to-test-to-monitor map is
[`../architecture/trace-matrix.md`](../architecture/trace-matrix.md); this document states the rules
and the evidence tiers.

## Rules

1. Every **deterministic** fit criterion has at least one test. A **pending metric** has a row in
   [`../architecture/evaluation-thresholds.md`](../architecture/evaluation-thresholds.md) naming its
   statistic, comparison, verification method, owner and status. A pending metric is not a pass.
2. Every invariant has at least one test that **fails when the invariant is violated** (a test that
   always passes proves nothing). The current register has four system invariants: INV-01, INV-02,
   INV-03 and INV-12.
3. Every test references the requirement, invariant or case it verifies.
4. Every new round of work runs all previous rounds' test suites with **zero regressions**.
5. Every new behaviour gets a positive test, a negative test and a **mutation check**: break the
   behaviour, watch the intended test go red, restore it, and record the red/green result.
6. Every gate has a negative test or an explicitly recorded mechanical limit. A gate that has never
   been observed rejecting has not been shown to be a gate.
7. A change to a test, gate, permission, threshold or CI step is reviewed more strictly than the
   production diff. Never delete, skip or relax a check to make a change pass.

## Three-tier verification (gated; no skipping)

| Tier | Applies | Command / evidence |
| --- | --- | --- |
| 1 — Structural | imports, module boundaries, permissions, schemas, trace/frozen fitness | `pnpm test:readiness` (`contracts`, `requirements`, `boundaries`); `pnpm test:trace`; `pnpm lint`; `pnpm typecheck` |
| 2 — Regression | all prior offline suites, zero regressions | `pnpm test` (99 files / 2268 tests at `2a0c009`) |
| 3 — Behavioral | SEM1 faithfulness, SEM2 answer relevance, zero safety escapes | **pending / not run** — requires a fixed evaluation set, reviewed labels, provider access and thresholds. G4's condition scan is **not** a semantic evaluator. |

**Tier 3 is not satisfied by a green G4.** G4 checks that a measured claim names its fixed conditions
and that a claim row has a value; it does not run faithfulness or relevance. A G4 `not run` is not a
pass, and a G4 pass is not a quality result.

## Coverage and mutation

- **Canonical coverage:** 32/32 requirements have a trace row; every monitor cell is a signal or a
  reasoned `—`; four current invariants remain in the invariant register.
- **Cases:** 69 registered, 64 implemented, 5 pending (C-05, C-08, C-09, C-16, C-75).
  C-05, C-08 and C-09 have exact offline scenario tests recorded as proposed verifiers in
  `case-registry.yaml` and `trace-matrix.md`; they stay pending until the case owners confirm the
  mapping and the accepted joint scope. C-75 has no composition-level rebuild-equality verifier:
  M4's adapter from admitted turns to `DeriveSourceTurn` at the M5 composition boundary is missing
  (`test/fixtures/memory/README.md`).
- **Mutation:** the new trace checks were mutation-checked on this branch (missing requirement,
  bare monitor, non-invariant register row), as was the taxonomy subtype requirement. See the
  review memo and AI-use log for the red/green results.
- **A test that cannot fail is a defect.** A test that asserts only the shape of a mock, or that
  passes when the behaviour is removed, is not evidence.

## Gate inventory and current truth

The per-gate inventory is [`gate-inventory.md`](gate-inventory.md): trigger, position, reference data,
failure action, positive test, negative test and owner. The current truth is:

| Question | Answer |
| --- | --- |
| Is `verify` required? | **Yes per the recorded ruleset measurement**; re-read the active ruleset before repeating the claim. |
| Is G1 blocking? | G1 is in `evidence` mode for PRs created at/after the 2026-11-16 cutover; a time-boxed waiver covers #170/#171/#175/#181 through 2026-11-27. A waiver is not a pass. |
| Is G4 a semantic gate? | **No.** It is a condition/claim scan. Tier 3 semantic evaluation is not run. |
| Does green CI prove product behavior? | **No.** Fixtures are not the product; live providers, acoustic output and Windows recovery are separate. |

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

**Two corollaries (BUG-017, 2026-10-29).** A *negative* claim requires a positive read: the field must be
returned by the command and be empty (`[]`); an omitted field is `unknown`, never "none". And every claim
about a live setting or an issue thread is re-read at the moment of writing, not carried from an earlier
session.

## M6 coverage map (requirement/invariant → case → test)

This table is the M6 evidence detail; the canonical requirement-to-component-to-test-to-monitor map is
[`../architecture/trace-matrix.md`](../architecture/trace-matrix.md). It does not replace that matrix.

Taxonomy note (2026-11-25): only `INV-01..03` and `INV-12` are system invariants. Rows below that use
`INV-04..17` are retained as quality, governance or security NFR controls under their stable legacy IDs;
their verification evidence is unchanged.

| Invariant / requirement | Case | Test that would fail if violated |
| --- | --- | --- |
| INV-04 (session-scoped identity/sequence uniqueness) | C-18, C-23, C-39, C-40, C-41, C-43, C-44, C-51 | `m6-storage.test.ts`; conformance `append-duplicate`, `append-changed-content`, `append-seq-unique`, `append-session-scoped-identity`; conflicting commit reports `conflict` on both sides; canonical content equality (key order irrelevant, array order significant); a non-JSON payload is rejected with `unsupported_payload` (incl. sparse arrays) |
| INV-05 (atomic delivery + event) | C-19, C-38, C-42 | `m6-storage.test.ts::INV-05` (failed commit persists nothing; a later unpublishable mutation leaves no partial state); `m6-sqlite-backend.test.ts` (batch rollback); conformance `atomic-failure-reported`, `atomic-no-partial-mutation` |
| INV-06 (projection no gap / idempotent / session-scoped) | C-20, C-66 | `m6-storage.test.ts::INV-06`; `m6-storage.test.ts` C-66 independent-session test; conformance `projection-no-gap-claim`, `projection-idempotent` |
| INV-07 (record isolation) | C-24, C-29 | `m6-storage.test.ts` (isolation tests); conformance `input-isolation`, `read-isolation` → runs over **both** in-memory and SQLite |
| INV-08 (history ordering) | C-25, C-29 | `m6-storage.test.ts` (ordering test); conformance `history-ordered` → over **both** backends |
| INV-09 (delivery attribution and consistent evidence) | C-46, C-47, C-67 | `m5-attribution.test.ts` (capture and persistence); `m6-late-delivery-conflict.test.ts` (late fully-delivered claim against cancelled delivery preserves original); conformance `delivery-invalid-combination:*`, `delivery-invalid-event:*`, `delivery-correlation:*`, `delivery-provenance:*`; negative adapters `createCombinationNormalizingEventStore`, `createProvenanceIgnoringEventStore` |
| G1 (tests approved before implementation) | D7.1, M6-GOV-02 | `test-approval-gate.test.ts` (record covers every changed path; tests exist; record commit precedes the first code commit; unavailable history and a late approval fail; docs-only and non-PR are not applicable); `pnpm gate:test-approval evidence` |
| G4 (claims need fixed conditions) | D7.4, NFR-01 | `eval-gate.test.ts` (not run only with no evidence; missing condition fails; claim row without value or conditions fails; measured prose claim without a table fails; a target passes; an expiry-dated exception passes until it expires; an exemption cannot hide a different sentence); `pnpm gate:eval` |
| INV-15 (M5 within-turn reconstruction) | C-47 | `m5-attribution.test.ts`, existing ordering regression: exact session/turn filtering, known indices ascending, unknowns last, stable ties, preserved nulls and unchanged input |
| INV-10 (config + schema version validated) | C-26, C-27 | `m6-sqlite.test.ts` (config + migrations) |
| INV-11 (migration recoverable / contradictory legacy refusal) | C-27, C-28, C-48, C-65 | `m6-sqlite.test.ts` (backup before apply; rollback on failure; legacy attribution migrated/refused; contradictory row refused and database preserved) |
| FR-06 (SQLite conformance) | C-29 | `m6-sqlite-backend.test.ts` (conformance suite over SQLite) |
| FR-06 (SQLite persistence/reopen) | C-30 | `m6-sqlite-backend.test.ts` (reopen + isolation) |
| FR-06 (delivery terminal outcome persisted) | C-31 | `m6-sqlite-backend.test.ts` (terminal outcome for recovery) |
| INV-12 (restart restores only confirmed history; no replay) | C-32, C-33 | `m6-recovery.test.ts` (recovery view; restart + isolation) |
| INV-13 (traceability chain machine-checked) | C-34, C-35, C-37 | `trace-fitness.test.ts` (valid repo → no violations; injected defect or missing owner → violation; a changed frozen path passes only on a verified default-branch restoration and fails for a content/mode change, deletion, not-frozen-at-baseline, or unavailable/non-ancestor baseline; an exact `file::title` citation must exist in the file; a bare `x.test.ts::title` is unresolved; an ADR cell must name an ADR or an unexpired row-identified exemption; a missing canonical table, Requirement column or Runtime monitor column fails); `pnpm test:trace` |
| INV-14 (G6 AI-use log) | C-36 | `ai-use-log-gate.test.ts` (shape; added-entry rule; a new or edited entry's cited commits are reachable from HEAD; an entry identical to a base entry is historical wherever a merge placed it, so a mid-insertion does not widen strictness and a repeated entry consumes one base match per occurrence; cited case and invariant ids exist; unavailable register fails closed; a base log that is missing or unreadable, unparsable, has a top-level `entries` value that is not a list, or contains a recursive alias fails closed with POL-G6-03 evidence naming `base-log` (the message separates a missing list from a value that is not a list); a recursive alias in the head is reported once as the same policy naming `head-log`; acyclic shared anchors still compare by content; expiry-dated baseline); `ai-use-log-gate.test.ts::names the base-log finding and skips identity classification when the base file is missing` (the real CLI entry run as a subprocess with an unwritten base path: exit status 1, one POL-G6-03 `base-log` record, no identity classification and no stack trace); `pnpm gate:ai-use-log` over the PR diff |
| INV-16 (every executed attempt accounted for; missing usage unknown; empty failure rate unknown) | C-52, C-53, C-54, C-55 | `m6-02-metrics.test.ts` (failed/cancelled counted; incomplete usage unknown, never a partial total; an empty sample has no failure-rate claim); `m6-02-comparison.test.ts` (a thrown variant is a failure with a reason); `m6-02-report.test.ts` (a fixture source is refused; a zero-attempt variant prints `—`; a not-run entry without a reason is refused) |
| FR-06 (history excludes non-delivered) | C-17, C-21 | `m6-storage.test.ts` (confirmed-history tests); conformance `history-fully-delivered-only` |
| FR-06 (JSONL export carries `versions`) | C-22 | `m6-storage.test.ts` (version attribution) |
| FR-06 (in-memory vs SQLite agreement) | C-45 | `m6-sqlite-backend.test.ts` (cross-backend integration: state, export, history, payload rejection) |
| FR-06 / C-12 (replay isolation) | C-12 | `m6-storage.test.ts` (replay-isolation test) |

**G6 base acquisition (#215, 2026-11-27).** For a pull request checked out as GitHub's synthetic
merge commit, the base copy and changed-file diff are taken from `HEAD^1`, the base-branch tip used to
build the merge. `github.event.pull_request.base.sha` can name an older base and is not used for that
checkout. `change-range.test.ts` pins the first-parent choice, keeps the PR's own diff, and fails
closed when the checkout is not a two-parent merge.

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
  filesystem. Gate **G4** reads the generated table. The current pilot table is one attempt with
  declared conditions; it is not a p95 or threshold baseline.

## Honest limitations

- Fixtures do not prove live providers, browser audio or durable SQLite recovery.
- Fault injection for storage failure is supplied by the **test adapter** (READINESS-KITS:26); the
  production API exposes no failure switch (ADR-001).
- Tier 3 behavioral thresholds and full-course gates remain pending.

## M6-02 R1 recorded-run command

- `test/offline/m6-02-recorded-run.test.ts` — a valid versioned recorded run writes the exact rendered table;
  malformed JSON, wrong schema version, an embedded summary, fixture/injected-clock runs, sample mismatch,
  empty attempts, blank identifiers/reasons, unknown nested fields/variants, missing/duplicate CLI options,
  unreadable input and an explicit output are validated; a refused run writes nothing and preserves an existing output. The command uses a temp
  path; it does not create the repository evaluation table.

## M6-02 R2 runBench harness

- `test/offline/m6-02-bench.test.ts` — `runBench` returns the frozen recorded-run v1 shape, recomputes the
  actual attempt sample size, preserves not-run entries and thrown failures, does not emit a trusted summary,
  and does not mutate the supplied cases/variants; `serializeRecordedRun` produces the JSON the R1 parser
  consumes. The test uses the synthetic runner; no provider or runtime pipeline is imported.

### C-69 — zero-attempt variant reporting

`test/offline/m6-02-report.test.ts` / “reports an unknown failure rate for a variant with no attempts”. A mixed run
with a not-run-only variant renders `—` for failure rate and unknown usage; an entirely unexecuted run is still
refused.

### C-70 — R1 recorded-run refusal

`test/offline/m6-02-recorded-run.test.ts` / “refuses a malformed or unpublishable run and writes nothing”.
Output-preservation, strict-schema, and summary-recomputation tests remain supporting coverage.

### C-71 — R2 producer-to-command integration

`test/offline/m6-02-bench.test.ts` / “writes a runBench recording through the R1 report command without losing
attempts or not-run entries”. Two variants, executed and not-run entries, temporary serialized input and the real
R1 command are used; all-not-run refusal, output preservation and non-finite serialization refusal remain
supporting boundary tests.

## Historical enforcement record — required status check (2026-10-29)

**Historical measurement, not a current claim.** Re-read the active ruleset before repeating it; the
current truth table is in “Gate inventory and current truth” above.

Records the enforcement half of issue #84 (checkpoint 01, target 2026-10-30). This is an **evidence note, not a
rule change**: ADR-006 D2 remains the decision, and this section records which of its conditions held at that
measurement.
Measured on `main` `4e4f7cd` at 2026-10-29T10:57Z with `gh api repos/inscripoem/isla/rulesets/24803426` and
`.../rules/branches/main`.

| Property | Measured value |
| --- | --- |
| Ruleset | `Protect Main`, id 24803426, `enforcement: active`, target default branch (`main`) |
| Required check | context `verify`, `integration_id 15368` (GitHub Actions) |
| Review | 1 approval; approval required after the latest push; unresolved threads are not required to be resolved; code-owner review is not required |
| History / merge | linear history; squash or rebase only |
| Bypass | `current_user_can_bypass: "never"` for the verifying account; bypass actors are not readable with it |
| Branch up to date | **off** (`strict_required_status_checks_policy: false`) |
| Initial branch creation | not enforced (`do_not_enforce_on_create: true`) |
| Last ruleset update | 2026-10-29T17:39:26+08:00 |

Classic branch protection returns 404 for this repository; the ruleset is the enforcement path. The required
context matches the real check: the `verify` job (`.github/workflows/ci.yml:31-32`) is the only workflow, and
both recorded check runs on `4e4f7cd` report `verify`, `success`, app `github-actions` id `15368`.

**What blocks a merge.** Every step of that job: G1 test approval (for PRs created at or after the
cutover), G2 typecheck + lint, G3 readiness, trace, G5 regression, G6 AI-use log, G4 evaluation gate and
the build. A red step anywhere makes the required check red.

**G1 and the cutover.** The G1 step selects its mode from the pull request's creation time. A PR
created before 2026-11-16T16:01:01Z selects the label/advise rule (the `tests-approved` label) and
cannot fail. A PR created at or after the cutover selects `evidence` mode, and a failing G1 step makes
the required `verify` check red. Missing or invalid timestamps fail closed to `evidence`. The values
live in `src/evaluation/test-approval-gate.ts` and are passed by the `G1` step in
`.github/workflows/ci.yml`. M6 records a time-boxed waiver for #170/#171/#175/#181 through 2026-11-27
23:59 +08; it is a recorded exception, not a G1 pass, and it expires by the clock. #181 is the CP04 M2
console UI-defect slice, is G1-only, and merged in `6d8f8d2`; this waiver does not accept CP04 or any
console scope. The waiver is PR-scoped: any additional PR must be requested explicitly to M5 (PM) and
M6 (gate owner).

**What this establishes and what it does not establish.**

- PR #197 (`83666ff4fe63b13c1ecfba9439d7fe25d1a4e134`) was `BLOCKED` while the required pull-request
  `verify` check was red ([45565786945](https://github.com/inscripoem/isla/actions/runs/45565786945)); the
  failing step was G6 with `POL-G6-02` (`commit-missing`: the cited commit object `4273673` was absent).
  The PR was closed unmerged on 2026-11-25; its content is not accepted. It also lacked the required human
  approval, so this observation does not isolate the check as the cause of the blocked state. The refused
  merge call itself remains unobserved. PR #57 (`c1decc2`, 2026-10-29) remains the green-merge case.
- The maintainer records that they applied the setting (issue #84, 2026-10-29T10:15:50Z), consistent with
  the ruleset's `updated_at`. The previous required-check value is not recorded.
- The maintainer records that an **administrator PR-only bypass** remains (same comment). It is not readable
  with the account used here, so universal non-bypassability is not claimed.
- A green check on an older base can still merge, because the branch is not required to be up to date.

**Falsifier.** This section is false if `rulesets/24803426` no longer lists `verify`, or if an approved pull
request merges while `verify` is failing.

Re-measure with:

```
gh api repos/inscripoem/isla/rulesets/24803426
gh api repos/inscripoem/isla/rules/branches/main
gh api repos/inscripoem/isla/commits/main/check-runs
```
