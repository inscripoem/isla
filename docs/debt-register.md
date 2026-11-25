# Debt register

Status: under review. Owner: R3 / M6 tooling (D4); all owners contribute. Tracked across the AI-era
categories: prompt rot, hallucinated dependencies, untouchable code, hidden dependencies,
agent-induced bloat, evaluation debt, guardrail debt, human/cognitive debt.

| ID | Category | Debt | Impact | Owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| DEBT-01 | evaluation debt | NFR thresholds (latency/quality/cost) are TBD; no measured baseline | gate G4 has no evaluation set to check (it reports not run, never a pass) | M3/M4/M5 | pending team measurements |
| DEBT-02 | guardrail debt | G1 has in-repo ordering evidence (`test-approvals.yaml`); the 2026-11-16 cutover and the 2026-11-19 PR-creation correction activate it, with the M6 time-boxed waiver for #170/#171/#175 through 2026-11-27; G4 can check claims but has no evaluation set to check | partial gate coverage | R3/M6 | keep the cutover record current; G4 needs M6-02's evaluation set |
| DEBT-03 | hidden dependency | `persona_version` is persisted `NULL` until C6 carries it (M4 interop) | version-aware trimming degrades after restart | M4/M6 | decide at issue #22 item 3 |
| DEBT-04 | evaluation debt | trace fitness functions parse Markdown tables | fragile to format drift | R3/M6 | revisit machine-readable sources + generator |
| DEBT-05 | untouchable code | `src/contracts/app/*` frozen | coordination cost | M5 | by design (ADR-006) |
| DEBT-06 | agent-induced bloat | multiple stacked PRs pending merge (#9/#23/#24) | rebase churn | team | sequence merges |
| DEBT-07 | guardrail debt | M4 reports 5 Windows-only `test:m6` failures (`m6-sqlite` ×3, `m6-02-boundary` ×2); Linux passes 181/14 and the cleanup branch 182/14 | no Windows test claim; CI is Linux-only | M6 | separate platform investigation; do not claim Windows coverage |
| DEBT-09 | guardrail debt | Gates block merges: the active *Protect Main* ruleset requires the `verify` check (integration 15368) with no bypass actors visible to the M6 token, so a red gate step prevents a merge. Remaining limits: G1 uses the PR-creation cutover (evidence for PRs created at/after 2026-11-16T16:01:01Z; label/advise before; the M6 waiver covers #170/#171/#175 through 2026-11-27); `do_not_enforce_on_create` exempts branch creation; `strict_required_status_checks_policy` is false | merge protection is real; the G1 cutover decision is recorded in proposal §11 and Delta-006 | M6 + human/remote | maintain the cutover record; re-verify the ruleset when it changes (M6-GOV-16) |
| DEBT-08 | evaluation debt | documentation claims about live configuration are not machine-checked; M6-GOV-11 cannot be satisfied by a docs-only slice | a false or stale claim can ship inside a reviewable document (BUG-017) | M6 | every claim names its command; a negative claim needs a positive read; refresh the thread at write time. Trigger: refusal experiment or a read-only claims check |
| DEBT-10 | evaluation debt | No label→report interface exists; quality cannot be joined or scored | reported numbers are latency, cost and outcome only | M3/M4/M6 | define the label file and owner; add an appendix join |
| DEBT-11 | guardrail debt | A failing required check has produced a blocked merge state on PR #197 (`83666ff`, run 45565786945, G6 `POL-G6-02`); an attempted merge command has not been refused | enforcement is configured and a red check blocks mergeability; only an attempted-merge refusal is unobserved | M6 | keep the #197 evidence; if an attempted-merge refusal is needed, run a controlled failing PR and record the refusal |
| DEBT-12 | hidden dependency | The append-only `docs/ai-use-log.yaml` conflicts on every code merge | the I1 PRs are blocked by a bookkeeping file, not by code; repeated rebases | M5/M6 | standing rebase rule; an ADR to split the log only if it recurs after the I1 batch |
| DEBT-13 | evaluation debt | `condition-mismatch` cannot be evaluated: conditions are recorded per run, not per attempt | protocol §3 rule 5 is unimplemented | M4/M6 | per-attempt conditions, or an explicit recorded limitation |
| DEBT-14 | evaluation debt | the recorded run carries no corpus identity (`FixedConditions` has no `corpusVersion`/`casesSha256`), so the label file's corpus tuple is checked only against the supplied manifest | a label file for one corpus can be joined to a run produced from another whenever the manifest matches the labels (#145) | M6/M3 | add a corpus field in a versioned run-schema decision (trigger: the first formal run, or a second corpus version); until then the operator supplies the run and the manifest together |
| DEBT-15 | guardrail debt | G1 evidence mode (#158) left #170/#171/#175 without a pre-implementation approval record. #160 was also affected but is resolved by the #178 cutover fix. | the #178 waiver makes G1 green as an explicit exception through 2026-11-27; after the waiver this fallback record expires on 2026-11-30 or at submission, whichever is earlier, and G1 would be red again unless evidence or a ruleset change exists; G1 is not claimed as passed | CHANG Xuben (M5, team coordination) / M6 | active fallback for #171 only; #170 merged (`a028a2e`) and #175 closed unmerged (superseded by #187) are historical; #160 out via #178; #171 acknowledged by M4 on #146; #181 is outside this exception; no retroactive TA record; future PRs need a TA record on `main` before implementation |
| DEBT-16 | evaluation debt | The ADR-008 companion shape (root binding plus `attempts[]`) is implemented but not confirmed by M5/M4 | formal run archives could freeze a shape the team did not choose | M6/M5 | decide before CP07; parser and renderer share one reading |

## G1 fallback exception — 2026-11-18

Decision: CHANG Xuben (M5, team coordination) records a one-delivery fallback exception for PR #171. #170 (merged as `a028a2e` on 2026-11-20) and #175 (closed unmerged on 2026-11-21T17:17:55Z, superseded by #187) were originally in scope and are now historical records. #160 is resolved by #178 and is not part of the active exception. This record accepts the G1 failure as debt; it does not make G1 evidence pass and does not create or backdate an approval record.

### Scope and evidence

- #160: `src/runtime/evaluation-adapter.ts`; resolved by #178 (merged as `d4234f38c6616634ce6a84080877ed5b2621be34`), which selects G1 mode by PR creation time. Historical run `44302927637` failed only G1 before that fix.
- #170 (historical): `src/dialogue/` (A03); pull-request run `44145390282` failed only the G1 step; merged as `a028a2e` on 2026-11-20.
- #171 (active): `src/dialogue/` (A06); pull-request run `44146008624` fails only the G1 step.
- #175 (historical): `src/console/ConsoleApp.tsx` and `src/console/console.css`; pull-request run `44294388233` failed only G1 with `no recorded approval covers src/console/ConsoleApp.tsx, src/console/console.css`; closed unmerged on 2026-11-21T17:17:55Z, superseded by #187.

The corresponding push runs are green because G1 is skipped on push by design; they are not evidence that the pull-request gate passed.

### Conditions

1. #178 merged as `d4234f38c6616634ce6a84080877ed5b2621be34`; the waiver is active for #171 only through 2026-11-27 23:59:59 +08. #170 (merged `a028a2e`) and #175 (closed unmerged) are historical and no longer active. The G1 step is green as an explicit exception and prints that it is a waiver. This record is the fallback after expiry or if the waiver is not used; it does not claim G1 evidence passed.
2. M6's token reports no usable ruleset bypass (`bypass_actors: null`, `current_user_can_bypass: never`), matching DEBT-09; no bypass is assumed. The #178 waiver removes the need for one during its window; otherwise a ruleset change would be required. This exception does not itself change the ruleset.
3. Code review and every non-G1 gate must pass at the exact head.
4. M4 acknowledged #170/#171 on issue #146 at 2026-11-20T08:31:07Z ([comment 7034450240](https://github.com/inscripoem/isla/issues/146#issuecomment-7034450240)); M2 acknowledged #175 on issue #174 at 2026-11-19T13:25Z, at `dccca53`. Both condition-4 acknowledgements are now recorded; PR reviews do not replace them.
5. #160 is resolved by #178 and is out of DEBT-15; no CP08 trigger applies.
6. No retroactive TA record is created, and no approval date is backdated. Future PRs require a TA record on `main` before implementation begins.

Scope note: PR #181 (console P1 C07-C10) is outside DEBT-15 and needs its own G1 handling; this record does not cover it.

Expiry: 2026-11-30 or final submission, whichever is earlier. The #178 waiver expires earlier (2026-11-27 23:59:59 +08); after that the evidence rule returns. This is a delivery-window exception, not a precedent for future gates.

## PR53 IPC literal follow-up

Owner: M5. Status: open, non-blocking, as identified in the
[M6 review](https://github.com/inscripoem/isla/pull/53#pullrequestreview-5598159923).
`src/runtime/production-cli.ts` and `test/support/production-cli-kit.ts` each define
`isla.runtime.shutdown`. They can drift because there is no explicit agreement
check. A follow-up should use a shared side-effect-free constant or add an
agreement test, preserving shutdown success, pending/failed release, duplicate
message and startup-failure coverage. This entry records the debt; it does not
claim the duplication is fixed or allocate a new stable ID.

## M3 selection integration follow-up

Owner: M3 (M3/M5 where the oldest/answer rule and prepared-input boundary are
shared). Status: open, non-blocking, as identified in the M6 re-review of PR #57
and M5's coordination reply.

`src/decision/selection.ts` and M5's `src/runtime/policy.ts` both choose the
oldest eligible candidate and use `answer` when allowed, but there is no
cross-module agreement test binding the two implementations. The rule port's
usage is synthetic (`elapsedMs: 0`, `usageMissing: true`), intent coverage in
`selection-001` remains partial, and the `EvalCase`/prepared-input binding for a
future `runVariant` remains unresolved (#41/#55). This entry records the debt;
it does not allocate a new stable ID, change runtime behavior or claim corpus,
report, S6 or G4 completion.
