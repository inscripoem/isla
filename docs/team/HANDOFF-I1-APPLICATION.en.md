# I1 application transport handoff (protocol 0.2)

Status: under review · 2026-10-18.3 · Owner: M5 (runtime) · Consumer: M2 (console)

Explicit operator session recovery (`session.recover`) is implemented under review; see [Explicit session recovery](#explicit-session-recovery). The shared case registry is unchanged: the existing C-08 row stays pending and is not re-registered here.

PR36 was merged as `2d0459fdc89b88992f383872c0674d7d1db1266f`, with the same tree as its reviewed head `979f88d81cc1d071f99a41112feb128658b5d561`. This follow-up is on `feat/i1-session-recovery`. [M1's baseline approval](https://github.com/inscripoem/isla/pull/36#pullrequestreview-5561759957) does not cover these changes; the new application messages require M2 consumer review.

Independent validation passed `pnpm verify` (809 tests / 46 files, typecheck, lint and build) and all ten real-browser scenarios with zero page errors. See [current recovery verification](#current-recovery-verification). Earlier results below belong to their historical revisions. Full product, live-provider, acoustic and SQLite restart acceptance remain open; role ownership is unchanged.

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
  never logged. This is a local-demo trust boundary: the custom header and
  allowed origin/host do not authenticate a person. Do not treat the bootstrap
  as a remote-user login mechanism.
- Every message is `protocolVersion: "0.2"`. Receipts are accepted only from the
  bound performer connection; envelope and payload identities are correlated,
  and a superseded connection generation is rejected.

## Local diagnostics

`createApplicationEndpoint` accepts an optional `onDiagnostic` sink; the loop demo passes one. Scheduler, request-processing and snapshot faults produce a local record with `level: warn`, `service: isla-runtime`, `outcome: error` and one of `application.scheduler`, `application.request` or `application.snapshot`. `sessionRef` and optional `requestRef` are the first 16 hexadecimal characters of SHA-256 over the UTF-8 identifier. They support correlation without emitting the raw identifier; they are not an authentication or anonymization mechanism. Records may also contain a server-assigned `connectionId`, the validated request's `messageKind`, and its envelope `epoch` (scheduler/snapshot use the coordinator epoch when available).

No error text, stack, cause, payload or frame is included. Client errors remain generic. Synchronous sink throws and recursive diagnostic delivery are isolated; returned promise/thenable rejections are consumed and the sink is never awaited. The callback is independent of `/diag` protocol 1 and application protocol 0.2; neither wire schema changed.

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

## Physical status, send provenance and cached terminals

A `performance.receipt` proves the observed delivery fact; it does not prove
that local media was released. The real M1 controller can report a truthful
`completed` after a natural end while its failed detach retains quarantined
media and `status().idle` stays false, and it reports `failed/cleanup_failed`
after a Stop whose detach failed. The bridge therefore keeps the delivery fact
and physical occupancy as separate evidence:

- The browser reports its own M1 `PlayerStatus` (`status()`) as a new
  `performance.status` client message carrying `{ outputId, status }` and the
  output's envelope `sessionId`/`epoch`. The bridge trusts a report only for the
  output it most recently granted under that exact epoch and the *current*
  connection generation. A status before any grant, a wrong-epoch or
  wrong-identity report, a retained-terminal report from a superseded
  connection, a post-rebind report about an old output, an `idle: true` with a
  named active output, or a non-idle report naming a different active output is
  rejected. A delivery terminal never manufactures idle, and a missing status
  never manufactures idle, so physical admission stays blocked.
- Physical uncertainty survives disconnect/rebind. The last grant and its
  verified report are retained across `detach`; the application advances the
  connection generation before detaching, so a new connection cannot attest the
  old one's cleanup and a completed/failed output with failed cleanup (or with
  no report) stays non-idle instead of silently becoming idle once no operation
  is unsettled. A genuinely clean release (last report idle) is preserved as
  resolved, so a verified clean disconnect still allows fresh work.
- The transport `send` returns `sent`, `unsent` or `ambiguous`. `unsent` is a
  proven no-dispatch (a closed socket or a rejected send buffer); `ambiguous`
  covers a synchronous socket-layer throw that may follow a partial queue. The
  bridge grants only after a non-`unsent` send; a provably-unsent grant settles
  not-dispatched and immediately releases its binding, while an ambiguous grant
  stays conservatively granted. The offer path treats a provably-unsent send as
  `performer_unavailable` and never settles on an ambiguous one.
- The demo state machine reports the physical status ahead of each receipt and
  reconciles a cached terminal returned by the M1 controller for an identical
  retry after the machine's 64-entry retirement boundary (the M1 controller
  itself keeps current-epoch records with no count quota). It publishes that
  terminal through the same single receipt path, guarded to the captured pending
  admission so an ordinary execution still publishes exactly once. A terminal
  whose local cleanup failed keeps the pending entry and local admission closed
  over the retained media.

`performance.status` is an additive protocol-0.2 client kind. A strict decoder
that predates it rejects it rather than ignoring it, so producers and consumers
must be upgraded together; this handoff documents the coordinated change for
M2 and M3.

A physical status moves the bridge's own admission only. `Resume` additionally
requires the coordinator's committed output evidence: a Stop leaves
`outputConfirmation` pending, so a later standalone idle status does not by
itself restore `Resume`. That conservative recovery is documented here rather
than replaced with an invented confirmation.

## Explicit session recovery

A disconnect after playback started leaves the retired session's output
unconfirmed and its physical occupancy unknown, so the retained session can
accept input but cannot produce new output. The operator can end that session
explicitly and continue in a fresh successor over the same store.

- A `session.recover` client message is the operator's own decision. The
  envelope `sessionId` is the session the operator intends to retire; its
  payload requires the literal `acknowledgePlaybackEnded: true`. The
  acknowledgement is never measured media evidence and never a delivery fact. A
  request against the current session must carry its current epoch; a request
  against an already-retired session is answered idempotently rather than
  creating a second successor.
- The server answers `session.recovery.ack`. The envelope stays on the retiring
  session and the request epoch; the payload carries `status` (`applied` or
  `already_applied`), the correlated `requestMessageId`, the retiring and
  successor session ids, and the `recoveries`/`remainingRecoveries` counters.
- The server also pushes `session.recovery.state` (`retiring: true`) when valid
  retirement begins and to each newly connected client right after its snapshot,
  so the retired state is server-authoritative and a reload after a failed
  retirement still reflects it rather than inferring retirement from a lifecycle
  value. A refusal that never retires the live session (stale, unknown-session,
  unauthorized or already-retired) never sets it, and the successor reports
  `retiring: false`.
- Recovery retires the old in-memory scheduling and every old connection,
  installs a fresh, **stopped** successor with a new epoch and its own deadline
  gate, and carries forward only confirmed history through the production
  reconstruction entry. Unknown and partial outcomes are never promoted to
  speech, and the retired session's own stored evidence and record are
  preserved.
- The successor starts stopped: there is no replay and no automatic Resume. The
  client reconnects, receives the successor snapshot first, bootstraps operator
  authority and attaches the performer through the existing flow, then a manual
  `Resume` is required.
- The archive-source bound remains explicit. Exceeding it is a non-retryable
  `conflict` refusal that never silently drops an earlier selected source. A
  successor-construction failure is a retryable `storage_unavailable`; the
  retiring session stays current and a retry is possible without a second live
  runtime. A request that is neither the current nor a retired session, and any
  recovery without operator authority, are refused.
- A late or superseded request cannot reach the successor: every old connection
  is closed, the endpoint swaps its bridge binding and server-message
  subscription, and the successor's fresh gate and generation reject stale
  identities.

```json
{"protocolVersion":"0.2","messageId":"recover-1","sessionId":"session-loop-demo","epoch":1,
 "kind":"session.recover","payload":{"acknowledgePlaybackEnded":true}}
{"protocolVersion":"0.2","messageId":"app-9","sessionId":"session-loop-demo","epoch":1,
 "kind":"session.recovery.ack","payload":{"status":"applied","requestMessageId":"recover-1",
 "retiredSessionId":"session-loop-demo","successorSessionId":"session-<fresh>",
 "recoveries":1,"remainingRecoveries":7}}
{"protocolVersion":"0.2","messageId":"app-10","sessionId":"session-loop-demo","epoch":1,
 "kind":"session.recovery.state","payload":{"retiring":true}}
```

`session.recover` is an additive protocol-0.2 client kind; `session.recovery.ack`
and `session.recovery.state` are additive server kinds. A strict decoder that
predates them rejects rather than ignores them, so producers and consumers must be
upgraded together. This is lifecycle recovery over an existing (for example
in-memory) store, not disk/process-crash recovery.

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

## Client identity across page/realm lifetimes

A browser reload re-evaluates the client module in a fresh JS realm, so a
module-scoped identity sequence restarts. Default client identities are
therefore unique across page and realm lifetimes: the shared performer machine
combines a per-module-evaluation realm nonce with its sequence, and its receipt
id generator defaults to the same realm-unique source. A reloaded page can no
longer reuse message or receipt identities that a retained server session still
remembers, which would otherwise make its receipts conflict and prevent a
commit. The default uses `crypto.randomUUID`/`getRandomValues` where available
and a time/random fallback otherwise. Tests keep deterministic identity
injection through the optional `receipts` (and `now`) options; the single
receipt publication path is unchanged. M2 must adopt this behaviour together
with the browser-safe extraction; production code must not import `test/`.

## Client state machine

The browser-side protocol behaviour lives in one browser-safe module,
`test/browser/performer-machine.ts`, shared by the automated Node performer
client and the demo. It validates with `applicationServerMessageSchema`, fully
correlates envelope/payload/session/epoch, ignores stale or duplicate grants
without replacing abort ownership, computes the conservative expiry, cleans a
completed operation, and detaches all pending work on socket close/error/unload.
Epoch reconciliation is monotonic: stale offers, grants, acknowledgements,
snapshots and cancels cannot revive older work. Completed-output identities are
retained in a bounded set. Each receipt is preceded by a correlated
`performance.status` report of the controller's own `status()`, so the server
can separate the delivery fact from physical occupancy; a cached terminal
returned for an identical retry after the bounded set retires an entry is
reconciled through the same single publication path. The demo displays the last
observed server confirmation separately from the local media stage; it does not
imply a fresh server confirmation after every media event.

M2 should adopt this behaviour through an owner-reviewed extraction into a
browser-safe production module; production code must not import `test/`. The
shared wire definitions are already in `src/contracts/app/transport.ts`.

## Known gaps

M3 adoption, live dialogue/TTS/VTS, SQLite durability, full C-05/C-08/C-09/C-16
and physical audio/silence verification remain pending. Explicit operator
session recovery is implemented for the in-memory I1 loop only; disk or
process-crash restart recovery over the SQLite backend remains M6 work and is
not claimed here. The automated loop uses a controlled media driver that emits
synthetic media events, so its receipts are M1 controller logic evidence, not
acoustic proof. This handoff validates the offline loop only.

## Historical I1 verification and ownership

The candidate rebuilt on main `dbbbfcb`, including merged PR30 and PR31,
independently passed 634 tests in 30 files, typecheck, lint and build on
2026-10-15. The ten-case real-M6 consumption suite and all I1 source/test bodies
are preserved. The earlier 582/30 result belongs to the candidate on `7297da4`.
The current rebuild required no I1 source adaptation; main and I1 process records
were merged without rewriting historical entries.

The bounded M1-finding repair on PR36 (`08ff362`) was implemented and verified
locally on 2026-10-16: it added the correlated `performance.status` client kind,
the tri-state transport send, the physical-versus-delivery admission split and
the machine's cached-terminal reconciliation. Chronology, stated plainly: the
implementation came first; the three findings were then demonstrated red by
temporarily reintroducing each defective behavior, then restored green. That is
not the same as reproducing each fault before fixing it.

An independent review then requested a bounded follow-up, also implemented
locally on 2026-10-16: physical uncertainty is preserved across
disconnect/rebind (with a verified clean-disconnect path retained); the physical
status is rejected when contradictory, pre-grant, stale-generation or
identity-mismatched (closing the retained-terminal generation bypass); the
tri-state send is exercised through Stop and expiry with no retained binding or
dispatch; actual natural completion with a failed detach preserves completed
history while blocking fresh media; a failed cached/local cleanup never reopens
local admission; and `execute` fulfillment is tied to the captured pending
admission. The two most important new regressions were also shown red against
the pre-follow-up behavior.

A browser regression then reported a bounded reconnect defect: after a page
reload against a retained server session the reloaded client reused message and
receipt identities, so its receipts conflicted and the second turn never
committed. M5 fixed client identity generation across page/realm lifetimes with
a per-module-evaluation realm nonce and a realm-unique default receipt source,
keeping deterministic injection for tests. The fresh-realm identity unit
regression and the actual application reconnect regression (`i1-reconnect-identity.test.ts`)
were both shown red without the nonce and green with it; no server identity or
dedup check was weakened and no M2 code was touched.

After the final code, the focused suites pass and `pnpm verify` passed 653 tests
in 31 files, typecheck, lint and build (all prior quarantine/unsent/cached-terminal
repairs retained). The repair was subsequently published as `191f58b`; both
current-head CI runs passed. M1 subsequently approved this published head within
the fixed-audio consumer/interface scope; M2 review and publication of the locally
reconciled branch remain pending.
OpenCode authored the repair and ran the automated checks;
the supervisor independently repeated verification and the browser checks below.
Real loopback tests cover two turns, delivery attribution,
Stop before grant/during resolution/during playback, Resume, delayed and
duplicate messages, authorization, reconnect, storage failure, input bounds and
shutdown while selection/dialogue/offer/playback are held. Browser dependency
checks include the actual demo entry.

The supervisor independently reran pnpm verify: 653 tests / 31 files, typecheck,
lint and build passed. The final Orca browser run observed two completed turns
(two segments each), a fresh-page reload against the retained server followed by
another completed turn with distinct receipt identities, cancellation after
playback started, and another completed two-segment turn after Resume
(epoch 1 → 2 → 3). A separate clean run closed the runtime immediately after a
started receipt; the browser observed socket closure and local cancellation.
Its displayed server lifecycle/confirmation remained the last observed values,
not a fresh server confirmation. No automatic reconnect or replay occurred.

Earlier attempts included an automation timeout, failed media receipts without
a captured cause, and a shutdown sent after playback had already ended. They
are retained as inconclusive or mistimed attempts, not passed cancellation
checks. The original 2026-10-15 browser record belongs to the published baseline.
The final checks above use fixed WAV assets and media events, not acoustic
measurements, live providers or SQLite recovery. The supervisor closed the
review page and demo services after verification. No staging, commits, pushes
or GitHub writes were performed for this repair.

M2 reviews the shared transport and integrates the product console, including
the additive `performance.status` kind and reload-safe identities. The tri-state
send result belongs to the server transport implementation. M3 supplies
its compatible implementation; M4 retains merged PR30 adoption and supplies
a live text provider and its separate follow-up guards. M6 supplies SQLite and recovery evidence. M2 and M3
remain separate owners; this repair does not implement their modules. Replace one
module at a time and rerun the same scenarios. Full I1 acceptance remains open.

## Current recovery verification

The recovery increment, implemented locally on 2026-10-18, added the
explicit operator `session.recover` action over the in-memory I1 loop: the
endpoint retires the old scheduling and every old connection, installs a fresh
**stopped** successor with a new epoch and its own deadline gate over the same
store, and carries forward only the confirmed history through the production
reconstruction entry. The operator acknowledgement is a decision, never measured
media or delivery evidence; unknown and partial outcomes are preserved but never
promoted to speech, the archive-source bound stays explicit, and a
successor-construction failure is a retryable refusal that leaves the retiring
session current without a second live runtime. Focused suites pass and
`pnpm verify` passed 809 tests in 46 files, typecheck, lint and build (the prior
653/31 result predates this increment and the upstream tests present on the
current integration base). New consuming regressions in
`test/offline/i1-recovery.test.ts` cover interrupted-playback recovery, the fresh
stopped successor, confirmed-only carry, partial/unknown exclusion, repeated and
concurrent recovery, unauthorized and stale requests, a failed build retried, and
normal Stop/Resume; the I1 demo UI and transport wiring are covered without
labelling ordinary in-flight confirmation as a disconnect failure. Three of those
tests capture the outputs already started before a Stop and wait for a NEWLY
started output identity, so each Stop provably acts on its own turn; the
stopped-partial-turn case asserts that the matching cancelled evidence is retained
and excluded from the carried confirmed history rather than resting on a
timing-dependent refused-Resume premise, since recovery refusal stays covered by
the disconnect and failed-retirement tests. A genuine Playwright acceptance against
the real loop page and runtime (`test/browser/recovery-acceptance.mjs`) passed all
ten scenarios on two fresh runtime+page servers with zero page errors: initial
stopped session, manual Resume and a full two-segment output; an ordinary Stop
during a natively playing turn producing a new `performance.cancel` frame, a new
cancelled receipt and genuine local media release, then a fresh authoritative
snapshot (stopped/confirmed on the same session), exactly one applied manual
Resume and a new full output; a new playing turn closed at the real `/app` socket
with local release; reload of the same session unconfirmed and replay-free;
explicit recovery to a different stopped successor; reconnect/bootstrap/attach/
manual Resume and two complete fresh turns; and a second recovery preserving
lineage. These are fixed-WAV media-API observations, not acoustic or full SQLite
recovery. This is lifecycle recovery over the existing in-memory store, not SQLite
restart recovery; no new shared register or case id was introduced and C-08 stays
pending with no verifier. OpenCode authored the implementation in `ses_eb2014c63ffePhR2Ga1C7G7sxo` and continued after the approved branch migration in `ses_eb180c970ffeoD5t6ywKvYKwFS`. The supervisor independently repeated `pnpm verify` (809 / 46, exit 0) and all ten browser scenarios with zero page errors. The results remain
under review. The checks above precede publication; Captain subsequently authorized the follow-up branch commit, push and new PR.
