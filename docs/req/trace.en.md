# Requirements trace and approval record

Date: 2026-10-15. Status: under review. Scope: shared preparation, M5-01 and the Step A attribution/storage-test increment; not complete product acceptance or coursework D1.

This record links candidate requirements to machine-checkable acceptance criteria, cases, owners and automated checks. It records the actual supervisory review decision; it does not claim individual approval by all six team members.

## Registry, schema and case-to-test map

- Requirements: `docs/req/requirements.yaml`; schema `docs/req/req-schema.json` (exported from `src/contracts/requirements.ts`).
- Case-to-test registry: `docs/req/case-registry.yaml`; schema `docs/req/case-schema.json`.
- Validation: `src/evaluation/requirements-registry.ts` cross-checks each deterministic acceptance against the case registry: it rejects unknown case IDs, missing test files, absent test strings, deterministic entries without criteria, and deterministic entries citing pending cases. Checked by `test/offline/requirements.test.ts`.

## Case-to-test map

| Case | Status | Verifier file | Test / check |
| --- | --- | --- | --- |
| C-01 | implemented | `test/offline/composition.test.ts` | C-01/C-13 selection-to-delivery |
| C-02 | implemented | `test/offline/composition.test.ts` | duplicate input and control |
| C-03 | implemented | `test/offline/composition.test.ts` | late result after Stop is stale |
| C-04 | implemented | `test/conformance/runtime.conformance.ts` | `c04-second-partial` |
| C-05 | pending | — | decision timeout (full product) |
| C-06 | implemented | `test/conformance/runtime.conformance.ts` | `noop-zero-renderer` |
| C-07 | implemented | `test/conformance/runtime.conformance.ts` | `untrusted-control-refused` |
| C-08 | pending | — | reconnect while audio pending |
| C-09 | pending | — | synthesis failure after dialogue |
| C-10 | implemented | `test/offline/regressions.test.ts` | unknown resolves, no overwrite |
| C-11 | implemented | `test/offline/regressions.test.ts` | substitution preserves plan/delivery |
| C-12 | implemented | `test/conformance/runtime.conformance.ts` | `replay-no-live-change` |
| C-13 | implemented | `test/offline/composition.test.ts` | selected message and intent |
| C-14 | implemented | `test/offline/regressions.test.ts` | fallback for invalid/expired selection |
| C-15 | implemented | `test/offline/regressions.test.ts` | attempt accounting |
| C-16 | pending | — | intent and late fallback semantics |
| C-17 | implemented | `test/offline/composition.test.ts` | storage failure degrades, Stop responsive |
| C-18 | implemented | `test/offline/m6-storage.test.ts` | INV-04 event identity/sequence uniqueness |
| C-19 | implemented | `test/offline/m6-storage.test.ts` | INV-05 atomic commit persists nothing |
| C-20 | implemented | `test/offline/m6-storage.test.ts` | INV-06 projection does not advance across a gap |
| C-66 | implemented | `test/offline/m6-storage.test.ts` | projection bookmark is independent per session |
| C-21 | implemented | `test/conformance/storage.conformance.ts` | confirmed history is fully-delivered only |
| C-22 | implemented | `test/offline/m6-storage.test.ts` | JSONL export carries event version attribution |
| C-23 | implemented | `test/offline/m6-storage.test.ts` | event identity is session-scoped |
| C-24 | implemented | `test/offline/m6-storage.test.ts` | committed records are isolated from caller mutation |
| C-25 | implemented | `test/offline/m6-storage.test.ts` | confirmed history is ordered by the supporting event sequence |
| C-26 | implemented | `test/offline/m6-sqlite.test.ts` | SQLite storage configuration is validated (fail-fast) |
| C-27 | implemented | `test/offline/m6-sqlite.test.ts` | schema migrations are versioned, idempotent and recoverable |
| C-28 | implemented | `test/offline/m6-sqlite.test.ts` | a failed migration rolls back and leaves the prior version intact |
| C-29 | implemented | `test/offline/m6-sqlite-backend.test.ts` | SQLite backend passes the storage conformance suite |
| C-30 | implemented | `test/offline/m6-sqlite-backend.test.ts` | SQLite persistence survives reopen with isolation and order |
| C-31 | implemented | `test/offline/m6-sqlite-backend.test.ts` | SQLite persists the delivery terminal outcome for recovery |
| C-32 | implemented | `test/offline/m6-recovery.test.ts` | recovery view separates confirmed history from unresolved records |
| C-33 | implemented | `test/offline/m6-recovery.test.ts` | restart restores only confirmed history and keeps the rest unknown |
| C-34 | implemented | `test/offline/trace-fitness.test.ts` | traceability fitness functions accept a valid repository |
| C-35 | implemented | `test/offline/trace-fitness.test.ts` | traceability fitness functions reject a broken chain |
| C-36 | implemented | `test/offline/ai-use-log-gate.test.ts` | gate G6 requires the AI-use log for code/prompt changes |
| C-37 | implemented | `test/offline/trace-fitness.test.ts` | shared governed tables require an explicit owner per row |
| C-38 | implemented | `test/offline/m6-storage.test.ts` | a commit whose later mutation cannot be published leaves no partial state |
| C-39 | implemented | `test/offline/m6-storage.test.ts` | a conflicting atomic commit reports the conflict cause on both sides |
| C-40 | implemented | `test/offline/m6-storage.test.ts` | event content equality is insensitive to object key order |
| C-41 | implemented | `test/offline/m6-storage.test.ts` | event content equality keeps array order significant |
| C-42 | implemented | `test/offline/m6-sqlite-backend.test.ts` | the SQLite backend rolls back the whole batch when a later mutation fails |
| C-43 | implemented | `test/offline/m6-storage.test.ts` | an event whose payload is not a JSON value is rejected before publication |
| C-44 | implemented | `test/offline/m6-storage.test.ts` | a sparse array payload is not conflated with an empty array |
| C-45 | implemented | `test/offline/m6-sqlite-backend.test.ts` | the in-memory and SQLite backends agree end-to-end on accepted and rejected payloads |
| C-46 | implemented | `test/offline/m5-attribution.test.ts` | M6 delivery attribution persistence: strict fields, nulls, ordering and conflicts |
| C-47 | implemented | `test/offline/m5-attribution.test.ts` | M5 delivery attribution capture and reconstruction: normal, request mutation, Stop, late receipt, shared sessions, explicit indices and stable within-turn ordering (INV-15) |
| C-48 | implemented | `test/offline/m6-sqlite.test.ts` | legacy delivery attribution migrates safely (NULL preserved; unsafe legacy data refused) |
| C-65 | implemented | `test/offline/m6-sqlite.test.ts` | contradictory legacy classification/outcome is refused and the database is preserved |
| C-67 | implemented | `test/offline/m6-late-delivery-conflict.test.ts` | a late fully-delivered claim for a cancelled delivery conflicts and preserves the original evidence |
| C-51 | implemented | `test/offline/m6-storage.test.ts` | an event is validated against the schema before append mutates storage |
| C-52 | implemented | `test/offline/m6-02-metrics.test.ts` | failed and cancelled attempts remain in the aggregate |
| C-53 | implemented | `test/offline/m6-02-metrics.test.ts` | incomplete usage remains unknown rather than becoming a partial total |
| C-54 | implemented | `test/offline/m6-02-comparison.test.ts` | a thrown variant is recorded as a failure with a reason |
| C-55 | implemented | `test/offline/m6-02-report.test.ts` | the evaluation report rejects a fixture text source (this case covers fixture-source rejection only, not every report validation rule) |
| C-68 | implemented | `test/offline/m6-i1-storage-recovery.test.ts` | coordinator writes SQLite, closes and reopens, restores only confirmed history and keeps interrupted output unresolved |
| C-69 | implemented | `test/offline/m6-02-report.test.ts` | a not-run-only variant reports unknown failure rate and usage |
| C-70 | implemented | `test/offline/m6-02-recorded-run.test.ts` | a malformed or unpublishable recorded run is refused without output |
| C-71 | implemented | `test/offline/m6-02-bench.test.ts` | runBench produces a recording consumed by the real R1 command without losing attempts or not-run entries |
| C-73 | implemented | `test/offline/production-cli.test.ts` | `production CLI` — cooperative IPC shutdown, pending/failed release, duplicate/unrelated messages, startup/listen failure and raw exit reporting |
| C-74 | implemented | `test/offline/m5-process-restart.test.ts` | `production process restart acceptance` — two-process IPC continuation and SIGKILL between a committed prefix and held tail; no replay or promotion |

