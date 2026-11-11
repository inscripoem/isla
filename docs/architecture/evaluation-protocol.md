# Evaluation protocol — S6 comparison and pilot

Status: **proposal.** Not an approved protocol. Owner: M6. Reviewers: M3 (corpus, rubric,
thresholds), M4 (condition eligibility, labels), M5 (acknowledgements, timings).
Anchors: NFR-01 … NFR-06, INV-16; ADR-007 (bench); ADR-008 (prepared-input provenance companion).
This document fixes the **method**. It fixes no threshold value: a threshold is set only after a
measured pilot baseline (§5). No S6, G4, quality, latency or cost result is claimed here.

## 1. Evaluation set

- **Corpus:** the versioned selection corpus supplied by M3, identified by
  `(corpusVersion, casesSha256, caseId, candidate.eventId)` — the tuple M3 confirmed on 2026-10-29.
- **Split:** the held-out cases are those M3 marks held-out in the corpus manifest; a run that scores a
  case not marked held-out is a development run, not an evaluation run.
- **Eligibility:** a case is eligible only when its labels are human-reviewed and the case is not `draft`.
  **No label producer exists today:** there is no label or review record in `src/`, and no `status` field
  to read. The label file and its reviewed state are a CP05 dependency owned by M3/M4 and tracked as
  DEBT-10; until it exists, every attempt stays `unscored` for want of labels.
- **Exclusions:** a case whose prepared input cannot be identified, or whose conditions differ from the
  run's `FixedConditions`, is **unscored** with its reason (§3), never dropped silently.

## 2. Metrics and owners

| Metric | Owner | Observation | Missing value |
| --- | --- | --- | --- |
| `submitMs` | M5 | accepted → dispatched | `null` |
| `planMs` | M3 | selection entry → terminal selection outcome; excludes history assembly, admission, recall scoring and the consistency audit | `null` |
| `dialogueMs` | M4 | dialogue stage; a deadline budget is not a measurement (`DEFAULT_CYCLE_TIMINGS.dialogueMs` is 60,000 ms at `src/runtime/coordinator.ts:225`, used as `dialogueDeadline` at `:1935`) | `null` |
| `synthesisMs` | M1 | synthesis stage; a deadline budget is not a measurement | `null` |
| `firstAudibleMs` | M1 (observation); M2 (console) | physical output observation only | `null` |
| `stopToSilenceMs` | M1/M2 | physical silence observation only | `null` |
| usage / cost | M4 (observation, including `usageMissing`); M5 (aggregation and price) | provider-reported tokens; a half-reported pair stays `usageMissing` (`src/dialogue/dialogue-port.ts:300,309`), and a partial total is unknown | `unknown` |
| outcome counts | M6 | completed / failed / cancelled over executed attempts; a not-run entry is not an attempt | `—` for an empty sample |

No stage is summed into an end-to-end latency. An unobserved stage is `null` and renders `—`
(`src/evaluation/report.ts:231-233`).

No stage is produced today: the adapter writes `NO_TIMING`, whose every stage is `null`
(`src/runtime/evaluation-adapter.ts:278,1287`; `src/evaluation/comparison.ts:88,130`). A pilot will render
`—` for every stage — correct, and expected rather than discovered.

## 3. Scoring and eligibility

A case is **scored** only when every condition below holds; otherwise it is **unscored** with one of the
named reasons, and the attempt keeps its completed/failed/cancelled classification.

1. The run has a companion record; without one, the result is `unscored` `no-provenance-record`.
2. The input-to-acknowledgement link is `exact`; `missing` or `ambiguous` gives
   `missing-acknowledgement-link` or `ambiguous-acknowledgement-link`.
3. `inputs[].inputId` was observable; an unexported identity is recorded as
   `not-yet-observable` (rendered from `null`), and the case is `missing-input-identity`.
