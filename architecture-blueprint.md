# Isla architecture blueprint

Revision: 2026-10-10.5. The team-confirmed allocation is retained. Directory conventions are authorized; product requirement/interface acceptance remains under review. The implementation includes the diagnostic foundation, shared contracts, fixture kits and requirements-validation tooling; the M5-01 coordinator is implemented with injected peer ports and remains under review. Peer business modules and their integration remain pending.

## Scope and current behavior

Isla will be a reusable AI VTuber runtime plus local console. The selected direction is TypeScript/Node.js, React/Vite, pnpm, SQLite persistence, validated JSON WebSocket traffic and independent synthesis/player/renderer adapters. The scaffold implements loopback-only HTTP health and validated WebSocket diagnostics. It rejects unsupported product actions and malformed messages; diagnostics do not imply successful chat, playback or persistence. Diagnostic version 1 is distinct from planned application protocol 0.2. Shutdown releases sockets and reports failures explicitly; logs contain operation/outcome metadata without raw credentials.

## Module directory ownership

Use one package. All paths below are relative to the repository root. Planned paths establish locations for future work; create them with real module implementation, not empty placeholders.

| Role | Main directory | Status | Responsibility |
| --- | --- | --- | --- |
| M1 | `src/performance/` | Planned | Synthesis, browser playback and avatar adapters; expose the browser player through `src/performance/browser/`, separate from Node-only/provider implementation. |
| M2 | `src/console/` | Existing | Input, configuration, control and presentation; consume M1's player through its public interface. |
| M3 | `src/decision/` | Planned | Message selection, reply intent, decision providers and rule reactions; no authoritative output dispatch. |
| M4 | `src/dialogue/` | Planned | Dialogue providers, persona/context assembly and memory semantics; access persistence through M6 interfaces. |
| M5 — CHANG Xuben | `src/runtime/` | Existing | Authoritative lifecycle, request scheduling, validation, cancellation, dispatch and composition. |
| M6 | `src/storage/`, `src/evaluation/`, `.github/workflows/` | Storage planned; requirements tooling and CI existing | SQLite/migrations, recording/replay, common evaluation tooling and CI. |

M5 coordinates `src/contracts/`; affected producers and consumers review changes together. Every owner supplies their own tests in `test/offline/`; provider-dependent tests will use `test/live/`. M6 coordinates shared fixtures, not every domain assertion. M3/M4 will maintain their respective runtime prompts under `prompts/`. Evaluation program code belongs in `src/evaluation/`, test fixtures in `test/`, and generated recordings/measurements in ignored local storage outside OneDrive.

Keep feature internals within the owning module. The console must not import database code or backend provider credentials. M2 integrates the player without owning M1 playback internals; M4 determines memory semantics without writing SQL directly. Coordinate shared contracts, root entry points, manifests and lockfiles. Directory ownership alone is not a complete enforced permission model.

## Runtime authority and the agent loop

M3 proposes which eligible message to address and with which intent; M4 generates dialogue under its context policy. M5 controls when a decision opportunity exists, validates the plan against current state, reserves the input, invokes the next stage and authorizes output. M1 reports actual completion/cancellation; M5 reconciles the outcome, M4 updates memory semantics and M6 persists records. These are existing assigned responsibilities, not extra modules or additional model calls.

Operator Stop, epoch/freshness checks and action capabilities are deterministic boundaries. Late results and fallbacks cannot bypass them. A generation-complete result is not evidence of delivered speech; an acknowledged Stop is not yet proof of physical silence. SQLite will own persistent records while M5 owns live authority. The M5-01 coordinator implements these authority boundaries in `src/runtime/coordinator.ts` and `policy.ts`, tested with injected peer substitutes. The test-only `coordinator-runner.ts` adapter retains existing conformance assertions. See the [handoff](docs/team/HANDOFF-M5-01.en.md) for the I1-01 boundary; physical output and durable storage still require peer integration.

## Development and verification

The [team plan](docs/team/PLAN.en.md) defines first tasks, dependencies and parallel work; the [interface contract](docs/team/INTERFACES.en.md) defines C1–C7 and acceptance cases. Shared application schemas and port interfaces now live in `src/contracts/app/`, with explicit fixtures, deliberately faulty adapters and reusable conformance suites under `test/`; the [readiness kits](docs/team/READINESS-KITS.en.md) document per-role commands and replacement instructions. These fixtures exercise contract boundaries, not live providers, browser audio or SQLite behavior. Integrate one normal/Stop-aware offline loop before relying on live providers. The [candidate requirements](docs/team/REQUIREMENTS.en.md) are not a substitute for formal YAML/schema or an approved complete D1; the scoped preparation registry is under `docs/req/`.

The initial scaffold commit c717f77 passed [GitHub CI](https://github.com/inscripoem/isla/actions/runs/37954077638): frozen installation, typecheck, lint, offline tests and build. This evidence predates the M5-01 implementation. Scoped requirements validation is now included locally. Full semantic evaluation, test-approval automation, final D1 and complete coursework gates remain pending. Main is governed by the existing PR ruleset; human review and merge remain required. Preserve authentic development evidence; do not create retrospective approvals or claim unfinished product tests passed.

Current English collaboration documents use `docs/team/`; synchronized Chinese understanding copies remain in OneDrive. Formal coursework packages include only explicitly selected English artifacts. Internal raw evidence and historical review ZIPs remain outside the repository. Shared-boundary changes require affected-owner review and updates to contracts/tests before integration.
