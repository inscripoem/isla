# Delta-006 — Gate enforcement (G1, G4, G6, trace)

Status: merged in `9492070`; cutover correction 2026-11-19. Date: 2026-11-13; review fixes 2026-11-14. ADR: ADR-006.
Branch `m6-gate-enforcement`, pull request #158. Revision type: **ADD-R** (enforcement added
to existing gates; no interface, contract or schema change).

## Change

- **G1 — recorded approval.** New `evidence` mode and `docs/code-governance/test-approvals.yaml`.
  An approval names its scope and tests; the commit that added the record must be an ancestor of the
  first code commit in the pull request. `approved_at` later than that commit is a violation.
  CI runs `evidence` only when the approval record exists **at the pull request's base**; otherwise the
  existing `tests-approved` label rule runs in `advise`. **Corrected 2026-11-19:** the base-presence
  test was the defect; the mode is selected by the PR creation time. See “Cutover correction” below.
- **G4 — claims need evidence.** The evaluation table gains a `Claim | Value | Conditions | Artifact`
  table; an empty value or conditions cell fails. `README.md` and `Report.md` are scanned for measured
  performance claims (`p95`, `p99`, `recall@`, `precision@`, `accuracy`, `tokens per`, `cost per`);
  an unqualified measured claim without an evaluation table fails. Wording such as *target*,
  *threshold*, *requirement*, *goal* marks an intention, not a claim, and passes.
- **G6 — references must exist.** A **newly added or edited** entry must cite commits **reachable
  from HEAD**; an entry present in the base log is historical and checked as advice only, wherever a
  merge placed it, because a fresh clone does not carry the orphaned commits of squash-merged work.
  Every cited case id must exist in `docs/req/case-registry.yaml`; every cited invariant must exist
  in `docs/architecture/invariants.md`. A register that cannot be read, or an unavailable history,
  fails closed. `docs/code-governance/gate-baseline.yaml` holds expiry-dated exemptions for the
  other gates.
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

## Gate failure records and policies (2026-11-13, third pass)

A gate verdict now carries the decision that follows it. `src/evaluation/gate-record.ts` is the single
source for 20 policies (`POL-PIPE-*`, `POL-G1-*`, `POL-G4-*`, `POL-G6-*`, `POL-TR-*`, `POL-G2/3/5-*`),
each declaring its decision, its action and exactly the evidence fields it promises. The same table is
rendered into `docs/architecture/runtime-policy-catalog.md` under **Pipeline gates (M6)**, and an
agreement test compares the policy set plus each row's decision, action and evidence fields. The
catalog's Action cell is the `POLICY_SPECS.action` text exactly, so a paraphrase or a drifted action
turns the test red.

- **Records.** Every failing gate writes `.cache/gate-failures/<policy>-<commit>-<utc>.json`; CI uploads
  the directory for 14 days and the summary names each file. One record per policy per run, so a
  repeated failure does not bury the decision in duplicates.
- **Completeness.** `buildGateRecord` throws when the evidence keys differ from the declared fields.
  A policy cannot promise seven fields and emit six; the test fails first.
- **Pipeline.** Every gate step is `if: always()`, so one failure no longer hides the rest; the
  aggregate step records any gate that did not succeed as `not-verified` (POL-PIPE-01). A G1 skip on a
  `push` event is labeled `skipped-by-design`: it remains not-verified and is never a pass. The policy
  text now says “record the outcome map”; the earlier “fail the aggregate step” contradicted the
  deliberate return 0, where the failed gate already fails the job (M5 review, 2026-11-14).
- **Honesty.** G2/G3/G5 have policies but no dedicated record: their failing step is the record, and
  the catalog marks them `convention`. There is no pager; the escalation column says `none` and names
  the human role that reads the check.
- **Defect found while verifying.** The standalone `gate:trace` entry point did not load the ADR-cell
  baseline and failed on the known `INV-15` row; it now reads the same baseline as the test.

## What each gate now proves — and what it does not

| Gate | Proves | Does not prove |
| --- | --- | --- |
| G1 (evidence mode) | an approval record covering every changed code path existed in a commit **before** the first code commit, and its tests exist | that a human wrote or read it; pre-cutover and waived PRs do not run this check |
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
would make the gate meaningless.

**Corrected after the first CI run (2026-11-13).** "Object exists" is not clone-stable either: the
GitHub checkout carries only reachable objects, so 30+ historical entries failed in CI while the same
gate passed locally against dangling objects. The rule is now **new entries → reachable from HEAD;
historical entries → advisory**. The same run exposed a defect in this branch: rebasing rewrote the
branch's own commit ids while the AI-use entries still cited the pre-rebase ids, which existed locally
and nowhere else. Those entries were repointed after the final rebase. The 4 genuinely missing
historical commits remain recorded for their owners (M1/M4 entries 110, 116, 117, 118) but no longer
need an exemption.

