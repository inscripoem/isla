# Isla

Team delivery: [submission checkpoints and per-member handoffs](docs/team/DELIVERY-PLAN.en.md). The plan retains I1-01 / I2-01 and targets a complete candidate on November 22, with November 23-25 reserved for contingency. Progress board: [Isla Roadmap](https://github.com/users/inscripoem/projects/4).

Isla is a planned AI VTuber framework: a configurable character runtime with replaceable decision, dialogue, speech and avatar adapters, plus a local console.

This checkout contains the shared contracts, M5 coordinator, M1 speech/rendering/browser interfaces, M3 rule SelectionPort, M4 dialogue context and M6 in-memory/SQLite storage. The application transport (PR36), explicit session recovery (PR45), M3 rule selection (PR57) and bounded VTS acquisition (PR64) are merged. The standard console provides diagnostics; the separate interactive demo uses deterministic dialogue text, fixed audio and an M3 substitute. The production application uses real SQLite with deployment-supplied peers and a same-origin dynamic audio resource route over `POST /audio`. A coordinator-backed evaluation adapter is also available for explicit peers and consumers; see the [evaluation handoff](docs/team/HANDOFF-M5-EVALUATION-ADAPTER.en.md). Complete product deployment, M3 rule reactions, live dialogue, the browser product resolver and VTube Studio acceptance remain open. See the [current delivery plan](docs/team/DELIVERY-PLAN.en.md) for component and PR status.

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

The runtime listens on `127.0.0.1:4317`. Vite proxies `/health` and `/diag` (diagnostics), `/app` (application WebSocket) and `/operator` (operator bootstrap) to it, so an application runtime can share the root entry origin with the diagnostics console; the runtime's own origin/host checks still apply to the forwarded request. The console currently uses the diagnostics routes only; M2 owns the console UI. The optional `ISLA_RUNTIME_HOST` and `ISLA_RUNTIME_PORT` settings are validated; changing the runtime endpoint also requires updating the Vite proxy. No provider credentials or model downloads are needed.

## Run the first interactive loop (I1)

The offline product loop (input → selection/intent → dialogue → fixed
audio/subtitle/reaction → real player receipts → history) runs against the real
M5 runtime, M4 dialogue/context/memory, M1 playback and M6 in-memory storage.
M3 and the dialogue text provider are explicit `test/support` substitutes. The
fixed text matches the registered WAV assets exactly. Production source imports
no test code.

```sh
pnpm dev:loop                                        # loop runtime on 127.0.0.1:4317
pnpm exec vite --config test/browser/vite.config.ts  # loop page on 127.0.0.1:5173
```

Open `http://127.0.0.1:5173/loop.html` and follow the on-page steps. The
[I1 application transport handoff](docs/team/HANDOFF-I1-APPLICATION.en.md)
documents the protocol-0.2 wire messages, authority rules and M2 integration
points. Diagnostic protocol `1` at `/diag` is unchanged.

The browser demo and the automated Node performer share one browser-safe
protocol state machine (`test/browser/performer-machine.ts`), so the demo does
not duplicate transport logic. Media events are API observations, not acoustic
measurements.

## Dynamic audio resource route

The runtime serves registered dynamic audio resources over one explicit
same-origin route: `POST /audio?ref=<reference>` with the `x-isla-audio-fetch`
header. The root Vite entry (`pnpm dev`) proxies `/audio` to the runtime, so a
page served by that entry fetches resources on its own origin; the demo-local
config above does not proxy it. Admission, lifecycle rechecks, serving slots and
lease ownership are documented in the
[dynamic audio handoff](docs/team/HANDOFF-M5-DYNAMIC-AUDIO.en.md).

```sh
pnpm dev:loop   # loop runtime on 127.0.0.1:4317
pnpm dev        # root entry on 127.0.0.1:5173 (proxies /health, /diag, /app, /operator, /audio)
node test/browser/root-entry-routing.mjs         # root routing and refusal checks
node test/browser/root-entry-audio-browser.mjs   # real-browser audio fetch acceptance
```

The browser acceptance resolves Playwright from the installed packages and lets
Playwright pick Chromium; on a machine that keeps them outside the project, set
`ISLA_PLAYWRIGHT_PATH` (Playwright package directory) and `ISLA_CHROMIUM_PATH`
(Chromium executable).

## Run the production composition

`pnpm runtime:production` starts the M5 production application: one real SQLite
database, the M6 store/history view over it, operator-driven session recovery and
the loopback HTTP/WebSocket server. The entry requires an explicit deployment
module and never falls back to fixtures. The module exports
`createProductionDeployment` (or a default export) returning the peer ports, the
initial archive selection and the allowed origins; the contract is documented in
the [M5 production composition handoff](docs/team/HANDOFF-M5-PRODUCTION.en.md).

```sh
ISLA_DEPLOYMENT_MODULE=/absolute/path/to/deployment.ts pnpm runtime:production
```

| Variable | Purpose / default |
| --- | --- |
| `ISLA_DEPLOYMENT_MODULE` | Required path of the deployment module exporting `createProductionDeployment`; a missing or malformed module exits 1. |
| `ISLA_STORAGE_DB_PATH` | SQLite database path; default `.cache/isla/isla.db`, kept outside OneDrive. |
| `ISLA_RUNTIME_HOST`, `ISLA_RUNTIME_PORT` | Loopback bind address; default `127.0.0.1:4317`. |

No product deployment module exists in this checkout yet. The retained synthesis
factory uses the merged M1 PR33/34 interfaces. See the [physical synthesis
handoff](docs/team/HANDOFF-M5-PHYSICAL-SYNTHESIS.en.md) for the shared adapter,
originating gate and owned-release contract. M3 rule selection is merged, but
its adoption in the controlled formal deployment, M3 rule reaction and a live M4
text source remain open. M5 owns dynamic audio HTTP/resource assembly and physical
provider lifecycle; M2 is the browser consumer. The module under
`test/support/` is test-only and is used by the automated CLI suite, not by the
product entry. SIGINT/SIGTERM perform the controlled shutdown: stop the transport,
drain admitted turn and receipt bookkeeping, then the queued writes, close the
database and await deployment-owned release. Readiness follows signal-handler
registration; shutdown completion requires successful release. Multiple cleanup
failures remain visible, including on repeated stop calls.

## Check the foundation

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests run locally without model services and exercise HTTP/WebSocket success, rejection and lifecycle behavior. The build produces the browser bundle; the runtime runs through `tsx`. The [initial scaffold CI passed](https://github.com/inscripoem/isla/actions/runs/37954077638) at commit c717f77. Main requires a protected, approved PR; follow maintainer confirmation and the effective branch rules before merging.

## Blocking gates (D7)

The CI pipeline implements six gate checks plus the traceability fitness function; the design is recorded in [ADR-006](docs/architecture/adr/006-gate-tooling.md). G1 remains advisory, and G4 reports not run when its required evidence is absent.

| Gate | Enforced by |
| --- | --- |
| G1 — tests approved before implementation | the **`verify` job** (advisory step): the `tests-approved` label on a code/prompt pull request |
| G2 — static analysis + boundary | `pnpm typecheck && pnpm lint`; `pnpm test:readiness` (import/permission boundaries) |
| G3 — requirements schema | `pnpm test:readiness` (registry validation) |
| G4 — semantic evaluation | `pnpm gate:eval` — reports **not run** without an evaluation set + provider access (never a pass), and fails an evaluation table that omits the fixed conditions NFR-01 requires |
| G5 — regression | `pnpm test` (all offline suites) |
| G6 — AI-use log | `pnpm gate:ai-use-log` over the pull-request diff |
| traceability | `pnpm test:trace` (INV-13: the chain is machine-checked; a changed frozen path passes only on a verified default-branch restoration for a feature-branch push) |

The effective main rules require the GitHub Actions `verify` check, PR approval and linear history.
Account-specific bypasses and the untested failed-check refusal are recorded in
[verification constraints](docs/code-governance/verification-constraints.md). Live providers, browser
audio and semantic quality thresholds are not proven by these checks.

## Team development

Start with [the team development index](docs/team/README.md). The [work plan](docs/team/PLAN.en.md) describes the confirmed allocation, directories and first parallel tasks; [interfaces](docs/team/INTERFACES.en.md) and [candidate requirements](docs/team/REQUIREMENTS.en.md) remain subject to their stated acceptance status.

| Role | Main directory | State |
| --- | --- | --- |
| M1 speech/player/avatar | `src/performance/` | Synthesis, mapped rendering, browser player and guarded Kokoro worker implemented; live product acceptance pending |
| M2 console | `src/console/` | Diagnostic console exists; product transport integration pending |
| M3 response decisions | `src/decision/` | Rule SelectionPort merged in PR57; rule reaction and formal composition pending |
| M4 dialogue/memory | `src/dialogue/` | PR23/30/35/65 merged; live provider pending |
| M5 runtime — CHANG Xuben | `src/runtime/` | Application transport, reconstruction, production composition and bounded VTS acquisition implemented; combined product acceptance pending; [reconstruction](docs/team/HANDOFF-M5-RECONSTRUCTION.en.md) and [production](docs/team/HANDOFF-M5-PRODUCTION.en.md) handoffs |
| M6 storage/evaluation/CI | `src/storage/`, `src/evaluation/`, `.github/workflows/` | Storage, recorded-run parser and evaluation tooling implemented; product recovery, run provenance and live measurements remain unaccepted |

Shared contracts use `src/contracts/` (application schemas and ports under `src/contracts/app/`); tests use `test/offline/` and, when implemented, `test/live/`. The [architecture blueprint](architecture-blueprint.md) defines editing boundaries. Planned directories are not empty substitute implementations. Each owner can begin against the shared contracts and explicit fixtures; see [readiness kits](docs/team/READINESS-KITS.en.md).

Each role has an independently runnable conformance command:

```sh
pnpm test:m1 && pnpm test:m2 && pnpm test:m3
pnpm test:m4 && pnpm test:m5 && pnpm test:m6
pnpm test:composition   # fixture and production-coordinator loops
pnpm test:readiness     # contracts, requirements, import boundaries
pnpm verify             # typecheck, lint, all tests, build
```

M5 tests exercise the production coordinator and retain the independent fixture reference. Both implementations run the same composition and regression assertions. See the [M5-01 handoff](docs/team/HANDOFF-M5-01.en.md) for imports, configuration and I1-01 integration requests. The production application and process-restart tests additionally exercise real SQLite persistence and application transport. Controlled peer fixtures do not certify live providers or acoustic output.

Diagnostics use version `1`: send `{"v":1,"kind":"ping"}` or `{"v":1,"kind":"get_health"}` to `/diag`. Application actions such as `input.submit` are rejected. This diagnostic protocol is separate from application protocol `0.2` at `/app`.

Keep dependencies, caches and execution data outside OneDrive. Current English collaboration documents are maintained in `docs/team/`; Chinese understanding copies remain in OneDrive. Internal raw records, historical review-only drafts and sharing ZIPs remain in OneDrive or external evidence storage. Coursework submission packages use an explicit English-only whitelist and exclude Chinese copies. Genuine development records are kept in the adjacent external evidence directory.

Product references: [AIRI](https://github.com/moeru-ai/airi), [Cortico](https://github.com/Pal-AI-Lab/Cortico), [cortico-world-vtuber](https://github.com/Pal-AI-Lab/cortico-world-vtuber), and the public [Neuro SDK](https://github.com/VedalAI/neuro-sdk). These are references, not claims about Neuro-sama's private implementation.