> C-73/C-74 are M5 suite-level verifiers, coordinated in [Issue25](https://github.com/inscripoem/isla/issues/25) following [M6 scope review](https://github.com/inscripoem/isla/issues/25#issuecomment-6313932602). C-73 covers the separate FR-05 process-lifecycle clause; C-74 covers FR-06/INV-12. Neither proves full product, Windows, torn-write/power-loss or acoustic acceptance. Scope and INV-12 edits were accepted by [M6 review at `8c36cad`](https://github.com/inscripoem/isla/pull/53#pullrequestreview-5599418482).
>
> C-68 is the distinct M6-01 coordinator/SQLite-reopen proof. C-32/C-33 remain
> the registered unit verifiers for the recovery view and storage-only restart;
> all three link INV-12.

### C-73/C-74 suite test names

The registry retains one verifier file per case. These are the exact test names at `8c36cad`, accepted as suite-level evidence by M6; this list adds no new acceptance claim.

C-73 — `test/offline/production-cli.test.ts`:

- `fails visibly when no deployment module is configured`
- `fails visibly when the deployment module cannot be loaded`
- `fails visibly when the deployment module exports no factory`
- `fails startup over a seeded live id and exits naturally with an IPC channel attached`
- `starts over a durable database, serves health, and shuts down on SIGTERM`
- `shuts down cooperatively through the IPC control message`
- `awaits a genuinely pending owned release before reporting IPC shutdown completion`
- `reports an incomplete shutdown and still exits naturally when the owned release fails over IPC`
- `ignores unrelated and duplicate IPC control messages`
- `awaits the owned release once when startup fails over a seeded live id`
- `awaits the owned release once on SIGTERM shutdown`
- `awaits a genuinely pending owned release before reporting shutdown completion`
- `reports an incomplete shutdown when the owned release fails`
- `reports a shutdown fault after a listen failure instead of swallowing it`

Same-file supporting coverage, outside the registered `production CLI` suite: `collectUntilExit output drain` / `retains output that arrives after the exit event until both streams end`. The registered suite contains 14 lifecycle tests; whole-file execution also runs this helper regression.

C-74 — `test/offline/m5-process-restart.test.ts`:

- `continues one durable database across two spawned CLI processes without replay or promotion`
- `restarts after a forceful kill without promoting the interrupted tail`

## Requirement trace

| Requirement | Owner | Deterministic cases | Pending |
| --- | --- | --- | --- |
| FR-01 | M3 | C-13, C-14, C-15 | C-16 |
| FR-02 | M4 | C-01, C-04, C-13 | — |
| FR-03 | M1 | C-06, C-11 | — |
| FR-04 | M1 | C-01, C-04, C-10 | — |
| FR-05 | M5 | C-03, C-04; C-73 (separate controlled-process-lifecycle clause) | C-08 |
| FR-06 | M6 | C-12, C-17, C-21, C-22, C-29, C-30, C-31, C-32, C-33, C-45, C-46, C-47, C-67, C-68, C-74 | product-console recovery adoption, Windows and live-provider acceptance; C-74 covers controlled Linux process continuation only |
| NFR-01 | M5 | C-52, C-54, C-55, C-69, C-70, C-71 | metric baseline |
| NFR-02 | M5 | C-10, C-17 | C-05, C-09, recovery duration |
| NFR-03 | M3 | — | C-16, human rubric (docs/decision/m3-quality-rubric-v0.1.md, draft) |
| NFR-04 | M3 | C-15, C-52, C-53, C-69 | cost/token caps |
| NFR-05 | M5 | C-07 | retention/deletion |
| NFR-06 | M1 | C-11 | — |
| INV-01 | M5 | C-03, C-04 | — |
| INV-02 | M5 | C-06 | — |
| INV-03 | M5 | C-07 | — |
| INV-04 | M6 | C-18, C-23, C-39, C-40, C-41, C-43, C-44, C-51 | — |
| INV-05 | M6 | C-19, C-38, C-42 | — |
| INV-06 | M6 | C-20, C-66 | — |
| INV-07 | M6 | C-24 | — |
| INV-08 | M6 | C-25 | — |
| INV-09 | M5 | C-46, C-47, C-67 | M4/SQLite consumer rollout |
| INV-10 | M6 | C-26, C-27 | — |
| INV-11 | M6 | C-27, C-28, C-48, C-65 | — |
| INV-12 | M6 | C-32, C-33, C-68, C-74 | C-74 link accepted by [M6 review at `8c36cad`](https://github.com/inscripoem/isla/pull/53#pullrequestreview-5599418482); product/Windows acceptance remains separate |
| INV-13 | M6 | C-34, C-35, C-37 | — |
| INV-14 | M6 | C-36 | — |
| INV-15 | M5 | C-47, C-50 (turn reconstruction ordering and M4 agreement guard) | M4/M6 consumer acceptance |
| INV-16 | M6 | C-52, C-53, C-54, C-55, C-69, C-70, C-71 | — |

> **M3-01 module-level prerequisite.** `src/decision/selection.ts` and
> `test/offline/m3-decision.test.ts` provide FR-01 module-level evidence for the
> rule port, corpus loading and exact-one/deadline/failure observations. This is
> not a registered composition case: C-13 remains the registered
> selection-to-delivery verifier. No new case ID is assigned; C-05/C-16 remain
> pending. Direct runner evidence is not full-pipeline S6 evidence.

## Ordering trace correction (2026-10-15)

The [issue #25 coordination](https://github.com/inscripoem/isla/issues/25#issuecomment-6188155358) separates two existing guarantees. The helper header previously cited INV-08 in error; its within-turn rule is now INV-15, owned by M5. INV-08 and C-25 continue to describe M6 supporting-event read order. Runtime behavior and assertions are unchanged. The existing ordering suite now shares the `M5 delivery attribution capture (C-47)` verifier prefix, so the C-47 test-name filter selects both capture and reconstruction checks. No case ID is added.

| Coordinated mapping | Owner / state |
| --- | --- |
| M5 helper header: INV-08 → INV-15 | Local correction under review; not a renumbering of the M6 invariant |
| M6 config / migration / recovery: INV-09 / INV-10 / INV-11 → INV-10 / INV-11 / INV-12 | Adopted with PR26; merged into main `a2ecb86` |
| M6 trace gate / log gate: INV-12 / INV-13 → INV-13 / INV-14 | Adopted from merged PR27 on main `c2f9b38`; existing historical log entries retain their original IDs |
| C-48 | M6 legacy-null migration/reopen; implemented in PR26 and merged into main `a2ecb86` |
| C-65 | Contradictory legacy-row quarantine; separate C-48 null-preservation proof |
| C-49 | Allocated to M4 admission divergence; registered on PR35 `b6c078d`, not adopted in this branch |
| C-49 / C-50 / C-51 allocation | PR42 merged the active M6 append-validation migration to C-51; C-49/C-50 remain M4 allocations on PR35. [Issue25](https://github.com/inscripoem/isla/issues/25#issuecomment-6232454938) remains the numeric/ADR coordination location |

## Approval record

| Item | Decision | Basis |
| --- | --- | --- |
| READINESS-PLAN | Approved by the user on 2026-10-10 after a Chinese explanation | AGENTS.md authorization |
| Contract/test design | Approved by the supervisor after corrections | `docs/team/READINESS-REVIEW.en.md` |
| First-slice acceptance cases | Reviewed before implementation | READINESS-REVIEW |
| Step A and relevant unsubmitted storage tests | PR30 human-merged into main dbbbfcb after formal approval | [PR30](https://github.com/inscripoem/isla/pull/30); issue #22 is closed. The separate local I1 increment requires publication approval. |
| Final numeric quality/performance/cost/retention targets | Not approved | Await a reviewed measured baseline |

## Honest limitations

- The first-slice checks prove contract boundaries and Stop/receipt semantics for the cited cases only; they do not prove C-05/C-08/C-09/C-16 or any live provider, browser audio or durable SQLite behavior.
- NFR-02 recovery duration and NFR-05 retention remain pending, not accepted.
- A finite fixture suite is not a universal security or correctness proof.

## M5-01 production increment

The composition and regression suites now run the same assertions against the independent fixture reference and `src/runtime/coordinator.ts`, through the test-only adapter. `test/offline/m5-coordinator.test.ts` adds production-specific deadline, cancellation, receipt, persistence and input-boundary checks. This supplies scoped M5 evidence for the existing requirement/case links; it does not change requirement owners or promote pending product cases. See the [M5-01 handoff](../team/HANDOFF-M5-01.en.md) for actual commands/results and remaining I1-01 reviews. Status: under review.

## Local I1 application increment

The user approved local I1 implementation on 2026-10-15. The application endpoint composes the real M5 coordinator, M1 fixed synthesis/player and M6 in-memory store with real M4 and explicit M3/dialogue-provider substitutes. New I1 tests cover transport, deadline and lifecycle boundaries; the candidate rebuilt on main `dbbbfcb` with merged PR30/PR31 passed 634 tests / 30 files plus typecheck, lint and build, retaining its ten-case M4/M6 consumption suite. Browser turns, Stop/Resume and disconnect cancellation were independently observed again on this candidate. See the [I1 handoff](../team/HANDOFF-I1-APPLICATION.en.md). This is uncommitted work under review, without remote publication. PR30 already moved the M5 attribution case from C-45 to C-47, preserving C-46 and M6's draft C-45; role ownership and full-course acceptance status remain unchanged.

## M1-02 D offline connection prerequisite

`src/performance/vts-connection.ts` and its helper `test/support/m1-vts-connection-kit.ts` are an offline module-level prerequisite for a future D/M5 connection composition. The appended suite in `test/offline/m1-performance.test.ts` is selected by the existing M1 role command `pnpm test:m1`. This note adds no registered case or requirement row and assigns no ID. Existing case-verifier rows, requirement ownership and pending product status are unchanged; live pairing, authentication, model/hotkey verification, device actions and production physical-close recovery remain unimplemented and require M5/M6 review and separate acceptance.


## M1-02 D2 offline pairing prerequisite

[`src/performance/vts-pairing.ts`](../../src/performance/vts-pairing.ts) supplies the private protocol prerequisite for M1-02 authenticated-connection handoff, supporting FR-03/FR-04/FR-05 and NFR-06 at module scope. The controlled peer/provider helper is [`test/support/m1-vts-pairing-kit.ts`](../../test/support/m1-vts-pairing-kit.ts); actual primitive, cancellation/cleanup and same-handle C-client regressions are appended to [`test/offline/m1-performance.test.ts`](../../test/offline/m1-performance.test.ts), selected by the existing `pnpm test:m1` command. These are prerequisite checks, not a newly registered global case or closure of an existing product verifier.

M5 supplies the finite overall acquisition signal, deployment budgets and identity/target-bound credential provider, including serialization while a shared-record save is unsettled. A test-only caller/provider illustrates that boundary; it does not implement or validate M5 production storage/composition. The original case rows, requirement owners, D1/C APIs and registered identifiers are unchanged. Live VTS pairing/authentication, verified model/hotkey actions, physical output, Windows recovery, real measurements and G4/S6 acceptance remain separate and unclaimed.

## M5 VTS acquisition prerequisite (2026-10-27)

[`src/runtime/vts-acquisition.ts`](../../src/runtime/vts-acquisition.ts) consumes the real M1 D1/D2 primitives for one bounded acquisition, cancellation, same-handle handoff and explicit release. Its record-aware credential coordinator serializes operations for a plugin identity and target when deployment callers share one coordinator per store. This supplies module-level support for FR-03/FR-04/FR-05 and NFR-02/NFR-05/NFR-06; it does not change their owners or satisfy their complete product acceptance criteria.

The 23 original cases in [`test/offline/m5-vts-acquisition.test.ts`](../../test/offline/m5-vts-acquisition.test.ts) (25 after the 2026-10-28 follow-up), selected by `pnpm test:m5`, exercise the production module with [`test/support/m5-vts-acquisition-kit.ts`](../../test/support/m5-vts-acquisition-kit.ts). The cases check cancelled/expired acquisition, late-handle closure, explicit stopped replacement, physical-close and subscription-cleanup failure, record-bound load/save exclusion, and delayed-save settlement. The successful-handoff case also uses the real C client; pre-abort and coordinator-only cases intentionally perform no pairing. See the [handoff](../team/HANDOFF-M5-VTS-ACQUISITION.en.md) for the exact verification scope and deployment obligations.

Follow-up (2026-10-28). Two cases were appended without changing the existing case bodies or production behavior. One uses fake timers and a manual-close fixture socket to prove that a connector handle arriving after owner cancellation stays blocked during its bounded close, latches `quarantined` when the close times out, and remains `quarantined` after the physical close later completes, with replacement and release refused. The other proves that a competing same-record load is refused before the store effect and reaches D2 as `credential_read_failed`, without deleting the stored value or prompting again. Initial author checks and the subsequent independent review are recorded separately in the handoff; neither extends M1's approval to this changed candidate.

These are supporting module tests, not a newly registered global case. Existing case rows and identifiers remain unchanged; C-08, recovery duration, retention/deletion, live VTS, physical output, Windows and S6/G4 acceptance remain pending. Production CLI/renderer assembly, a real credential store, and recovery from a quarantined connection are not part of this slice.

## M5 mention follow-up (local, 2026-10-22)

The [M5 mention handoff](../team/HANDOFF-M5-MENTIONS.en.md) records outcome/deadline consumer checks and bounded input preparation. `test/offline/m5-dialogue-outcome.test.ts`, `m5-production-application.test.ts` and `m5-evaluation-adapter.test.ts` supply scoped regression evidence. They do not redefine an existing registered case or allocate an ID. C-05/C-16 remain pending until the agreed cross-owner verifiers, real execution conditions and semantic evidence are reviewed. Deterministic boundary tests do not close NFR-03 or establish S6/G4.

The final coordinator regressions cover exact selection/reaction deadlines, accepted clarify intent and exact candidate expiry; their full executable names are in the linked handoff. Coordinator/adapter checks passed 121/2; M5 passed 203/9 and full verification passed 1223/69. These results do not promote C-05/C-16 to registered completed verifiers.
