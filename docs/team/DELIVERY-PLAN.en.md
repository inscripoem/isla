# Submission checkpoint plan

Revision: 2026-10-29.2. Status: under review. Captain has adopted these target dates; individual capacity, review slots and forecasts require member acknowledgement. All times are UTC+8; each target is 21:00. No checkpoint is marked accepted by this document.

Scope: CS5351 submission and the agreed Isla requirements only. Preserve M1-M6 ownership, workload ratings, existing task/requirement/case IDs and genuine evidence. Checkpoint numbers are schedule positions, not new requirement/case IDs. I1-01, I2-01 and S1-01 remain the original task references. Any scope reduction needs an explicit recorded decision.

The team agreed November 22 as the complete-candidate date (reported by Captain on October 29). The planning time is 21:00 UTC+8; individual delivery capacity and intermediate forecasts still need owner confirmation.

## Start here

The public [Isla Roadmap](https://github.com/users/inscripoem/projects/4) is published with the five other members granted writer access. The live views are [Team progress](https://github.com/users/inscripoem/projects/4/views/2), [Checkpoints](https://github.com/users/inscripoem/projects/4/views/3) and [Next checkpoint](https://github.com/users/inscripoem/projects/4/views/4). This document holds schedule and acceptance definitions; Project fields hold operational status. Member forecasts still await confirmation.

The Team progress table contains six explicit member rows. Checkpoints uses a Roadmap with Planned start and Target; Next checkpoint uses a Board with Status columns. These browser display settings were saved and verified after reload. Planned start denotes scheduling rather than actual work or member capacity. The board is for Isla throughout its lifetime; the current ten checkpoints cover the course delivery. The Next checkpoint view shows unaccepted Delivery items for checkpoint 01; its filter changes only after explicit checkpoint acceptance. These summaries and filters require maintenance. No automatic roll-up or acceptance is claimed.

Keep the main view short: member, next delivery, status, target, forecast, blocker and latest evidence. A member update changes the canonical delivery once. Do not repeat changing status across every handoff. Missing or outdated confirmation is unknown, not evidence of inactivity or completion.

## Published tracking structure

There are ten checkpoint Issues (#71-#80) and 50 canonical child delivery Issues, reusing #68/#69 and creating 48 missing delivery trackers. Each checkpoint links its children and acceptance dependencies. The Checkpoints view exposes native Sub-issues progress; this counts accepted/closed delivery issues, not implementation percentage. Existing source and evidence are reused.

Current checkpoint: [01 - scope and delivery queue](https://github.com/inscripoem/isla/issues/71), In progress. Its four remaining deliveries are [plan publication #81](https://github.com/inscripoem/isla/issues/81), [member capacity #82](https://github.com/inscripoem/isla/issues/82), [PR queue confirmation #83](https://github.com/inscripoem/isla/issues/83) and [required verify #84](https://github.com/inscripoem/isla/issues/84). No delivery or checkpoint has been marked Accepted by administrative setup.

## Schedule

| Order | Original task | Acceptance target (UTC+8) | Checkpoint |
| --- | --- | --- | --- |
| 01 | S1-01 / R1-R3 | 2026-10-30 21:00 | [Scope and delivery queue](#checkpoint-01) |
| 02 | I1-01 / delivery 1A-1B | 2026-11-01 21:00 | [I1-01 first joint check](#checkpoint-02) |
| 03 | I1-01 / delivery 1A-1D | 2026-11-05 21:00 | [I1-01 complete offline acceptance](#checkpoint-03) |
| 04 | I2-01 / M1-02 / M4-02 / delivery 2A | 2026-11-08 21:00 | [I2-01 live reference application](#checkpoint-04) |
| 05 | M6-02 / delivery 2D / S1-01 R6 | 2026-11-10 21:00 | [Evaluation readiness](#checkpoint-05) |
| 06 | I1-01 / I2-01 fault cases / S1-01 R4 | 2026-11-12 21:00 | [Fault, recovery and safety acceptance](#checkpoint-06) |
| 07 | M6-02 / S1-01 R1/R4/R6 | 2026-11-15 21:00 | [Formal evaluation and requirement verdicts](#checkpoint-07) |
| 08 | S1-01 R1-R4 / D1-D4/D7-D9 | 2026-11-18 21:00 | [Architecture and governance final check](#checkpoint-08) |
| 09 | S1-01 R5/R6 / D5/D6 | 2026-11-21 21:00 | [Report, transcripts and video candidate](#checkpoint-09) |
| 10 | S1-01 / D1-D9 | 2026-11-22 21:00 | [Complete submission candidate](#checkpoint-10) |

Contingency: **November 23-25**. A complete candidate must exist on November 22; contingency is not the planned start of packaging. Aim for Captain's upload by November 25 at 18:00, ahead of the official November 25 23:59:59 deadline. Final upload remains Captain's action.

Do not schedule joint acceptance on the November 2 quiz or November 4 Phase 2 deadline. The November 20 individual report and Chronicle's late-November work reduce shared capacity. Members confirm their own availability rather than inheriting a full-time assumption.

## Deliveries and acceptance

An ordinary PR should be ready at least 24 hours before acceptance, and a cross-module or safety change at least 48 hours before it. A missed slot changes the forecast immediately; the original target remains visible. Preparation, live adapters, evaluation tooling, CI and report inputs proceed in parallel. Shared references do not require all work on a long-lived role issue to finish before one scoped delivery is accepted.

Use Planned -> In progress -> In review -> Ready for acceptance -> Accepted. Blocked is a separate reason/owner, not a completion state. Accepted requires evidence and named human confirmation; a merged PR can remain Ready for acceptance. A checkpoint with mandatory unmet criteria remains open. Checkpoint 2 is explicitly an inspection checkpoint that can close with an agreed, dated failure/gap list; complete I1 is checkpoint 3.

Each delivery records one primary owner, reviewers, original task, source/PR, target and forecast, blockers, and actual acceptance evidence. Existing issues and PRs are reused first. Create a child issue only for independently owned, scheduled work or a blocker. Never automatically close an acceptance issue merely because its implementation PR merged. Evidence PRs are excluded from delivery-count summaries to prevent double counting.

At each acceptance slot record exact source revision, conditions, commands/results, pass/fail/not-run, remaining owner actions and accepter. Future dates are targets, not claims that members agreed them. Report slippage when known and summarize twice weekly; daily duplicate reports are not required. Essential safety remains an obligation in I1/I2 rather than being postponed to checkpoint 6.

<a id="checkpoint-01"></a>

Tracking issue: [#71](https://github.com/inscripoem/isla/issues/71).

### 01. Scope and delivery queue

Target: **2026-10-30 21:00 UTC+8**. Coordinator: M5. Original scope: S1-01 / R1-R3.

Acceptance dependencies: preparation may start now; follow the prerequisites in the deliveries.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M5 | Planning PR: submission requirements, target platform, comparison baseline, checkpoint dates and acceptance boundaries. | M1-M6 | docs/team/PLAN.en.md; docs/team/DELIVERY-PLAN.en.md |
| M1-M6 | Each member confirms next delivery, review availability, unpublished work and seven-day capacity on the existing role issue. | M5 | Issues #2-#7 |
| M5 | For every open PR, record its current head, author action, consumer reviewer, forecast and checkpoint; obtain owner acknowledgement. | respective owners | PRs #57/#63/#64/#66/#67/#70 |
| M6 + human maintainer | Prepare and approve the required-check setting for existing verify; maintainer applies it and records effective rules. | M5 | Existing CI and Protect Main ruleset |

Pass condition: All six next deliveries are visible; critical dependencies have owners and forecasts; adopted scope and actual required-check settings are recorded. Member capacity is not inferred from silence.

<a id="checkpoint-02"></a>

Tracking issue: [#72](https://github.com/inscripoem/isla/issues/72).

### 02. I1-01 first joint check

Target: **2026-11-01 21:00 UTC+8**. Coordinator: M5. Original scope: I1-01 / delivery 1A-1B.

Acceptance dependencies: preparation may start now; follow the prerequisites in the deliveries.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M5 | Audio-deployment PR: supply the existing controlled audio resource peer and verify the same-origin resource route. | M1/M2 | Issue #69; existing ProductionAudioResources seam |
| M2 | Complete the PR67 consumer review follow-up and run two turns, Stop/Resume, duplicate/late frames and transport-loss checks in the product console. | M1/M5 | PR #67; Issue #37 |
| M1 | Verify WAV mapping/duration and browser playback/receipt behaviour; link actual observations and remaining gaps. | M2/M5 | Issues #2/#69; scoped review on PR67 |
| M6 | Complete boundary-parser repair review; M2 removes its workaround only after adoption. This does not block the joint check while the workaround works. | M2 | PR #70; Issue #68 |
| M5 | Run the complete I1 acceptance checklist and record pass/fail/not-run, owner and forecast for every remaining item. | M1-M6 | Existing I1 application handoff and original case IDs |

Pass condition: The first joint inspection is completed and all observed results or missing deliveries are recorded. Checkpoint 2 means the inspection happened; only checkpoint 3 can accept complete I1. Fixture decision/text peers must be identified.

<a id="checkpoint-03"></a>

Tracking issue: [#73](https://github.com/inscripoem/isla/issues/73).

### 03. I1-01 complete offline acceptance

Target: **2026-11-05 21:00 UTC+8**. Coordinator: M5. Original scope: I1-01 / delivery 1A-1D.

Acceptance dependencies: checkpoint 02.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M3 | Finish PR57 review fixes and obtain current-head consumer acceptance for the rule SelectionPort. | M6/M5; M4 rubric | PR #57; role Issue #4 |
| M3 | Deliver rule ReactionPort and its tests as a separate PR if no existing implementation covers the agreed scope. | M1/M5 | M3-01; shared ReactionPort |
| M5 | I1 adoption PR: reuse applicable local eleven-file preparation; wire real module factories with a shared clock and run one combined revision. | M1/M3/M4/M6 | Local m5-i1-independent-20261028; Issue #6 |
| M4 | Validate selected text, intent and delivered-versus-unconfirmed history through the real dialogue module; repair owned defects. | M5/M6 | Merged PR65; Issue #5 |
| M1/M2/M6 | Supply playback, console and recording acceptance for the same combined source revision, including two turns and Stop/late/duplicate behaviour. | M5 | Issues #2/#3/#7/#37 |

Pass condition: The formal console, real rule selection/reaction, dialogue/context, fixed audio/subtitles, runtime receipts and recording work together with the agreed negative cases. Full cross-session recovery is not added as an I1 prerequisite.

<a id="checkpoint-04"></a>

Tracking issue: [#74](https://github.com/inscripoem/isla/issues/74).

### 04. I2-01 live reference application

Target: **2026-11-08 21:00 UTC+8**. Coordinator: M5. Original scope: I2-01 / M1-02 / M4-02 / delivery 2A.

Acceptance dependencies: checkpoint 03.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M4 | Live text-provider PR with cancellation, deadlines and honest usage; replace live todo cases with actual assertions. | M5/M6 | DialogueTextSource; M4 live harness |
| M1 | Verify existing Kokoro and selected avatar implementation on the target machine; submit focused fixes only for demonstrated defects. | M2/M5 | Merged M1 providers; Issue #2 |
| M5 | Resolve PR64 conflicts with current main and obtain renewed review; implement remaining product connector/store/budget/assembly work required by the selected VTS deployment. | M1 | PR #64; Issue #58 |
| M5 | Product deployment PR: real peers, explicit configuration failure and owned cleanup; reference one reproducible startup command. | M1/M4/M6 | Existing production CLI and composition |
| M2 | Verify live waiting/failure/output states through the formal console and fix owned UI defects. | M1/M5 | Adopted PR67; Issue #3 |

Pass condition: One approved product configuration runs real AI generation and speech with the selected avatar path. Missing services are visible failures, not fixture success. I2 covers normal operation and essential cancellation; detailed committed fault criteria continue in checkpoint 6.

<a id="checkpoint-05"></a>

Tracking issue: [#75](https://github.com/inscripoem/isla/issues/75).

### 05. Evaluation readiness

Target: **2026-11-10 21:00 UTC+8**. Coordinator: M6. Original scope: M6-02 / delivery 2D / S1-01 R6.

Acceptance dependencies: checkpoint 04. Preparation starts immediately in parallel.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M3 | Versioned selection/intent corpus, detached human labels, held-out split and the comparison variants agreed at checkpoint 1. | M4/M6 | PR57 development examples; Issue #41 |
| M4 | Dialogue/persona/history rubric and condition eligibility; independently review relevant reference labels. | M3/M6 | Issue #41; PR63/66 discussions |
| M6 | Resolve PR63/66 wording and design reviews; deliver the approved run/provenance capture and validation needed by the agreed evaluation. | M3/M4/M5 | PRs #63/#66; ADR-008 reservation |
| M5 | Adapter PR to export actual admission/acknowledgement and observable timings without changing frozen records silently. | M3/M4/M6 | Existing evaluation adapter; Issue #41 |
| M1/M2 | Submit measurement methods and samples for input/playback/Stop on documented hardware and clocks. | M5/M6 | Existing browser and performance observations |
| M6 + metric owners | Approve thresholds and protocol before formal evaluation; run a pilot from real input to valid recorded result. | M3/M4/M5 | NFR-01 through NFR-06; scoped comparison plan |

Pass condition: The pilot is reproducible, the evaluation set and thresholds are fixed, and observed/unknown values remain distinct. Formal live runs require checkpoint 4; preparation starts immediately. No result is scored from unreviewed or condition-mismatched labels.

<a id="checkpoint-06"></a>

Tracking issue: [#76](https://github.com/inscripoem/isla/issues/76).

### 06. Fault, recovery and safety acceptance

Target: **2026-11-12 21:00 UTC+8**. Coordinator: M5. Original scope: I1-01 / I2-01 fault cases / S1-01 R4.

Acceptance dependencies: checkpoint 03, checkpoint 04.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M3/M5 | Verify decision timeout, invalid proposals, fallback/defer and late results against the existing case obligations. | M4/M6 | C-05/C-16; runtime policy |
| M1/M2/M5 | Joint playback-disconnect, synthesis-failure, Stop and physical-release evidence, with focused owner fixes. | affected consumers | C-08/C-09; Issues #37/#58/#69 |
| M6/M4/M5 | Product SQLite/restart and selected-history acceptance: confirmed history only; unknown output is neither promoted nor replayed. | M2 | Issue #25; C-68/C-73/C-74 existing evidence |
| M5 + owners | Verify untrusted control, invalid output, permissions and agreed retention/privacy policy on the declared supported configuration. | M1/M4/M6 | NFR-02/NFR-05; invariant register |
| M1-M6 | Fix blocking defects on the target submission platform; record other platform limits and freeze the functional scope. | M5/M6 | Existing Windows failures; supported-platform decision |

Pass condition: Every committed critical fault and safety criterion has a source-bound verdict and repair/retest evidence. No new full-platform expansion or power-loss claim is introduced. Essential safety is still required at earlier acceptance points.

<a id="checkpoint-07"></a>

Tracking issue: [#77](https://github.com/inscripoem/isla/issues/77).

### 07. Formal evaluation and requirement verdicts

Target: **2026-11-15 21:00 UTC+8**. Coordinator: M6. Original scope: M6-02 / S1-01 R1/R4/R6.

Acceptance dependencies: checkpoint 04, checkpoint 05, checkpoint 06.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M6 | Produce formal run archives, report tables, rerun commands and record validation with source/model/prompt versions. | M3/M4/M5 | Existing runner/report tooling |
| M3/M4 | Complete human scoring, independent review and disagreement resolution against the fixed rubric. | M6 | Reviewed corpus and rubric from checkpoint 5 |
| M1/M2/M5 | Supply actual latency/output/Stop observations and conditions for the formal runs, including failures and unknowns. | M6 | Target-machine measurements |
| M5 + requirement owners | Requirement verdict PR: pass/fail/explicitly approved scope revision for every included requirement, with trace links. | M1-M6 | Existing requirements/schema/trace files |

Pass condition: Every reported number resolves to actual evidence and every included requirement has an explicit verdict. A failed mandatory condition prevents acceptance until repaired or legitimately revised; wording alone cannot make it pass.

<a id="checkpoint-08"></a>

Tracking issue: [#78](https://github.com/inscripoem/isla/issues/78).

### 08. Architecture and governance final check

Target: **2026-11-18 21:00 UTC+8**. Coordinator: M6. Original scope: S1-01 R1-R4 / D1-D4/D7-D9.

Acceptance dependencies: checkpoint 07. Preparation starts immediately in parallel.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M6 | Separate gate PRs implementing G1-G6, dependency/safety-path checks and trace coverage; retain negative evidence that applicable failures block. | M5 + affected owners | Current CI; G1 adoption proposal; G4 evaluation inputs |
| M5/M6 | Permission model and governance documents with designated human review; reconcile actual tool versions and course-required paths. | M1-M6 | D3; AGENTS.md; Prompt.md; required .opencode/.agent documents |
| M5 + module owners | Architecture PRs: chosen design and alternatives, context layers/budget/compaction reinjection, invariants, runtime policies and candidate evaluation. | affected consumers | D2; existing blueprint/ADRs; frozen changes need ADR |
| M4/M6/M5 | Align memory/state, retention/privacy and recovery documentation with the accepted implementation. | M2; affected owners | D2 memory-design; Issue #25 |
| M1-M6; M6 coordinates | Complete requirement/case/test/monitor links and review, debt and significant-bug records. | M5/M6 | D1/D4; C-02/C-49/C-50/C-64 mapping gaps |

Pass condition: All required repository artifacts are present and accurate, and remote required checks are effective. G1 activation follows its recorded team adoption requirements; historical approval is never fabricated. G4 uses accepted checkpoint-7 results. Work starts immediately, not on November 18.

<a id="checkpoint-09"></a>

Tracking issue: [#79](https://github.com/inscripoem/isla/issues/79).

### 09. Report, transcripts and video candidate

Target: **2026-11-21 21:00 UTC+8**. Coordinator: M5. Original scope: S1-01 R5/R6 / D5/D6.

Acceptance dependencies: checkpoint 07, checkpoint 08.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M1-M6 | Each member supplies module process text, authentic annotated interventions, contribution evidence and a verified personal reflection. | M5; respective member | Existing external evidence; no invented authorship/hours |
| M5 | Report integration PR: one English Report.md with team identity, relative contributions and process findings. | M1-M6 | D6; at most 10000 words, over 15 pages, 12pt single spacing |
| M6 | Audit reported numbers, defects, test scope and CI claims against the exact candidate. | M5 | Accepted runs and QA records |
| M1/M2 + M3/M4/M5 | Recorded demo candidate and script show before/after behaviour, software-engineering contributions, traceability and governance. | M1-M6 | Separate video, at most 10 minutes; no extra slide requirement |
| M5 coordinates; all supply | Finalize transcript selection and annotations; obtain clarification or record the unresolved five-versus-one wording and the actual coverage chosen. | M1-M6 | D5 original specification ambiguity |

Pass condition: The complete report, member inputs, transcripts and an actually recorded video are reviewable and meet the course requirements. Inputs accumulate after each checkpoint; November 21 is the acceptance date, not the drafting start.

<a id="checkpoint-10"></a>

Tracking issue: [#80](https://github.com/inscripoem/isla/issues/80).

### 10. Complete submission candidate

Target: **2026-11-22 21:00 UTC+8**. Coordinator: M5. Original scope: S1-01 / D1-D9.

Acceptance dependencies: checkpoint 03, checkpoint 04, checkpoint 05, checkpoint 06, checkpoint 07, checkpoint 08, checkpoint 09.

| Owner | Delivery | Reviewer / accepter | Existing work |
| --- | --- | --- | --- |
| M5 | Pin source SHA and prepare complete submission directory, explicit ZIP whitelist, hashes and separate video. | M6 | Existing evidence/submission conventions |
| M6 + rotating member | Restore from a clean environment using README and run the declared offline/live/full checks; report skips and gaps honestly. | M5 | D7/D8; candidate source and recorded environment |
| M1/M2 | Verify final video behaviour matches the candidate and playback is readable/audible. | M5 | Checkpoint 9 video |
| M3/M4 | Verify corpus, model/prompt versions, scoring and report conclusions agree. | M6 | Accepted evaluation artifacts |
| M1-M6 | Confirm names/student IDs, contributions, reflections and each member's own materials. | M5 | D5/D6 |
| M5 | Record readiness for Captain's final upload; verify ZIP contents exclude credentials, internal Chinese drafts, caches and the separately submitted video. | M6 | Canvas ZIP and Demo Video are separate |

Pass condition: A complete, recoverable and checked submission candidate exists by November 22 at 21:00. November 23-25 is contingency for gaps, blocking fixes and re-verification. Only Captain performs the official upload; submission requires an actual receipt, not this checkpoint.

## Course requirements and evidence

D1: machine-readable PRD/requirements and schema, MoSCoW, measurable criteria and sources. D2: architecture and alternatives, layered context/budgets/compaction reinjection, invariants, state/retention/privacy, permissions, runtime policy and candidate comparison. D3/D9: AGENTS, structural rules, tool manifest, required permission/rule files and static Prompt with real human plan gates. D4: structural/regression/behavioural verification, negative tests, review/debt/bug records. D5: authentic annotated transcripts covering the supervised process; the original five-versus-one wording remains unresolved until clarification. D6: one English Markdown process report, at most 10,000 words excluding diagrams, over 15 pages in 12pt single spacing, names/IDs/contributions and each member's approximately 300-500-word reflection. D7/D8: meaningful history, effective blocking CI, source/tests and honest offline/live/full run instructions. Demo: at most ten minutes, before/after requirements, original software-engineering ideas, traceability/governance, uploaded separately from ZIP.

Source basis checked October 29, 2026: `CS5351-2026-2027-project.pdf`, project PDF pages 6/9/10 and Introduction pages 20/23/24. The locally synchronized Canvas Project (Zip file) and Project (Demo Video) pages both give 2026-11-25T15:59:59Z. Do not treat a schedule suggestion as a new teacher requirement. Keep student reflections and contribution claims factual. Review/QA/acceptance responsibilities can rotate while module ownership remains fixed.

## Transition and change control

The ten checkpoint issues (#71-#80) are published and open. Their bodies mirror this plan's acceptance definitions; approved schedule changes update both. Operational status belongs to each linked delivery item. Role issues #2-#7 retain responsibilities and history. Long coordination threads #25/#37/#41/#44/#58 remain intact; add approved concise current-action links rather than replacing past discussions. Historical handoffs are version-bound evidence, not the current project status.

Existing PRs continue on their original branches. PR64 also edits team plans: resolve its documentation conflicts against the adopted plan while preserving its VTS handoff and original evidence; renewed review remains necessary. An unrelated review cannot clear another author's requested changes. Module fixes remain with their owners unless separately delegated. No agent merges, enables auto-merge or submits coursework.

Captain approved Project creation, five member writer grants, ten checkpoints, all independent delivery items and the existing-item associations. Git commit/push, the documentation PR, CI/ruleset changes and business implementation still need their respective approval. Publication records preserve returned IDs and actual changes. G1 activation still requires its documented adoption decisions; the existing advisory mode is not changed by this plan. G4 implementation and required checks remain independent owner work.