4. The admitted record set was captured; otherwise `missing-history-observation`. A `history.source:
   'none'` run that was observed carries the empty-set digest and is eligible — a known-empty set is not
   an unobserved one. The encoding is `recordSetRevision: null` together with `correlation: missing`, and
   `exact` is refused when the revision is null (`src/evaluation/provenance.ts`, D7 refusal in PR #140).
5. The attempt's conditions match the run's `FixedConditions`; a mismatch gives `condition-mismatch`. An
   exact link does **not** bypass this check. The two conditions M4 owns are explicit: the persona pair
   `persona {profileId, version}` (a half-known or empty pair is `unknown`, never back-filled from the
   current profile) and `history {source, recordSet}`. `history.recordSet` is a **declared label** fixed
   before the run; `recordSetRevision` is an **observed digest** captured at admission — they are not
   substitutes.

Rules 1–5 follow ADR-008 (`docs/architecture/adr/008-prepared-input-provenance.md`) and the merged companion
proposal (`docs/architecture/evaluation-provenance.md`, PR #63); this section cites the decision, not a
result. Rule 5 is a **target rule, not evaluated at this revision**: the run records conditions per run,
not per attempt, so the report states that it is not evaluated (DEBT-13). `provenance-eligible` in #143
means rules 1–4 passed; a scored attempt also needs a human-reviewed label. The `no-label-record` reason
is proposed, not implemented.

**Open decision (proposed by M4, not implemented).** Only a `completed` attempt would be quality-eligible;
`failed` and `cancelled` would be excluded with a named reason and remain counted in §2's outcome counts,
and a `notRun` entry is never scored. This is a proposal, not an enforced rule: the eligibility
implementation (#143) currently covers rules 1–4, so adopting this would add a reason and a test there.
M4 owns the decision; M6 implements it after it is recorded.

## 4. Refusal rules

The report refuses, rather than scoring:

| Condition | Behaviour |
| --- | --- |
| `textSource: 'fixture'` for a published benchmark | refusal — fixture text consumes no tokens and is not comparable |
| `clock: 'injected'` with measured durations | refusal — a fixture clock is not an observation of time |
| a declared sample size that differs from the recorded attempts | refusal |
| a blank condition, an undeclared variant | refusal |
| a negative or non-finite duration or usage | refusal |
| a failed attempt with no reason | refusal |
| zero attempts | refusal; an empty *variant* inside a mixed run renders `—` |

These are implemented in `src/evaluation/report.ts` and `src/evaluation/recorded-run.ts`; the tests are
`test/offline/m6-02-report.test.ts` and `m6-02-recorded-run.test.ts`.

## 5. Threshold-setting rule

1. A threshold has three parts: **statistic** (e.g. p95), **comparison** (absolute bound or delta against a
   named baseline) and **verification** (the command that prints it).
2. A threshold may be fixed only after a pilot that produced a recorded result on a named head, with the
   conditions declared.
3. Every fixed threshold names: its baseline value, the pilot head, the date, and the owner who approved it.
4. A threshold with no baseline is recorded as **pending**, not as zero and not as a target.

## 6. Pilot procedure

Preparation (may run before checkpoint 4):

1. Declare `FixedConditions`: hardware, providers, workload, sample size, cold/warm, persona, model and
   prompt versions, text budget, history source, text source, clock.
2. Produce the recorded run with the bench harness (`runBench` in `src/evaluation/bench.ts`), using the
   eligible set and the declared conditions.
3. Render the table: `pnpm evaluation:report --input <recorded-run.json> --output <evaluation-table.md>`.
4. Record the companion and validate it against the run digest with
   `--provenance <path>` (parser and command: the #100 slice). The command's refusal set is owned
   by ADR-008 D8: run id, digest, key set, input order, a duplicate key, a not-run pair or
   occurrence the run did not record, and `exact` without an observed acknowledgement. This method
   does not restate that list.

Pilot pass conditions:

- the run is reproducible from the recorded command on the named head;
- every executed attempt appears once; a not-run entry is explicit;
- unobserved metrics are `null`, not `0`;
- no case is scored from an unreviewed or condition-mismatched label;
- the report is written and cites model, prompt and conditions; any threshold is referenced from
  `evaluation-thresholds.md` and is `pending` — the current report has no threshold field, so this is a
  documented reference, not a report feature.

A pilot on **fixture-generated answers** is an internal plumbing check: the test output (command, head,
pass/fail) records it. It is not live-provider performance, usage or a real-provider baseline; the report
refuses `textSource: fixture`, and fixture text is never relabelled as provider output. No new report
feature is added for this wording.

Prepared fixture **inputs** sent to an **actual provider** are a different case. A real-provider baseline
needs the actual responses plus the recorded head, model and measurement conditions; no such run is
claimed here. Formal live runs require checkpoint 4.

## 7. Checkpoint-05 acceptance checklist (M6 side)

| Condition | Evidence |
| --- | --- |
| Evaluation set fixed | corpus version + hash + held-out list, reviewed by M3/M4 |
| Protocol approved | this document reviewed by M3/M4/M5 |
| Thresholds fixed or explicitly pending | §5 entries with baseline, head, date, owner |
| Pilot reproducible | recorded command, head, conditions, recorded run and report |
| Observed and unknown distinct | report shows `—`/`unknown`, never `0` |

## What this does not claim

No formal evaluation, no evaluation table, no G4 pass, no quality, latency or cost result. C-05/C-16
remain open. The provenance companion is a proposal; implementation needs its own approved slice.
