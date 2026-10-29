# Live tests

Provider-dependent tests live here. The offline suites under `test/offline/`
run in CI and in every local `pnpm test`; everything in this directory is
opt-in and never runs as part of the offline gates (the root
`vitest.config.ts` includes only `test/offline/**`).

## Run the live suite

```sh
pnpm exec vitest run --config test/live/vitest.config.ts
```

The suite skips cleanly when the provider environment is not configured.

## Credential rules

- Credentials come from environment variables only, and are never written to
  the repository, never defaulted, and never printed. See `live-config.ts`,
  whose unavailability reasons name variable NAMES and never values (pinned by
  `live-config.test.ts`).
- Variables (all required for a live run):
  `ISLA_LIVE_TEXT_BASE_URL`, `ISLA_LIVE_TEXT_MODEL`, `ISLA_LIVE_TEXT_API_KEY`.
- Keep caches and logs outside OneDrive, as for all execution data.

## Contents

| Path | Purpose |
| --- | --- |
| `vitest.config.ts` | Opt-in vitest config; include is scoped to this directory. |
| `live-config.ts` | Environment-only provider configuration; reports availability without echoing secrets. |
| `live-config.test.ts` | Offline-safe tests of the configuration loader, including the no-secret-echo property. |
| `m4-text-source.live.test.ts` | M4-02 acceptance harness (`it.todo` placeholders mapped to the HANDOFF-M4-01 criteria); skips without credentials. |
| `kokoro-*` | M1's Kokoro worker live-verification assets (run via `tsx`, see `src/performance/README.md`). |

Live evidence never substitutes for the offline gates: a passing live run is
reported as such, and fixtures alone never claim live provider behavior
(AGENTS.md).
