# Parallel development: role kits

Revision: 2026-10-15.2. Status: under review. These kits provide shared contracts, deterministic substitutes and executable examples. Main includes the production M5 coordinator, M1 fixed synthesis/mapped rendering/browser player, and M6 in-memory storage. The [M5 handoff](HANDOFF-M5-01.en.md) records original implementation evidence. PR30 attribution and PR23 dialogue remain open; the product console/business transport, live TTS/VTS, model quality and SQLite durability remain pending.

## Run the prepared version

Use Node.js 22.12+ and pnpm 12. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test:m1
pnpm test:m2
pnpm test:m3
pnpm test:m4
pnpm test:m5
pnpm test:m6
pnpm test:composition
pnpm test:readiness
pnpm verify
```

Each role command runs its real test file, including correct and deliberately faulty adapters. The composition command runs the basic offline loop; `pnpm verify` also includes the held-dependency and late-result regressions. No model credentials are needed for these checks. The current browser page remains diagnostic-only.

## First task and replacement point

Use your confirmed first task in [PLAN](PLAN.en.md). Add a test beside the linked example, retain its assertions, and replace the correct factory with your implementation. Keep fault-injection controls in your test adapter; do not expose them as production API. Do not modify another owner's module to make your test pass.

All port types are exported from `src/contracts/app/`. In a test under `test/offline/`, import collectors from `../conformance/<file>` and fixtures from `../support/correct-ports`.

| Role / directory | Implements / consumes | Collector import | Working example and correct factories |
| --- | --- | --- | --- |
| M1 / `src/performance/` | Implements SynthesisPort, RendererPort, PlayerPort | `collectPerformanceViolations`, `collectPlayerCancellationViolations` from `performance.conformance` | [m1-performance.test.ts](../../test/offline/m1-performance.test.ts): createFixtureSynthesisPort, createFixtureRendererPort, createFixturePlayer |
| M2 / `src/console/` | Integrates ConsoleTransportPort and M1's player | `collectConsoleViolations` from `console.conformance` | [m2-console.test.ts](../../test/offline/m2-console.test.ts): createFixtureConsoleTransport(createBootstrapOnlyRuntime()) |
| M3 / `src/decision/` | Implements SelectionPort, ReactionPort | `collectDecisionViolations` from `decision.conformance` | [m3-decision.test.ts](../../test/offline/m3-decision.test.ts): createFixtureSelectionPort, createFixtureReactionPort |
| M4 / `src/dialogue/` | Implements DialoguePort, MemoryCommitPort; consumes M6 HistoryQueryPort | `collectDialogueViolations` from `dialogue.conformance` | [m4-dialogue.test.ts](../../test/offline/m4-dialogue.test.ts): createFixtureDialoguePort, createFixtureMemoryCommit; use createFixtureHistoryQuery with the fixture store |
| M5 / `src/runtime/` | Implements RuntimeEndpointPort; composes ClockPort, ControlAuthorizerPort and pipeline ports | `collectRuntimeViolations` from `runtime.conformance` | [m5-runtime.test.ts](../../test/offline/m5-runtime.test.ts): createFixtureRunner from `../support/runner-factories` |
| M6 / `src/storage/`, `src/evaluation/`, CI | Implements EventStorePort, MemoryProjectionPort, ReplayReaderPort, HistoryQueryPort | `collectStorageViolations` from `storage.conformance` | [m6-storage.test.ts](../../test/offline/m6-storage.test.ts): createFixtureEventStore, createFixtureMemoryProjection, createFixtureHistoryQuery, createFixtureReplayReader; supply the failure-injection callback. History and replay assertions run when those ports are supplied; attribution conformance additionally requires at least one read view (a HistoryQueryPort or an inspection view) and reports `attribution-read-view-missing` when neither is present. |

C6/C7 storage revision `2026-10-14.1` requires `segmentIndex`, `personaProfileId` and `personaProfileVersion` on delivery writes and history records. Keep their captured values in adapters and use explicit null only for genuinely unknown legacy data. See [interfaces](INTERFACES.en.md) for conflict and ordering rules; M4/M6 consumer review remains required.

`collectStorageViolations` proves each attribution field independently: captured values round-trip through an actual write and a read view, explicit legacy nulls stay null, an omitted required field is rejected with no partial event and no leaked record while its identity and sequence stay reusable for a restored retry, and a conflicting reuse — a changed index, persona or version, or an explicit-null reuse — keeps the originally recorded attribution, checked after every conflicting attempt. Reusing the seeded all-null identity with known attribution must conflict rather than silently backfill. The retry and preservation guarantees run against every supplied read view, so a valid history-only, inspection-only or dual-view kit is accepted. An adapter that supplies neither a HistoryQueryPort nor an inspection view reports `attribution-read-view-missing`, so an empty violation list cannot be mistaken for a full pass. The fixture store and the real in-memory M6 store both satisfy these checks. It also rejects an inconsistent `classification`/`terminalOutcome` pair (`delivery-invalid-combination:*`), a malformed supporting event (`delivery-invalid-event:*`) and a contradictory known delivery↔event provenance or correlation (`delivery-correlation:*`) as one paired `failed` with zero residue and a valid retry, accepts partial or absent legacy event provenance including a known event output against an unknown delivery output (`delivery-provenance:*`), and preserves unrelated `versions` entries.

Collectors return named violations; an empty array is expected for the correct baseline. Exceptions/timeouts still fail the test. Each owner also retains the additional role-specific tests in the example file, rather than running only one collector.

`collectAtomicFailureViolations` from `storage.conformance` checks failed-batch isolation with injected storage/history ports and optional inspection views. It seeds a valid record, captures serialized baselines, attempts a failing commit, and checks that records and exports remain unchanged. A valid retry must reuse the failed identity and sequence without orphaning or duplicating records. The default function-valued event payload triggers preparation failure in the current fixture; it does not prescribe a storage technique. Other backends can supply the test-only `StorageKit.induceFailure` hook (or `induceFailure` on the standalone probe) to arm their own failure immediately before that commit. An accepted attempt produces `atomic-failure-not-induced`, not a passing failure check.

The fixture returns failed acknowledgements for ordinary preparation failures. Its explicit `throwNextAppend`/`throwNextCommit` controls still throw before publication; `beforeAppend`/`beforeCommit` and acknowledgement mutators retain their semantics. The invariant probe can inspect state after a thrown failure as well. Correct inspection views must be detached; the probe snapshots its own baselines so deliberately faulty live views cannot conceal partial publication.

M4 emits segments through `DialoguePort.generate(request, context, sink)` and returns DialogueEnd. M6 supplies stored history; M4 decides how that history enters dialogue context. M2's kit tests the transport boundary; real UI interaction and browser playback tests remain M2/M1 development work. M1 exposes the browser player under `src/performance/browser/`; M2 may import that subtree, whose transitive imports must remain browser-safe. Node/provider adapters stay outside it.

## M5 harness and integration

`ContractRunner` in `test/support/contract-runner.ts` is a test driver, not an application interface. It adds methods such as runTurn, trace inspection and controlled test hooks around a fixture RuntimeEndpointPort. The M5 collector accepts a factory returning that test-driver shape; implementing only RuntimeEndpointPort does not automatically satisfy the collector.

M5 now supplies `src/runtime/coordinator.ts` and the test-only `test/support/coordinator-runner.ts` adapter connecting its cycle driver, endpoint, trace and injected dependencies to that shape. Use `RunnerOptions` in `test/support/runner-factories.ts` to see the dependency substitutions used by the suite. Keep this adapter under `test/`; production code must not import the fixture coordinator or its policy. This preserves the same observable tests while M5 supplies the actual lifecycle and scheduling implementation.

`test/support/shared-store-probe.ts` runs two real coordinators that share one `EventStorePort` and asserts session isolation, delivery and JSONL-export consistency, replay detachment, Stop isolation and single-session failure containment. Each session uses a distinct persona and a recording dialogue port captures the originating request and segments, so the probe checks that confirmed-history attribution matches those origins rather than merely another stored copy, and detects a store that corrupts attribution even when session isolation holds. It accepts injected storage/history/replay ports, so it can also be pointed at an external M6 implementation; [shared-store.test.ts](../../test/offline/shared-store.test.ts) drives it with the real M6 in-memory backend, the fixture store and a deliberate faulty store.

I1-01 integrates one real offline loop using the confirmed module owners. Preserve normal delivery, Stop, stale-result and receipt behavior before I2-01 connects real providers. See [INTERFACES](INTERFACES.en.md) for authority and [case-registry](../req/case-registry.yaml) for exact coverage. Full C-05/C-08/C-09/C-16 and live measurements remain pending.

## Development records and handoff

The role-based agent entry is defined in [AGENTS.md](../../AGENTS.md). A request such as "I am M3. Start my first task" selects the relevant task and planning workflow; no long reusable prompt is required. `Prompt.md` points to the same entry.

For course implementation, use the configured OpenCode provider and the established model. From the checkout, the launch shape is:

```sh
opencode run --dir . -m <configured-provider>/deepseek-v4-flash --pure --agent build --variant xhigh --format json --title "<task-id>" "<English task>"
```

The angle-bracket values are placeholders, not ready-to-run credentials/configuration. Provider setup is separate from offline onboarding. Preserve actual session IDs and export original records outside the checkout; never place credentials or raw private records in a PR.

A small handoff includes task/requirement IDs, changed ports, actual commands/results, failure/Stop behavior, known gaps and the consuming owner's actual review. M5 coordinates shared contracts, entry points and dependency changes; each owner supplies their own tests and fixes.

Interfaces remain changeable. Trace consumers and update types, examples, tests and documents together. Strict decoders require coordinated rollout even for added optional fields; breaking changes need an explicit version/migration decision. Final coursework artifacts remain subject to the required English-only submission whitelist.

PR merging is reserved for human team members. Agents must not merge, enable auto-merge or enqueue merges, even after reviews and CI pass.
