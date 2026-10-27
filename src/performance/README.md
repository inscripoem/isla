# M1 performance adapters

This module houses the M1 speech synthesis, browser playback and avatar adapters
for Isla. Application version 0.2. The M1 member owns this directory; the
browser-safe public interface lives under [`browser/`](browser/) so M2 may
import that subtree while its transitive imports stay browser-safe.

Revision state: increments A and B, plus the M1-02 increment A offline
Kokoro adapter and the increment B guarded Node provider, pinned tokenizer
facade, persistent single-worker host and live setup/smoke entrypoints. This
checkout implements fixed-audio preparation, the mapped renderer, the
single-output browser playback controller, its `PlayerPort` adapter, the
`HTMLAudioElement` media driver, a real injected-provider `SynthesisPort`
adapter, a controlled audio-resource registry, a synchronous no-truncation
tokenizer guard over the real SDK boundary and an optional Node worker
offload for the blocking CPU inference, plus the offline D1 connection handle
and D2 pairing primitive (token grant/authentication only). Live VTS, the network
receipt transport and product history integration remain later work.

## Public adapters

| Module | Port | Behaviour |
| --- | --- | --- |
| [`fixed-synthesis.ts`](fixed-synthesis.ts) | `SynthesisPort` | An exact, unambiguous lookup over a fixed audio catalog. |
| [`kokoro-synthesis.ts`](kokoro-synthesis.ts) | `SynthesisPort` + private `whenIdle()` | Injected raw-audio provider adapter registering generated WAV resources. |
| [`audio-resources.ts`](audio-resources.ts) | `AudioResolver` | Controlled opaque `audio://` registry with leases, retirement and a byte budget. |
| [`mapped-renderer.ts`](mapped-renderer.ts) | `RendererPort` | Maps verified capability actions to low-level driver commands. |
| [`browser/index.ts`](browser/index.ts) | — | Browser-safe public entry for M2 (types + player + DOM driver). |
| [`browser/player.ts`](browser/player.ts) | `PlaybackController` | Single-output playback controller with admission, dedup and cleanup. |
| [`browser/player-port.ts`](browser/player-port.ts) | `PlayerPort` | Adapts the same controller to the shared same-process port. |
| [`browser/dom-driver.ts`](browser/dom-driver.ts) | `MediaDriver` | `HTMLAudioElement` handle with object-URL cleanup. |
| [`browser/types.ts`](browser/types.ts) | — | Browser-safe shared declarations (deadline gate, media, resolver, controller). |

### Kokoro synthesis adapter (M1-02 increment A)

`createKokoroSynthesis({ provider, profiles, registry, clock, deadlineGate })`
substitutes for `createFixedSynthesis` behind the unchanged
[`SynthesisPort`](../contracts/app/ports.ts) contract. `provider` is a
Kokoro-compatible raw-audio provider; `profiles` maps an exact public
`voiceProfileId`/`voiceProfileVersion` tuple to a private provider voice id and a
positive finite speed; `registry` is the audio-resource registry below; `clock`
and `deadlineGate` are the injected server-domain dependencies. The tuple is
keyed structurally in a nested map, never joined with a delimiter, so two
distinct legal tuples cannot collide even when they contain NUL or another
control character. Profile id/version/provider voice id must be nonempty strings
and the speed a finite positive number; every configured profile is validated at
construction before any generation effect.

The provider interface ([`kokoro-types.ts`](kokoro-types.ts)) is deliberately
narrow: `generate({ text, voiceId, speed })` returns the provider's actual
Promise of `{ samples: Float32Array, sampleRate }`. There is no fictitious SDK
`AbortSignal` parameter and no claim that underlying inference stops. The
provider contract requires complete audio for the exact text, or an explicit
`KokoroProviderError('input_too_long')` refusal before physical inference.

`prepare(request, context)`:

- Parses and snapshots the original `PreparePerformance` before any asynchronous
  work. A malformed identity-bearing request throws without inventing identity or
  causing provider/resource effects. An exact unknown voice/version returns
  `ok: false`/`unknown_voice_profile` with the original correlation and no
  provider call. The text is forwarded verbatim: there is no character limit and
  no silent segmentation of M4 text.
- Checks the original signal and the earlier of the request/context deadline
  before invoking the provider, then binds that effective context through the
  injected `DeadlineGate`. The original caller signal is preserved and neither
  deadline is lengthened; the binding is released exactly once on every path.
- Reserves the single physical generation slot synchronously. A concurrent call
  fails `busy` with no second generation, no scheduler and no queue.
- Resolves a failed result promptly on logical owner abort or expiry while the
  physical slot stays occupied until the original provider Promise settles. A
  late fulfillment registers zero references; a late rejection is consumed with
  no unhandled rejection. There is no hidden retry.
- Validates and copies raw samples and the sample rate, rejecting empty,
  malformed, non-finite or nonrepresentable audio as `invalid_audio`. A rate must
  be a positive integer whose encoded `byteRate` (rate × block align) and data
  length fit an unsigned 32-bit WAV header, so `24000.5`, `2**30` and `2**32`
  cannot be truncated or wrapped into a misleading header. It encodes a
  deterministic mono IEEE-float32 WAV using only built-in APIs, derives
  `durationMs` from the actual samples and rate, sets `timing: null` because no
  word alignment is known, and does not reuse the increment B 22.05 kHz PCM16
  fixture durations.
- Re-observes the abort/terminal state after every injected clock observation and
  immediately before publication, then makes one final clock-free owner/
  membership check through the registry's `admission` query. A synchronous owner
  abort raised inside the clock call — including the final publication
  observation — settles the logical wait, and a synchronous owner invalidation
  (`retireSession`/`retireBefore`/`dispose`) that does not abort the signal is
  still refused. Every reference that is not actually published is retired
  rather than leaked, and the failure keeps the original request/session/epoch
  identity with an honest lifecycle reason (`session_retired` or
  `resource_closed`). Physical generation occupancy stays reserved until the
  original provider Promise settles. Provider refusal/errors, capacity,
  collision, session/epoch invalidation and a closed registry all become honest
  `ok: false` results, and no `Blob`, `Error`, `AbortSignal` or raw provider
  object enters the C5 JSON.
