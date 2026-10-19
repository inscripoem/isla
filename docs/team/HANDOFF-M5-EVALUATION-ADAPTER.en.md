# M5 evaluation adapter handoff

Current combined publication: `feat/m5-production-main` over [d1b040bc42bc5367b5f0612ff8b4968049205752](https://github.com/inscripoem/isla/commit/d1b040bc42bc5367b5f0612ff8b4968049205752), under review and unpublished. The original increment baselines and counts below are provenance; current alignment and verification are recorded in [DELIVERY-PLAN](DELIVERY-PLAN.en.md#current-baseline). Application and test contents are unchanged from the frozen combination.

Revision: 2026-10-19.3. Status: under review; local, uncommitted and unpublished.

## Scope and baseline

`src/runtime/evaluation-adapter.ts` supplies M6's `ComparisonDeps.runVariant` by executing the real M5 control/input/turn path with explicit deployment peers. It is based on [PR40 e44f6ce0a985853eb298cd53f42824dd3dfe5ec4](https://github.com/inscripoem/isla/commit/e44f6ce0a985853eb298cd53f42824dd3dfe5ec4), with the separately reviewed M5 production application and dynamic audio increments adopted locally. M6 retains its runner, metrics, report writer and forthcoming report command; no M6 source or shared contract was changed.

This increment implements execution and accounting plumbing. It does not establish a live provider run, acoustic measurements, a quality score, cap compliance or a G4 pass.

## Caller contract

Call `createEvaluationAdapter` with caller-owned `EventStorePort` and `HistoryQueryPort`, explicit `{ variant, peers }` configurations, and an audio consumer. Pass its `runVariant` method to the existing `runComparison` dependency. Each case gets a fresh session, real Resume and input submission, a real coordinator turn, and an admitted evidence drain before the record is assembled. The adapter leaves caller storage open.

| Input | Contract |
| --- | --- |
| Variant and peers | Requested `id`, `kind` and `combined` must match the configured variant. Supply M3 selection/reaction, M4 text source, M1 synthesis/renderer factories and the intended character/voice profile explicitly. No fixture fallback is installed by the adapter. |
| Consumer | `attach(composition)` binds a real output consumer and its bridge/receipt routing. Optional `detach()` releases it and must tolerate a failed attach. The production adapter imports no test performer. M2's product consumer remains owner work. |
| Storage/history | Existing M6 ports; SQLite is used by the acceptance suite. A session ID already present in the store or already claimed by this adapter is refused before execution. Use the normal sequential M6 comparison runner; concurrent calls sharing one consumer are not an accepted deployment mode. |
| Case | `input` is submitted unchanged. A supplied `replyIntent` is explicitly refused before any work: this mode evaluates the configured selection port and does not override its decision. Intent-constrained cases require a coordinated M3/M6 execution mode; removing a condition changes the experiment. Human labels and held-out metadata are not scored or enforced here. |
| Observation | Optional `onObservation` receives `sessionId`, case/variant identity, raw cycle/dialogue status, delivery classifications, invocation provenance and cleanup diagnostics. Use `sessionId` with the caller's store to retrieve the actual event history. |

Missing peers/consumer, mismatched variant metadata, unsupported case conditions and non-fresh sessions produce explicit not-run reasons. Once input is admitted, a failed or cancelled attempt remains a record. Setup failures are not silently converted into executed provider attempts.

## Outcomes and measurements

A completed cycle requires at least one matching effective fully-delivered record and all committed deliveries for that turn to be fully delivered. A zero-output cycle or a consumer that supplies no effective terminal evidence cannot produce bench completion. The adapter reads recorded dependency, dialogue and delivery evidence because the coordinator uses `cancelled` for some execution-failure paths. An observed operator Stop remains cancellation; other non-completed paths produce a failure reason.

Confirmed cancellation and completed speech are different facts. A cancelled receipt can leave output confirmation `confirmed` while delivery remains `partial-unknown`. Missing terminal evidence remains unconfirmed and never enters fully-delivered history. These local receipts do not prove acoustic audibility or silence.

| Field | Current meaning and limit |
| --- | --- |
| `caseId`, `variantId`, `cold` | M6 owns labels and first-attempt bookkeeping. First in a comparison does not establish a cold process, worker, provider or cache. |
| Stage timings and `totalMs` | All remain `null`. Budgets and successful coordinator wall time are not first-audible measurements. Stage boundaries and actual-output methods remain an I1-01 owner dependency. |
| `attempts` | `null`: port invocations do not prove underlying model requests or retries. Separately labelled selection/reaction/dialogue counts remain available in the observation. |
| Usage | `provider.call` and `provider.usage.late` join by the full invocation identity; late usage updates the original invocation. Missing counts stay unknown. On this PR40 base, M4's text-source interface does not propagate token counts, so completed dialogue aggregates remain unknown until M4-02 adoption. |
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
- A deadline-order race in the held-playback fixture was reproduced and corrected by separating the browser expiry from the coordinator deadline through controlled readiness delay. Ten subsequent focused runs and two full runs passed; the final independent full run also passed. This is controlled-media evidence, not an acoustic test.
- Actual-change trace/G6 and G4 status are recorded in the external review evidence. No evaluation table or live G4 pass is claimed. The full native session export is now preserved externally: 1640 unique records, valid JSON and terminal succeeded/idle metadata matching the native API. Earlier partial captures remain historical and are not substituted for this complete export.

M3 must provide real decision implementations and reviewed cases/rubric; M4 must complete its reviewed dialogue/usage interface and cases; M1/M2 must provide the product consumer and actual-output measurement method; M6 retains recorded-run/report tooling. Review the supplied-intent mode and cleanup-reason interpretation with M3/M6 before a real comparison. Keep existing role ownership, case IDs and invariant allocations unchanged.

The genuine OpenCode build session is `ses_eb01582deffe1lXlytG5wjv8Gm` (`self-api/deepseek-v4-flash#xhigh`, OpenCode 2.0.32). OpenCode authored the application/test changes; the supervisor reviewed, probed, independently verified and prepared this handoff. No commit, push, review/comment publication or merge accompanies this local increment.
