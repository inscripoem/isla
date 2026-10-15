# Isla delivery plan

Revision: 2026-10-15.2. Status: under review. Existing six-member responsibilities and workload ratings are unchanged. I1 rebuilding and local verification were approved; publication, new implementation slices and repository settings require their applicable approvals.

## Current baseline

Main is dbbbfcb after the human merge of PR30; PR31 is also merged. The I1-only candidate has been rebuilt on this main, retaining all PR31 additions and original I1 source/test bodies. Independent verification and OpenCode review both passed 634 tests / 30 files, typecheck, lint and build. Browser observations cover two completed fixed-audio turns, Stop during playback, a completed turn after Resume and local cancellation on socket closure. These are media-API observations, not acoustic measurements. I1 is local and unpublished.

PR33 f7a0d3e (ownership) and PR34 93846ab (Kokoro worker, stacked on PR33) await review. Both have successful CI. PR34 supplies author-recorded CPU and browser smoke evidence; M5 production composition/HTTP resources and independent consumer verification remain pending. PR26 1e3711d has published the consistent-backup fix and two regressions, but remains draft, conflicting and Changes requested. PR27 and PR32 remain drafts; UNKNOWN mergeability is not proof of conflict resolution. M4 PR35 ae5b4a3 now publishes the C-50 agreement guard and F3/F4 fixes on main; CI passed, consumer review remains pending. It does not supply a live text provider.

## Work and acceptance

The rows are dependency batches, not promised dates. M2/M3 can implement against the existing interfaces while I1 publication is prepared.

| Order | Work | Owner / collaborators | Concrete acceptance |
| --- | --- | --- | --- |
| 1A — prepared locally | Publish I1 and its M2/M1 consumer handoff | M5 inscripoem; M2 Warpshlczy, M1 Pioneer141, M4 L01nki1 | Review the exact diff and full publication drafts, recheck remote main, then publish a separate main-based PR. Consumers reproduce two turns, Stop/Resume and disconnect cases. Preserve INV-15 and original archives; do not replay merged PR30/31. |
| 1B — parallel | Product console | M2 Warpshlczy; M1/M5 | Issue #3: input/profile/control state, selection/intent, pending/unknown output state, snapshot-first reconnect, one performer and no replay. Reuse M1 playback; any demo state-machine extraction requires owner review and must stay browser-safe. Production never imports test/. |
| 1C — parallel | Deterministic selection/intent and reaction rules | M3 shallight; M5/M4 | Issue #4: actual SelectionPort/ReactionPort modules cover eligibility, legal intent, defer/no-op, identity, cancellation and bounded attempts. Replace fixtures and rerun normal/Stop/defer. No Jev or SQLite dependency. |
| 1D — review | PR33/34 ownership and Kokoro worker | M5 lifecycle/composition; M6 dependencies/tooling; M1 implementation | Review PR33 before its dependent PR34. Retain one adapter/provider, keep physical occupancy through logical cancellation, await actual worker exit, verify dependency/script policy and decide development versus production packaging. PR34 smoke does not establish full product acceptance. |
| 1E — review | PR26 backup fix and SQLite increment | M6 MichaelLsh; M5/M4 | Independently rerun pinned-WAL-reader backup completeness/integrity and fail-closed migration tests; retain attribution/null/append cases. Reconcile the branch with merged PR30 and present the SQLite-only diff before human merge. |
| 2A — next integration | Real text and audio in production composition | M4 text provider; M1 synthesis/resources; M5 assembly/HTTP boundary | Inject SynthesisPort rather than constructing only fixed synthesis. Use controlled audio HTTP resources, one authoritative DeadlineGate and receipt transport. Verify usage, cancellation, lease release, explicit missing-config failure and fixed-loop regressions. |
| 2B — after safe PR26 adoption | SQLite startup and selected-history reconstruction | M6 persistence/discovery; M5 selection/fresh stopped session; M4 semantics | Actual SQLite close/reopen and process restart retain selected archives, null/partial attribution and old history after new delivery. Reject contradictory legacy data; never replay or promote unresolved output. |
| 2C — parallel | Effective CI and trace gates | M6 R3; M5 coordination; authorized maintainer settings | Wire real PR changed files, distinguish empty diff from acquisition failure, and demonstrate failing negative CI cases. Synchronize INV-10–15. Main currently requires review/linear history but not successful CI; making verify required needs a settings decision. G1/G4 remain explicit additional work. |
| 3A — after stable real loop | Model/Jev comparison and VTS | M3 decisions; M1 VTS; M4 semantic cases; M5 integration | Compare rules/general-model/Jev with dialogue/reaction held fixed and the planned combined-call baseline. Record all calls/usage/failures and held-out cases; confirm actual access/capacity. Do not presume models improve latency or quality. |
| 3B — throughout | S1 / R1–R6 and reproducible delivery | M5 R1/R2/consolidation; M6 R3/tooling; all R4/R5; M3/M4/M6 R6 | Preserve actual owner contributions, measured NFR fits, reviewed semantic thresholds, audible Stop/latency evidence and reproducible English report/demo/package. |

## Tracking and preservation

Issue #22 closed with PR30; its closure does not establish SQLite restart or full I1 acceptance. Remaining storage acceptance is in #25 and role issues #2–#7 remain open. Do not recreate duplicate #10–#21.

The [latest #25 agreement](https://github.com/inscripoem/isla/issues/25#issuecomment-6192331425) assigns C-49/C-50 to M4 guards and C-51 to M6 append validation; C-48 remains M6 migration. PR26 still needs the C-51 registry/code synchronization. M4's C-50 guard is published in PR35; registration and consuming review remain pending for the extended INV-15 trace. The owner-prefixed ID scheme in draft PR32 has M4 support but still awaits M5's decision and tooling enforcement; it is not adopted by this I1 slice.

Keep the original PR30 and I1 worktrees and verified archives. The current candidate is i1-main, detached at dbbbfcb; i1-current is the preserved 7297da4 candidate. Source and tests are unchanged by the rebuild. The unused deprecated application-protocol re-export is a low-priority cleanup candidate, not a reason to broaden this migration.

Report planned, locally verified, published for review, owner-accepted, human-merged and live-verified separately. Agents never merge. Course deadlines were not re-audited in this update.