- Never plays, resolves bytes for playback or labels provider synthesis
  completion as a playback start or completion.

Tokenizer-length and SDK truncation guards are **not** implemented or validated
by this adapter; the injected provider must refuse an over-long input with
`input_too_long` before inference. Concrete `kokoro-js` loading, dependency/model
installation and a real-SDK smoke test are increment B work.

#### Composition and provider ownership

The factory returns a long-lived `KokoroSynthesis` (a `SynthesisPort` plus the
private `whenIdle()` observation), and the surrounding composition owns the
lifetime of both the provider and that adapter. The supported shape is
**one provider plus one retained adapter**, initialized once and reused across
turns and Stop/logical cancellation. Do **not** build a new adapter per turn, and
do **not** share one provider across several adapters: the in-flight generation
slot is local to one adapter instance, so two adapters over the same provider do
not exclude each other and could start overlapping physical work. Multiple
adapters would require a separately designed shared exclusion, which this module
does not provide. The adapter reports `busy` only for a second concurrent call on
the *same* adapter instance.

A logical owner abort or expiry settles the returned `PreparedAudio` promptly,
but that result is **not** evidence the physical provider generation stopped. The
retained adapter stays `busy` for new work until the provider's original
`generate` Promise settles; a late fulfillment publishes no reference and a late
rejection is consumed. The retained adapter therefore exposes one private,
composition-only observation: `whenIdle()`.

`createKokoroSynthesis` returns a `KokoroSynthesis`, which is the unchanged
`SynthesisPort` plus `whenIdle(): Promise<void>`. `whenIdle()` resolves when the
generation that is active **at call time** physically settles — its original
provider Promise fulfills or rejects — and resolves promptly when the adapter is
idle. It never rejects with the generation's failure, and each generation owns an
independent observation, so an earlier settlement never releases a later wait and
a distinct later generation gets its own pending observation. The observation is
reserved synchronously with the generation slot, so a provider that calls
`whenIdle()` synchronously inside `generate` observes its own generation. A
synchronous provider throw releases that generation's reserved observation — it
settles rather than leaking — and clears the busy slot.

`whenIdle()` is deliberately not a global mutex, queue, cancellation API or
general lifecycle framework. It does not lock admission to the adapter, does not
cancel or shorten provider inference, and does not prove that a registry resource
or playback handle was cleaned up. The owner must **first stop admission to the
old adapter**, then `await synthesis.whenIdle()`, and only then replace it; a
premature replacement is still the caller's responsibility. There is no automatic
guard against constructing a replacement, and this observation is not a
substitute for the registry/playback cleanup the owner performs separately.

```ts
// One provider and one retained adapter for the whole composition lifetime.
const provider: KokoroProvider = /* concrete kokoro-js facade, increment B */
const synthesis: KokoroSynthesis = createKokoroSynthesis({
  provider,
  profiles,
  registry,
  clock,
  deadlineGate,
})

// Reuse `synthesis` for every turn and across Stop. Before replacing it, stop
// admission on the old adapter and await its physical-settlement observation:
await synthesis.whenIdle()
// Only now has the provider's original generation settled; construct the
// replacement (or retry) under the owner's own exclusion policy.
```

No production composition exists in this checkout yet; installing it and
accepting its ownership is M5 work. The offline tests in this module exercise the
real adapter over a controlled provider and verify the caller's compliant
sequence — they are not evidence that a production root is integrated.

### Worker-isolated provider host (M1-02 increment B)

`createKokoroWorkerProvider(config, options?)` (in
[`kokoro-worker-provider.ts`](kokoro-worker-provider.ts)) implements the same
`KokoroProvider` seam while running inference in one persistent Node worker, so
the main event loop keeps serving timers and cancellation while the SDK's
CPU-bound Promise is pending. It returns `{ provider, close }`, where `close()` is
idempotent and owner-only.

- The host snapshots and validates the same `KokoroProviderConfig` the in-process
  factory uses, then loads the SDK and model **only** inside the worker from the
  verified local-only revision cache. No HuggingFace environment is mutated on the
  main process and no model is downloaded.
- At most one physical generation is pending. A second `generate` fails `busy`
  rather than queueing; there is no scheduler, pool, per-call worker, retry or
  global lock.
- Request scalars are validated before `postMessage`, so a malformed request
  posts nothing. Each accepted job keeps a unique, non-reused id; only a matching
  `result` settles it. Unknown, duplicate or old replies cannot settle another
  job or clear its slot.
- A logical caller abort belongs to the retained `SynthesisPort` adapter and never
  settles the physical Promise or frees occupancy. Worker `error` (an uncaught
  exception) and `exit` are distinct: an error closes admission but keeps the
  pending slot until the real exit, when the original Promise is rejected. There
  is no automatic respawn.
- `close()` synchronously rejects new generation, drains the current physical job,
  posts one `dispose` request that releases the loaded model through its public
  `dispose()`, and resolves only after the actual worker exit. It is not Stop or
  playback cancellation, and it never terminates a still-generating worker to
  make Stop look prompt. The owner must `await close()` before replacing the host.

The default transport is a real Node `Worker` created from a module-relative file
URL to [`kokoro-worker-bootstrap.mjs`](kokoro-worker-bootstrap.mjs) with an
explicit `execArgv: []`. That `.mjs` bootstrap registers the project's existing
`tsx` development runtime (`tsx/esm/api` `register()`) and then imports the
TypeScript worker entry [`kokoro-worker.ts`](kokoro-worker.ts); the registration
stays active for the worker's lifetime. **This is a development/demo runtime
dependency only.** A production install that omits development dependencies
cannot be claimed supported, and moving or replacing `tsx`, or changing runtime
packaging, requires M5/M6 review. No second product package or duplicated
provider implementation is introduced to avoid that decision.

