# Delta-006 — Gate enforcement (G1, G4, G6, trace)

Status: under review (M6). Date: 2026-11-13. ADR: ADR-006. Branch `m6-gate-enforcement`,
local only. Revision type: **ADD-R** (enforcement added to existing gates; no interface, contract
or schema change).

## Change

- **G1 — recorded approval.** New `evidence` mode and `docs/code-governance/test-approvals.yaml`.
  An approval names its scope and tests; the commit that added the record must be an ancestor of the
  first code commit in the pull request. `approved_at` later than that commit is a violation.
  CI runs `evidence` only when the approval record exists **at the pull request's base**; otherwise the
  existing `tests-approved` label rule runs in `advise`.
- **G4 — claims need evidence.** The evaluation table gains a `Claim | Value | Conditions | Artifact`
  table; an empty value or conditions cell fails. `README.md` and `Report.md` are scanned for measured
  performance claims (`p95`, `p99`, `recall@`, `precision@`, `accuracy`, `tokens per`, `cost per`);
  an unqualified measured claim without an evaluation table fails. Wording such as *target*,
  *threshold*, *requirement*, *goal* marks an intention, not a claim, and passes.
- **G6 — references must exist.** Every cited commit must be an object in the repository; every cited
  case id must exist in `docs/req/case-registry.yaml`; every cited invariant must exist in
  `docs/architecture/invariants.md`. A register that cannot be read, or an unavailable object database,
  fails closed. `docs/code-governance/gate-baseline.yaml` holds expiry-dated exemptions.
- **trace — exact citations and ADR cells.** `` `test/…/x.test.ts::title` `` is checked against the
  file's actual test titles. Prose-only citations stay path-checked and are reported as
  `unverified-citation` advice, not failures. A row's ADR cell must contain `ADR-\d{3}` or start with
  `—`; `pending allocation (#25)` fails unless an expiry-dated, row-identified exemption exists.
- **Tests.** `pnpm test:gates` selects the four gate suites, which previously ran only in the full
  suite and not in `pnpm test:m6`.

## Gap closure (2026-11-13, second pass)

- **G4 exemptions.** A reviewed prose-claim exception lives in `gate-baseline.yaml` under `claims:`,
  keyed by the SHA-256 of `path|trimmed line`. Editing the sentence removes the exemption; an expired
  exemption fails the gate instead of renewing itself.
- **Real git tests.** `gate-git-facts.test.ts` builds temporary repositories: an amended (rewritten)
  code commit keeps the approval record as an ancestor, a record committed after the code is rejected,
  and a `--depth 1` clone cannot answer ancestry and hides older objects, so the gate fails closed.
- **Citation migration and a closed loophole.** The two rows that cited `m6-storage.test.ts::INV-05/06`
  without a path now carry full `test/…::title` forms; INV-13 and INV-14 cite exact titles. A bare
  `x.test.ts::title` now fails as `trace-test-unresolved` instead of being silently ignored.
- **Plan defect resolved.** The plan's §3 listed `trace-matrix.md` as read-only except five ADR cells,
  while §8 required updating the INV-13/INV-14 evidence cells. §8 is the evidence requirement and wins;
  §3's list was too narrow. Recorded here so the contradiction is not silently repeated.

## What each gate now proves — and what it does not

| Gate | Proves | Does not prove |
| --- | --- | --- |
| G1 | an approval record covering every changed code path existed in a commit **before** the first code commit, and its tests exist | that a human wrote or read it |
| G4 | a recorded claim has a value and names its conditions; an unqualified prose claim has a table | that the number is correct, or that an evaluation ran |
| G6 | cited commits and ids exist in this repository | that the work was correct, or that a committed change was merged |
| trace | the cited test title exists in the cited file; a row names an ADR or none | that the test is adequate, or that the row's prose is true |

## Measured decision: ancestry is not the enforceable rule

The plan required every cited commit to be an ancestor of the branch head. Measurement on 2026-11-13
rejected that rule for this repository:

- 58 commit ids are cited by the AI-use log;
- **54 exist as objects, 0 are reachable from `HEAD`** — this project squash-merges, so the original
  commit of every merged change is orphaned by design;
- 4 do not exist at all (M1 and M4 entries 110, 116, 117, 118).

Ancestry as a failure rule would fail the entire log and demand a 54-entry permanent exemption, which
would make the gate meaningless. The failing rule is therefore **existence**; reachability is reported
as advice. The 4 missing commits are baselined until **2026-12-15** for their owners to correct.

## Cutover

`docs/code-governance/test-approvals.yaml` is committed before the implementation in this branch
(`bf9c39f`). A pull request whose **base already carries** that file is gated on evidence; an older
base keeps the label rule. No open pull request is retroactively failed.

## Limits

- The gate cannot see authorship. A record can be written by an agent; review checks content.
- The gates block pull-request merges to `main`: the active *Protect Main* ruleset requires the
  `verify` check (integration 15368, `bypass_actors: null`, `current_user_can_bypass: never`;
  measured 2026-11-13). G1 still runs `advise` until the base carries `test-approvals.yaml`;
  switching new bases to `evidence` is the team decision ADR-006 D2 records, and it is owed before
  this branch merges. `do_not_enforce_on_create` exempts branch creation and
  `strict_required_status_checks_policy` is false, so a branch need not be up to date.
- The G4 prose scan is a heuristic over two named files; a reviewed exception needs a baseline entry
  with an expiry, not a silent edit.
- Prose-only trace citations remain advisory until they are migrated to `::` form.
- Baseline entries expire; an expired entry fails the gate rather than renewing itself.
