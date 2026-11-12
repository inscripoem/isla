# Live provider suite

This directory holds opt-in tests that call real remote providers. They are
deliberately excluded from the offline gate (`pnpm test` collects only
`test/offline/**`).

## Opt-in command

```sh
pnpm exec vitest run --config test/live/vitest.config.ts
```

The command is safe to run without credentials: each suite reads its provider
configuration at module load, and an unconfigured group skips cleanly with zero
failures. A configured provider is expected to answer; a live failure is a real
failure, not a fixture fallback.

## Provider environment groups

All variables are optional until a suite is configured. Values are read from the
process environment only; they are never committed, defaulted, logged or echoed.

### M4 text provider (`test/live/m4-text-source.live.test.ts`)

| Variable | Purpose |
| --- | --- |
| `ISLA_LIVE_TEXT_BASE_URL` | OpenAI-compatible chat-completions base URL (http/https, no trailing slash required) |
| `ISLA_LIVE_TEXT_MODEL` | Model identifier the provider exposes |
| `ISLA_LIVE_TEXT_API_KEY` | Bearer credential |

### M3 decision provider (`test/live/m3-decision.live.test.ts`)

| Variable | Purpose |
| --- | --- |
| `ISLA_LIVE_DECISION_BASE_URL` | OpenAI-compatible chat-completions base URL for M3 selection and reaction |
| `ISLA_LIVE_DECISION_MODEL` | General-model identifier used for the M3 decision adapters |
| `ISLA_LIVE_DECISION_API_KEY` | Bearer credential |

### M3 Jev provider (`readLiveJevProviderConfig`)

| Variable | Purpose |
| --- | --- |
| `ISLA_LIVE_JEV_BASE_URL` | OpenAI-compatible chat-completions base URL for the dedicated Jev model |
| `ISLA_LIVE_JEV_MODEL` | Jev model identifier |
| `ISLA_LIVE_JEV_API_KEY` | Bearer credential |

The Jev group names the NFR-03 dedicated-model configuration. It is reported
separately so a measurement run can compare `m3-general-model` with `m3-jev`
without conflating either credential or endpoint.

## Clean skip semantics

- Missing or blank variables make that provider group unavailable; the suite
  reports the missing variable names and skips.
- A non-http(s) base URL makes the group unavailable and names the offending
  variable.
- An available group runs its live cases; a rejection, timeout or invalid model
  output fails the suite rather than being replaced by fixture data.
- The offline suites never collect these files, so `pnpm test` is unaffected.

## Credential rules

- Never write a credential into the repository, a test, a log or an error
  message.
- Availability reasons name environment variable names only, never values.
- Tests compare a configured credential but never print it, and no case displays
  a provider response body.
- Keep `.env` files and other secret-bearing files outside the checkout as
  required by `AGENTS.md`.

## Contents

| Path | Purpose |
| --- | --- |
| `vitest.config.ts` | Opt-in live Vitest configuration; scopes collection to this directory and is not part of the offline gate. |
| `live-config.ts` | Reads the provider environment groups and reports availability without echoing values. |
| `live-config.test.ts` | Offline-safe unit and no-secret-echo tests for the live configuration loaders. |
| `m3-decision.live.test.ts` | M3 live selection and reaction acceptance; skips cleanly when unconfigured. |
| `m4-text-source.live.test.ts` | M4 live text-source acceptance; skips cleanly when unconfigured. |
| `kokoro-*` | M1's Kokoro worker live-verification assets (`kokoro-setup.ts`, `kokoro-smoke.ts`, and the browser config/page/entry); run explicitly via `tsx`, see `src/performance/README.md`. |

Keep model caches, dependency caches, generated audio and live logs outside
OneDrive (for example under `.cache/` or another approved local temporary area)
so sync clients do not copy, lock or upload large or private artifacts.