`options.createWorker` is an embedding/test seam. The offline tests inject a
small scripted Worker-like transport to exercise the host's real control logic
deterministically without a subprocess or the SDK; the real bootstrap and real
CPU timing are exercised only by the explicit live entrypoints.

Initialization exposes **no internal timeout or cancellation API**:
`createKokoroWorkerProvider` awaits the worker's own `ready` or `exit` and adds
no timer of its own, so a hung worker initialization can remain pending
indefinitely. A caller deadline bounds only the caller's logical wait; it neither
settles, cancels nor replaces the initialization. An owner that stops waiting
must still retain and observe the original initialization Promise and `close`
any handle it eventually yields, awaiting the real worker exit before
constructing a replacement. No `Promise.race` shortcut safely abandons that
resource ownership or grants replacement permission.

### Audio resource registry (M1-02 increment A)

`createAudioResourceRegistry({ clock, byteBudget, retentionMs, newRef? })` is a
real controlled registry exposed as an `AudioResolver`. It stores owned immutable
bytes and a `Blob` snapshot per registered opaque `audio://` reference, retains
the original request (`requestId`)/session/epoch/turn/segment and public voice
id/version privately, and never treats a reference as a path, URL or `src`.

- `register(request)` validates and privately snapshots the request identity and
  owned bytes before invoking any injected clock or reference factory, so a
  reentrant callback cannot alter the retained identity or bytes, and preserves
  the original `requestId`. It generates a unique reference from the supplied
  factory (or a safe default UUID reference), and rejects an invalid, colliding or
  previously used reference atomically without overwriting anything. Admission
  (disposal, session/epoch retirement, reference collision and capacity) is
  rechecked after every injected callback boundary and immediately before the
  uninterruptible commit, so a callback that synchronously retires a session,
  disposes the registry or reclaims bytes cannot leave a stale entry, leaked
  bytes or an overwritten reference. Active bytes count against `byteBudget`; a
  capacity rejection cannot leave a partial entry. Expired unleased resources are
  reclaimed first.
- `retentionMs` is a separate explicit policy measured at successful
  registration in the injected clock domain. It is not the prepare deadline and
  it is not a playback deadline. There are no production default TTL or byte
  numbers here: the owner supplies validated configuration and tests set explicit
  virtual values.
- `resolve(audioRef, signal)` returns an owned `AudioLease` whose `release()` is
  idempotent and non-throwing. An already-aborted or expired-before-resolve call
  produces no lease. The captured entry's live membership/admissibility and the
  disposed/signal state are re-observed after the injected clock call and before
  any lease is accounted, so a clock that synchronously retires, reclaims or
  aborts cannot yield an unaccounted lease. Reference identifiers are never reused within a registry
  lifetime, including after release, so an old reference fails rather than
  replaying new bytes.
- `retire(audioRef)`, `retireBefore(sessionId, newEpoch)`, `retireSession(sessionId)`
  and `collectExpired()` are local resource-lifecycle seams. Retirement, expiry
  and session invalidation prevent **new** acquisition but do not destroy a lease
  already held by the player; the existing lease survives until the consumer
  releases it after media detach, and the last release reclaims the resource
  once. A monotonic per-session epoch bound refuses even a late registration
  after trusted invalidation. `collectExpired()` is an explicit owner/virtual
  clock hook; there is no production janitor timer here.
- `admission(audioRef, sessionId, epoch)` is a pure, clock-free local query that
  reports `null` only for the same active, unretired resource whose retained
  identity matches and whose original session/epoch remain admissible, otherwise
  the lifecycle code (`disposed`, `invalid_ref`, `session_retired`,
  `unknown_ref`). It runs no injected callback, so a producer may use it as the
  final check immediately before publishing a reference.
- `dispose()` rejects new work and marks resources retired but retains pinned
  bytes until the last lease is released. `snapshot()` returns a protected
  metadata view that cannot mutate state; its retirement record uses a
  null-prototype record so a legal session id such as `__proto__` is retained as
  an own key rather than lost to the prototype.

These are local registry seams, not new C5 fields, not transport fields and not
M5 dispatch authority. A registry method never receives authority from browser
input; M5 will invoke trusted invalidation and composition later.

### Fixed synthesis

`createFixedSynthesis({ entries, clock })` matches the exact
`(text, voiceProfileId, voiceProfileVersion)` tuple. Nothing is trimmed,
lowercased or joined with an ambiguous delimiter. The `clock` is an injected
dependency (`ClockPort`) and is never copied or validated; only the catalog and
its metadata are copied and validated at construction:

- Nonempty text, voice profile id and version.
- Nonempty `format`; `durationMs` is null or a finite nonnegative number.
- `timing` is null or has finite nonnegative bounds with `endMs >= startMs`.
- `audioRef` is an opaque, server-controlled `audio://<id>` identifier and is
  never treated as a filename, URL or `src` value. Only the `audio` scheme is
  accepted; filesystem paths and any other scheme (`file:`, `http:`, `https:`,
  `data:`, `blob:`, `ftp:`, arbitrary schemes) are rejected as control
  references.
- Duplicate text/voice tuples and duplicate audio references are rejected.

`prepare(request, context)` validates the request against the current prepare
schema and rejects a malformed identity-bearing call without inventing identity.
It then performs one synchronous lookup and returns a `PreparedAudio`. It checks
`context.signal.aborted` and the monotonic injected `clock.nowMs()` against the
earlier of the request and context deadline both before the lookup and before
returning; the post-lookup check applies to a missing tuple as well as a match.
Abort/expiry returns `ok: false` with reason `cancelled_or_expired`; an unknown
tuple returns `fixed_audio_missing`. On success it copies
request/session/epoch/turn/segment identity and returns the registered
reference, format and metadata; unknown duration/timing stays null.

