# I1 application transport handoff (protocol 0.2)

Status: under review · 2026-10-15 · Owner: M5 (runtime) · Consumer: M2 (console)

This note describes the browser-facing transport the first interactive loop
uses so M2 can connect the product console without reverse-engineering the
runtime. It is the M5 application transport, separate from diagnostic protocol
`1` served at `/diag` (unchanged, product commands still rejected there).

## Run the loop

The demo uses real M4 context, generation and delivery memory against M6 history.
M3 and the dialogue text provider remain explicit `test/support` substitutes. The
provider returns the exact registered WAV text; this is not a live-model result.
Production source imports no test code.

```sh
pnpm install --frozen-lockfile
pnpm dev:loop                                              # runtime on 127.0.0.1:4317
pnpm exec vite --config test/browser/vite.config.ts        # page on 127.0.0.1:5173
```

Open `http://127.0.0.1:5173/loop.html`, then **Enable operator and attach
performer**, **Resume**, and **Send input**. The page plays the registered fixed
WAV assets through the real M1 `PlaybackController` and shows subtitles and a
mapped reaction. Media events are observations, not acoustic measurements.

## Endpoint and authority

- Application socket: `GET /app` (WebSocket, upgrade). Diagnostic `/diag` is
  unchanged.
- The upgrade must carry an `Origin` that exactly matches a configured origin,
  and the `Host` must be a loopback host (or an explicitly configured host).
  Loopback alone is not authorization.
- A connection starts as an unprivileged `viewer` **transport role**. The role
  is assigned by the server, never by a payload field.
- `session.attach` reserves the single active performer slot (not a privilege).
- Operator authority requires a one-time token from the explicit, same-origin
  bootstrap: `POST /operator/bootstrap` with header
  `x-isla-operator-bootstrap: 1`. The token is short-lived, single-use, and is
  never logged.
- Every message is `protocolVersion: "0.2"`. Receipts are accepted only from the
  bound performer connection; envelope and payload identities are correlated,
  and a superseded connection generation is rejected.

## Wire examples

Connect first receives a complete snapshot; the client must not send a control
before it arrives.

```json
{"protocolVersion":"0.2","messageId":"app-1","sessionId":"session-loop-demo","epoch":0,
 "kind":"session.snapshot","payload":{"lifecycle":"stopped","activeTurnId":null,
 "performerStatus":"idle","outputConfirmation":"confirmed","capabilityRevision":1,"lastSeq":0}}
```

```json
{"protocolVersion":"0.2","messageId":"attach-1","sessionId":"session-loop-demo","epoch":0,
 "kind":"session.attach","payload":{}}
{"protocolVersion":"0.2","messageId":"app-2","sessionId":"session-loop-demo","epoch":0,
 "kind":"session.attach.ack","payload":{"connectionId":"conn-1","performer":true}}

{"protocolVersion":"0.2","messageId":"bootstrap-1","sessionId":"session-loop-demo","epoch":0,
 "kind":"operator.bootstrap","payload":{"token":"<one-time>"}}
{"protocolVersion":"0.2","messageId":"app-3","sessionId":"session-loop-demo","epoch":0,
 "kind":"operator.ack","payload":{"role":"operator","requestMessageId":"bootstrap-1"}}
```

Input acceptance is not output delivery. `input.ack` acknowledges acceptance;
speech is evidenced later by `session.event` records such as `delivery.committed`.

```json
{"protocolVersion":"0.2","messageId":"m-1","sessionId":"session-loop-demo","epoch":1,
 "kind":"input.submit","payload":{"source":"local-audience","text":"hello"}}
{"protocolVersion":"0.2","messageId":"app-4","sessionId":"session-loop-demo","epoch":1,
 "kind":"input.ack","payload":{"status":"accepted","requestMessageId":"m-1",
 "eventId":"event-m-1","sessionId":"session-loop-demo","epoch":1,"seq":1}}
```

```json
{"protocolVersion":"0.2","messageId":"m-2","sessionId":"session-loop-demo","epoch":0,
 "kind":"control.resume","payload":{"requestId":"resume-1"}}
{"protocolVersion":"0.2","messageId":"app-5","sessionId":"session-loop-demo","epoch":1,
 "kind":"control.ack","payload":{"sessionId":"session-loop-demo","requestId":"resume-1",
 "requestMessageId":"m-2","action":"resume","status":"applied","previousEpoch":0,"epoch":1,
 "lifecycle":"running","outputConfirmation":"confirmed","reasonCode":null,"message":"resume applied"}}
```

## Delayed execution (offer → ready → grant)

The server never treats `send` as playback completion.

1. `performance.offer` carries a `PerformanceCommand` and authorizes no
   playback. The browser may show the subtitle/reaction.
2. The browser records its own local request time and answers `performance.ready`
   with the output identity.
3. The server revalidates identity, epoch and connection generation and sends
   `performance.grant` carrying `remainingLifetimeMs` only (a duration, never an
   absolute reading).

The browser's conservative local expiry is its own request start plus the
remaining lifetime; its remaining local budget at receipt is
`serverRemaining - (localNow - localRequestStart)`. It discards a grant past
that expiry and binds audio to a local abort. `performance.cancel` addresses the
active output; `performance.receipt` reports observed stages. Contradictory
terminal receipts never overwrite the first retained fact. An unresolved result
may be reconciled by a matching terminal. Reused output IDs require identical
commands; valid duplicates reuse retained outcomes, and unresolved old playback
blocks new admission. A settling claim
before any grant, a superseded connection generation and a wrong envelope are
rejected rather than forwarded as valid evidence.

