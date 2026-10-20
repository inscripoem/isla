# M5 dynamic audio resource route handoff

Published baseline: [PR48 cbc845c746e426934acc8a55289fe58efefb8ec5](https://github.com/inscripoem/isla/commit/cbc845c746e426934acc8a55289fe58efefb8ec5), incorporating main37c1d9e. M1's [scoped Windows approval](https://github.com/inscripoem/isla/pull/48#pullrequestreview-5583059851) resolves the original response-hold P2 at that head. The current local candidate additionally incorporates main579b14b (merged PR51); publication and verification of that combination are separate. Earlier increment baselines and test counts below retain their original scope. See [DELIVERY-PLAN](DELIVERY-PLAN.en.md#current-baseline) for current status, verification and remaining owner work.

Revision: 2026-10-20.4. Owner: M5 — CHANG Xuben. Status: cbc845c published; main579b14b reconciliation local and under review. Historical increment worktree: `m5-dynamic-audio`, based on merged main `abb847c` (the
squashed PR45 merge commit; the restored production-composition patch is the
working base). Scope:
FR-04/FR-05 delivery of registered dynamic audio resources to a same-origin
browser consumer — one explicit HTTP route, authoritative session/epoch/lifecycle
admission with rechecks after every asynchronous boundary, bounded serving slots
and lease ownership held until the response ends, plus the assembled-turn and
real-browser acceptances. M1 registry/synthesis internals, the M2 product
resolver and live provider work are not part of this slice. The production
application base remains described in the [production composition
handoff](HANDOFF-M5-PRODUCTION.en.md).

## Response ownership regression (2026-10-20)

The local follow-up to [M1's review](https://github.com/inscripoem/isla/pull/48#discussion_r4314578882) replaces the paused-client/16 MiB assumption with a test-only gate on the first matching real `ServerResponse.end`. Before releasing that call, the test observes zero finish events, an unreleased lease, one occupied slot and a second request refused as 429 `busy`. Releasing it delivers all 4096 patterned bytes over real HTTP, emits one finish, releases the lease once and restores capacity.

Independent negative controls reject premature lease-and-slot release, lease-only release and slot-only release. Production route code is unchanged. The gate proves ownership at an unfinished-response boundary; it does not measure socket back-pressure. Linux/Node22.23.3 verification is recorded in DELIVERY-PLAN; Windows re-review remains pending. The current main-combination rerun passes unchanged root routing 11/11 and Chromium audio 8/8; this still exercises the explicit loop fixture page, not M2 product-console adoption. Historical results below retain their original versions.

## Recorded browser toolchain

The 8/8 audio-route result on published `17ab933` used Node.js 22.23.3, pnpm 12.9.0, Playwright 1.63.0 and Chromium 155.0.8059.79 on briefcase (Linux x86_64). Playwright was installed outside the checkout at `~/LocalDev/cityu/tools/isla-browser/node_modules/playwright`; Chromium was supplied through `ISLA_CHROMIUM_PATH` from Nix `nixpkgs#chromium`. Reproduction requires those browser tools and the explicit paths shown in the acceptance command below. M6 did not reproduce the browser result because its review environment lacked Playwright/Chromium. This is HTTP/media-byte evidence, not an acoustic measurement.

## Route contract

`POST /audio?ref=<encoded opaque reference>` is the only method and the only
acquisition path; there is no cacheable GET. The route checks, in order:

| Check | Refusal |
| --- | --- |
| method is POST | 405 `method_not_allowed` |
| `x-isla-audio-fetch` header present | 403 `forbidden` |
| exact allowed `Origin` present; a missing Origin is refused, never admitted (a browser same-origin POST supplies it) | 403 `forbidden` |
| loopback `Host` | 403 `forbidden` |
| exactly one non-empty `ref` parameter | 400 `malformed` |
| route not disposed | 503 `unavailable` |
| serving slot available (`maxConcurrent`, default 8, integer 1–1024) | 429 `busy` |
| captured live identity is servable and the reference is admitted for its session/epoch | 409 `conflict` / 404 `not_found` |

A served response carries the lease blob's `content-type` (sanitized against the
MIME pattern, falling back to `application/octet-stream`), `content-length`,
`cache-control: no-store` and `x-content-type-options: nosniff`. Refusals are
`{"ok":false,"error":{"code":...}}`. The 404/409 distinction is the only state
information exposed: an unknown, retired, out-of-scope or never-controlled
reference is `not_found`, while a request whose captured session/epoch or serving
lifecycle no longer matches is `conflict`.

## Authority, lifecycle and scope

- `AudioRouteIdentity` carries `sessionId`, `epoch` and `servable`. The
  application wiring computes `servable` from the authoritative live composition:
  `coordinator.lifecycle() === 'running'` and neither disposed nor retiring. The
  initial stopped composition, a stopped or degraded session and a session being
  retired refuse new audio with 409.
- The identity is captured at request start, then rechecked after the resolver
  settles and again after the body is acquired and immediately before headers and
  bytes are written. A Stop, retirement, recovery or degradation during
  acquisition therefore cannot publish stale audio, even when the epoch itself
  did not change.
- An omitted `servable` means the injected source asserted no lifecycle; only the
  composition owner can know the label, and the production wiring always asserts
  it. Test sources and the independent probe omit it deliberately.
- The reference is never treated as a path, filename or URL: only the injected
  source (the real M1 `AudioResourceRegistry`) admits it, scoped to the captured
  session and epoch.

## Ownership, slots and cleanup

- The serving slot and the resource lease are held until the response finishes,
  closes or errors. Capacity is not released while a slow response still retains
  bytes.
- A release requested before a late resolver settlement is applied the moment
  the lease is held, so an early client disconnect, a route disposal and a
  non-cooperating resolver each release exactly once.
- `dispose()` refuses new work, aborts every acquisition signal and terminates
  every still-open response, so no serve waits forever on response completion; a
  late settlement still releases its resource. Pending acquisitions remain
  bounded by `maxConcurrent`, and `pendingCount()` is exposed for assertions.

## Wiring

- `src/runtime/audio-resource-route.ts` — `createAudioResourceRoute` (the route,
  its refusal order and its ownership rules).
- `src/runtime/config.ts` — `AUDIO_PATH` and `AUDIO_FETCH_HEADER` (Node-side
  constants; the browser wire literals are documented above).
- `src/runtime/application.ts` — `ApplicationEndpointOptions.audioSource`; the
  endpoint creates and disposes the route, dispatches it from `handleHttp`, and
  supplies the live identity from the current composition.
- `src/runtime/production.ts` — `ProductionAudioResources` widens
  `ProductionPeers.audioResources` with `admission`/`resolve`;
  `validateProductionPeers` validates all four methods when the field is present
  and the endpoint forwards the source.
- `vite.config.ts` — the root entry proxies `/audio` to the runtime. The proxy
  keeps the original `Origin` and `Host`, so the runtime's own checks still decide
  admission.
- The M2 consumer seam is unchanged: `AudioResolver.resolve(audioRef, signal)`
  returning an `AudioLease` (`src/performance/browser/types.ts`). M2 implements it
  by POSTing this route with the explicit header; the browser acceptance performs
  exactly that fetch and is the reference evidence for the wire shape.

## Test-only fixtures

- `test/support` keeps every substitute; production code imports no test module.
- The loop demo (`test/browser/loop-server.ts`) wires the real registry as the
  composition's `audioResources` (epoch retirement on Stop, session retirement on
  disposal) and a demo-only fixture source that presents the stable reference
  `audio://demo/audio-route-check`, registering the prepared WAV asset
  (`test/browser/assets/segment-0.wav`) with the real registry for the exact live
  session/epoch on the first admission query for that identity. This is a labeled
  fixture, not product behavior: it exists because the demo starts stopped and the
  resumed epoch is not known in advance.