`prepare` never plays audio, resolves bytes, renders, subscribes, or allocates
timers, signal subscriptions or deadline bindings.

### Mapped renderer

`createMappedRenderer({ snapshot, bindings, driver, deadlineGate, receipts })`
validates the full current capability schema and copies the capability snapshot
and action bindings. At construction every advertised action must have exactly
one binding; duplicate action ids, unadvertised bindings, no-op action bindings
and no-op driver mappings are rejected. The mapping and capability revision are
immutable for the instance; `capabilities()` returns a protected copy.

`execute(command, context)` parses the command into an independent validated
snapshot, then:

- A wrong capability revision returns a defensive failed avatar receipt with
  reason `stale_capability` and makes zero driver calls.
- A no-op action returns `no_op_not_dispatched` with zero driver calls; actual
  no-op enforcement (zero `RendererPort.execute` calls) remains the caller's
  (M5) responsibility.
- An unknown action returns `unsupported_action` with zero driver calls.
- The provided `DeadlineGate` is bound; if the bound signal is already aborted
  the call returns `cancelled` with no dispatch.
- A valid command dispatches the mapped low-level driver action and reports the
  driver's observed execution stage, with original command identity, modality
  `avatar`, a unique receipt id, source `m1-mapped-renderer` and null chunk ids.

The adapter never reports the capability observability labels (`observable`,
`acceptance-only`) as stages. An `acceptance-only` capability cannot be turned
into a completed claim; a contradictory driver observation yields `unknown` with
a diagnostic reason. A late driver resolve or reject produces no second result
and no unhandled rejection. The binding is always released exactly once.

### Browser playback controller

`createPlaybackController(deps)` serves one trusted session with an initial
epoch and at most one active media operation. `deps` is
`{ sessionId, initialEpoch, resolver, media, receipts, onReceipt, reportFault }`.
`resolver` is an `AudioResolver` mapping a registered ref to an owned
`AudioLease` (`Blob` + idempotent `release()`); `media` is a `MediaDriver`
creating `MediaHandle`s; `receipts` supplies unique ids and local times;
`onReceipt` is the single observer; `reportFault` is best-effort.

Construction validates the bootstrap configuration: `sessionId` must be a
nonempty string and `initialEpoch` a finite nonnegative integer. Invalid values
are rejected before any effect instead of being coerced.

`execute(command, context)` validates all command fields, then:

- A retained identical current-epoch command returns the same core-operation
  promise while active, or the cached terminal receipt once settled, without a
  new media call or receipt.
- A same-id command with a different payload rejects `conflict`.
- A different output while one is active rejects `busy`.
- A wrong session, malformed command or epoch below the accepted lower bound
  rejects `session_mismatch`, `invalid_command` or `stale`.
- A higher trusted epoch while idle advances the local lower bound, clears
  closed-epoch records and admits; a higher epoch while active rejects `busy`.
- A valid new output reserves the active slot synchronously, reports
  `accepted`, emits one accepted receipt and starts resolution.

The controller never invokes a renderer. Actual playback is evidenced only by a
current handle's `playing` event; a fulfilled `play()` promise is not a start.
`ended` after an observed start settles `completed`; `ended` without a start
settles `failed`/`start_unobserved`; resolver rejection, load throw, play
rejection and media error settle `failed`. A single terminal-selection guard
arbitrates ended/error/abort/cancel races.

Cleanup invalidates callbacks before unsubscribing, detaching and releasing the
lease. A successful detach clears the active slot and reports idle. A failed
detach quarantines the handle and lease, reports a fault, refuses new work and
keeps `idle` false; a cancel then settles `failed`/`cleanup_failed`, while an
already-observed natural completion is preserved as the delivery fact.
`dispose()` prevents future admission, settles the active operation and may
retry quarantined cleanup; a successful retry releases the retained lease once,
while a failing retry keeps `idle` false and admission disabled.

Synchronous dependency boundaries are rechecked. A terminal selected during
`create`, `subscribe`, `load` or `play` — including by an authoritative `cancel`
or `dispose` raised inside the boundary — is deferred until that call registers
its returned handle and subscription, then cleaned up exactly once: a
late-returned subscription is released, the operation never proceeds to
`load`/`play` after a terminal, and a handle that cannot detach is quarantined
and reported `failed`/`cleanup_failed` rather than falsely cancelled or idle. A
deferred `cancel` adopts the operation's own terminal promise, and `dispose`
stays synchronous and non-throwing while never dereferencing a cleared active
slot.

`cancel(request)` validates the counters, requires `newEpoch > revokedEpoch`,
targets the active output only when its epoch is at most `revokedEpoch`, advances
the lower bound, retires closed-epoch records and returns the active operation's
single terminal receipt (or `null` when idle). A newer active output makes a
cancel reject `stale_cancel` while it continues. Retained records are protected
from mutation; `status()` is a local snapshot, not delivery or silence proof.

All receipts preserve output/session/epoch/turn/segment identity, modality
`audio`, source `m1-player`, a stable unique receipt id, an observed local time
or null, and null chunk ids. Observed facts are delivered to the single observer
through a FIFO microtask queue; observer and fault-reporting exceptions cannot
corrupt cleanup or convert an observed completion into a failure.

### PlayerPort adapter and DOM driver

`createPlayerPort({ controller, deadlineGate })` adapts the same controller to
`PlayerPort`. Ownership follows the returned core-operation promise identity:
the first binding owns that promise and is released when it settles; a duplicate
call reusing the same promise releases its unused binding immediately; a
rejected admission releases only its own binding and never displaces the
existing owner. `cancel` forwards the trusted cancellation independently of the
call context's expiry, so an already-expired context cannot preserve revoked
playback.

