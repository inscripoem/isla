# M5 GitHub mention follow-up

Revision: 2026-10-22. Status: local implementation under review; no publication or product acceptance.

Responds to [M4’s consumer request](https://github.com/inscripoem/isla/issues/44#issuecomment-6333621829), [M3’s evaluation design](https://github.com/inscripoem/isla/issues/41#issuecomment-6317285447) and [M6’s required delivery](https://github.com/inscripoem/isla/issues/41#issuecomment-6332904039). The candidate combines PR53 at `8c36cadadf64da2b543aacd930392090b9e4a7cd` and M4 at `a678b619e3c4002eae6a79425479f38f3d2cd5e6`. Imported M4 memory work keeps its original attribution; the producer repair is a separate proposal for M4 review.

## Generation outcomes

`DialogueCompositionDeps.onDialogueOutcome` accepts a projected, frozen event. `ProductionPeers.onDialogueOutcome` is forwarded to the initial composition and each explicit recovery successor. Evaluation collects the same events in `EvaluationAttemptObservation.dialogueOutcomes`; refused projections and observer faults are separate diagnostics. The callback adds no C6 write, provider attempt or spoken-history entry. M5 retains runtime persistence and delivery decisions; M6 owns storage infrastructure.

The projection retains request/session/epoch/turn identity, validates safe non-negative counts and their sums, removes additional fields, and folds unknown reason names into `unclassified`. Synchronous and asynchronous observer failures cannot change generation. A held call released after another composition exists keeps its original identity; the scoped composition test is not a recovery-authority or playback acceptance test. A separate real production-application test verifies callback wiring before and after explicit recovery.

The proposed producer units are returned source candidates (`generated`), fulfilled sink writes (`emitted`), and their difference (`discarded`). `overflow` and `sink-uncertain` distinguish capped candidates from a rejected write that might have side effects. M4 must review these diagnostic units and labels. None proves playback; existing authoritative receipts and delivery classification still decide history admission.

Evaluation treats `deadline_exceeded` as a failure even when a prefix has effective delivery evidence. Recorded operator Stop remains cancellation. Timings, model-attempt counts, costs, and missing usage retain their existing unknown/null behavior.

## Input preparation

Set `EvaluationAdapterOptions.input` to `{ mode: 'prepared', resolve(caseId) }`. The resolver receives only the case ID and returns one to five `PreparedEvaluationInput` entries containing exactly `source`, `text` and `actorId`. Unknown modes, missing resolvers, rejected resolution, empty/invalid/oversized batches and unsupported entry fields return not-run before constructing the runtime. Entries are copied after validation. Omitting the option or selecting `case-input` retains the existing single `EvalCase.input` behavior.

The adapter submits every entry in order through the real endpoint under its actor context, then calls `runTurn` once. An initial rejection remains not-run. If some entries were accepted before rejection, the adapter skips selection, drains and cleans up normally, and returns a failed attempt whose reason identifies the accepted count and failed admission. The admitted input events remain available from the session store; no partial batch is run.

This prepares bounded pipeline inputs, not full `SelectionRequest` replay: event IDs, receive/expiry times, persona and history still come from the runtime. M3 retains actual request/label files, loader/SelectionPort runner and reviewed rubric; M6 retains corpus/report binding. `EvalCase`, `FixedConditions`, recorded-run schemas and `promptVersion` semantics remain unchanged. Forced `replyIntent` remains unsupported/not-run. No corpus completeness or semantic score is claimed.

## Verification and remaining decisions

Independent final verification: `pnpm test:m5` passed 203 tests / 9 files; `pnpm verify` passed 1,223 tests / 69 files, typecheck, lint and build on Linux/Node 22.23.3. The coordinator and adapter focused run passed 121 tests / 2 files (94 coordinator, 27 adapter). The independent PR53 seven-file documentation follow-up passed 1,132/63; the independent M4-only proposal passed 1,190/68. The same 13 producer regressions failed 12/passed one on the unchanged M4 head.

Additional deterministic checks in `test/offline/m5-coordinator.test.ts`:

- `treats a valid selection returned exactly at its deadline as stale without fallback dispatch`
- `accepts valid speech when the reaction returns exactly at its deadline`
- `captures an accepted non-default reply intent unchanged in the dialogue request`
- `defers a malformed selection returned exactly at candidate expiry while its deadline is live`

C-05/C-16 remain pending; no new global ID is allocated. M6 retains serialized `memory.inspect` review. Real text-provider integration, reviewed corpus/labels, Windows, acoustic measurements, S6 and G4 remain outstanding. Final PR merge is human-owned.

## Consistency audit follow-up (2026-10-22, under review)

The dependent M4 proposal now bounds statement visits, text preprocessing, claims and pair
comparisons, fixes long-word contraction matching, and reports incomplete audits through
context and the redacted inspection builder. See [memory design](../architecture/memory-design.md#bounded-consistency-audit-proposal-2026-10-22-under-review) for ceilings and the exported API changes.
M5 integrates the same reviewed code and tests; existing outcome/deadline handling, recovered
session wiring and prepared evaluation inputs are retained. PR53's three documentation
corrections are included. M4 retains ownership of the limits and API adoption; M2/M6 inspection
adoption remains separate.

Independent Linux verification: M4 1209 tests / 68 files; this M5 combination 1242 / 69;
typecheck, lint and build passed with unchanged source/test/dependency hashes. The same
1024-turn, two-clause history and 64-character prompt took 1691.9 ms before and 30.8 ms after
in one controlled assembly comparison; timer delay was 1691.9 versus 31.0 ms. These observations
are not a whole-pipeline latency guarantee. No live provider, Windows, acoustic or S6/G4
acceptance is claimed. The previous M1 approval of PR54 at 4bc4c18 does not cover this
revision. Captain approved publication of this update; owner adoption and final PR merge
remain separate.
