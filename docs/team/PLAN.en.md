# Isla — Team Work Plan v0.2

Status: proposed coordination update, under review · 2026-10-31.2 · [Project overview](../../README.md)

## Requirements and course-deliverable work

The [candidate register](REQUIREMENTS.en.md) defines FR-01–FR-06, NFR-01–NFR-06 and INV-01–INV-16 mapped to the established module responsibilities; requirement acceptance remains under review. INV-10–INV-12 are implemented in merged PR26; INV-13–INV-14 and their trace/log gates are adopted from merged PR27; M5 retains INV-09 and INV-15. M1–M6 are module roles, not requirement IDs. The preparation baseline has executable deterministic tests and an actual supervisory review record. Numerical targets, the comparison baseline and named team reviewers remain to be settled before claiming the corresponding product acceptance; they do not block offline module development.

S1-01 is divided into six concrete work items: R1 requirements/schema; R2 architecture/context/state/traceability; R3 governance and six blocking gates; R4 requirement-linked tests and offline integration; R5 authentic process records and six-member report input; R6 controlled comparison and demo. R1/R2 are coordinated by M5 with module-owner input; M6 leads R3 tooling; each owner supplies R4 tests and R5 evidence; M3/M4 supply R6 cases, M6 measurements and M1/M2 visible outputs. M5 consolidates integration and delivery. These follow the existing role boundaries. Each owner supplies their module evidence; the leader consolidates rather than authors every deliverable.

## First working result

Send a message from the console and get a spoken reply with subtitles and a supported avatar reaction. Stop must cancel playback; later conversation must distinguish completed speech from an interrupted segment.

Begin with fixed replies/audio and a test renderer, then connect real services. Add response selection and reply intent in one decision request before dialogue. Proposed limit: inspect at most five eligible messages, select one or wait, and choose one of six intents: answer, clarify, acknowledge, support, playful, check-correction. Keep one character and at most two finalized segments per turn. The first comparison uses rules for reactions; model-based reactions remain a later experiment.

Make at most one response-provider attempt per decision opportunity, with automatic retries disabled. On provider failure, use a validated oldest-eligible-message/answer fallback; after Stop or expiry, reject stale results instead. Waiting must not repeatedly call the model on unchanged input. Adding this decision ahead of dialogue adds a serial latency/cost step, so count it in end-to-end measurements.

Selected direction (2026-10-09): TypeScript/Node.js with pnpm, SQLite persistence and JSON WebSocket messages with shared runtime schema validation. Retain React/Vite, Vitest and an OpenAI-compatible dialogue endpoint; verify exact versions and dependencies. Backend modules use in-process interfaces; no vector database or Protobuf/gRPC is needed initially.

Start with lightweight local Kokoro/`kokoro-js` behind a TTS adapter to verify the full pipeline. Keep synthesis, browser playback and the VTS renderer adapter separate: provider SDKs, credentials and renderer-specific commands stay inside their adapters. Swap providers through composition/configuration without rewriting dialogue or scheduling; verify substitution with fixtures.

SQLite stores sessions, events, delivery outcomes, profiles and versioned memory; JSONL is an export/replay format, not a second writable source. M6 owns storage APIs/migrations, M4 owns memory semantics, and M5 owns live authority. Keep the database and audio outside OneDrive. See C5/C7 for adapter and storage boundaries.

## Working directories

Directories describe ownership. Current delivery and acceptance dates are maintained in the [submission checkpoint plan](DELIVERY-PLAN.en.md).

| Role | Main directory | Editing boundary |
| --- | --- | --- |
| M1 | `src/performance/` | Synthesis, player and avatar adapters; browser API under `src/performance/browser/`, Node/provider code outside it. |
| M2 | `src/console/` | Input, configuration, controls and presentation; consume M1's public browser interface. |
| M3 | `src/decision/` | Selection/intent, decision adapters and rule reactions; M5 retains live authority. |
| M4 | `src/dialogue/` | Text provider, persona/context and memory semantics; use M6 storage APIs. |
| M5 | `src/runtime/` | Session authority, scheduling, validation, cancellation, dispatch and composition. |
| M6 | `src/storage/`, `src/evaluation/`, `.github/workflows/` | Persistence/migrations, recording/replay, common evaluation and CI; each owner supplies module tests. |