`createDomMediaDriver()` creates `HTMLAudioElement` handles. Each handle owns one
object URL per load and releases it on the next load or on detach. `detach()` is
synchronous, non-throwing and idempotent and reports a failed local detachment
as `false`.

## Browser-safe boundary

Only `browser/` and the browser-safe contracts may enter the browser graph.
Backend adapters may import the browser-safe type declarations but never a
sibling backend module into the browser subtree. `Blob` belongs to the local
resolver/driver contracts and never crosses a JSON wire boundary. The player,
the mapped renderer and the console transport each keep their own sending mode:
M2 is the sole browser wire sender and does not resend execute/cancel return
values; the same-process `PlayerPort` returns terminal evidence to its caller.

## Failure, cancellation and Stop

- Fixed synthesis: reference lookup miss and provider-side abort/expiry are the
  current failure and cancellation paths. No timers or subscriptions are used.
- Kokoro synthesis: an exact unknown voice/version, a provider `input_too_long`
  refusal delivered by a synchronous throw or an asynchronous rejection, a
  provider throw/rejection, empty/malformed/non-finite/nonrepresentable audio, a busy
  generation slot, registry capacity/collision/session-retirement/closure, and
  owner abort/expiry are all honest `ok: false` results. Retiring a resource or
  invalidating a session prevents new acquisition without destroying a held
  lease; `status`/"prepared" never proves playback, acoustic silence or natural
  speech.
- Mapped renderer: driver rejection settles `failed`; abort before dispatch
  settles `cancelled`; abort after dispatch with no outcome settles `unknown`.
- Player: resolver/load/play/media errors settle `failed`; owner-signal abort or
  a valid active cancel settles `cancelled`; a failed detach settles
  `failed`/`cleanup_failed` and quarantines resources.
- `status().idle` is local evidence and does not prove acoustic silence.

## Demo and verification

Run the automated adapter tests with:

```sh
pnpm test:m1
pnpm typecheck
pnpm lint
pnpm build
```

`test/browser/` contains an isolated manual browser demonstration (T14) using
the real DOM driver and the two prepared fixed WAV assets. It runs under a
demo-local Vite configuration (`test/browser/vite.config.ts`) bound to
`127.0.0.1`; see [`test/browser/README.md`](../../test/browser/README.md). It is
separate from the automated pass, and its `playing`/`ended`/status values are API
observations rather than acoustic measurements.

### Live Kokoro setup and smoke (manual; not part of `pnpm test`)

The M1-02 increment B live entrypoints exercise the real pinned model and SDK.
They are explicit, isolated experiments:

```sh
# One explicit network acquisition step (the only entrypoint that may download):
pnpm exec tsx test/live/kokoro-setup.ts

# Local-only CPU smoke in the persistent worker (default; no network; fails
# when the pinned cache is absent):
pnpm exec tsx test/live/kokoro-smoke.ts

# The historical in-process diagnostic baseline (expected to block the main
# thread; responsiveness lag is the recorded baseline, not a probe failure):
pnpm exec tsx test/live/kokoro-smoke.ts --main-thread
```

Both use the same repo id `onnx-community/Kokoro-82M-v1.0-ONNX`, fixed revision
`1939ad2a8e416c0acfeecc08a694d14ef25f2231` and the checkout-relative
`.cache/models` directory. Setup lets the SDK acquire and write its own
revision-addressed FileCache, then asserts exactly one known-safe q8 binary by
size and SHA-256; it never walks, lists or copies the model tree. The smoke runs
with `allowRemoteModels=false` and `local_files_only=true`, verifies that same
binary, then measures two fixed fixtures from the private
`actual-boundary-fixtures.json` at the API level only: real `KokoroTTS`
phonemization plus the real cached tokenizer with an apply-trapped probe model and
a positive control (no weights). It then runs real CPU cold/warm inference, the
accepted 512-token inference and the 513-token refusal through one long-lived
provider, and a short accepted WAV plus a logical-cancellation sequence through
one retained synthesis adapter. It reports a real `setInterval`/`AbortController`
observation and the cancellation facts (physical settlement, busy-while-pending,
zero registry bytes, reuse and reclaim) separately. The browser WAV fixture
remains the short 3.65 s output; the 512-token audio is reported but not written
to it.

The report is printed before any hard gate fails. The gates require the fixed
512/513 fixture texts to hash-match their provenance, the unrestricted tokenizer
to measure exactly 512 and 513 full ids (`exactBoundaryVerified`), the guarded 512
call to reach the trapped model and the guarded 513 call to be refused with a zero
model-call delta; the over-limit provider refusal; a coherent mono IEEE-float32
24 kHz WAV header/sample/duration; and the `cancelled_or_expired` reason with a
pending physical job after the logical return, a maximum physical in-flight of
one, physical settlement, zero registry bytes, successful reuse and zero bytes
after the reuse retirement. In worker mode the smoke additionally gates the
individual per-callback delay (`maxPendingTimerLagMs<=250`), the AbortController
bound (`abortObservedMs<=250`) and at least one main-thread timer callback while
the physical generation is still pending; these are local to this smoke, not a
production SLA. The per-callback delay is
`max(0, actualOffsetMs - previousActualOffsetMs - requestedIntervalMs)`; the
cumulative cadence drift (a nominal interval firing slower than requested without
any blocking) is reported separately as advisory only, with every raw callback
timestamp and pending marker retained in the report for independent
recomputation. The main-thread diagnostic reports the blocking baseline honestly
and skips those responsiveness gates. Model-call-zero claims are API-only: the worker
has no model spy and its model counters are `null`, while the main-thread
diagnostic's counting loader can observe real model calls. These remain API and
timing observations, not acoustic, physical-silence or product proof, and the
exact 512/513 fixtures are checked at runtime rather than assumed.

