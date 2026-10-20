# M5 production composition and durable application lifecycle handoff

Published baseline: [PR48 cbc845c746e426934acc8a55289fe58efefb8ec5](https://github.com/inscripoem/isla/commit/cbc845c746e426934acc8a55289fe58efefb8ec5), incorporating main37c1d9e. M1's [scoped Windows approval](https://github.com/inscripoem/isla/pull/48#pullrequestreview-5583059851) resolves the original response-hold P2 at that head. The current local candidate additionally incorporates main579b14b (merged PR51); publication and verification of that combination are separate. Earlier increment baselines and test counts below retain their original scope. See [DELIVERY-PLAN](DELIVERY-PLAN.en.md#current-baseline) for current status, verification and remaining owner work.

Revision: 2026-10-20.4. Owner: M5 — CHANG Xuben. Status: cbc845c published; main579b14b reconciliation local and under review. Historical increment branch: `feat/m5-production-composition`, based on the published PR45
head `6bcfc2b`. Scope: FR-05/FR-06 production assembly, durable startup/controlled
shutdown and explicit selected-history recovery over the existing M6 SQLite backend,
the root Vite entry routing for the application socket and operator bootstrap, and
the two-process restart acceptance over the real application transport.
Peer provider work (M1 live audio, M3, M4 live text) is not part of this slice.

## Implemented behavior

M5 owns one production application over the real M6 SQLite backend. It injects the
peer ports a deployment supplies, builds every session through the existing
production reconstruction entry, and controls the transport and database lifetime.

- `src/runtime/production.ts` — `createProductionApplication(options)`:
  - Validates the injected peer set (`validateProductionPeers`) before any storage
    is opened. `selection.select`, `reaction.decide`, `textSource.compose` and the
    `createRenderer(gate)` / `createSynthesis(gate)` factories are required; a
    missing or malformed peer is an explicit `TypeError` naming the field. There is
    no fixture fallback in production code.
  - Opens and migrates the database once (`openDatabase` + `migrate`), creates the
    M6 store and history view over that handle, and creates the operator recovery
    controller. Every composition — the initial one and each recovery successor —
    is built through `createReconstructedRuntimeComposition` with its own
    `createDeadlineGate(clock)`, so the renderer and synthesis of one composition
    share exactly that gate and a successor never shares a gate, bridge, renderer
    or coordinator with its predecessor. Each coordinator is recorded, and a
    composition starts stopped and dispatches nothing.
  - `start()` binds the loopback server; it rejects unless the state is `created`.
    `stop()` is the controlled shutdown and is idempotent. It marks shutdown
    synchronously, stops the transport (or disposes the endpoint directly when
    `start()` was never called or failed), drains every recorded recovery build,
    disposes every composition (aborting raw providers and releasing a playback
    wait that can no longer receive terminal evidence) and awaits each
    coordinator's two-phase `settle()`: admitted bounded operations (the active
    turn, an in-flight receipt finalization) drain to their terminal bookkeeping,
    then the write seal closes storage admission and the serialized write chain
    drains. Only then does it close the SQLite handle. The drain runs in a
    `finally`, so a transport fault cannot skip it, and it never waits for a
    cancellation-ignoring provider. `start()` and `stop()` are serialized through
    one lifecycle queue, so a stop racing a start cannot dispose the endpoint while
    the server is still binding.
  - A recovery build in flight during shutdown is drained: the build callback
    refuses after shutdown with a rejected promise, the recovery reports
    `construction_failed` without touching the store, and a late successor built
    before the refusal is disposed with the other compositions.
  - A creation failure after the handle was opened disposes every built
    composition, settles their coordinators and closes the handle, rethrowing the
    original error; a close fault during cleanup never replaces it.
- `src/runtime/production-cli.ts` — the runnable entry (`pnpm runtime:production`):
  - Loads the deployment factory from `ISLA_DEPLOYMENT_MODULE` (absolute or
    process-relative path; named `createProductionDeployment` or the default
    export). A missing/empty variable, an unloadable module or a module without a
    factory fails visibly with exit code 1 and a structured
    `deployment_module_missing` / `deployment_module_invalid` error; there is no
    silent fixture fallback.
  - Resolves storage (`ISLA_STORAGE_DB_PATH`, default `.cache/isla/isla.db`) and
    server (`ISLA_RUNTIME_HOST`, `ISLA_RUNTIME_PORT`) configuration fail-fast;
    invalid configuration exits 1 with `configuration_invalid`.
  - Emits one JSON line per lifecycle event (`listening`, `shutdown_started`,
    `shutdown_complete` and structured `*_failed` errors) and performs the
    controlled shutdown on SIGINT/SIGTERM.
