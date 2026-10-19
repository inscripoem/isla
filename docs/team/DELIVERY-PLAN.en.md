# Isla delivery plan

Revision: 2026-10-19.5. Status: under review. Existing roles and workload ratings are unchanged. PR states below are a dated snapshot; review each current head before adoption.

## Current baseline

Main is [d1b040bc42bc5367b5f0612ff8b4968049205752](https://github.com/inscripoem/isla/commit/d1b040bc42bc5367b5f0612ff8b4968049205752) after Captain squash-merged PR40. Its tree equals the reviewed PR40 head, and main CI passed. PR33, PR34, PR36, PR45 and PR47 are also merged. The earlier PR40 and PR47 local history repairs are superseded; they must not be pushed.

| PR / current head | State | Next action |
| --- | --- | --- |
| [33](https://github.com/inscripoem/isla/pull/33), [34](https://github.com/inscripoem/isla/pull/34), [40](https://github.com/inscripoem/isla/pull/40), [47](https://github.com/inscripoem/isla/pull/47) | Merged; their implementation and tests are retained in the current main baseline | Verify consumers; keep owner changes outside the M5 publication diff |
| [35](https://github.com/inscripoem/isla/pull/35) `10f87e9` | Changes requested; the latest inspected update does not change the dialogue implementation | Repair explicitly selected archive recall while preserving composite session/turn identity |
| [43](https://github.com/inscripoem/isla/pull/43) `4f8a694` | Changes requested; initial admission and newer-owner fixes present; independent M2 27/27 and full 901/48 passed | Revalidate pending busy retries after Stop/stopped snapshots or local cancellation in synchronous injected-port delivery; reconcile current main conflict. No follow-up review was published. |
| [45](https://github.com/inscripoem/isla/pull/45) | Merged | M2/M1 consumer adoption and combined recovery acceptance |

CI success, review approval, merge and product acceptance remain separate facts. External review/comment publication requires confirmation of the exact text and commit; a request to perform review work alone does not authorize sending it.

## M5 local work

The combined publication candidate is now on `feat/m5-production-main`, based on [d1b040bc42bc5367b5f0612ff8b4968049205752](https://github.com/inscripoem/isla/commit/d1b040bc42bc5367b5f0612ff8b4968049205752). All 39 frozen M5 files were restored; only the shared script manifest, trace table and log required alignment with main, followed by this documentation refresh. Application and test contents remain identical to the frozen OpenCode-authored combination. All 14 other files changed upstream since the earlier candidate remain identical to main.

Current verification: `pnpm verify` passed 1013 tests / 58 files, typecheck, lint and build; M5 passed 168 / 8; actual-change G6 and trace passed. Real HTTP/WebSocket routing passed 11 checks and Chromium audio-route acceptance passed 8 checks; the two server processes were stopped and their exits observed. The earlier 1008-test total predates three merged recovery cases and two report regressions. G4 explicitly remains not run.

The branch is local, uncommitted and unpublished. The next step is confirmation of the exact publication diff, commit message and PR body. The paragraphs below retain the original increment provenance and verification scope; they do not replace the current baseline above.

The production application is under review on `feat/m5-production-composition`, based on PR45. It owns the shared M6 SQLite handle, stopped initial composition, explicit selected-history reconstruction, deployment-supplied peers, and controlled shutdown. Independent verification passed 832 tests / 49 files, typecheck, lint and build after correcting the shutdown race. The unchanged held-provider probe retains the admitted provider-call and stale-result records, then refuses writes after shutdown. See [the production handoff](HANDOFF-M5-PRODUCTION.en.md) for the current verification scope.

The close/reopen continuation test uses two application instances in one process. A separate real CLI child-process test covers startup, health and SIGTERM, and the two-process restart acceptance now covers confirmed output through the real transport, explicit selected-history continuation into the assembled dialogue context, no replay by session-scoped delivery identity and preserved unknown/null evidence. Live provider acceptance remains to be verified. Root Vite application routing now passes eleven actual HTTP/WebSocket checks through the root entry, including origin/header refusals and the dynamic audio route's method, header and origin refusals. Dynamic audio HTTP/resource assembly is implemented in the `m5-dynamic-audio` worktree and under local acceptance (uncommitted, under review): one explicit same-origin `POST /audio` route with authoritative session/epoch/lifecycle rechecks, bounded serving slots and response-lifetime lease ownership, an assembled-turn check over the real M1 registry with a clearly controlled provider, and a real-browser fetch through the root Vite proxy (8/8 browser checks). See [the dynamic audio handoff](HANDOFF-M5-DYNAMIC-AUDIO.en.md). Retained physical provider ownership is now implemented locally and under review: one adapter/provider survives logical Stop and recovery, each facade preserves its originating gate, and shutdown awaits owned release through actual worker exit. Independent full verification passed 931 tests / 52 files with typecheck, lint and build. Controlled real-worker and CLI checks cover pending release and truthful shutdown completion; no live model or acoustic result is claimed. See [the physical synthesis handoff](HANDOFF-M5-PHYSICAL-SYNTHESIS.en.md).

The production evaluation adapter is independently frozen in a separate worktree, with 922 tests / 55 files and 19 adapter cases. It is now adopted alongside the frozen physical lifecycle in this combination; see [the evaluation adapter handoff](HANDOFF-M5-EVALUATION-ADAPTER.en.md). Its timings, actual provider-attempt counts and costs remain null, with supplied-intent mode and M4 token propagation still unsupported. The separate integration worktree passed 986 tests / 56 files before physical-lifecycle adoption. Both increments are now adopted and their combined path is independently verified: 1008 tests / 57 files, typecheck, lint and build passed; M5 168 / 8 and evaluation 20 cases passed. One retained provider serves the actual evaluation adapter, real registry and a controlled real worker: successful resource delivery, Stop during held synthesis, explicit busy failure until settlement, reuse and caller-owned release through actual exit. Metrics remain null; this does not establish real model or acoustic output.

The C-49/C-50 and INV-15 documentation follow-up is prepared and independently verified outside this branch. Adoption awaits PR35's selected-archive repair; no new case IDs are invented.

## Remaining delivery sequence

| Order | Work | Owner / collaborators | Acceptance |
| --- | --- | --- | --- |
| 1A | Adopt merged application transport and session recovery | M5; M1/M2 | Two turns, Stop/Resume, reconnect, explicit stopped successor, no replay or promotion of unknown delivery |
| 1B | Product console and PR43 repairs | M2; M1/M5 | Snapshot-first reconnect, one performer, input/profile/control, correct playback admission and pending/unknown state |
| 1C | Selection/intent and reaction rules | M3; M4/M5 | Replace fixtures; normal/Stop/defer, eligibility, identity, cancellation and bounded attempts |
| 1D | Review PR35/43 repairs and verify merged-owner adoption | Module owners; M5 | Current-head approval, linear conventional history and consuming checks; resource ownership and selected-history semantics preserved |
| 2A | Real text/audio production composition | M4 text; M1 provider/registry; M5 assembly/HTTP; M2 browser consumption | Injected synthesis, controlled audio routes and leases, shared deadline gate, safe physical settlement/replacement and explicit missing-config failure |
| 2B | SQLite startup and selected-history recovery | M6 persistence/discovery; M5 selection/lifecycle; M4 semantics | Cross-process continuation with confirmed archives and partial/null attribution retained; no replay or fabricated terminal evidence |
| 2C | Effective CI and trace gates | M6 R3; M5 coordination | Actual change-range and negative gate evidence; stable ownership/trace; required-check settings need a separate decision |
| 2D | Production evaluation adapter and recorded-run tooling | M5 adapter; M6 runner/report command; observations from M1–M5; cases from M3/M4 | Coordinator-backed VariantRun, unchanged bench accounting, declared conditions and source-backed observations |
| 3A | Model/Jev comparison and VTS | M3/M1; M4/M5 | Stable real loop, fixed conditions, held-out cases, all attempts/usage/failures and actual access |
| 3B | S1 / R1–R6 delivery | M5 R1/R2/consolidation; M6 R3; all R4/R5; M3/M4/M6 R6 | Genuine owner evidence, measured NFRs, reviewed rubric, English report/demo/package |

## Evaluation and coordination boundaries

[Issue41](https://github.com/inscripoem/isla/issues/41) retains the injected `VariantRun` seam: M5 composes and M6 aggregates. The report-writing command can proceed without live providers. M3's missing decision implementation blocks dependent variants; reviewed cases and rubric/version block quality claims, while the observe-versus-enforce caps decision blocks cap-compliance claims. None of those is a reason to postpone unrelated report tooling.

Metric start/end events, clock domains and observation methods remain provisional. `CycleTimings` are budgets; browser accept-to-ack and server accepted-to-dispatched intervals differ. First-in-run does not establish process/provider/cache cold state. Bench invocations do not establish response-provider attempt counts. `firstAudibleMs` and `stopToSilenceMs` stay unknown until actual-output observation is agreed. No real evaluation table or G4 pass is claimed.

[Issue25](https://github.com/inscripoem/isla/issues/25) remains the numeric/global-ADR reservation thread. C-51 belongs to M6 on main; C-49/C-50 remain M4 cases on PR35; INV-16/C-52–C-55 and C-68 are on main; C-65/C-66/C-67 remain separate M6 follow-ups. C-56–C-64 are reserved for M4, with C-62 preserving explicit history selection and C-64's verifier still needing M6 alignment. Registration and a recorded adoption revision are separate from reservation; no future naming scheme is activated by these edits.

Main protection requires linear history and approval after the latest push, but has no required CI checks. G1 remains advisory; G4 is not run. Issues2–7/25/37/41/44 remain open. Preserve unique work and authentic evidence outside the repository, and restore published source from full-SHA references. Course deadlines were not re-audited.