`test/live` is excluded from the root typecheck; check the entrypoints explicitly
with a standalone `tsc --noEmit`. The live entrypoints import the shared
`test/support` WAV decoder, so a standalone check must follow imports (a bare
`pnpm exec tsc --noEmit --ignoreConfig ... test/live/kokoro-smoke.ts` works). The
executed local-only setup, worker bootstrap and CPU smoke results are summarized
under **Standalone verification** below.

### Dependency build-script policy (M1-02 increment B)

The pinned SDK runtime pulls packages with install scripts, so the project's
`pnpm-workspace.yaml` `allowBuilds` map records every build decision explicitly.
The existing `esbuild: true` approval is unchanged. The following exact resolved
versions are explicitly **denied** (`false`) and therefore never run their build
scripts: `onnxruntime-node@1.21.0`, `protobufjs@7.6.6` and `sharp@0.34.5`. The
version-qualified matchers are deliberate: a different future version without its
own entry remains unreviewed and fails a strict install rather than silently
building.

Ordinary offline CI and `pnpm test:m1` do not use SDK weights; the CPU live smoke
uses the packaged runtime and the local-only model cache. CUDA, native
build-from-source, or any production packaging change would need explicit M5/M6
approval. This dependency/tooling proposal is submitted for their human review;
it is not a claim that they have approved it.

## Standalone verification (2026-10-15)

The increment B provider, worker host and local-only smoke were executed against
the pinned local q8 model at revision
`1939ad2a8e416c0acfeecc08a694d14ef25f2231` (92,361,116-byte
`model_quantized.onnx`, SHA-256
`fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478`):

- Worker CPU smoke (default mode): cold 1647.98 ms and warm 1540.77 ms; the
  accepted 512-token inference produced 631,800 samples at 24 kHz (26,325 ms) and
  the 513-token input was refused with `input_too_long`.
- Real phonemizer/tokenizer API probe with no weights: the fixed fixture measured
  512 and 513 full ids, the accepted 512 path reached the probe model once, and
  the refused 513 path had a zero model-call delta. This is API-only; the worker
  has no model spy and its internal model counters are `null`.
- Same final smoke source, main-thread diagnostic versus worker: maximum
  individual timer-callback delay 1571.37 ms versus 9.77 ms (106 callbacks while a
  job was pending, pending maximum 6.57 ms). This is an event-loop observation,
  not a TTS speedup or an SLA.
- Logical cancellation kept the physical job pending with a maximum in-flight of
  one until it actually settled, left zero registry bytes, and awaited the real
  worker `close`/exit.
- A real Chrome 155 run of the existing harness consumed the final generated
  350,444-byte, 3650 ms WAV: 46/46 checks passed with zero console errors,
  observed `playing`/`ended`/`Stop`, released both object URLs and both leases, and
  cleared the DOM. This is muted media-API evidence only, not acoustic or full I2
  proof.

Rerun with the existing entrypoints:

```sh
# Local-only CPU smoke in the persistent worker (default):
pnpm exec tsx test/live/kokoro-smoke.ts

# Main-thread diagnostic baseline:
pnpm exec tsx test/live/kokoro-smoke.ts --main-thread
```

The browser harness is served from the committed config
`test/live/kokoro-browser.config.ts` and page `test/live/kokoro-browser.html`.

## VTube Studio hotkey adapter (M1-02 increment C)

[`vts-client.ts`](vts-client.ts) implements the deterministic VTS protocol
client and [`vts-driver.ts`](vts-driver.ts) implements the hotkey driver plus its
composition with the existing mapped renderer. This increment is the offline,
injected-transport adapter: it contains no endpoint discovery, pairing,
authentication token, credential reader, socket constructor, reconnect, retry or
replay. A later D/M5 composition supplies an already connected transport and
owns the live connection decision.

```ts
const adapter = createVtsRenderer({
  transport, // already connected; owned by the adapter until dispose
  modelId, // exact configured model identity
  rendererId,
  characterId,
  capabilityRevision,
  mappings: [
    { actionId: 'neutral', hotkeyId: 'exact-hotkey-id-neutral' },
    { actionId: 'smile', hotkeyId: 'exact-hotkey-id-smile' },
  ],
  timeoutMs, // finite positive timer value
  maxPending, // positive bounded in-flight request count
  deadlineGate,
  receipts,
})

const receipt = await adapter.renderer.execute(command, context)
adapter.invalidate() // or adapter.dispose(): permanent, idempotent
```

`createVtsRenderer` exposes a mapped `RendererPort`, the lifecycle-owning
`VtsHotkeyDriver`, a protected `capabilities()` view, and `invalidate()`/
`dispose()`. Its capability snapshot advertises every configured semantic action
as `acceptance-only` with no parameter bounds. Mappings are immutable copies of
caller input; empty ids, duplicate actions/hotkeys, no-op actions, no-op hotkeys,
invalid identities/revisions and unbounded timeout/pending values are refused at
construction before the transport is subscribed. The validated model identity and
the renderer/character/revision configuration are also captured once at
construction, so later mutation of the caller-owned dependency object cannot
retarget an existing capability revision. Injected live services and clock hooks
remain separate from that immutable configuration.

Each client requires one exclusively owned transport/connection for its whole
lifecycle. Request ids are generated and correlated per client; overlapping
clients must never share one transport/connection, because a reply stream and the
connection-level subscription cannot be partitioned safely. The injected
transport contract is deliberately narrow:

- `send(serializedJson)` is synchronous; a throw may still have had an effect
  and is never reported as certainly unsent.
- `subscribe(event => ...)` returns an idempotent unsubscribe function;
  `message`, `close` and `error` events are handled, including callbacks raised
  synchronously during `subscribe` or `send`.
- `dispose()` is called once by the adapter. The adapter never reconnects after a
  close, error or disposal.