- `test/browser/root-entry-audio-browser.mjs` drives the real demo page in
  headless Chromium: the page's own operator bootstrap and Resume, then a
  same-origin `POST /audio` from the page context through the root Vite proxy.
  It is portable: Playwright resolves from the installed packages (or
  `ISLA_PLAYWRIGHT_PATH`) and Chromium is Playwright's own selection (or
  `ISLA_CHROMIUM_PATH`); no absolute toolchain path is baked in.

## Verification (actual results)

- `pnpm test:m5` — 127 tests / 6 files passed, including
  `test/offline/m5-audio-resource-route.test.ts` (14 tests). Beyond the earlier
  ten, four boundary tests were added and pass:
  - the actual application becomes degraded without an epoch change while an
    acquisition is held: a real SQLite fault renames the event table, the next
    admitted durable write fails on the actual backend, and the held request is
    refused 409 `conflict`, releases its lease exactly once and leaves the
    reference reclaimed;
  - the operator recovers the session while an acquisition is held: the old
    bytes are not published, the lease releases exactly once, the retired
    reference is reclaimed, the stopped successor refuses 409 until resumed,
    and after Resume the retired reference is 404 while a successor-scoped
    reference is served 200;
  - the lifecycle is invalidated while `Blob.arrayBuffer()` is pending (the
    route's second asynchronous boundary): the route refuses 409 `conflict` and
    releases exactly once;
  - an early-disconnected resolver that ignores abort keeps its serving slot
    until it settles: a further request is 429 `busy` while the resolver is
    pending, and after settlement the slot frees and a later request is served.
- The production fixture's `boot` now waits for the session snapshot before
  sending operator and control messages. A successor client connected right
  after recovery exposed a harness race (the snapshot had not arrived, so the
  machine never sent the bootstrap message and the client wait timed out); a
  real client follows the documented snapshot-first order. This is a test-harness
  fix, not a product defect.
- Assembled turn: the real M1 Kokoro synthesis adapter and the real M1 registry
  with a clearly controlled raw-audio provider (no live provider, download or
  inference); the performer acquires the generated reference over the HTTP route
  and the received bytes equal `encodeMonoFloat32Wav` of the provider samples.
- `pnpm verify` — 846 tests / 50 files passed; typecheck, lint and build passed.
- The unchanged out-of-tree probe `.cache/audio-late-lease-review-probe.ts`
  (`node --import tsx`) reported `releaseCount 1` of 1 with `pendingCount 0`.
- Real processes: the tracked browser script discovers Playwright from the
  installed packages and lets Playwright select Chromium, or accepts
  `ISLA_PLAYWRIGHT_PATH` (package directory or specifier) and
  `ISLA_CHROMIUM_PATH` (executable). The recorded acceptance ran against fresh
  direct Node children (`node --import tsx test/browser/loop-server.ts`,
  `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`)
  with the prepared local toolchain supplied explicitly:

  ```sh
  ISLA_PLAYWRIGHT_PATH=/home/inscripoem/LocalDev/cityu/tools/isla-browser/node_modules/playwright \
  ISLA_CHROMIUM_PATH=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
  node test/browser/root-entry-audio-browser.mjs
  ```

  `node test/browser/root-entry-routing.mjs` passed 11/11, including header 403,
  GET 405 and disallowed-origin 403 for `/audio` through the root proxy, and the
  Chromium acceptance passed 8/8 — the stopped session 409, the admitted browser
  POST returning the registered 103420-byte WAV equal to the prepared asset, the
  missing-header 403, the GET 405 and the unknown-reference 404. The run log is
  `.cache/m5-audio-fresh-browser.log` and the cleanup record
  `.cache/m5-audio-fresh-browser.json`: both owned Node children exited after
  SIGTERM without force, and ports 4317/5173/5174 are empty.
- One earlier rerun attempt against a leftover loop server from the previous
  acceptance run is recorded as a failure: that server's session had already
  been resumed, so the demo page's `#start` control was disabled and the click
  timed out. The fresh run above superseded it; no product behavior is inferred
  from the failed attempt.
- Actual-diff gates (`CHANGED_FILES_FILE` set to the tracked and untracked
  working-tree changes and `AI_USE_LOG_BASE_FILE` set to the log at `abb847c`):
  `pnpm gate:ai-use-log` passed with 54 entries against 49 at the base;
  `pnpm test:trace` passed 41 tests; `pnpm gate:eval` reported G4 not run (no
  evaluation set or provider access); the test-approval gate is satisfied in
  advise mode, while its enforce mode fails for an unpublished change set
  without the `tests-approved` label — that label is a remote/human action, not
  a local one. The `.vitest/` run artifact that was present when the earlier
  change set was taken was copied to OneDrive evidence, verified byte-for-byte
  and removed; nothing is pending cleanup.

## Limitations and review requests

- No live provider, network download, inference or acoustic measurement is
  claimed; all audio evidence is media/byte observation.
- This increment changed tests and tooling only: no production source file
  changed, and the four new boundaries assert existing behavior (they found no
  product defect).
- The degradation boundary proves refusal and lease release while the session is
  degraded; it does not prove recovery from a degraded session, which the
  coordinator treats as terminal.
- The recovery boundary exercises the existing operator recovery flow through
  the actual application; it does not add or change product recovery behavior.
- The browser acceptance proves the transport path (origin, proxy, method,
  header, bytes) with a labeled fixture resource; it does not prove M2's product
  resolver, which remains M2's work against the unchanged `AudioResolver` seam.
- Retention expiry (`collectExpiredUnleased`) is exercised by existing registry
  tests, not by this slice; the route holds leases only for response lifetime.
- Requested review: M2 on the POST wire shape and the unchanged resolver seam;
  M1 on the registry's admission/lease use (no registry change was made); M5
  coordination on the peer-set widening and the root proxy entry.
- The original local increment was later published in PR48. No live service
  call, subagent or dependency change was part of that increment. The frozen
  `m5-production-composition` worktree was not touched.
