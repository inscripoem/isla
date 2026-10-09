# Isla

Isla is a planned AI VTuber framework: a configurable character runtime with replaceable decision, dialogue, speech and avatar adapters, plus a local console.

This checkout contains the initial runnable foundation, under review (2026-10-09). It provides local health checks and WebSocket diagnostics. Character conversations, Jev, TTS, VTube Studio and SQLite persistence are not implemented yet.

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

## Check the foundation

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests run locally without model services and exercise HTTP/WebSocket success, rejection and lifecycle behavior. The build produces the browser bundle; the runtime runs through `tsx`. The initial CI workflow repeats these checks. Remote CI, branch protection, live provider tests and the full course gates remain unverified or unimplemented.

## Where to work

| Area | Current entry | Responsibility |
| --- | --- | --- |
| M2 console | `src/console/ConsoleApp.tsx` | Browser UI and connection state |
| M5 runtime | `src/runtime/cli.ts`, `server.ts` | Local service, lifecycle and integration |
| Shared contracts | `src/contracts/` | Diagnostic message and health boundaries |
| Shared verification | `test/offline/`, `.github/workflows/ci.yml` | Owner-authored tests and M6 CI coordination |

M1 speech/player/avatar adapters, M3 response decisions, M4 dialogue/memory and M6 SQLite/evaluation are future work. No empty implementations stand in for these modules.

Diagnostics use version `1`: send `{"v":1,"kind":"ping"}` or `{"v":1,"kind":"get_health"}` to `/diag`. Application actions such as `input.submit` are rejected. This diagnostic protocol is separate from the planned application protocol `0.2`.

Keep dependencies, caches and execution data outside OneDrive. Chinese counterparts and all review-only planning materials remain in the separate OneDrive course workspace; they are excluded from this repository. Genuine development records are kept in the adjacent external evidence directory.

Product references: [AIRI](https://github.com/moeru-ai/airi), [Cortico](https://github.com/Pal-AI-Lab/Cortico), [cortico-world-vtuber](https://github.com/Pal-AI-Lab/cortico-world-vtuber), and the public [Neuro SDK](https://github.com/VedalAI/neuro-sdk). These are references, not claims about Neuro-sama's private implementation.