The protocol client validates the complete VTS envelope identity
(`apiName='VTubeStudioPublicAPI'`, `apiVersion='1.0'`), correlates the exact
`requestID`, and validates every field it uses. Frames with a different
`requestID`, a non-VTS envelope identity, non-JSON data, or an unrecognised, old
or duplicate request id are unrelated and ignored. A frame whose request id
matches a pending request is correlated: a different response type, malformed
data, missing field or malformed `APIError` is a protocol failure and cannot
succeed. Request ids are unique and non-reused within the client lifetime,
nonempty and shorter than 64 characters. Pending work is bounded by
`maxPending`, every request has a finite validated timeout, settlement is exactly
once, and abort listeners and timers are removed on every outcome. A correlated
protocol `APIError` is a refusal; raw error messages and transport exception text
never enter observations or logs.

Each dispatch rechecks, in order, `APIStateResponse` `active` and
`currentSessionAuthenticated` (never a caller-supplied trust boolean),
`CurrentModelResponse` `modelLoaded`/`modelID`, and
`HotkeysInCurrentModelResponse` `modelLoaded`/`modelID` plus the exact configured
`hotkeyID` for that currently loaded model. Only then is one
`HotkeyTriggerRequest` with that exact id sent. A missing/unavailable mapping,
model mismatch, unauthenticated or inactive API, disappeared hotkey or invalidated
instance means zero trigger calls. One dispatch is admitted per driver instance;
a concurrent dispatch fails `vts_busy` with no queue and no extra request.

A matching `HotkeyTriggerResponse` with the exact requested `hotkeyID` is
reported only as `accepted`. It never becomes `started` or `completed`; the
mapped renderer additionally refuses an acceptance-only completion claim. A
known `APIError` refusal settles `failed`. An already-aborted dispatch guarantees
zero protocol sends and settles `cancelled`. An abort or expiry during preflight
may already have sent read-only API/model/hotkey queries, but it guarantees zero
trigger requests. The low-level driver can report `cancelled` before trigger; the
existing generic mapped-renderer abort race can conservatively report `unknown`
before the driver resolves, so the mapped wrapper does not always return
`cancelled` for that pre-trigger case. No animation-stop guarantee is made. After
the hotkey trigger send was attempted, abort, close, error, timeout, a send fault,
a malformed correlated frame or a mismatched successful hotkey id settle
`unknown`, because the protocol provides no proof that the trigger had no effect.
A close, error or timeout during read-only preflight never sent a trigger and
settles `failed` (for example `vts_unavailable` or `vts_timeout`) rather than an
uncertain trigger. There is no automatic reset, remove-expression,
stop-animation or replay guess, and no VTS timestamp is used as a local clock:
driver observations and mapped receipts use the injected `ReceiptTools` local
time. A cancel or close is not evidence that an animation stopped.

`invalidate()`/`dispose()` permanently disable the old instance, close its owned
transport and make all later dispatches fail with zero sends. A new capability
revision and a freshly constructed instance are required, while M5 is stopped and
previous work has settled. The adapter does not take over scheduling, epoch or
freshness authority, global deduplication, history or product composition.

**Known limitation.** This protocol cannot atomically fence the model/hotkey
identity check against the trigger, nor fence a device-side model change against
an in-flight trigger. An external model change between the preflight query and
the trigger, or between the trigger and its response, is a TOCTOU window. The
adapter rechecks on every dispatch but cannot eliminate that race; D/M5 remain
responsible for controlled model changes, stopping admission and serializing
replacement. The offline tests use explicitly scripted fixture peers and prove
only the adapter's protocol handling, not a live VTS session, authentication,
physical animation, acoustic timing or completion.

The tests for this increment live in
[`test/offline/m1-performance.test.ts`](../../test/offline/m1-performance.test.ts)
and use [`test/support/m1-vts-kit.ts`](../../test/support/m1-vts-kit.ts) as the
controlled transport peer. `pnpm test:m1` includes them without script changes.

### Connection handle (M1-02 increment D offline)

[`vts-connection.ts`](vts-connection.ts) adapts one injected, already OPEN Node
`ws` socket to the existing `VtsTransport` seam.
`createVtsConnectionHandle({ socket, closeTimeoutMs })` validates the OPEN ready
state and a finite positive cleanup bound before taking ownership; a rejected
factory call leaves the caller's socket untouched. It creates no endpoint,
performs no discovery, pairing or authentication, and reads no credential. The
caller still owns the private connection decision, and the C client still
performs its own `APIStateResponse` checks.

The handle exposes `{ transport, close(), closed }`. `transport.send` forwards
one serialized request to the socket. A synchronous send throw and an
asynchronous `ws` send-callback error both become one safe `error` transport
event; the adapter never retries, replays or exposes raw exception text.
`message` handlers normalize string, `Buffer`, `ArrayBuffer` and `Buffer[]` text
frames to a UTF-8 string; malformed UTF-8 and unexpected binary frames are
ignored. `close` and `error` are forwarded once without the raw close reason or
error object. One application subscriber is allowed at a time; its unsubscribe
is idempotent, and subscriber exceptions are contained. Only listeners added by
this adapter are removed.

Closing has three distinct facts:

- **Close initiation** is the idempotent local request made by `close()` or
  `transport.dispose()`. Both share one path and call `socket.close()` at most
  once. Initiation alone is not evidence that the physical socket closed.
- **Closed completion** is reported only after the socket's actual `close`
  event is observed and the adapter's owned listeners and timer are released.
  `closed` resolves `{ kind: 'closed' }`, and `close()` returns that same
  Promise. A normal remote close reaches the same completion.
- **Failed cleanup (quarantined)** resolves
  `{ kind: 'failed', code: 'close_timeout' | 'close_failed' }` when the cleanup
  budget expires or `socket.close()` throws.
  The Promise never rejects with a raw error. The adapter does not retry,
  reconnect or call `terminate`, and it refuses replacement sends and
  subscribers through the failed handle. A later real close releases the
  retained guards but does not rewrite the failed outcome.