`src/contracts/` is shared: M5 coordinates changes and affected producers/consumers review them. Owners place their tests in `test/offline/`; provider-dependent tests will use `test/live/`. M6 coordinates common fixtures and CI, not all module tests. Runtime prompts will use `prompts/`, with M3/M4 owning their respective prompt content. `docs/team/` holds English collaboration documents; Chinese understanding copies remain in OneDrive; machine-readable requirements and formal architecture artifacts still belong at the course-prescribed paths when prepared.

Evaluation program code uses `src/evaluation/`. Test fixtures remain under `test/`; generated measurements, databases and audio remain in ignored local storage outside OneDrive. A folder identifies responsibility, not a separate process or a complete access-control policy. Shared contracts, entry points, package manifests and lockfiles require coordinated review.

## Responsibilities and deliverables

The six-role allocation has been confirmed by the team. CHANG Xuben owns M5 and team coordination; GitHub owner accounts are recorded below; coursework names and student IDs are verified for the final report. This revision documents working locations and sequencing without changing assignments or ratings.

| Owner | Concrete deliverable | First task | Next task | Difficulty / workload (1–5) |
| --- | --- | --- | --- | --- |
| M1 — Pioneer141 | Speech playback and VTS avatar adapter | M1-01: play/stop fixed audio, advertise mapped actions, report completion/cancellation | M1-02: connect local Kokoro/VTS through separate adapters; verify output and fixture substitution | 5 / 5 |
| M2 — Warpshlczy | Local console | M2-01: input, profile/configuration, Stop/Resume and output state; mount M1's player | Show selected message/intent/wait and provide a small batch-input fixture | 3 / 4 |
| M3 — shallight | Response selection, intent and decision adapters | M3-01: filter inputs; implement the response-plan contract and rule baselines for plans/reactions | M3-02: general-model/Jev response plans; own selection cases, validity and fallback checks | 5 / 5 |
| M4 — L01nki1 | Dialogue model, persona and memory | M4-01: accept a response plan, produce fixture segments and correct delivery history | M4-02: real LLM/context/usage; own intent-to-dialogue mapping and intent-adherence cases | 5 / 5 |
| M5 — CHANG Xuben | Conversation flow and overall integration | M5-01: schedule one response decision, validate and reserve the selection, control Stop/late results | Integrate modules and verify no duplicate or stale reply starts | 5 / 4, plus leadership |
| M6 — MichaelLsh | Recording, replay, comparison tools and shared CI | M6-01: SQLite storage/migrations, durable plans/outcomes, JSONL export/replay and invariant CI | M6-02: shared comparison runner and total latency/cost; owners supply domain cases and review labels | 4 / 5 |

Each owner writes their own tests and module instructions, supplies genuine OpenCode records, and fixes their integration issues. M6 owns shared test tooling. CHANG Xuben coordinates architecture, scope, progress, integration and final delivery. Review/planning/QA roles can rotate. Ratings are estimates, not contribution grades.

Response-plan incremental burden: M1 negligible, M2 low, M3 medium–high, M4/M5 medium, M6 medium–high. Existing 5/5 ratings have no headroom; they do not mean the added work is free. To keep the increment bounded, prioritize response-plan comparison, retain rule reactions, share case authoring with M3/M4, and defer proactive speech, model-driven interruption and memory selection. This sequencing is proposed, not confirmed team capacity. SQLite adds storage/migration/recovery work to M6 and integration work to M4/M5; adapter substitution adds M1 checks. Keep these within existing tasks and review capacity before adding further providers.

## Development sequence and parallel work

S0-02 is the published diagnostic foundation at commit c717f77, with initial CI passed. S0-01 now has the shared preparation baseline and supervised contract/test review. Each owner reviews the tests for their next implementation slice.

The team can work in parallel after agreeing a small shared contract baseline. Confirmed roles do not by themselves approve interface fields, test oracles or numerical quality targets. Current diagnostic protocol 1 does not implement application protocol 0.2; its successful ping cannot serve as a business-integration test.

### 1. Run and review the shared baseline

Obtain this prepared repository version and run your role command below. M5 coordinates C1–C7 changes; affected owners review the examples and expected outcomes for their next module slice. M6 coordinates shared fixtures and test tooling. Reuse the defined identities, plans, segments, receipts and storage ports. Record actual review decisions without attributing supervisory approval to all members. Latency and live-model quality targets remain open for later measurement.

