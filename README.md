# Isla

Repository: https://github.com/inscripoem/isla

Isla is an AI VTuber runtime: a configurable character runtime with replaceable decision, dialogue, speech and avatar adapters, a local console and a durable session store. The repository holds the runtime, its module implementations, the shared contracts between them and the offline, live and browser test suites.

Delivery status, checkpoint records and per-member handoffs are kept in the [delivery plan](docs/team/DELIVERY-PLAN.en.md) and the [GitHub issue tracker](https://github.com/inscripoem/isla/issues). This README describes the repository itself and does not track individual pieces of work.

## Architecture

One Node.js process owns the session loop. It admits input, asks the decision module for a selection and a reply intent, asks the dialogue module for text, drives speech synthesis and playback, renders avatar actions through the performance module, and records the confirmed result through storage. Modules meet only at the ports and schemas in `src/contracts/`; each module has a production implementation and explicit test substitutes under `test/support/`. The browser console and the automated tests share the same browser-safe performer state machine.

Diagnostic protocol `1` at `/diag` is separate from application protocol `0.2` at `/app`.

## Project organization

| Path | Contents |
| --- | --- |
| `src/contracts/` | Shared application schemas and ports (C1-C7); application schemas under `src/contracts/app/`. |
| `src/runtime/` | Runtime coordinator, application transport, session reconstruction, production CLI and deployment modules. |
| `src/performance/` | Speech synthesis, audio playback adapters, the browser player and avatar rendering; the browser entry lives in `src/performance/browser/`. |
| `src/console/` | Browser console, application transport client and the shared performer state machine. |
| `src/decision/` | Response-plan selection and segment-reaction decisions, with rule and OpenAI-compatible provider adapters. |
| `src/dialogue/` | Dialogue context, persona content and memory. |
| `src/storage/` | SQLite persistence, history views and session recovery stores. |
| `src/evaluation/` | Evaluation runner, report writer, provenance records and gates. |
| `test/offline/` | Default suite collected by `pnpm test`; no model services required. |
| `test/live/` | Opt-in live provider suites with a standalone Vitest configuration; not collected by `pnpm test`. |
| `test/browser/` | Playwright browser acceptance, root-entry routing and audio fetch checks. |
| `test/support/` | Test-only fixtures, substitute peers and the contract runner; production code must not import them. |
| `docs/req/` | Machine-readable requirements, cases and their schema. |
| `docs/architecture/` | Architecture blueprint, ADRs and deltas, supported platform, permission model and candidate comparison. |
| `docs/code-governance/` | Gate tooling, test approvals, structural constraints, verification constraints and the tool manifest. |
| `docs/team/` | Role entry points, plans, readiness kits, interfaces, requirements and handoffs. |
| `prompts/` | Versioned prompt specifications, the character bible and the prompt version manifest. |
| `.opencode/` | Permission policy source (`permissions.jsonc`) and the always-on rules (`rules.md`). |
| `.agent/` | Project covenant (`rules.md`). |
| `.github/workflows/` | Continuous integration: verification, the D7 gates and the traceability check. |

## Run locally

Use Node.js 22.12 or newer and pnpm 12. From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm dev:runtime
```

In a second terminal, from the same directory:

```sh
pnpm dev:web
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5173`). The console displays backend health and the diagnostic socket status. Select **Ping diagnostics** to obtain a real response. Start the runtime before opening the page; reload the page to reconnect after a runtime restart. Use Ctrl-C in each terminal to stop it.

The runtime listens on `127.0.0.1:4317`. Vite proxies `/health` and `/diag` (diagnostics), `/app` (application WebSocket) and `/operator` (operator bootstrap) to it, so an application runtime can share the root entry origin with the diagnostics console; the runtime's own origin/host checks still apply to the forwarded request. The root console provides diagnostic and application views; the console UI is owned by the console module. The optional `ISLA_RUNTIME_HOST` and `ISLA_RUNTIME_PORT` settings are validated; changing the runtime endpoint also requires updating the Vite proxy. No provider credentials or model downloads are needed.

## Run the offline interactive loop

The offline product loop (input → selection/intent → dialogue → fixed audio/subtitle/reaction → real player receipts → history) runs against the real runtime, dialogue/context/memory, playback and in-memory storage. The loop uses the rule `SelectionPort` with the runtime clock. Reaction and the dialogue text provider are explicit `test/support` substitutes, and the fixed text matches the registered WAV assets exactly. Production source imports no test code.

```sh
pnpm dev:loop                                        # loop runtime on 127.0.0.1:4317
pnpm exec vite --config test/browser/vite.config.ts  # loop page on 127.0.0.1:5173
```

Open `http://127.0.0.1:5173/loop.html` and follow the on-page steps. The [application transport handoff](docs/team/HANDOFF-I1-APPLICATION.en.md) documents the protocol-0.2 wire messages, authority rules and console integration points. Diagnostic protocol `1` at `/diag` is unchanged.

The browser demo and the automated Node performer share the browser-safe production state machine (`src/console/performer-machine.ts`). The `test/browser/performer-machine.ts` shim re-exports it for test consumers. Media events are API observations, not acoustic measurements.

## Dynamic audio resource route

The runtime serves registered dynamic audio resources over one explicit same-origin route: `POST /audio?ref=<reference>` with the `x-isla-audio-fetch` header. The root Vite entry (`pnpm dev`) proxies `/audio` to the runtime, so a page served by that entry fetches resources on its own origin; the demo-local config above does not proxy it. Admission, lifecycle rechecks, serving slots and lease ownership are documented in the [dynamic audio handoff](docs/team/HANDOFF-M5-DYNAMIC-AUDIO.en.md).

```sh
pnpm dev:loop   # loop runtime on 127.0.0.1:4317
pnpm dev        # root entry on 127.0.0.1:5173 (proxies /health, /diag, /app, /operator, /audio)
node test/browser/root-entry-routing.mjs         # root routing and refusal checks
node test/browser/root-entry-audio-browser.mjs   # real-browser audio fetch acceptance
```

The browser acceptance resolves Playwright from the installed packages and lets Playwright pick Chromium; on a machine that keeps them outside the project, set `ISLA_PLAYWRIGHT_PATH` (Playwright package directory) and `ISLA_CHROMIUM_PATH` (Chromium executable).

## Run the production composition

`pnpm runtime:production` starts the production application: one real SQLite database, the store/history view over it, operator-driven session recovery and the loopback HTTP/WebSocket server. The entry requires an explicit deployment module and never falls back to fixtures. The module exports `createProductionDeployment` (or a default export) returning the peer ports, the initial archive selection and the allowed origins; the contract is documented in the [production composition handoff](docs/team/HANDOFF-M5-PRODUCTION.en.md).

```sh
ISLA_DEPLOYMENT_MODULE=/absolute/path/to/deployment.ts pnpm runtime:production
```

| Variable | Purpose / default |
| --- | --- |
| `ISLA_DEPLOYMENT_MODULE` | Required path of the deployment module exporting `createProductionDeployment`; a missing or malformed module exits 1. |
| `ISLA_STORAGE_DB_PATH` | SQLite database path; default `.cache/isla/isla.db`, kept outside OneDrive. |
| `ISLA_RUNTIME_HOST`, `ISLA_RUNTIME_PORT` | Loopback bind address; default `127.0.0.1:4317`. |

The reference live deployment is `src/runtime/deployments/reference-live.ts`. It reads its configuration from the same injected environment, fails startup when a required value is missing or invalid (naming the variables only, never their values), and wires the live text provider, Kokoro synthesis, the VTube Studio renderer and the audio registry. [Supported platform](docs/architecture/supported-platform.md) records the target machine, the observed model and voice, and the limits of that observation.

```sh
ISLA_DEPLOYMENT_MODULE=src/runtime/deployments/reference-live.ts \
ISLA_STORAGE_DB_PATH=.cache/isla/isla.db \
ISLA_RUNTIME_HOST=127.0.0.1 ISLA_RUNTIME_PORT=4317 \
pnpm runtime:production
```

`ISLA_VTS_HOTKEY_MAP` is a JSON object; every advertised action must have exactly one binding. The reference target uses the bundled `Hiyori_A` model (`00f9750080014d43bb398cd98e4f55ad`) and these three hotkey ids:

```sh
ISLA_VTS_HOTKEY_MAP='{"animation-1":"b66cf516d694446b9e1aafbcf16459a9","animation-2":"c28e206b5e3c4eb5be3c1dcee11f02c0","animation-3":"ad4e0bc1a58746a58002ad180692e649"}'
```

The `Hiyori_A` model id and the three hotkey ids are recorded platform observations, not re-measured here. `animation-1/2/3` map to `hiyori_m03/m06/m10.motion3.json`; the display names are the model's "My Animation 1/2/3". The host operator keeps the raw model, textures and motions outside the repository. The demo credits must carry Live2D's prescribed Hiyori copyright notice and use content that respects the character terms.

The synthesis factory uses the speech-synthesis interfaces; the [physical synthesis handoff](docs/team/HANDOFF-M5-PHYSICAL-SYNTHESIS.en.md) documents the shared adapter, originating gate and owned-release contract. A controlled deployment combines rule selection and reaction with fixed WAV assets, while the reference live deployment adds live dialogue text, Kokoro synthesis and the VTS renderer. The runtime owns dynamic audio HTTP/resource assembly and physical provider lifecycle; the console is the browser consumer. The module under `test/support/` is test-only and is used by the automated CLI suite, not by the product entry. SIGINT/SIGTERM perform the controlled shutdown: stop the transport, drain admitted turn and receipt bookkeeping, then the queued writes, close the database and await deployment-owned release. Readiness follows signal-handler registration; shutdown completion requires successful release. Multiple cleanup failures remain visible, including on repeated stop calls.

### Choose a voice

Open **Session → Voice** to see the English Kokoro voices installed on this machine. Choose a voice and click **Preview voice** to hear the same short line in that voice. **Stop preview** ends the audition. The **Current voice** label shows which voice will be used for replies.

Enable operator controls and click **Use this voice** to save your choice. It takes effect on the next conversation turn. A reply already in progress finishes in the voice it started with. The reference deployment stores the selection beside its SQLite database in `<database path>.voices.json` and loads it at startup. The initial voice is Heart.

Each VTube Studio hotkey dispatch sends three requests and reports `play_not_allowed` or `play_failed` when the model refuses or fails playback.

## Check the repository

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The three check paths are:

| Path | Command | Scope |
| --- | --- | --- |
| Offline | `pnpm test` (or `pnpm verify`) | Every suite in `test/offline/`; no model services or audio device required. |
| Live | `pnpm exec vitest run --config test/live/vitest.config.ts` | Opt-in provider suites in `test/live/`; excluded from CI and from `pnpm test`, needing the pinned model. |
| Full | `pnpm verify` | Typecheck, lint, every offline suite and the production build. |

Tests exercise HTTP/WebSocket success, rejection and lifecycle behaviour. The build produces the browser bundle; the runtime runs through `tsx`. Main requires a protected, approved PR; follow maintainer confirmation and the effective branch rules before merging.

## Blocking gates (D7)

The CI pipeline implements six gate checks plus the traceability fitness function; the design is recorded in [ADR-006](docs/architecture/adr/006-gate-tooling.md) and its [enforcement delta](docs/architecture/delta/006-gate-enforcement.md). G1 uses recorded approval evidence for pull requests created at or after the 2026-11-16T16:01:01Z cutover and keeps the label rule (advisory) for earlier ones; a time-boxed M6 waiver covers the recorded exception set through 2026-11-27; see docs/code-governance/g1-test-approval-proposal.md. G4 reports not run when there is no evidence at all, and fails a measured claim that has no evaluation table or no fixed conditions.

| Gate | Enforced by |
| --- | --- |
| G1 — tests approved before implementation | the **`verify` job**: a PR created at or after the 2026-11-16T16:01:01Z cutover needs `docs/code-governance/test-approvals.yaml` to cover every changed code path and be committed before the first code commit; a PR created before it keeps the `tests-approved` label/advise rule; the M6 time-boxed waiver covers the recorded exception set through 2026-11-27; see docs/code-governance/g1-test-approval-proposal.md. The path check covers changed files under `src/` or `prompts/` only (`CODE_OR_PROMPT_PREFIXES`); `tools/` is outside G1 and is covered by G2 and G5 |
| G2 — static analysis + boundary | `pnpm typecheck && pnpm lint` |
| G3 — requirements schema | `pnpm test:readiness` (contracts, requirements registry and import boundaries); the permission-policy test runs in G5 |
| G4 — semantic evaluation | `pnpm gate:eval` — reports **not run** only when there is neither a table nor a claim; fails a table that omits the fixed conditions NFR-01 requires, a claim row with no value or conditions, and a measured prose claim with no evaluation table; reviewed exceptions expire in `gate-baseline.yaml` |
| G5 — regression | `pnpm test` (all offline suites) |
| G6 — AI-use log | `pnpm gate:ai-use-log` over the pull-request diff |
| traceability | `pnpm test:trace` (INV-13: the chain is machine-checked; a changed frozen path passes only on a verified default-branch restoration for a feature-branch push) |

The effective main rules require the GitHub Actions `verify` check, one approving review after the latest push, and linear history. Account-specific bypasses and the untested failed-check refusal are recorded in [verification constraints](docs/code-governance/verification-constraints.md). Live providers, browser audio and semantic quality thresholds are not proven by these checks.

## Team development

Start with [the team development index](docs/team/README.md). The [work plan](docs/team/PLAN.en.md) describes the confirmed allocation, directories and first parallel tasks; [interfaces](docs/team/INTERFACES.en.md) and [candidate requirements](docs/team/REQUIREMENTS.en.md) carry their own acceptance status.

| Role | Main directory |
| --- | --- |
| M1 speech/player/avatar | `src/performance/` |
| M2 console | `src/console/` |
| M3 response decisions | `src/decision/` |
| M4 dialogue/memory | `src/dialogue/` |
| M5 runtime — CHANG Xuben | `src/runtime/` |
| M6 storage/evaluation/CI | `src/storage/`, `src/evaluation/`, `.github/workflows/` |

Shared contracts use `src/contracts/` (application schemas and ports under `src/contracts/app/`); tests use `test/offline/` by default, and the opt-in live suites live in `test/live/` (not collected by `pnpm test`). The [architecture blueprint](architecture-blueprint.md) defines editing boundaries. Each directory holds its stated implementation; unfinished adapters use explicit `test/support` substitutes rather than silent stubs. See [readiness kits](docs/team/READINESS-KITS.en.md) for each owner's starting points.

Each role has an independently runnable conformance command:

```sh
pnpm test:m1 && pnpm test:m2 && pnpm test:m3
pnpm test:m4 && pnpm test:m5 && pnpm test:m6
pnpm test:composition   # fixture and production-coordinator loops
pnpm test:readiness     # contracts, requirements, import boundaries
pnpm verify             # typecheck, lint, all tests, build
```

The coordinator tests exercise the production coordinator and retain the independent fixture reference. Both implementations run the same composition and regression assertions. The production application and process-restart tests additionally exercise real SQLite persistence and application transport. Controlled peer fixtures do not certify live providers or acoustic output.

The [coding permission model](docs/architecture/permission-model.md) compiles one task-local `build` configuration from an explicit role/path policy. The policy is not auto-loaded and does not activate a blocking gate; human adoption and branch protection are separate decisions. Provider, model and plugin choices are generation inputs, not committed policy values. The [qualitative architecture candidate comparison](docs/architecture/candidate-comparison.md) consolidates the alternatives recorded in the ADRs; measured results belong to the G4 evaluation table.

## Diagnostics

Diagnostics use version `1`: send `{"v":1,"kind":"ping"}` or `{"v":1,"kind":"get_health"}` to `/diag`. Application actions such as `input.submit` are rejected. This diagnostic protocol is separate from application protocol `0.2` at `/app`.

## Repository hygiene

Keep dependencies, caches and execution data outside OneDrive. English collaboration documents are maintained in `docs/team/`; Chinese understanding copies remain in OneDrive. Internal raw records, historical review-only drafts and sharing ZIPs remain in OneDrive or external evidence storage. Coursework submission packages use an explicit English-only whitelist and exclude Chinese copies. Genuine development records are kept in the adjacent external evidence directory.

## References

Product references: [AIRI](https://github.com/moeru-ai/airi), [Cortico](https://github.com/Pal-AI-Lab/Cortico), [cortico-world-vtuber](https://github.com/Pal-AI-Lab/cortico-world-vtuber), and the public [Neuro SDK](https://github.com/VedalAI/neuro-sdk). These are references, not claims about Neuro-sama's private implementation.
