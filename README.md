# Isla

Isla is a planned AI VTuber framework: a configurable character runtime with replaceable decision, dialogue, speech and avatar adapters, plus a local console.

This checkout contains the diagnostic foundation, shared contracts, M5 coordinator, M1 fixed synthesis/mapped rendering/browser player and M6 in-memory storage. The local I1 increment connects these through a separate interactive demo, under review (2026-10-15). The standard console still provides diagnostics; real M4 is now integrated locally with a deterministic text provider. The product console, M3, live dialogue/TTS/VTube Studio and SQLite remain owner deliverables.

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

The runtime listens on `127.0.0.1:4317`. Vite proxies `/health` and `/diag` to it. The optional `ISLA_RUNTIME_HOST` and `ISLA_RUNTIME_PORT` settings are validated; changing the runtime endpoint also requires updating the Vite proxy. No provider credentials or model downloads are needed.

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

## Check the foundation

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests run locally without model services and exercise HTTP/WebSocket success, rejection and lifecycle behavior. The build produces the browser bundle; the runtime runs through `tsx`. The initial CI workflow repeats these checks. The [initial scaffold CI passed](https://github.com/inscripoem/isla/actions/runs/37954077638) at commit c717f77. Main requires an approved PR; only a human may merge it. Live provider tests and the full course gates remain pending; that run does not validate subsequent changes.

## Team development

Start with [the team development index](docs/team/README.md). The [work plan](docs/team/PLAN.en.md) describes the confirmed allocation, directories and first parallel tasks; [interfaces](docs/team/INTERFACES.en.md) and [candidate requirements](docs/team/REQUIREMENTS.en.md) remain subject to their stated acceptance status.

| Role | Main directory | State |
| --- | --- | --- |
| M1 speech/player/avatar | `src/performance/` | Fixed synthesis, mapped rendering and browser player implemented; live adapters pending |
| M2 console | `src/console/` | Diagnostic console exists; product transport integration pending |
| M3 response decisions | `src/decision/` | Planned |
| M4 dialogue/memory | `src/dialogue/` | PR23/PR30 merged; live provider pending |
| M5 runtime — CHANG Xuben | `src/runtime/` | Application loop and selected-history reconstruction under review; [handoff](docs/team/HANDOFF-M5-RECONSTRUCTION.en.md) |
| M6 storage/evaluation/CI | `src/storage/`, `src/evaluation/`, `.github/workflows/` | In-memory storage, requirements tooling and CI exist; SQLite pending |

Shared contracts use `src/contracts/` (application schemas and ports under `src/contracts/app/`); tests use `test/offline/` and, when implemented, `test/live/`. The [architecture blueprint](architecture-blueprint.md) defines editing boundaries. Planned directories are not empty substitute implementations. Each owner can begin against the shared contracts and explicit fixtures; see [readiness kits](docs/team/READINESS-KITS.en.md).

Each role has an independently runnable conformance command:

```sh
pnpm test:m1 && pnpm test:m2 && pnpm test:m3
pnpm test:m4 && pnpm test:m5 && pnpm test:m6
pnpm test:composition   # fixture and production-coordinator loops
pnpm test:readiness     # contracts, requirements, import boundaries
pnpm verify             # typecheck, lint, all tests, build
```

M5 tests exercise the production coordinator and retain the independent fixture reference. Both implementations run the same composition and regression assertions. See the [M5-01 handoff](docs/team/HANDOFF-M5-01.en.md) for imports, configuration and I1-01 integration requests. These checks do not certify live providers, browser audio or SQLite persistence.

Diagnostics use version `1`: send `{"v":1,"kind":"ping"}` or `{"v":1,"kind":"get_health"}` to `/diag`. Application actions such as `input.submit` are rejected. This diagnostic protocol is separate from application protocol `0.2` at `/app`.

Keep dependencies, caches and execution data outside OneDrive. Current English collaboration documents are maintained in `docs/team/`; Chinese understanding copies remain in OneDrive. Internal raw records, historical review-only drafts and sharing ZIPs remain in OneDrive or external evidence storage. Coursework submission packages use an explicit English-only whitelist and exclude Chinese copies. Genuine development records are kept in the adjacent external evidence directory.

Product references: [AIRI](https://github.com/moeru-ai/airi), [Cortico](https://github.com/Pal-AI-Lab/Cortico), [cortico-world-vtuber](https://github.com/Pal-AI-Lab/cortico-world-vtuber), and the public [Neuro SDK](https://github.com/VedalAI/neuro-sdk). These are references, not claims about Neuro-sama's private implementation.