The immediate shared examples are one normal turn (C-01), one selected message/intent (C-13), a late result after Stop (C-03) and an interrupted second segment (C-04). These are existing case IDs, not new scope. Their shared types, fixtures and tests are implemented under src/contracts/app and test/. Product modules remain the owners' work.

### 2. Implement the existing first tasks in parallel

| Owner / existing task | First reviewable result | Substitute while a dependency is unfinished |
| --- | --- | --- |
| M1 / M1-01 | Fixed audio can play and stop; mapped capabilities and completion/cancellation receipts can be inspected. | Fixed audio, a test renderer and agreed dispatch messages; no dependency on real TTS/VTS. |
| M2 / M2-01 | Input, profile/configuration, Stop/Resume and output-state UI using agreed messages. | A clearly identified fixture transport and fixture receipts; replace it with the live transport during integration. |
| M3 / M3-01 | Deterministic response-plan and reaction rules, with eligibility, intent, defer and fallback cases. | Fixed candidate snapshots; no dependency on Jev or another online model. |
| M4 / M4-01 | Fixture dialogue segments and delivery-aware context behavior for completed/interrupted output. | Fixed response plans/receipts and a fixture implementation of the agreed storage interface; no real LLM required. |
| M5 / M5-01 | One controlled response cycle: request a plan, validate/reserve selection, invoke dialogue, authorize output and process Stop/late results. | Inject agreed fixture implementations of M1/M3/M4/M6; do not duplicate their business logic inside the coordinator. |
| M6 / M6-01 | SQLite event/receipt persistence, migrations, export/replay and the initial shared verification support. | Agreed fixture events and receipts; no dependency on real speech or models. |

Each owner supplies their module tests and failure cases. Producers and consumers review the same version of each contract. Use one task branch and a small PR per deliverable; coordinate edits to `src/contracts/`, root entry points and dependency files. A shared type change includes affected callers and tests in the same reviewed change; do not resolve conflicts by overwriting another member's work.

### 3. Integrate one offline loop, then connect real services

I1-01 joins console → selection/intent → dialogue → audio/reaction → receipts → history/recording. M5 coordinates integration; each owner fixes their module. Accept the normal flow and Stop/late-result cases before adding more providers, then exercise the remaining relevant C-01–C-17 cases as their features become available. Existing test suites must continue to pass.

M1-02, M4-02 and M3-02 can subsequently proceed in parallel behind the unchanged contracts: real Kokoro/VTS, dialogue model, and general-model/Jev response plans respectively. If a provider is unavailable, continue with fixtures and identify the live verification gap. I2-01 verifies the working live reference application.

M6-02 prepares measurement tooling alongside the offline work and compares implemented providers once usable results exist. M3/M4 supply semantic cases, M1/M2/M5 supply their observations. S1-01 records authentic evidence throughout; R1–R6 refine the existing course-deliverable work, not additional module assignments.

### Submission checkpoint responsibilities

Captain adopted the target schedule on October 29. Record delivery estimates when supplied; no separate weekly capacity return is required under this proposed process. Each cell points to existing work rather than a new module assignment. Members update the actual task or PR once; M5 maintains the Project summary. See [DELIVERY-PLAN](DELIVERY-PLAN.en.md) for product acceptance and reviewer dependencies.

| Member / role issue | I1 checks: Nov 1 / Nov 5 | I2: Nov 8 | Evaluation / faults: Nov 10-15 | Course closure: Nov 18-22 |
| --- | --- | --- | --- | --- |
| M1 / #2 / Pioneer141 | Playback/resource confirmation and consumer review | Real Kokoro/avatar acceptance | Physical observations and fault evidence | Output evidence and demo verification |
| M2 / #3 / Warpshlczy | PR67 product-console acceptance | Live waiting/failure/output UI | Input/Stop measurement and recovery UI | Demo recording and candidate check |
| M3 / #4 / shallight | Merged PR57 selection, ReactionPort and rule adoption | Prepare agreed comparison adapters in parallel | Corpus, labels, rubric, decision fault evidence | Evaluation interpretation and own process/reflection |
| M4 / #5 / L01nki1 | Intent and delivery-history consumption | Real text provider | Persona/history rubric, privacy and recovery semantics | Memory/context architecture and own process/reflection |
| M5 / #6 / inscripoem | Issue69 resource assembly, combined I1 candidate | Product deployment over merged PR64 acquisition | Capture, control, composition and requirement verdicts | Plan/architecture/report consolidation and package |
| M6 / #7 / MichaelLsh | PR70 checker and storage support | Measurement tooling in parallel | PR63/66, runner/provenance, formal results | Gates, trace/QA and independent recovery check |