`closeTimeoutMs` is an independent cleanup budget, not a renderer or request
timeout, and this module invents no production default. The Node-only module is
not exported from `browser/index.ts` and is not composed into a production
entrypoint in this checkout. The offline tests in
[`test/offline/m1-performance.test.ts`](../../test/offline/m1-performance.test.ts)
use [`test/support/m1-vts-connection-kit.ts`](../../test/support/m1-vts-connection-kit.ts)
for controlled sockets and one local `127.0.0.1` ephemeral fixture server; they
do not contact VTS, port 8001, a provider or credentials. Real pairing,
authentication, model/hotkey verification and device actions remain
unimplemented in increment D and require separate acceptance.

### Pairing primitive (M1-02 increment D2 offline)

[`vts-pairing.ts`](vts-pairing.ts) is the offline pairing primitive over one
exclusive, already OPEN D1 connection handle. It does not construct a socket,
discover an endpoint, read a credential file, contact VTube Studio or install a
production connection owner. The public shape is:

```ts
pairVtsConnection({
  handle,                  // one exclusive OPEN VtsConnectionHandle
  identity: { pluginName, pluginDeveloper },
  credentials: { load(signal), save(value, signal) },
  signal,                  // M5-owned cancellation + finite total deadline
  mode: 'existing-only' | 'allow-prompt',
  requestTimeoutMs,
  humanApprovalTimeoutMs,
}): Promise<VtsPairingResult>
```

A successful result is `{ kind: 'authenticated', handle }` with the **identical**
D1 handle. A failed result is `{ kind: 'failed', code, cleanup }`, where
`cleanup.connection` is the actual D1 `VtsConnectionCompletion` and
`cleanup.pairingSubscription` separately reports `'released'` or
`'release_failed'`. The failure codes are `aborted`, `timeout`,
`credential_missing`, `credential_read_failed`, `credential_write_failed`,
`permission_denied`, `authentication_rejected`, `protocol_error`,
`transport_closed`, `transport_error` and `pairing_cleanup_failed`.

Invalid programming options (identity name outside 3–32 characters, an unknown
mode, malformed handle/provider/signal shape, or a non-positive or out-of-range
timer budget) reject with one fixed safe error before ownership and with no
provider, subscription, send or close effect. A valid input whose signal is
already aborted is instead an operational `aborted` failure: it calls the same
D1 `close()` and returns the observed completion with zero provider calls and
zero sends.

`existing-only` never prompts: a missing credential is `credential_missing`.
`allow-prompt` sends exactly one `AuthenticationTokenRequest` only when the
provider returns `null`; a correlated `APIError` 50 is `permission_denied`.
A previously stored credential that VTS rejects is `authentication_rejected` and
never falls back to prompting or a retry. Token issuance alone is not
authentication: the primitive must receive a correlated `AuthenticationResponse`
with `authenticated === true`. Only a newly granted token is passed to
`credentials.save`, and only after that success; an existing token is never
re-saved. Tokens must be nonempty printable ASCII of at most 64 characters, and
no token, raw provider exception, API error message or protocol frame is logged
or returned.

Request correlation uses a per-attempt `m1pair-<attempt>-<n>` namespace, disjoint
from the C client's `vts-<sequence>` ids; all ids are ASCII 1–64 characters.
Pending state exists before a synchronous send or reply. Unrelated envelope
identity, request ids, duplicate old frames and unknown ids are ignored; a
correlated wrong message type or malformed used field fails `protocol_error`.
VTS timestamps are never used as a local clock. `requestTimeoutMs` bounds the
ordinary `AuthenticationRequest` response only, and `humanApprovalTimeoutMs`
separately bounds the initial permission response. There are no hidden defaults.

**M5 ownership.** M5 must bind the credential provider to the intended plugin
identity and deployment target, serialize same-record saves, provide persistent
storage, and arm one finite overall acquisition deadline **before** credential
load. That signal spans load, permission, authentication and save; M5 retains
whether cancellation or deadline won and clears its own deadline timer on
handoff. The primitive adds no production overall-timer API and no credential
storage lock. Cancellation stops protocol progress and starts bounded D1 cleanup
without awaiting an unresolved provider; late provider fulfillment/rejection is
contained, admits no new send or save and cannot produce a successful handle.
An already admitted save is not rolled back. A coordinated M5-supplied initial
close policy of 5000 ms is a caller policy, not a D1/D2 hidden default or a
measured cleanup guarantee.

On failure the primitive releases its pairing subscription, clears its own
timers and abort listener, calls the same D1 `close()` and reports the actual
completion; close initiation is never reported as proof of physical closure. A
thrown unsubscribe prevents success and reports `release_failed` separately even
when the physical connection closes. On success only the pairing subscription,
timers and abort listener are released; D1's socket guards and the identical
open handle remain for the caller. D1 completion observed during that release
fences a successful handoff, so a closed handle is never returned as usable. The
C client later performs its own `APIStateResponse` authentication/active check.

This Node/private module is not exported from [`browser/index.ts`](browser/index.ts).
The offline tests exercise the real pairing primitive and D1 handle over
controlled sockets and private provider fixtures. They are not evidence of live
VTS pairing, a real credential store, production composition or a physical
device session.

## Not yet implemented

- Live VTube Studio attachment, real credential storage, a production connection
  owner and device-facing integration remain unimplemented. The offline C client,
  hotkey driver, D1 connection handle and D2 pairing primitive above target
  injected or locally fabricated sockets and a private injected credential
  provider only; no live pairing/authentication, real credential store,
  animation start/completion or physical device proof is claimed.
- The authoritative `DeadlineGate` (M5) and the browser receipt transport (M2).
  The registry above is composed and invalidated by M5 later; it grants no
  dispatch authority.
- Real-start/history classification, network timing and durable recovery.
- A product HTTP audio-resource endpoint and root composition (an M2/M5
  integration decision). No HTTP resource serving is added by this module.