```json
{"protocolVersion":"0.2","messageId":"app-6","sessionId":"session-loop-demo","epoch":1,
 "kind":"performance.offer","payload":{"outputId":"output-1","sessionId":"session-loop-demo",
 "epoch":1,"turnId":"turn-1","segmentId":"turn-1-seg-0-1","audioRef":"audio://fixture/segment-0",
 "subtitleText":"We talked about the concert.","actionId":"neutral","capabilityRevision":1}}
{"protocolVersion":"0.2","messageId":"ready-1","sessionId":"session-loop-demo","epoch":1,
 "kind":"performance.ready","payload":{"outputId":"output-1","turnId":"turn-1","segmentId":"turn-1-seg-0-1"}}
{"protocolVersion":"0.2","messageId":"app-7","sessionId":"session-loop-demo","epoch":1,
 "kind":"performance.grant","payload":{"outputId":"output-1","sessionId":"session-loop-demo",
 "epoch":1,"turnId":"turn-1","segmentId":"turn-1-seg-0-1","remainingLifetimeMs":28400}}
{"protocolVersion":"0.2","messageId":"receipt-1","sessionId":"session-loop-demo","epoch":1,
 "kind":"performance.receipt","payload":{"receiptId":"receipt-1","outputId":"output-1",
 "sessionId":"session-loop-demo","epoch":1,"turnId":"turn-1","segmentId":"turn-1-seg-0-1",
 "modality":"audio","stage":"completed","localTimeMs":null,"chunkIds":null,"reasonCode":null,
 "source":"m1-player"}}
```

## Lifecycle rules relevant to M2

- Startup is stopped; no replay and no automatic resume. Reconnect receives a
  current snapshot first; old output confirmation is never silently cleared.
- Stop revokes dispatch and advances the epoch immediately; acknowledgement does
  not wait for providers, playback or storage, and does not prove silence. Work
  that was never granted is settled as no-dispatch and does not wedge Resume;
  granted or disconnected work stays conservative until correlated evidence.
- Duplicate input/control are idempotent; a reused id with different content is
  a conflict. A duplicate attach on one socket preserves the existing performer
  binding and never replays audio. A second performer or an unauthorized control
  is refused. Queued inputs and concurrent requests are bounded.
- The console must keep C1–C7 client imports browser-safe; `/app` messages are
  JSON control only; audio stays out of control JSON.

## Client state machine

The browser-side protocol behaviour lives in one browser-safe module,
`test/browser/performer-machine.ts`, shared by the automated Node performer
client and the demo. It validates with `applicationServerMessageSchema`, fully
correlates envelope/payload/session/epoch, ignores stale or duplicate grants
without replacing abort ownership, computes the conservative expiry, cleans a
completed operation, and detaches all pending work on socket close/error/unload.
Epoch reconciliation is monotonic: stale offers, grants, acknowledgements,
snapshots and cancels cannot revive older work. Completed-output identities are
retained in a bounded set. The demo displays the last observed server
confirmation separately from the local media stage; it does not imply a fresh
server confirmation after every media event.

M2 should adopt this behaviour through an owner-reviewed extraction into a
browser-safe production module; production code must not import `test/`. The
shared wire definitions are already in `src/contracts/app/transport.ts`.

## Known gaps

M3 adoption, live dialogue/TTS/VTS, SQLite durability, full C-05/C-08/C-09/C-16
and physical audio/silence verification remain pending. The automated loop uses
a controlled media driver that emits synthetic media events, so its receipts are
M1 controller logic evidence, not acoustic proof. This handoff validates the
offline loop only.

## Local verification and next handoff

The candidate rebuilt on main `dbbbfcb`, including merged PR30 and PR31,
independently passed 634 tests in 30 files, typecheck, lint and build on
2026-10-15. The ten-case real-M6 consumption suite and all I1 source/test bodies
are preserved. The earlier 582/30 result belongs to the candidate on `7297da4`.
The current rebuild required no I1 source adaptation; main and I1 process records
were merged without rewriting historical entries.
Real loopback tests cover two turns, delivery attribution,
Stop before grant/during resolution/during playback, Resume, delayed and
duplicate messages, authorization, reconnect, storage failure, input bounds and
shutdown while selection/dialogue/offer/playback are held. Browser dependency
checks include the actual demo entry.

An independent Orca browser run on this refreshed candidate observed two completed turns (two segments each),
cancellation after playback started, and a new completed turn after Resume
(epoch 1 → 2 → 3). Closing the runtime during another started output closed the
socket and cancelled local playback, without automatic reconnect or replay. The
displayed server lifecycle/confirmation then remained the last observed values,
not a fresh server confirmation; socket closure and local cancellation were shown separately.
These browser observations supplement controlled-media tests; they do not prove
physical sound or silence. The demo services and review page were closed after
verification. The rebuild used an SSH fetch and a new detached native worktree. No staging,
commits, pushes or GitHub writes were performed.

M2 reviews the shared transport and integrates the product console. M3 supplies
its compatible implementation; M4 retains merged PR30 adoption and supplies
a live text provider and its separate follow-up guards. M6 supplies SQLite and recovery evidence. Replace one
module at a time and rerun the same scenarios. Full I1 acceptance remains open.
