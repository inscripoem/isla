# Isla delivery plan

Revision: 2026-10-17.9. Status: under review. Existing roles and workload ratings are unchanged. This snapshot follows the October 17 M5 reviews and numeric reservations; newer heads require renewed checks.

## Current baseline

Main is `8937f7daed875b85839e91967dea5e72af210471`, including PR26 SQLite and PR42's storage evidence/C-51 migration. The local `feat/i1-application-loop` branch in `i1-main` adopts that main from the clean signed integration `4c42126`. Both log histories are retained; the package preserves `dev:loop` and runs all six M6 storage suites. No production/browser source or new test implementation was changed by this adoption.

Remote PR36 remains `191f58b`. [M1's approval](https://github.com/inscripoem/isla/pull/36#pullrequestreview-5548740603) covers that repaired fixed-audio consumer/interface scope only. M2 review and renewed review of the unpublished local increment remain pending.

| PR / head | State at this snapshot | Evidence / next action |
| --- | --- | --- |
| [26](https://github.com/inscripoem/isla/pull/26) `68e38c4` | Merged | SQLite implementation on main; application recovery acceptance remains separate |
| [27](https://github.com/inscripoem/isla/pull/27) `f926a71` | M5 approved | Independent 188 targeted tests / 12 files; push and PR CI pass; human merge decision pending |
| [32](https://github.com/inscripoem/isla/pull/32) `f000a8e` | M1 approved | M5 interpretation confirmed; refresh the post-PR42 inventory and residual summary wording |
| [33](https://github.com/inscripoem/isla/pull/33) `b70843c` | Approved; conflicts with main | Owner reconciliation pending; prior tests remain tied to their original revision |
| [34](https://github.com/inscripoem/isla/pull/34) `cb91f53` | M5 approved; stacked on PR33 | Current approval does not establish integration with main |
| [35](https://github.com/inscripoem/isla/pull/35) `b6c078d` | Changes requested | Combined maxTurns repair present; independent 83 M4 + 41 readiness checks pass, but a separate cross-session displacement probe loses a pinned record |
| [36](https://github.com/inscripoem/isla/pull/36) `191f58b` | M1 old-scope approval; M2 requested | Local diagnostics/integration remain unpublished; current validation below |
| [40](https://github.com/inscripoem/isla/pull/40) `7edc9b2` | Draft; conflicts with main | Independent 52 evaluation tests / 4 files; push CI passes; report writer, production adapter and real measurements pending |
| [42](https://github.com/inscripoem/isla/pull/42) `a1cd5fc` | Merged as `8937f7d` | Independent 96 storage + 41 readiness checks before merge; committed-WAL claim narrowed, C-51 active on main |

CI, independent tests, review approval, human merge and product acceptance are separate facts. PR27/35/40 were checked with targeted suites, not independently repeated full builds. The PR42 fixture proves committed-WAL recovery; uncommitted-tail recovery and an actual process kill remain unverified.

## Immediate coordination

1. [PR27 approval at f926a71](https://github.com/inscripoem/isla/pull/27#pullrequestreview-5557051657) follows the C-51 adoption and unavailable-before-commit resolver fix. Human merge remains pending. G1 stays advisory.
2. [PR35 changes requested at b6c078d](https://github.com/inscripoem/isla/pull/35#pullrequestreview-5557051916): recall displacement keys only by turnId, so two restored sessions sharing that ID can both be removed, including a pinned record. M4 must repair and publish the session-scoped behavior; retention-default wording also needs correction.
3. [M4 acknowledged HistoryQueryPort](https://github.com/inscripoem/isla/issues/25#issuecomment-6231206974). C-49/C-50 are registered on PR35 after main's C-51 migration; they are not adopted in this branch. [M5 reserved INV-16 and C-52–C-55 for M6](https://github.com/inscripoem/isla/issues/25#issuecomment-6231858718); M6 registers the rows and validates references. Reservations do not establish merged coverage.
4. The local PR36 adoption has passed verification; update its exact-revision publication package, then obtain publication approval and renewed consumer review. The existing M1 approval does not cover the local diagnostics increment.
5. Continue [Issue41](https://github.com/inscripoem/isla/issues/41#issuecomment-6231056482) and the original M2/M3 deliveries. The production runVariant adapter remains M5 work; M6 can implement the report-writing command independently. M3 supplies the rubric/version and observe-versus-enforce caps decision. Metric start/end events, clock domains and observation methods remain provisional; actual audible/silence metrics remain unknown. [Issue37](https://github.com/inscripoem/isla/issues/37) remains open for browser-safe product extraction and coordinated status/decoder adoption.

## M5 local increment and verification

The diagnostics/order/cache increment was authored through genuine OpenCode work, preserved in checkpoint `f25ab81`, and integrated with the prior main at `4c42126`. It adds a bounded local diagnostic callback, held-store ordering and duplicate-terminal regressions, and cached-terminal retirement checks. Coordinator/bridge/wire behavior did not require a new compatibility repair. The original 137-message follow-up and 53-message integration exports remain preserved outside the repository.

Historical validation: the pre-integration increment passed 667 tests / 34 files. At `4c42126`, independent full verification passed 695 tests / 37 files, typecheck, lint and build. Muted fixed-WAV browser checks at that revision covered two turns, Stop after started, Resume/new turn, reload without replay then a new turn, and socket closure followed by local cancellation. These are media-API observations, not acoustic, live-provider or full application SQLite recovery acceptance.

Current C-51 adoption validation: independent `pnpm verify` passed 703 tests / 39 files, typecheck, lint and build. All local and main historical log entries are preserved; the three adopted storage test files match main exactly. This adoption directly maintains documentation and integrates already-authored upstream tests; it does not create a new OpenCode development session. Browser source is unchanged, so the historical browser observation remains explicitly tied to `4c42126`.

Preservation: signed `4c42126` and the external `pr36-c51-adoption-20261017` archive are the rollback anchors. Both historical log entry sets are retained; the new entry records this actual integration. No reset/clean or remote publication is included. Preserve later user edits before any restoration.

## Remaining delivery sequence

| Order | Work | Owner / collaborators | Acceptance |
| --- | --- | --- | --- |
| 1A | PR36 follow-up publication and consumer acceptance | M5; M1/M2 | Exact-revision review; two turns, Stop/Resume, reload/disconnect, physical-status and grant regressions |
| 1B — parallel | Product console | M2; M1/M5 | Snapshot-first reconnect, one performer, input/profile/control and pending/unknown output state |
| 1C — parallel | Selection/intent and reaction rules | M3; M4/M5 | Replace fixtures; normal/Stop/defer, eligibility, identity, cancellation and bounded attempts |
| 1D — review | Merged PR26/42 consumption; PR33/34/35 review and adoption | Module owners; M5 | Human merge and consuming checks; retain resource ownership and M4/INV-15 follow-ups |
| 2A | Real text/audio production composition | M4 text; M1 synthesis/resources; M5 assembly/HTTP | Inject SynthesisPort; controlled audio resources, one DeadlineGate, cancellation/lease cleanup and explicit missing-config failure |
| 2B | SQLite startup and selected-history recovery | M6 persistence/discovery; M5 selection; M4 semantics | Close/reopen and process restart retain selected archives and partial/null attribution; no replay or promotion of unresolved output |
| 2C — parallel | Effective CI and trace gates | M6 R3; M5 coordination | Real diff and negative CI evidence; synchronized ownership/trace. Required-check settings need a separate decision |
| 2D — parallel | Shared evaluation bench | M6; observations from M1–M5, cases/rubric from M3/M4 | Issue41 boundaries agreed before real measurements; explicit synthetic results meanwhile |
| 3A | Model/Jev comparison and VTS | M3/M1; M4/M5 | Stable real loop, fixed conditions, held-out cases, all attempts/usage/failures and actual access |
| 3B — throughout | S1 / R1–R6 delivery | M5 R1/R2/consolidation; M6 R3; all R4/R5; M3/M4/M6 R6 | Genuine owner evidence, measured NFRs, reviewed rubric, English report/demo/package |

M5's Issue41 proposal retains the injected `VariantRun` seam and production assembly ownership. Each owner supplies execution and observations; M6 aggregates. Timing requires agreed start/end events, clock domains and observation methods. `CycleTimings` are timeout budgets; first-in-run does not establish actual cold state; benchmark cases do not establish provider attempt counts. Audible/silence metrics remain unknown until an actual-output method is agreed.

## Coordination and preservation

Main now assigns C-51 to M6. C-49/C-50 remain M4 allocations on PR35; INV-16/C-52–C-55 remain M6 reservations until registered. M5 extends INV-15 to M4's path and C-50 after the reviewed rows and implementation are adopted. This branch retains its existing INV-15/C-47 coverage without importing unmerged module work.

The future owner-prefixed naming scheme requires corrected PR32 documentation, supporting ID validation and a recorded adoption revision. Until then use numeric reservations in Issue25; M5 coordinates global ADR reservations there. G1 enforcement still needs verified wiring and the recorded team activation decision; no enforcement or branch-setting change occurred.

Issue22 closed with PR30; this does not complete I1 or durable recovery. Issues2–7/25/37/41 remain open. Preserve the PR30, i1-current and i1-integration worktrees and archives. Agents never merge GitHub PRs. Course deadlines were not re-audited.