- `src/runtime/composition.ts` — synthesis injection and the audio-resource seam:
  - The composition dependency types (`RuntimeCompositionDeps`,
    `ReconstructedRuntimeDeps`) accept an injected `synthesis` port (for example
    M1 Kokoro); `audioEntries` remains the fixed-catalog form. Supplying neither
    throws a `TypeError` reading "runtime composition requires a synthesis port:
    supply `synthesis` or `audioEntries`"; supplying both prefers `synthesis`.
  - `CompositionAudioResources` (`retireBefore(sessionId, newEpoch)`,
    `retireSession(sessionId)`) is an optional structural seam satisfied by M1's
    `AudioResourceRegistry`. A Stop delegates to `retireBefore` with the new epoch
    before the bridge cancels; composition disposal calls `retireSession`. Both
    calls are isolated: a throwing registry is contained and cannot break Stop or
    disposal.
- `src/runtime/coordinator.ts` — `RuntimeCoordinator.settle(): Promise<void>` is a
  two-phase controlled drain. It seals operation admission and drains every
  admitted bounded operation to its terminal bookkeeping — the active turn (its
  aborted provider calls and stale result) and an in-flight receipt finalization —
  then seals writes and awaits the serialized write chain. Disposal aborts the raw
  providers and releases a playback wait, so the drain is bounded by the
  coordinator's stage and storage budgets and never waits for a
  cancellation-ignoring provider. It never rejects, so shutdown cannot fail
  because a session is degraded. After the write seal a late callback (for example
  a raw provider completion) is refused without touching storage and is never
  counted as a storage failure.
- `vite.config.ts` (root entry) — the diagnostics console entry forwards
  `/health` and `/diag` (unchanged) plus the application socket `/app`
  (WebSocket) and the operator bootstrap `/operator` (HTTP) to the runtime at
  `127.0.0.1:4317`. The proxy forwards the original `Origin` and `Host`, so the
  runtime's own origin/host checks still decide whether a connection or
  bootstrap is allowed; M2 keeps the console UI and its diagnostics-only use.
- Durable restart model: a reopened database continues work in a fresh live
  session id with an explicit `selectedSources`/`catalogue` selection. Confirmed
  archive history is carried into the new session and continued output is produced
  there. Reopening with a live id that already has stored evidence (any event or
  partial delivery) fails visibly
  (`ReconstructedSessionError('live_session_not_fresh')`) and leaves no open
  handle or WAL side file.
- Cross-process restart acceptance (`test/offline/m5-process-restart.test.ts`):
  two separately spawned production CLI processes run over one real SQLite
  database through the real application transport (WebSocket `/app`). The first
  process produces a confirmed turn (two segments observed as completed receipts
  and two `delivery.committed` events through the transport) and exits 0 under
  SIGTERM. The second starts under a fresh live id, explicitly selects the
  previous live session and the seeded archive through
  `ISLA_TEST_ARCHIVE_SESSIONS`, and continues output in a new turn. The assembled
  dialogue context is observed through the test-only capture hook in the
  deployment module (`ISLA_TEST_DIALOGUE_CAPTURE_FILE`): the carried confirmed
  history reaches the provider with `historySource: 'history-port'` in selection
  order, the partial-unknown null-attribution record is excluded, and an
  independent `createRecoveryView` read after the second exit proves each session
  keeps exactly its own evidence, with the unknown record preserved and never
  promoted. No replay is established by comparing every old record's complete
  session-scoped delivery identity (`sessionId:turnId:segmentId`) against every
  performance message and receipt, and by requiring fresh-session authority (the
  new live `sessionId`) on each; raw output ids are per-process counters and
  cannot carry that claim.

## Deployment module contract

The deployment module exports a `ProductionDeploymentFactory` (named
`createProductionDeployment` or as the default export) and returns a
`ProductionDeployment`:

| Field | Meaning |
| --- | --- |
| `peers` | `ProductionPeers`: `selection`, `reaction`, `textSource`, `createRenderer(gate)`, `createSynthesis(gate)`, optional `personaRecall`, `audioResources`, `profile`, `timings` and budgets. The factories receive the composition's own deadline gate and must bind provider work to it. |
| `initialSelection` | The validated `ArchiveSelectionConfig` for the initial fresh live session (fresh id, selected archives, trusted catalogue). |
| `allowedOrigins` | Exact canonical origins permitted to open an application socket; at least one is required. |
| `allowedHosts` | Optional exact allowed `Host` values; omitted means loopback-only hosts. |

The factory receives `{ clock, databasePath, env }`. A deployment module for a
real product does not exist in this checkout yet: the live M1 synthesis
provider/loader and the M1 audio-resource registry interface, M3
selection/reaction and the M4 live text source are still owner deliverables. M5
owns the dynamic audio HTTP/routing and resource assembly; M2 is the browser
consumer. `test/support/production-deployment.ts` is a test-only module used by
the CLI suite; production source never imports it.

## Receipts after the operation seal

`settle()` first seals admission of new operations. Each later `handlePlayerMessage` call is refused before validation and increments `RuntimeMetrics.lateReceipts`. This counts incoming calls, including malformed or unrelated messages; it is not a count of verified playback completions. The counter is in memory only and disappears with the coordinator instance. No receipt event or delivery is written after the seal, no memory commit is made, and a refusal is not a storage failure.

Production shutdown disposes the composition before draining it. A waiting output therefore remains unknown; a first completion receipt delivered after the seal cannot enter confirmed spoken history. Conversely, a previously confirmed output remains confirmed when a duplicate, unrelated or malformed message is refused. The counter supplies refusal visibility without attributing unvalidated messages to an output. This preserves a documented limit: the durable history cannot recover the contents of a post-seal receipt, and the counter itself does not establish acoustic playback.

## Supported shutdown verification

The process-level graceful-shutdown and two-process restart evidence is verified
on briefcase/Linux x86_64 with Node.js 22.23.3. The supported tested trigger is
SIGTERM sent to the directly spawned runtime PID (`node --import tsx`), with
`shutdown_started`, awaited owned release, `shutdown_complete`, successful exit
and SQLite reopen checked. SIGINT is implemented but is not independently
established by these SIGTERM tests. The existing historical counts below retain
their original revision and platform scope.

On Windows, Node's [`subprocess.kill`](https://nodejs.org/docs/latest-v22.x/api/child_process.html#subprocesskillsignal)
for SIGTERM/SIGINT kills the child forcefully; it does not demonstrate execution
of the application's cooperative shutdown handler. M1's Windows/Node24 failures
therefore remain a platform/trigger verification gap. Windows deployment needs a
separately implemented and validated cooperative trigger before equivalent
process-level shutdown/restart acceptance can be claimed. This follow-up adds no
such trigger and does not skip or reinterpret the existing failing cases.

The process helper currently maps a null exit code to -1 without returning the
raw signal. Preserve M1's reported limitation: process exit alone is insufficient
proof of graceful shutdown; lifecycle and release assertions are required. Raw
signal reporting remains a separate harness follow-up.

## Evidence

- `test/offline/m5-production-application.test.ts` (15 tests): peer validation
  naming each missing field; rejection of an incomplete deployment before storage
  is opened; the missing-synthesis `TypeError`; `retireBefore` on Stop and
  `retireSession` on disposal, with a throwing registry contained; durable
  close/reopen — a seeded archive session with one confirmed and one
  `partial-unknown` null-persona record, a first live turn, a post-stop write
  rejection, an independent `createRecoveryView` read proving only confirmed
  history is restored, and a second application instance in the same process that
  reopens the same database and carries `[LIVE_1, ARCHIVE]` into a fresh live id
  (child-process startup is separate CLI evidence); `live_session_not_fresh`
  refusal with no WAL side file; stop-before-start; controlled shutdown with a
  turn in flight; `/health`, one-time operator bootstrap and lifecycle errors; one
  deadline gate per composition with a fresh gate after a socket-driven
  `session.recover`.
