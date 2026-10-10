# M5-01 coordinator handoff

Revision: 2026-10-10.5. Owner: M5 — CHANG Xuben. Status: under review.
Branch: `feat/m5-01-runtime`, based on merged preparation commit `384969d`. Local commit only; no push or PR.

## Implemented behavior

The coordinator runs one controlled response cycle with injected peer ports: select one of at most five eligible inputs, validate and reserve it, generate ordered dialogue segments, authorize speech/reaction, reconcile delivery evidence and record history. Stop advances the epoch and revokes dispatch immediately, without waiting for a provider, cancellation evidence or storage.

- Selection has one provider attempt per opportunity. An unchanged defer does not poll; invalid current proposals may use the validated oldest-input/answer fallback. Expired or revoked proposals never fall back into output. If `answer` is excluded from configured intents, the documented fallback defers instead.
- Dialogue admits at most two ordered immutable segments. Correlation, repeated IDs, segment counts and punctuation-only text are checked. Each stage has its own timeout and rechecks authority before dispatch.
- Optional reaction failure becomes no-op. A speech or playback failure does not count as a successful cycle.
- Registered audio evidence may arrive from execute, the endpoint or cancellation. Duplicate/regressive evidence cannot rewrite a terminal fact. A later valid terminal receipt can complete historical delivery once, without replaying output or changing a newer output.
- Storage operations are serialized. Exact event/sequence and delivery acknowledgements are validated; an unknown or failed write degrades the session and prevents later queued writes. Spoken-memory commit follows the atomic delivery/event acknowledgement. Stop remains available.

## Entry points and local configuration

Import `createRuntimeCoordinator` and its `RuntimeCoordinatorDeps` type from `src/runtime/coordinator.ts`. Shared port types are exported from `src/contracts`. The factory returns `endpoint`, `runTurn()`, lifecycle/epoch accessors and diagnostic trace methods. `runTurn()` drives one opportunity; it is not a polling loop.

Supply `clock`, `authorizer`, `selection`, `reaction`, `dialogue`, `synthesis`, `renderer`, `player`, `commit` and `store`. The factory creates a stopped session. Read `endpoint.snapshot()` for its identity/epoch, submit authorized Resume, then submit current-epoch input and invoke the cycle driver. The production module imports no test code.

The optional configuration is supplied to the factory, independently of diagnostic-server environment settings:

| Option | Purpose / default |
| --- | --- |
| `sessionId` | Explicit non-empty session identity; omitted values create a fresh UUID-based session. Fixtures pass a fixed identity. |
| `profile` | Character/voice IDs and versions, persona summary, topic, interaction state, policy/provider versions, allowed intents and context limits. The default context limits are 8 turns / 2,000 characters. |
| `timings` | Selection 5,000 ms; dialogue 60,000; synthesis 5,000; reaction 1,500; renderer 1,000; playback 30,000. |
| `inputTtlMs`, `storageTtlMs`, `cancelTtlMs` | Input expiry, one storage/memory call and cancellation evidence wait; each defaults to 60,000 ms. |

Budgets/timings accept integer milliseconds from 1 through 3,600,000. `resolveSessionProfile`, `resolveRuntimeBudgets` and `resolveCycleTimings` expose the same validation for composition code. Legacy `decisionDeadlineMs`/`reactionDeadlineMs` aliases remain supported; prefer `timings`. Profile strings and allowed intents are validated; configuration does not load credentials or create peer providers. Inputs accepted while stopped are revoked on Resume and must be submitted again under the new epoch.

Accounting uses `provider.call` for one actual selection/reaction/dialogue invocation, with original request/session/epoch/turn/segment identity, disposition and schema-valid usage. Dispositions are `accepted`, `invalid`, `rejected`, `failed`, `timeout` or `aborted`. Missing/malformed usage is `null`; synthetic fallback/cancellation objects do not count as provider calls. The runtime metrics expose separate selection, reaction and dialogue attempt counts.

`provider.usage.late` supplies later usage for the same request without a new attempt or output. M6 should join it to the original `(sessionId, call, requestId)` record, replacing unknown usage rather than summing both records as two calls. Failed storage leaves evidence incomplete and the session degraded; in-memory counters are not a durability claim.

The event stream also retains accepted input, validated `selection.plan` (including defer and marked synthetic fallback), `segment.accepted`, `dialogue.result` and full `output.receipt` evidence with original identities. Raw invalid results and exception messages are excluded. A historical terminal receipt may commit delivery after a cycle returned cancelled; M4/M6 must consume the later evidence without replaying output. Shared C1–C7 schemas and port signatures are unchanged. Application protocol 0.2 remains separate from diagnostic protocol 1; the current browser/CLI still exposes diagnostics only.

The test adapter is `test/support/coordinator-runner.ts`; factories are `createCoordinatorRunner` and `createFaultyCoordinatorRunner` in `test/support/runner-factories.ts`. Existing fixture coordinator/policy remain independent reference implementations. Test hooks are confined to `test/`.

## Verification

Independently verified on 2026-10-10 with Node 22.23.2 and pnpm 12.3.4: 90 M5 tests, 12 composition tests and 257 total tests in 16 files passed. Typecheck, lint (no warnings) and build passed. The suite starts real CLI processes and checks HTTP/WebSocket behavior, occupied-port errors, SIGINT/SIGTERM shutdown and port release. Shared contracts, lockfile and diagnostic entry points are unchanged. Commands from the repository root:

```sh
pnpm test:m5
pnpm test:composition
pnpm verify
```

The same original conformance, composition and regression assertions run against the fixture reference and production coordinator. Production-specific tests are in `test/offline/m5-coordinator.test.ts`.

## Next collaboration point: I1-01

Each owner supplies their real module factory and tests, then reviews its interaction with this coordinator. M5 assembles the factories and resolves shared-boundary issues with the affected owners; responsibilities and workload ratings in PLAN are unchanged.

| Owner | Requested implementation/review | Acceptance evidence |
| --- | --- | --- |
| M1 | Connect synthesis/player/renderer; review deadlines, capability revisions, receipt identities and cancellation/idle evidence. | Normal speech, interrupted second segment, async completion, actual stop and no output after revocation. |
| M2 | Connect the console transport to RuntimeEndpointPort, consume bootstrap identity/epoch and subscribe to server events; integrate M1 browser playback. | Input/Stop/Resume, rejected/stale controls, reconnect with unresolved output; keep diagnostic v1 separate. |
| M3 | Connect SelectionPort/ReactionPort; review fallback, allowed intents and provider metadata/usage. | One attempt, unchanged defer, invalid/stale proposal and no-op reaction tests. |
| M4 | Connect DialoguePort/MemoryCommitPort; review segment backpressure and C6 classification. M5 classifies physical evidence; M4 owns its effect on context. | Ordered segments, interrupted history, no memory before durable acknowledgement, truthful usage. |
| M6 | Connect EventStorePort and history/replay infrastructure; review ordered acknowledgements, atomic delivery/event writes and late evidence. | SQLite durability/recovery, duplicate/conflict handling, unknown writes, replay without live effects. |

I1-01 first accepts the normal offline flow, Stop, late results and receipt/history behavior with real owner modules. I2-01 then introduces real providers. Live model quality, Kokoro/VTS, browser audio, SQLite crash recovery, numerical quality targets, complete D1–D9 and course-wide CI gates remain outside this M5-only acceptance. Genuine OpenCode exports and independent verification records are retained outside the checkout.
