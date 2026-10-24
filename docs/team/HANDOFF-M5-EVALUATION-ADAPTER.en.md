# M5 evaluation adapter handoff

Current baseline: [main f972b32d6174b4827eebcb1d421a5b069968226e](https://github.com/inscripoem/isla/commit/f972b32d6174b4827eebcb1d421a5b069968226e), including merged PR35, PR48, PR51 and PR52. PR52 was merged by MichaelLsh at f972b32; its merged tree is identical to the reviewed head `eae51b49` and carries the C-66 P3 fixture getter (`47d9289`) and the INV-16 row (`ec77749`). Earlier increment counts below retain their original scope. See [DELIVERY-PLAN](DELIVERY-PLAN.en.md#current-baseline) for owner work and current PR states.

Revision: 2026-10-22.1. The deterministic-timing repair below is published in PR53 at `8c36cadadf64da2b543aacd930392090b9e4a7cd`. The new local outcome/deadline and input-preparation increment is described in [the M5 mention handoff](HANDOFF-M5-MENTIONS.en.md); it remains under review and unpublished. Earlier verification counts retain their original scope.

## Current M5-only review follow-up (2026-10-24)

This local candidate is based directly on published Draft PR55 at b4be30e7a49f5a15bef735a85f3afeadca67086b. The prior introductory status above is the historical 2026-10-22 snapshot: PR53 is now merged on main at 0868e0a, and the original outcome/input-preparation increment is already published in PR55. This follow-up changes only M5 runtime code, its tests, this handoff and a separate M5 development record. It does not retarget the PR or edit another owner's source or original evidence entries.

Addresses [M1 review 5626125615](https://github.com/inscripoem/isla/pull/55#pullrequestreview-5626125615). The diagnostic cutoff is the copy of dialogueOutcomes/dialogueOutcomeFailures immediately before onObservation is invoked. A forwarded onDialogueOutcome promise may reject later; its rejection is contained but cannot amend those captured arrays or the already decided execution result. Never wait for an unbounded diagnostic observer during Stop or attempt completion.

Two regressions reject a controllable onDialogueOutcome promise only after the comparison completes, and hold a never-settling callback while real Stop completes. They check the unchanged diagnostic snapshot, execution outcome, delivery evidence and confirmed history. Separate hardening contains rejected thenables returned by onObservation itself without awaiting them, with corresponding late-rejection and never-settling regressions. This does not claim that the entire observation object is deeply immutable.

The exact source/test changes were authored in OpenCode 2.1.2 session ses_e93d60c5fffeh3Wdrwp9hdjZ5E, build/self-api/deepseek-v4-flash/xhigh. They are copied byte-for-byte from that verified development candidate; no new code-authoring session is claimed for this extraction. Earlier 1246/69 M5-combination and 1316/69 cross-module results keep their original scope. Independent verification of this separate PR55-only candidate passed M5 207 tests / 9 files and full pnpm verify 1246 / 69, including typecheck, lint and build. The actual four-file b4-to-candidate G6 and diff checks passed; all other tracked files and the original AI-use log prefix remain unchanged.

This candidate remains local, uncommitted and under review. Previous approval stays tied to b4be30e; new publication requires Captain's confirmation. No new shared contract, corpus mapping, scorer, VTS connection or memory inspection panel is introduced. C-05/C-16, Windows/live-provider/acoustic and S6/G4 acceptance remain separate. Other owners retain their repairs and branch updates.

## PR53 deterministic-timing follow-up

The held-playback regression uses controlled timers installed before the harness clock is created. Each of the two offers waits for explicit ready release; playback must reach the controlled media's started boundary before time advances to the performer's local expiry. Both actual cancelled receipts must remain visible, output confirmation must be confirmed, and committed delivery must remain partial-unknown rather than completed speech.

A separate case releases ready after more than half of this setup's playback budget. The performer refuses playback; no media handle or delivery is created, and the attempt remains failed with unknown confirmation. The synchronous test transport does not persist the immediate offer-expired receipt because it arrives while the bridge is still marking the grant. The test therefore also advances the coordinator deadline and checks its durable unknown evidence. This is a limit of the direct test route, not validation of a network transport or a reason to fabricate cancellation.

This evaluation repair changes the evaluation test only; the production adapter, browser player, coordinator, shared contracts and dependencies remain at the pinned main revision. The separate CLI shutdown hardening is described in [the production handoff](HANDOFF-M5-PRODUCTION.en.md). M2 product adoption, live providers, actual-output measurements and S6/G4 remain separate work. The genuine implementation session is `ses_ea64bf454ffeCizP5ooUs5nqzM`, OpenCode 2.1.0, `self-api/deepseek-v4-flash#xhigh`, agent build; the supervisor maintains documents and performs independent verification.

Independent verification of this local follow-up: adapter 21/21; both timing cases passed ten consecutive runs; M5 171/8; full verification 1125/63 plus typecheck, lint and build passed. The exact second-cancellation-to-unknown mutation times out because prior started evidence is retained; the assertion-level variant also withholds that output's intermediate receipts and fails with unknown instead of confirmed, while both media starts still occur. A forced pre-start timeout leaves the next real-timer test passing. All mutations were restored byte-for-byte before the final checks. Both tests restore real timers in finally, with afterEach restoration and consumer disposal as a timeout fallback. Integration onto main f972b32 preserved the merged M6 log entries; reruns on the integrated tree passed adapter 21/21 and M5 171/8 (exit 0) before the separate CLI hardening, after which M5 passed 173/8 and full verify 1128/63 (exit 0). The subsequent process-test review leaves this evaluation test byte-identical. Final combined checks are recorded in the delivery plan; the 1128/63 result above belongs to an earlier CLI candidate.

## Scope and baseline

`src/runtime/evaluation-adapter.ts` supplies M6's `ComparisonDeps.runVariant` by executing the real M5 control/input/turn path with explicit deployment peers. It is based on [PR40 e44f6ce0a985853eb298cd53f42824dd3dfe5ec4](https://github.com/inscripoem/isla/commit/e44f6ce0a985853eb298cd53f42824dd3dfe5ec4), with the separately reviewed M5 production application and dynamic audio increments adopted locally. M6 retains its runner, metrics, report writer and the merged R1 report command/R2 recorded-run harness; no M6 source or shared contract was changed.

This increment implements execution and accounting plumbing. It does not establish a live provider run, acoustic measurements, a quality score, cap compliance or a G4 pass.

## Caller contract

Call `createEvaluationAdapter` with caller-owned `EventStorePort` and `HistoryQueryPort`, explicit `{ variant, peers }` configurations, and an audio consumer. Pass its `runVariant` method to the existing `runComparison` dependency. Each case gets a fresh session, real Resume and input submission, a real coordinator turn, and an admitted evidence drain before the record is assembled. The adapter leaves caller storage open.

| Input | Contract |
| --- | --- |
| Variant and peers | Requested `id`, `kind` and `combined` must match the configured variant. Supply M3 selection/reaction, M4 text source, M1 synthesis/renderer factories and the intended character/voice profile explicitly. No fixture fallback is installed by the adapter. |
| Consumer | `attach(composition)` binds a real output consumer and its bridge/receipt routing. Optional `detach()` releases it and must tolerate a failed attach. The production adapter imports no test performer. M2's product consumer remains owner work. |
| Storage/history | Existing M6 ports; SQLite is used by the acceptance suite. A session ID already present in the store or already claimed by this adapter is refused before execution. Use the normal sequential M6 comparison runner; concurrent calls sharing one consumer are not an accepted deployment mode. |
| Case | The default submits `input` unchanged. The optional `input: { mode: 'prepared', resolve(caseId) }` plan admits a validated batch of up to five source/text/actor entries before one turn; see the [current handoff](HANDOFF-M5-MENTIONS.en.md). A supplied `replyIntent` is explicitly refused before any work: this mode evaluates the configured selection port and does not override its decision. Intent-constrained cases require a coordinated M3/M6 execution mode; removing a condition changes the experiment. Human labels and held-out metadata are not scored or enforced here. |
| Observation | Optional `onObservation` receives `sessionId`, case/variant identity, raw cycle/dialogue status, delivery classifications, invocation provenance and cleanup diagnostics. Use `sessionId` with the caller's store to retrieve the actual event history. |

Missing peers/consumer, mismatched variant metadata, unsupported case conditions and non-fresh sessions produce explicit not-run reasons. Once input is admitted, a failed or cancelled attempt remains a record. Setup failures are not silently converted into executed provider attempts.

## Receipt cutoff and observation lifetime

The admitted drain seals receipt admission before the adapter reads its result evidence. A later player-message call increments the coordinator's in-memory `RuntimeMetrics.lateReceipts` counter and returns without validation, output-state changes, storage or memory commits. Missing terminal evidence is not upgraded to completed delivery; established completion is not regressed. This counter counts calls, not validated receipts or acoustic outcomes.

The counter is available on the retained coordinator instance; it is not persisted or added to the recorded-run schema, and a call arriving after the adapter captures its observations does not retroactively alter that record. The caller must observe the instance while it exists if it needs this refusal count. The production shutdown order and durability limit are described in [the production handoff](HANDOFF-M5-PRODUCTION.en.md#receipts-after-the-operation-seal). No discarded receipt is fabricated as a delivery or reported as a storage failure.

## Outcomes and measurements

A completed cycle requires at least one matching effective fully-delivered record and all committed deliveries for that turn to be fully delivered. A zero-output cycle or a consumer that supplies no effective terminal evidence cannot produce bench completion. The adapter reads recorded dependency, dialogue and delivery evidence because the coordinator uses `cancelled` for some execution-failure paths. An observed operator Stop remains cancellation; other non-completed paths produce a failure reason.

Storage boundary assumption: `hasEffectiveCompletedDelivery` inspects the committed classification and relies on the production M6 write boundary to validate the `fully-delivered` / `completed` terminal-outcome pair. A custom store must enforce the same `CommitDelivery` validation; a classification-only mock or unvalidated legacy/imported record does not establish that guarantee. The adapter does not independently validate the pair.

Confirmed cancellation and completed speech are different facts. A cancelled receipt can leave output confirmation `confirmed` while delivery remains `partial-unknown`. Missing terminal evidence remains unconfirmed and never enters fully-delivered history. These local receipts do not prove acoustic audibility or silence.

| Field | Current meaning and limit |
| --- | --- |
| `caseId`, `variantId`, `cold` | M6 owns labels and first-attempt bookkeeping. First in a comparison does not establish a cold process, worker, provider or cache. |
| Stage timings and `totalMs` | All remain `null`. Budgets and successful coordinator wall time are not first-audible measurements. Stage boundaries and actual-output methods remain an I1-01 owner dependency. |
| `attempts` | `null`: port invocations do not prove underlying model requests or retries. Separately labelled selection/reaction/dialogue counts remain available in the observation. |
| Usage | `provider.call` and `provider.usage.late` join by the full invocation identity; late usage updates the original invocation. Missing counts stay unknown. M5 does not infer token counts from completion: it reports counts only when present in recorded invocation evidence. M4 deadline expiry retains `DialogueEnd.usage.status: timeout`, distinct from ordinary cancellation; the coordinated provider/usage extension in Issue44 remains separate adoption work. |
| Cost | `null`: `UsageRecord` has no observed monetary amount; `pricingRef` is not a price. |
| Cleanup | Drain/detach/disposal faults are appended to the returned record's `failureReason`, preserving the observed output outcome, usage and any earlier execution reason. Thus a `completed` output can carry a cleanup failure and must not be treated as successful cleanup. Refused attempts append cleanup faults to the not-run reason. |

`evaluation.cleanup.failed` is an additional diagnostic event, not the only error channel. Thrown/rejected diagnostic writes remain visible in the returned cleanup reason. An observation-callback-only exception does not invalidate actual output; its diagnostic write is best effort. The adapter's drain bounds admitted evidence; it does not wait forever for a provider that ignores cancellation or prove physical provider exit. When combined with [retained physical synthesis](HANDOFF-M5-PHYSICAL-SYNTHESIS.en.md), the evaluation caller owns the shared provider and awaits its release through actual worker exit; an individual attempt does not close that shared provider.

## Combined acceptance

The integration tree also adopts [PR34 a2c2216dca37814f2e3b6518c1a79d85ccb333b5](https://github.com/inscripoem/isla/commit/a2c2216dca37814f2e3b6518c1a79d85ccb333b5), including PR33, and the frozen M5 physical lifecycle. One additional evaluation case uses the actual adapter/runner, retained synthesis, real M1 registry and a controlled real Node worker. The consumer acquires the generated resources; their leases are released before completed receipts. Success and reuse complete with effective fully-delivered evidence; operator Stop during a held job is cancelled; the next attempt fails with busy until that original job settles. No replacement generation starts. The caller closes the provider once through actual thread exit.

Independent combined `pnpm verify` passed 1008 tests / 57 files with typecheck, lint and build; the source checkpoint stayed unchanged. The evaluation suite now has 20 cases and M5 has 168 / 8. The failure-cleanup check intentionally broke the busy assertion, observed 19 passed / 1 failed and process exit, then restored it before successful verification. The existing consumer helper and production code needed no changes for this acceptance. The refusal currently renders `unknown: busy` because the coordinator event has no stage field; the failure classification is correct. This is a low-priority diagnostic limitation, not a model/acoustic measurement.

## Earlier independent increment verification and remaining work

- Independent `pnpm verify`: 922 tests / 55 files, typecheck, lint and build passed.
- Focused adapter suite: 19 cases through the actual M6 runner; M5 suite: 146 tests / 7 files passed.
- Coverage includes real SQLite evidence, pre-attempt refusal, session reuse rejection, zero-output and missing-terminal refusal, synthesis/dialogue failure, Stop before grant and after actual controlled-media start, late-usage joins, and cleanup/diagnostic failures without a working callback.
- Independent synthesis-failure probe changed from incorrect cancellation/failure rate 0 to failure/rate 1 with the recorded reason. The cleanup probe now retains both detach and diagnostic-write failures in the returned record.
- Historical held-playback runs passed after adding a 15 ms readiness delay, including ten focused and two full runs. The new delayed-readiness probe disproves the claim that this wall-clock wait establishes deterministic ordering: an extra 25 ms before the second ready yields unknown confirmation in 3/3 runs, versus confirmed in 3/3 controls. The local follow-up supersedes that test strategy; these are controlled-media observations, not acoustic or Windows acceptance.
- Actual-change trace/G6 and G4 status are recorded in the external review evidence. No evaluation table or live G4 pass is claimed. The full native session export is now preserved externally: 1640 unique records, valid JSON and terminal succeeded/idle metadata matching the native API. Earlier partial captures remain historical and are not substituted for this complete export.

M3 must provide real decision implementations and reviewed cases/rubric; M4 must complete its reviewed dialogue/usage interface and cases; M1/M2 must provide the product consumer and actual-output measurement method; M6 retains recorded-run/report tooling. Review the supplied-intent mode and cleanup-reason interpretation with M3/M6 before a real comparison. Keep existing role ownership, case IDs and invariant allocations unchanged.

The genuine OpenCode build session is `ses_eb01582deffe1lXlytG5wjv8Gm` (`self-api/deepseek-v4-flash#xhigh`, OpenCode 2.0.32). OpenCode authored the application/test changes; the supervisor reviewed, probed, independently verified and prepared this handoff. The original increment was later published and merged in PR48.
