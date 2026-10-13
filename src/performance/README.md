# M1 performance adapters

This module houses the M1 speech synthesis, browser playback and avatar adapters
for Isla. Application version 0.2. The M1 member owns this directory; the
browser-safe public interface lives under [`browser/`](browser/) so M2 may
import that subtree while its transitive imports stay browser-safe.

Revision state: increment A only. This checkout implements fixed-audio
preparation and the mapped renderer. Player, browser DOM driver, Stop, live
TTS/VTS and the browser demo are later increments (B) and are not implemented
or verified here.

## Public adapters

| Module | Port | Behaviour |
| --- | --- | --- |
| [`fixed-synthesis.ts`](fixed-synthesis.ts) | `SynthesisPort` | An exact, unambiguous lookup over a fixed audio catalog. |
| [`mapped-renderer.ts`](mapped-renderer.ts) | `RendererPort` | Maps verified capability actions to low-level driver commands. |
| [`browser/types.ts`](browser/types.ts) | — | Browser-safe shared declarations (`DeadlineGate`, `DeadlineBinding`, `ReceiptTools`). |

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
snapshot (mutating the caller-owned object afterwards cannot alter dispatch or
receipt identity), then:

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
a diagnostic reason. Every driver observation is fully validated: a null or
non-object result, an invalid stage, a malformed `reasonCode`, or a
negative/non-finite `localTimeMs` settles to a schema-valid `unknown` receipt
with a diagnostic and a null local time rather than leaving the call pending or
producing an invalid receipt. If the bound signal aborts after dispatch with no
established outcome, the call settles `unknown` without claiming the physical
action stopped; facts already observed are preserved. A late driver resolve or
reject produces no second result and no unhandled rejection. The binding is
always released exactly once.

This adapter does not add global deduplication, scheduling or epoch
authorization; those remain M5 responsibilities.

## Browser-safe boundary

Only `browser/` and the browser-safe contracts may enter the browser graph.
Backend adapters may import the browser-safe type declarations but never a
sibling backend module into the browser subtree. The `browser/types.ts` module
declares `DeadlineGate`, `DeadlineBinding` and `ReceiptTools`; the browser
player and `MediaDriver`/`AudioResolver` types are increment B.

## Failure, cancellation and Stop

- Fixed synthesis: reference lookup miss and provider-side abort/expiry are the
  current failure and cancellation paths. No timers or subscriptions are used.
- Mapped renderer: driver rejection settles `failed`; abort before dispatch
  settles `cancelled`; abort after dispatch with no outcome settles `unknown`.
- Stop/Resume and the single-output playback controller, their failure and Stop
  receipts, observed-start semantics and browser demo are increment B and are
  not implemented or verified in this increment.

The player (increment B) will be the single source of audio `completed`,
`cancelled` and `failed` receipts; local `status().idle` is not a delivery or
silence proof.

## Demo and verification

There is no browser demo in increment A. Run the adapter tests with:

```sh
pnpm test:m1
pnpm typecheck
pnpm lint
pnpm build
```

The increment A tests drive the real fixed synthesis and mapped renderer with
controlled lower-level dependencies and a labelled existing fixture player;
they include the pre-existing correct and faulty conformance cases.

## Not yet implemented

- Browser playback controller, DOM media driver, object-URL resolver and the
  browser entry.
- Stop/Resume cancellation integration, epoch-based player admission and
  closed-epoch record retention.
- Live Kokoro TTS and VTube Studio avatar adapters (M1-02).
- The authoritative `DeadlineGate` (M5) and the receipt transport (M2/M5).
- Real-start/history classification, network timing and durable recovery.