**Corrected 2026-11-25: historical means "present in the base log", not "below an index".** The
rule classified an entry by its array position (`index < base entry count`). When a merge inserted
its own entries before a base entry, that entry moved past the count and its previously accepted
citations were re-checked as new and failed. The gate now compares each head entry with the entries
of the base log by content: an identical entry is historical wherever it sits, including after a
mid-insertion, and each repeated occurrence consumes one base match. A new entry, or one whose fields
changed (a repointed commit, a reworded change), is still new and must cite a string commit reachable
from HEAD. A base log that is supplied but cannot be read as an entry list fails closed instead of
silently making every entry historical: that covers unparsable YAML, a document whose `entries` is
not a list, and a recursive YAML alias. A base log file that is missing or unreadable fails closed
the same way, with a `base-log` record, instead of ending the run with a stack trace. The CLI path is
covered by a subprocess test that asserts the named base-log record, no identity classification and no
stack trace. The same alias
in the head fails closed too, and the gate writes the resulting POL-G6-03 record with evidence naming
`base-log` or `head-log`; the record path now receives the base copy instead of rebuilding its
dependencies without it. A cyclic head entry is reported once, by the reference check, as the named
POL-G6-03 diagnostic; the shape check no longer repeats it. The non-list message now separates a
document with no top-level `entries` list from one whose `entries` value exists but is not a list.

## Cutover

`docs/code-governance/test-approvals.yaml` is committed before the implementation in this branch
(`bf9c39f`). A pull request whose **base already carries** that file is gated on evidence; an older
base keeps the label rule. No open pull request is retroactively failed. **Corrected 2026-11-19:**
the second sentence was false in practice; `base.sha` follows the current tip. See “Cutover correction”
below.

**Adoption precondition (M5 review, 2026-11-14).** Merging this branch puts
`docs/code-governance/test-approvals.yaml` on `main`. Every later pull request's base then carries it,
so G1 switches from the label rule to `evidence` mode for the whole team. The ADR-006 D2 adoption
decision must be recorded before or with that merge; this branch records the precondition and does not
make the decision. On `push` events G1 is skipped by design, and the aggregate records
`g1: skipped-by-design` — not-verified, never a pass. **Corrected 2026-11-19:** the mode is
selected by the PR creation time, not the base tip; see “Cutover correction” below.

## Cutover correction — 2026-11-19 (M6, #177)

**Finding.** The cutover above read `github.event.pull_request.base.sha`. That field follows the
**current** tip of the base branch, not the base at pull-request creation: GitHub refreshes it on every
push. When #158 merged, every open PR's base began to carry the register, so PRs opened before the
cutover entered `evidence` mode without touching the register. #160 is the measured case: created
2026-11-13T17:30:01Z; bases `78c7656` at creation, `205424f` at the last pre-activation push,
`b58a5ad` on 2026-11-18; pull-request run `44302927637` fails G1 on
`src/runtime/evaluation-adapter.ts`.

**Rule (effective 2026-11-19).** G1 selects its mode from the pull request's **creation time**, compared
with `G1_EVIDENCE_ACTIVATED_AT = 2026-11-16T16:01:01Z` (the #158 merge, `9492070`):

- created before the cutover → the `tests-approved` label rule in `advise`;
- created at or after the cutover → recorded-approval `evidence` mode;
- missing or unparsable creation or activation time → `evidence` (fail closed).

The current base tip is no longer a mode selector. The workflow passes
`github.event.pull_request.created_at`; the gate prints the selected mode and reason.

**Time-boxed waiver (M6, 2026-11-19; #181 added 2026-11-22).** PRs #170, #171, #175 and #181 may use the
label/advise rule through **2026-11-27 23:59:59 Asia/Taipei** (`G1_TIME_WAIVER_UNTIL =
2026-11-28T00:00:00+08:00`, the first instant after the window). #160 uses the permanent cutover rule and
is not in the waiver. #181 is the CP04 M2 console UI-defect slice and is covered by this waiver only for
G1; this is not a CP04 acceptance or a console-scope decision. #181 merged in `6d8f8d2`. The waiver is a
recorded exception, not evidence: the G1 step
prints that it is a waiver, the check is green under the exception, and the gate does not claim evidence
passed or create/backdate a TA record. After the expiry, a post-cutover PR returns to evidence. The M5
delivery exception in PR #176 (DEBT-15, pending) remains scoped to #170/#171/#175 and is the fallback
after expiry; #181 is not part of #176. This M6 waiver instead makes G1 green under an explicit,
expiring exception; if both records are used, #176's condition 1 must be read as superseded for the
waiver window and its author should update it. The waiver also removes the need to rely on the
unverified repository-role bypass in #176 for the covered PRs during the window. The waiver expires
earlier.

**Governance.** This waiver is PR-scoped. Any additional PR that needs G1 relief must be requested
explicitly to M5 (PM) and M6 (gate owner); do not extend or reuse this exception silently.

**Limits.** The cutover is PR-level: a pre-cutover PR keeps the label rule even for code written after
2026-11-16 (#160's current head is such a case). That is the recorded policy choice, not a claim that
the later code was approved. The waiver is debt, not a precedent; it does not change the ruleset, the
`verify` requirement or any other gate. The waiver is historical for merged or closed PRs; #171 remains
open. It does not accept CP04 or any console scope.

## Limits

- The gate cannot see authorship. A record can be written by an agent; review checks content.
- The gates block pull-request merges to `main`: the active *Protect Main* ruleset requires the
  `verify` check (integration 15368, `bypass_actors: null`, `current_user_can_bypass: never`;
  measured 2026-11-13). G1 uses the PR-creation cutover (see “Cutover correction”); the earlier
  “advise until the base carries the record” wording is superseded. `do_not_enforce_on_create` exempts branch creation and
  `strict_required_status_checks_policy` is false, so a branch need not be up to date.
- The G4 prose scan is a heuristic over two named files; a reviewed exception needs a baseline entry
  with an expiry, not a silent edit.
- Prose-only trace citations remain advisory until they are migrated to `::` form.
- Baseline entries expire; an expired entry fails the gate rather than renewing itself.
