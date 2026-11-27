# Gate inventory — CI and evidence gates

Status: **under review. No gate is claimed blocking unless the active remote ruleset requires it.**
Owner: M6. Date: 2026-11-25. Measurement base: `2a0c009` (D4 slice `03af868`).

One row per gate: trigger, position, reference data, failure action, positive test and negative test.
A gate that has never been observed rejecting has not been shown to be a gate; a gate that is advisory
is labelled advisory.

| Gate | Obligation | Kind | Position | Reference data | On failure | Positive test | Negative test | Owner | Current status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G1** test approval | tests approved before implementation | deterministic + human record | CI (pull request) | `docs/code-governance/test-approvals.yaml`, changed-file list, PR creation time | block in `evidence` mode; advisory in label mode | `test/offline/test-approval-gate.test.ts::accepts a code pull request carrying the label` | `::fails when the record was committed after implementation began` | M6 | **evidence mode after the 2026-11-16 cutover**; time-boxed waiver to 2026-11-27 for #170/#171/#175/#181; PR #199 TA-007 is an explicit replay exception (DEBT-21), not a judgment; a waiver is not a pass |
| **G2** static analysis | typecheck + lint | deterministic | CI | TypeScript config, oxlint config | block | `pnpm typecheck`, `pnpm lint` | compiler/linter non-zero (no dedicated negative test; recorded limit) | M6 | **blocking step** inside `verify` |
| **G3** schema + boundary | requirements registry schema, import/module boundaries | deterministic | CI | `docs/req/req-schema.json`, `case-schema.json`, boundary rules | block | `pnpm test:readiness` | `test/offline/requirements.test.ts::rejects an unknown case id`; `test/offline/boundaries.test.ts::rejects a backend import from the main entry (negative)` | M6 | **blocking step** inside `verify` |
| **trace** traceability fitness | every requirement has a canonical row; monitor cells reasoned; invariant register consistent; frozen paths; ADR refs | deterministic | CI | `docs/architecture/trace-matrix.md`, `invariants.md`, ADRs, `frozen.yaml`, case registry | block | `test/offline/trace-fitness.test.ts::reports no violations on the committed repository` | `::flags a trace row referencing a missing component`; `::flags a modified frozen path`; `::flags a requirement with no canonical trace row`; `::flags a runtime-monitor cell with no reason`; `::flags a non-invariant requirement registered in the invariant register`; `::flags a missing canonical requirement table`; `::flags a canonical table without a Requirement column`; `::flags a canonical table without a Runtime monitor column` | M6 | **blocking step** inside `verify`; coverage checks added 2026-11-25 |
| **G5** regression | all prior offline suites | deterministic | CI | test corpus | block | `pnpm test` (99 files / 2268 tests at the measurement base) | any failing suite (the suite is the oracle; no separate negative test) | M6 | **blocking step** inside `verify` |
| **G6** AI-use log | code/prompt change updates the log; new entry cites reachable commits and real case/invariant IDs | deterministic | CI (pull request) | `docs/ai-use-log.yaml`, base copy from the PR synthetic-merge first parent (`HEAD^1`), changed-file list, registers | block | `test/offline/ai-use-log-gate.test.ts::passes when the log is updated alongside code` | `::rejects a change that only edits an existing entry (the review reproduction)`; `::requires the log when a code file changes`; `::fails closed when the base log is not valid YAML` | M6 | **blocking step** inside `verify`; historical `INV-` citations resolve through the legacy register table; **base acquisition fixed 2026-11-27 (#215)** |
| **G4** semantic evaluation | measured claims need fixed conditions; no table = not run | deterministic + evidence | CI | evaluation table, `evaluation-conditions.md`, threshold register | block a measured claim without a table; report `not-run` otherwise | `test/offline/eval-gate.test.ts::accepts a table that records every fixed condition NFR-01 requires` | `::fails a table that reports results without the fixed conditions`; `::reports not run — never a pass — when there is no evaluation table` | M6 | **condition scan passes** with the one-attempt pilot table; the gate is **not** SEM1/SEM2 and no threshold baseline exists |
| **build** production bundle | the app builds | deterministic | CI | Vite/TypeScript config | block | `pnpm build` | compiler/build non-zero (no dedicated negative test; recorded limit) | M6 | **blocking step** inside `verify` |
| **PIPE** aggregate | records gates that did not run | deterministic | CI | gate step outcomes | report, not a pass | `pnpm gate:aggregate` | missing/failed step recorded as not-run | M6 | **reports** |
| **POLICY** permission policy (local candidate) | default-deny role/path policy compiles and denies another module | deterministic (local) | `tools/opencode/` + focused test | `.opencode/permissions.jsonc`, role/test paths, frozen manifest | fail the focused test; **not** a `verify` step | `test/offline/opencode-policy.test.ts::parses the committed policy and keeps the artifact under review` | `::allows the role-owned source and denies another module write`; `::keeps protected paths denied even with every approval class` | M6 | **local candidate, not blocking**; native observations are version-bound; adoption pending |

## Gate status truth (2026-11-25)

| Question | Answer at the measurement base |
| --- | --- |
| Is `verify` a required status check? | **Yes per the recorded ruleset measurement**; re-read `rulesets/24803426` before repeating it. |
| Is G1 blocking? | It is in `evidence` mode after the cutover; the recorded waiver is an explicit exception, not a G1 pass. |
| Is G4 a semantic gate? | **No.** It is a condition/claim scan; the pilot table passes it, but Tier 3 SEM1/SEM2 is not run. |
| Does a green CI prove product behavior? | **No.** Fixtures are not the product; live providers, acoustic output and Windows recovery are separate. |
| Is the permission policy blocking? | **No.** It is a local candidate; the focused test is not a `verify` step. |

## Negative-test gaps

The following gates have no dedicated negative test because the mechanism is the compiler, the linter,
the build or the suite itself:

- G2 typecheck/lint;
- G5 regression (the suite is the oracle);
- build.

Do not invent a negative test for them. Record the limit; a future gate can wrap the command if a
specific failure mode needs a regression.

G4 has negative tests for its own condition/claim checks, but **none** for semantic quality; that is a
scope gap, not a test that can be invented from the current fixtures.

## How to update this file

- Add a row when a gate is added or its position/reference data changes.
- Cite `file::title`, not a bare file, for every test.
- Change `Current status` only from a measured run or a ruleset read.
- A gate with no negative test is marked as such, not given a placeholder.
- Do not call a local test a blocking gate; name its position.
