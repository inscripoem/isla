# M1 performance adapters

This module houses the M1 speech synthesis, browser playback and avatar adapters
for Isla. Application version 0.2. The M1 member owns this directory; the
browser-safe public interface lives under [`browser/`](browser/) so M2 may
import that subtree while its transitive imports stay browser-safe.

Revision state: increments A and B. This checkout implements fixed-audio
preparation, the mapped renderer, the single-output browser playback controller,
its `PlayerPort` adapter and the `HTMLAudioElement` media driver. Live
Kokoro/VTS, the network receipt transport and product history integration remain
later work.

## Public adapters

| Module | Port | Behaviour |
| --- | --- | --- |
| [`fixed-synthesis.ts`](fixed-synthesis.ts) | `SynthesisPort` | An exact, unambiguous lookup over a fixed audio catalog. |
| [`mapped-renderer.ts`](mapped-renderer.ts) | `RendererPort` | Maps verified capability actions to low-level driver commands. |
| [`browser/index.ts`](browser/index.ts) | — | Browser-safe public entry for M2 (types + player + DOM driver). |
| [`browser/player.ts`](browser/player.ts) | `PlaybackController` | Single-output playback controller with admission, dedup and cleanup. |
| [`browser/player-port.ts`](browser/player-port.ts) | `PlayerPort` | Adapts the same controller to the shared same-process port. |
| [`browser/dom-driver.ts`](browser/dom-driver.ts) | `MediaDriver` | `HTMLAudioElement` handle with object-URL cleanup. |
| [`browser/types.ts`](browser/types.ts) | — | Browser-safe shared declarations (deadline gate, media, resolver, controller). |

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

- Live Kokoro TTS and VTube Studio avatar adapters (M1-02).
- The authoritative `DeadlineGate` (M5) and the browser receipt transport (M2).
- Real-start/history classification, network timing and durable recovery.
- A product HTTP audio-resource endpoint (an M2/M5 integration decision).
