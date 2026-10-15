# M1 performance adapters

This module houses the M1 speech synthesis, browser playback and avatar adapters
for Isla. Application version 0.2. The M1 member owns this directory; the
browser-safe public interface lives under [`browser/`](browser/) so M2 may
import that subtree while its transitive imports stay browser-safe.

Revision state: increments A and B, plus the M1-02 increment A offline
Kokoro adapter. This checkout implements fixed-audio preparation, the mapped
renderer, the single-output browser playback controller, its `PlayerPort`
adapter, the `HTMLAudioElement` media driver, a real injected-provider
`SynthesisPort` adapter and a controlled audio-resource registry. Concrete
`kokoro-js` loading, the real guarded SDK/tokenizer smoke test, live VTS, the
network receipt transport and product history integration remain later work.

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

## Not yet implemented

- Concrete `kokoro-js` model/dependency loading, the pinned tokenizer facade,
  its no-truncation real-SDK smoke test and actual CPU inference (M1-02 increment
  B). The increment A adapter only forwards a provider that already refuses an
  over-long input with `input_too_long`; it does not itself guard token length.
- Live VTube Studio avatar adapters (M1-02 increments C/D).
- The authoritative `DeadlineGate` (M5) and the browser receipt transport (M2).
  The registry above is composed and invalidated by M5 later; it grants no
  dispatch authority.
- Real-start/history classification, network timing and durable recovery.
- A product HTTP audio-resource endpoint and root composition (an M2/M5
  integration decision). No HTTP resource serving is added by this module.
