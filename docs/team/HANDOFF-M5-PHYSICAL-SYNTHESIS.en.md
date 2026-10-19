# M5 retained physical synthesis handoff

Current publication: [PR48](https://github.com/inscripoem/isla/pull/48) at [17ab93335e77d8a231674ae3a2a7c9d10fad2cc5](https://github.com/inscripoem/isla/tree/17ab93335e77d8a231674ae3a2a7c9d10fad2cc5), based on main `d1b040bc`. Both remote CI runs passed. M6 approved its storage/evaluation consumer boundary on 2026-10-19; the PR remains open. The original increment baselines and test counts below are historical provenance. See [DELIVERY-PLAN](DELIVERY-PLAN.en.md#current-baseline) for the combined publication and current review follow-up.

Revision: 2026-10-19.4. Status: published in PR48; under review.

## Scope and baseline

`src/runtime/physical-synthesis.ts` assembles one persistent M1 worker provider and one retained M1 synthesis adapter. Per-composition facades preserve the originating deadline gate across turns, Stop and explicit session recovery. The baseline is [PR34 a2c2216dca37814f2e3b6518c1a79d85ccb333b5](https://github.com/inscripoem/isla/commit/a2c2216dca37814f2e3b6518c1a79d85ccb333b5), including PR33, with the separately reviewed M5 production application and dynamic audio increments adopted locally. M1 retains the provider, worker host and registry implementation; no M1 production source or shared contract is changed.

This increment establishes lifecycle behavior with controlled providers and a real scripted Node worker. It does not establish a live Kokoro/model run, real dialogue/VTS integration, acoustic output or a performance measurement.

## Deployment contract

| Surface | Required use and ownership |
| --- | --- |
| `createRetainedSynthesis(options)` | Initialize once from explicit M1 `KokoroProviderConfig`, voice profiles, clock and an existing audio registry. With no `createWorker` override, M1 starts its actual worker/provider path. There is no automatic fixture fallback. |
| `retained.createSynthesis(gate)` | Supply this as the production peer factory. It returns a facade bound to that composition's gate; all facades share one underlying M1 adapter/provider. Constructing or discarding a candidate successor does not change an earlier facade's origin. |
| Registry | Supply the same caller-owned M1 registry as `peers.audioResources`. The application owns session/epoch retirement and HTTP lease draining; releasing the physical provider alone does not dispose unrelated registry ownership or prove playback cleanup. |
| `retained.release()` | Idempotently seal provider admission, drain the original physical job, request disposal once and wait for the actual worker exit. Logical cancellation and a worker error event do not authorize replacement. No timeout fabricates replacement permission. |
| `ProductionDeployment.release` | Return the owned cleanup from an explicit deployment module. The CLI passes it as `ProductionApplicationOptions.ownedRelease`; application creation failure and shutdown await it. A deployment factory that throws before returning still owns any resources it acquired and must release them itself. The retained helper handles its own post-acquisition adapter-construction failure. |

Use the originating request and context unchanged. The M1 adapter binds their earliest deadline through the facade's gate before invoking the provider. The facade scopes the binding origin around the synchronous prefix of this pinned M1 `prepare` implementation and restores it on return, including reentrant calls. A future M1 change that defers binding beyond this prefix requires a consumer review and the origin/interleaving regressions to be rerun.

Stop can finish the logical wait while inference remains physically active. A successor then receives the retained adapter's `busy` refusal; it cannot create another adapter/provider to bypass occupancy. Only the original settlement frees that slot. A late success from cancelled work publishes no audio reference; late rejection is consumed. Subsequent work can reuse the same provider after settlement.

## Shutdown and failures

Application shutdown closes new construction, stops the transport, retires compositions/audio, drains admitted evidence and closes SQLite before awaiting owned release. Every shutdown phase is attempted. Transport, durable-drain and owned-release errors remain individually labelled; multiple phase failures are returned together. Cleanup runs once, and repeated or concurrent `stop()` calls retain the same failure instead of returning success. `state() === 'stopped'` describes logical application shutdown; successful completion of the `stop()` Promise establishes that owned release also completed.

Creation failures retain the original error and any owned-release error. CLI listen failures also report a failed cleanup. Signal handlers are installed before server startup and before `listening` is published, so an immediate SIGTERM follows controlled shutdown. If shutdown begins during startup, readiness is not published afterward. `shutdown_complete` is emitted only after the owned release Promise resolves; a rejected release yields `shutdown_failed`.

These boundaries preserve the earlier admitted-evidence drain: callbacks arriving after the write boundary is sealed cannot reopen SQLite. Provider exit does not imply acoustic silence, and a missing output receipt remains unknown.

## Verification

- Independent `pnpm verify`: 931 tests / 52 files, typecheck, lint and build passed; the source checkpoint stayed unchanged during verification.
- M5: 148 tests / 7 files; M1: 214 / 2; trace: 41 passed. The physical suite contains 16 cases and the CLI suite 10.
- The unchanged independent probes now reject a disposed originating gate, preserve an active origin after a failed candidate, retain repeated-stop and startup-cleanup errors, and preserve simultaneous endpoint/owned-release faults.
- A real scripted Node worker exercises held generation, logical Stop, a busy recovery successor, settlement and resource reuse. App-owned close remains pending after disposal is requested and resolves only after the actual thread exit. This case verifies synthesized-resource reuse; its headless turns do not claim completed playback.
- A real CLI child uses a genuinely pending release: after SIGTERM, release has started while both process exit and `shutdown_complete` remain absent; explicit unblocking permits both. Immediate-SIGTERM cases remain immediate. The original readiness race reproduced twice at 926/928; corrected full verification and independent full verification passed.
- Actual-change G6/trace and G4 status are retained with the external review evidence. G4 is not a live pass. The full native session export is now preserved externally: 1640 unique records and terminal succeeded/idle metadata matching the native API; raw bytes and copied-file hashes agree.

Self-review: the identified gate-ownership, repeated-close, cleanup-observability and readiness defects are corrected and covered. The synchronous M1 binding dependency is explicit. No unrelated refactoring or additional provider lock was introduced. Adoption with the evaluation increment is now independently verified in the combined tree (1008 tests / 57 files). The actual adapter/runner, retained synthesis, real registry and controlled real worker cover completed delivery, Stop during a held job, busy failure, settlement/reuse and caller-owned close. The consumer releases each acquired resource before its completed receipt. See [the evaluation handoff](HANDOFF-M5-EVALUATION-ADAPTER.en.md). Full product/provider/acoustic acceptance remains separate work.

The genuine OpenCode build session is `ses_eb01582deffe1lXlytG5wjv8Gm` (`self-api/deepseek-v4-flash#xhigh`, OpenCode 2.0.32). OpenCode authored application/tests; the supervisor supplied independent probes, reviewed results and prepared this handoff. Failed and interrupted rounds remain in the external evidence. The original increment was later published in PR48; no merge has occurred.