- `test/offline/m5-production-application.test.ts` shutdown-boundary regressions:
  a held cancellation-ignoring selection is invoked exactly once, its
  `provider.call` (`disposition: aborted`) and `result.stale` survive `stop()` and
  an independent SQLite reopen, releasing the provider after `stop()` performs no
  store access and admits no delivery, and `storageFailure` stays false; a held
  `output.receipt` append keeps `stop()` pending until released, and the admitted
  receipt and `delivery.committed` are durable after reopen; a held successor
  preflight keeps `stop()` pending, the late successor is retired before close and
  a later `recover` rejects `construction_failed` without a store read; an invalid
  `allowedHosts` entry makes endpoint construction throw a `RangeError` after the
  initial composition was built, and the cleanup retires that composition and
  leaves no WAL side file.
- `test/offline/production-cli.test.ts` (5 tests): missing deployment module,
  unloadable module and factory-less module fail with exit 1 and the documented
  events; a pre-seeded live id fails startup with `startup_failed` ("already has
  stored evidence"); a full run logs `listening`, serves `/health` 200 and exits 0
  on SIGTERM with `shutdown_complete`.
- `test/offline/m5-process-restart.test.ts` (1 test): the two-process restart
  acceptance described above, including the dialogue-context capture and the
  independent post-exit recovery reads.
- `test/offline/m5-coordinator.test.ts` (+2 tests): `settle()` waits for a held
  store append and resolves after disposal; an aborted turn's `provider.call` and
  `result.stale` drain before the write seal, and a late receipt after the seal
  performs no store access and is never a storage failure.
- `test/offline/i1-recovery.test.ts` (M5 session-recovery integration) was adapted to the
  corrected retirement semantics: old evidence must remain an unchanged prefix,
  and retirement may only append the interrupted turn's bounded cancellation
  bookkeeping (an aborted provider call, its late usage, the terminal
  `turn.ended`). The appended bookkeeping must be truthful: exactly one terminal
  turn record and it is `cancelled`, every appended provider call is `aborted`,
  and no delivery or completed receipt may be admitted by retirement — fabricated
  completion is rejected.
- `test/browser/root-entry-routing.mjs` (manual real-traffic acceptance, not part
  of `pnpm test`): against the real loop runtime and the real root Vite entry it
  verifies the console page, `/health`, `/operator/bootstrap` (allowed origin 200;
  disallowed origin and missing explicit header 403), a real `/app` snapshot plus
  `session.attach` round-trip, the `/app` origin refusal and the unchanged `/diag`
  ping. Local run: 8/8 checks passed.
- Test support: `test/support/production-kit.ts` (controlled peers, evidence
  seeding, the dialogue-context capture text source),
  `test/support/production-cli-kit.ts` (the real child-process harness),
  `test/support/production-deployment.ts` and
  `test/support/production-deployment-invalid.ts` (CLI deployment modules).

## Verification

Historical increment results on 2026-10-19 (before PR48 publication):

```sh
pnpm typecheck      # passed
pnpm test:m5        # 113 tests / 5 files passed
pnpm verify         # 832 tests / 49 files passed; typecheck, lint and build passed
# targeted cross-process acceptance (spawns real CLI processes):
pnpm exec vitest run test/offline/production-cli.test.ts test/offline/m5-process-restart.test.ts
                    # 6 tests / 2 files passed; no production CLI process survived cleanup
# actual-diff gates (CHANGED_FILES_FILE = tracked and untracked working-tree
# changes; AI_USE_LOG_BASE_FILE = the log at HEAD):
pnpm gate:ai-use-log   # passed; the working-tree log has 52 entries against 49 at HEAD
pnpm test:trace        # 41 tests passed with the real changed-file list
```

Recorded acceptance findings (preserved):

- The first acceptance run failed its no-replay assertion because it compared raw
  `outputId` strings: two processes legitimately emit `output-20` and `turn-1`,
  since those ids are per-process counters. This is expected scoping, not a
  defect — the durable delivery identity is `sessionId:turnId:segmentId`
  (`sessionId:turnId:segmentId:modality` as the M6 key), and the live session id
  is deployment-fresh. The assertion now compares complete session-scoped
  identities plus fresh-session authority; production ID generation is unchanged.
- That run's failure cleanup exposed a harness defect: the `tsx` bin wrapper
  re-executes the entry in a child process, so killing the wrapper left the actual
  production CLI orphaned (PID 254031, terminated by the supervisor with
  SIGTERM). The shared harness now launches
  `node --import tsx src/runtime/production-cli.ts` directly, so the spawned PID
  is the runtime itself; failure cleanup closes tracked performer clients first,
  then sends SIGTERM with a bounded wait and SIGKILL as the fallback with another
  bounded wait, and removes the temporary database only after every tracked
  process has exited. A post-run process check shows no surviving production CLI,
  and an out-of-tree probe that called `cleanup()` on a listening runtime without
  SIGTERM observed the actual runtime PID gone and the temporary database removed.
  Cleanup checks both wait rounds: a process that survives SIGKILL keeps its
  temporary directory, is reported by a thrown cleanup error, and stays tracked
  for a later retry.

The unchanged independent shutdown probe (`shutdown-review-probe.ts`, retained
under `.cache/` outside the tracked checkout) reports after the repair:
`session.resumed`, `input.accepted`, the invoked selection's `provider.call`
(`disposition: aborted`) and `result.stale` are stored; no store write occurs
after `stop()` resolved; `storageFailure` is false; no late usage event is
admitted. Before the repair the same probe stored `result.stale` with `statement
has been finalized` and reported `storageFailure: true`; an intermediate immediate
write seal dropped the already-invoked provider attempt, which the supervising
review rejected and this revision corrects.

Real root-entry routing acceptance (`node test/browser/root-entry-routing.mjs`
with `pnpm dev:loop` and `pnpm dev` running): 8/8 checks passed — the console
page, `/health`, the `/operator/bootstrap` allowed-origin 200 and the
disallowed-origin and missing-header 403 refusals, a real `/app` snapshot plus
`session.attach` round-trip, the `/app` origin refusal, and the unchanged `/diag`
ping.

`pnpm verify` reports the advisory G1 notice (no `tests-approved` label in a
local run) alongside expected non-failing diagnostics: Node's `SQLite is an
experimental feature` warnings and one WebSocket max-payload rejection warning
exercised by the `server.test.ts` boundary test. The application tests inject
controlled peer fixtures; they assert real application, storage and transport
behavior, not live providers, browser audio or acoustic output.

## Remaining integration dependencies

| Owner | Remaining work |
| --- | --- |
| M1 | Live provider/VTS and actual-output observation; Windows cooperative release evidence with M5/M6. PR33/34 implementation is already merged and retained. |
| M2 | Product transport/strict decoder/status, dynamic audio resolver, recovery controls and notification follow-up in Issue37. |
| M3 | Production selection/reaction implementations, reviewed cases/rubric and cap policy. |
| M4 | Live dialogue and usage adoption, reviewed cases, and the two remaining PR35 P2 repairs. |
| M5 | Verify the main579b14b combination and coordinate deployment adoption; production lifecycle, dynamic audio and evaluation adapter are already implemented in PR48. |
| M6 | Recorded-run/report adoption and storage support; C-65/C-66/C-67 are on main. The PR51 getter P3 remains separate. |

Retention/deletion policy remains undecided. The [Issue25 reply](https://github.com/inscripoem/isla/issues/25#issuecomment-6286818499) records the controlled recovery evidence and platform/product gaps; the [Issue41 reply](https://github.com/inscripoem/isla/issues/41#issuecomment-6286821631) separates adapter implementation from S6/G4 acceptance.

## Ownership and remaining external acceptance

- M5 owns assembly, lifecycle, the entry points and the dynamic audio HTTP/routing
  and resource assembly; M1 supplies the synthesis provider and the audio-resource
  registry interfaces, M2 is the browser consumer, and M1/M2/M3/M4/M6 retain
  module ownership. No shared contract (`src/contracts/`), frozen path, lockfile or
  dependency changed in this increment.
- This is application-level durability over the real SQLite backend with
  controlled shutdown. It does not establish process-crash recovery of an
  uncommitted tail, live provider behavior, browser audio or complete course
  acceptance. The two-process restart acceptance uses real child processes, real
  SQLite and the real application transport, but its peers remain the labeled
  test substitutes, so it does not establish live provider, acoustic or
  course-level behavior either. The `session.recover` path is explicit and
  operator-driven; it never replays old audio and never admits unresolved
  delivery as spoken.
- No owner review or merge is implied by this document. [DELIVERY-PLAN.en.md](DELIVERY-PLAN.en.md)
  records the current combination, PR state and remaining owner work.