Every member supplies authentic process records, contribution evidence and a verified personal reflection. Review and QA roles rotate without changing module owners. The initial I1 loop does not depend on complete cross-session recovery; checkpoint 6 covers committed product recovery obligations. Existing preparation and merged implementations are reused with their actual verification scope.

### Readiness command map

| Role/task | Command | Port(s) |
| --- | --- | --- |
| M1 | `pnpm test:m1` | `SynthesisPort`, `RendererPort`, `PlayerPort` |
| M2 | `pnpm test:m2` | `ConsoleTransportPort` |
| M3 | `pnpm test:m3` | `SelectionPort`, `ReactionPort` |
| M4 | `pnpm test:m4` | implements `DialoguePort`, `MemoryCommitPort`; consumes M6 `HistoryQueryPort` |
| M5 | `pnpm test:m5` | `RuntimeEndpointPort`, `ClockPort`, `ControlAuthorizerPort` (test harness in `test/support/contract-runner.ts`) |
| M6 | `pnpm test:m6` | `EventStorePort`, `MemoryProjectionPort`, `ReplayReaderPort`, `HistoryQueryPort` |
| Integration | `pnpm test:composition` | composed fixture runner |
| Readiness | `pnpm test:readiness` | contracts, requirements, boundaries |
| Full check | `pnpm verify` | typecheck, lint, all tests, build |

Contract changes follow the version-change coordination in [readiness kits](READINESS-KITS.en.md): trace consumers and update producers, consumers, fixtures and documentation together.

## Performance: measure before changing the stack

- Keep TypeScript/Node.js as the proposed coordination stack. Model requests and local TTS are likely bottlenecks, not measured findings. Consider Workers, a separate inference process or native components only when profiling identifies CPU work that delays the runtime or Stop handling.
- Measure console message submission → first audible output, and Stop click → actual playback silence. Separately record decision, dialogue, TTS and queue durations; distinguish cold startup from warm runs. Record waits, failures and cancellations separately so missing audio does not disappear from the results. Player/API acknowledgements alone do not prove audible output or silence; document the observation method and use comparable clocks.
- Reuse existing tasks: M2 records input/Stop times, M3 decision timing, M4 dialogue timing, M1 TTS/playback observations, and M5 queue/control timing. M6-02 aggregates these into the shared comparison. Establish timing conventions at I1-01 and measure real output at I2-01. This adds instrumentation within existing work packages; it is not zero effort or a new module.
- First reduce unnecessary serial requests, waiting and repeated work. Where dependencies allow, prepare the next finalized segment during playback; retain Stop authority and actual-delivery history. Set numerical targets after measuring a baseline on documented hardware and service settings.
- Evaluate Jev's selection/reply-quality benefit against its added latency and total calls/tokens, including failed or deferred attempts; mark unavailable usage as unknown. Compare rules/general-model/Jev plans with the dialogue model and rule reactions fixed; separately compare against one call that selects the message/intent and writes the reply. A separate decision model is not an assumed speed improvement.

## Implementation prerequisites

Bind owners and verify dependencies for the selected stack. M1 checks VTS/assets/authorization and Kokoro/audio; M4 checks the actual model endpoint; M3 checks general-model and Jev access. Unavailable services do not block fixtures, but remain unverified live tasks. Human evaluators are needed before claiming naturalness or engagement.

Every module handoff needs supported input/output examples, actual run instructions, tests/results, failure/Stop behavior and known limitations. Use [C1–C7 and C-01–C-17](INTERFACES.en.md) when implementing these boundaries; detailed contracts are a reference, not prerequisite reading for understanding the product.

Keep source, dependencies and caches outside OneDrive. Use OpenCode for course project implementation. English is the source document; synchronize its Chinese counterpart and submit only required English deliverables. Course requirements and genuine evidence remain tracked through S1-01; see [teacher grading guidance, Introduction p. 25](https://canvas.cityu.edu.hk/courses/70607/files/15921983/download) when needed.
