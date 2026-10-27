# M5 VTS acquisition lifecycle handoff

Revision: 2026-10-27.1. Status: under review; candidate on branch
`feat/m5-vts-acquisition-20261026`. Publication preparation is complete;
commit, push and PR creation await Captain's confirmation as of this revision.
This document records the first implementation stage only. It does not describe
deployment wiring, which is later work. Later publication and consumer-review
results are recorded in the PR rather than inferred from these local checks.

## Scope

The approved first stage acquires one exclusive D1 `VtsConnectionHandle` from an
injected connector, pairs it with the real D2 primitive, and hands the identical
authenticated handle to the current owner. No renderer, gate facade, endpoint
discovery, production composition, CLI change, reconnect or recovery unlock is
included. M1 retains D1/D2/C protocol and renderer ownership.

New production source: `src/runtime/vts-acquisition.ts`.
New controlled support: `test/support/m5-vts-acquisition-kit.ts`.
New suite: `test/offline/m5-vts-acquisition.test.ts` (23 cases).
`package.json` adds that suite to `test:m5`; no dependency or lockfile changed.
Existing tests were not edited.

## Deployment surface

| Surface | Required use and ownership |
| --- | --- |
| `createVtsAcquisition(options)` | Validate and copy identity/target, build one frozen `VtsCredentialRecord`, bind it through the injected coordinator, and create one idle lifecycle. Options carry the connector, the coordinator, identity, structured target, mode, and explicit `acquisitionTimeoutMs`, `requestTimeoutMs` and `humanApprovalTimeoutMs`. No timer default exists; 60000/75000 ms in the delivery plan remain policy proposals. |
| `connect(signal)` | Injected by the deployment. It owns opening and rejection cleanup, observes the attempt signal, and must return any handle it acquires after cancellation so M5 can close it. M5 never constructs a socket or handle. |
| `acquisition.acquire(ownerSignal?)` | Runs one attempt. Returns `acquired` with the identical handle, `failed` with stage/reason/cause/pairing/cleanup, or `refused` with `busy`, `blocked`, `quarantined` or `already_acquired`. A pre-aborted owner signal performs no effect. Admission stays closed while a release continuation is still running. |
| `acquisition.release()` | Idempotent, concurrent-call sharing. Closes the ready handle or cancels an in-flight attempt, then reports `stopped`, `blocked` or `quarantined` from observed work. It does not await an unsettled connector. If the connector was never invoked, cancellation completes without external work. |
| `acquisition.state()` | One of `idle`, `acquiring`, `ready`, `stopping`, `blocked`, `stopped`, `failed`, `quarantined`. |
| `acquisition.whenSettled()` | Resolves when no attempt or admitted credential operation is outstanding. |
| `createVtsCredentialCoordinator(store)` | Creates the explicit coordinator for one underlying store. The deployment must create exactly one coordinator per store and inject the same instance into every acquisition manager for that store. The coordinator holds its own in-flight record set; no module-global `WeakMap` and no independent store-label object exists. |
| `coordinator.provider(record)` | Returns a D2 `VtsPairingCredentialProvider` bound to a frozen copy of the structured `{pluginName, pluginDeveloper, target}` record. Every actual `store.load(record, signal)` and `store.save(record, value, signal)` call receives that same frozen record. |
| `coordinator.isBusy(record)` / `coordinator.run(record, operation, action)` | Per-record exclusion. `run` takes its claim synchronously and throws `VtsCredentialBusyError` (carrying `record`, `recordKey` and `operation`) before any effect when the same record already has an operation in flight. Independent target or identity records remain independent. |
| `VtsCredentialStore` | Supplied by the deployment. `load(record, signal)` and `save(record, value, signal)` are record-aware; the coordinator neither caches a value nor owns persistence. |

## Observable behavior

Cancellation and the acquisition deadline settle the caller-visible result at
once and preserve the first cause (`owner`, `deadline` or `released`); a later
cancellation or the elapsed deadline cannot replace it. The attempt's remaining
work continues in its own background path: a handle returned by the connector
after cancellation, the D2 physical close, any admitted save or load, and the
pairing subscription release. `state()` is `blocked` while that work is
unresolved and refuses replacement. Clean completion becomes `failed` (or
`stopped` after an explicit release) and permits a later explicit attempt.
An observed physical or pairing cleanup failure becomes `quarantined`; it is a
process-local latch with no unlock, replacement, reconnect or fabricated success.
A physical close observed after the bounded close attempt times out does not
clear that latch.

A synchronous `owner.abort()` or `release()` immediately after `acquire()` no
longer starts the external connector: the queued connector microtask rechecks
the attempt cause and `currentAttempt`, and the final adoption rechecks both
again. A release continuation keeps admission closed until it finishes, so it
cannot clear a successor attempt.

At an accepted handoff the acquisition timer and owner listener are removed, the
current attempt and an already-observed D1 closure are rechecked, and only then
is the unchanged handle returned. Every stale result is closed or processed; the
connector remains responsible for its own rejection cleanup.

Credential operations run through the one explicitly injected coordinator. The
same underlying store and the same structured plugin identity/target cannot
bypass a pending save by constructing another manager, while independent target
and identity records remain independent. The coordinator caches no value,
fabricates no `null`, erases no credential and invents no rollback. A rejected
save remains D2's `credential_write_failed`; M5 does not substitute `load(null)`
or prompt again inside that attempt. D2's existing-token rejection policy is
unchanged.

Save admission is recorded before the delegated store effect. A store that
throws synchronously after entry is reported as an admitted rejected save, and a
store that synchronously cancels the attempt while returning an unresolved
promise is snapshotted as `pending`, not `not_admitted`. A same-record refusal
still happens before the store effect and remains `not_admitted`. Raw store
errors stay private to D2's own failure mapping. A delayed save that later
succeeds commits its admitted value; cancellation never promises rollback, and a
later explicit acquisition can read that committed value without a new prompt,
load override or reseed.

## Verification

Independent verification on Linux x86_64, Node `v22.23.4`, pnpm `12.9.0`,
against the final runtime/test bytes:

- `pnpm test:m5`: 200 tests / 9 files passed.
- `pnpm test:composition`: 12 tests / 1 file passed.
- `pnpm verify`: 1230 tests / 64 files, typecheck, lint and build passed.
- Runtime source, test source/support, manifest and lockfile hashes matched
  before and after verification. Original tests and M1/shared APIs are unchanged.

The stage baseline was 177 M5 tests across 8 files; the new suite contributes
23 cases. Author verification of the final correction separately passed the
23-case suite, typecheck and lint. Earlier 1221/1228 totals are intermediate
revisions, retained in the genuine session record rather than used as final
verification evidence. Actual-diff trace and G6 results are recorded with the
external verification evidence.

Lifecycle cases exercise the real D2 primitive when pairing is admitted;
pre-abort and coordinator-only cases deliberately perform no pairing. The real C
`createVtsClient` runs on the handed-off transport for an `APIStateResponse`
(`requestTimeoutMs: 1000`, `maxPending: 1`). Cases cover: identical handoff and
later attempt; pre-aborted owner; synchronous owner abort before the connector
microtask; synchronous release before the connector microtask; deadline during a
hung load; deadline during opening; owner cancellation during a prompt and
listener removal; late handle after cancellation; connector rejection;
cancellation between connector return and pairing; an already-closed handle;
clean close timeout quarantine plus late physical close; pairing subscription
release failure quarantine; release during an attempt; release/successor
ordering; first-cause survival across later cancellation and deadline;
timer/listener removal at a successful handoff; one controlled multi-record store
proving same-record pending-save exclusion, independent target and identity
records, correct frozen record keys at load and save, rejected-save value
preservation and retained last successful value, synchronous store throw
admission, synchronous cancellation during an admitted save whose delayed
success is later read without a new prompt, caller mutation after construction;
and the coordinator's own record binding. Deadline and close-timeout cases use
fake timers rather than racing short real timers. Fixtures do not prove real
VTS, real credential storage, physical silence or durable recovery.

### Publication preparation (2026-10-27)

Independent source/test review found no blocking High or Medium defect in the
first-stage scope. The original three runtime/test files are byte-identical to
the verified October 26 candidate. No new code or OpenCode session was needed.
The [trace note](../req/trace.en.md#m5-vts-acquisition-prerequisite-2026-10-27)
now links the new module and its tests without allocating or closing any case.

The publication check repeated M5 200/200, composition 12/12 and full verify
1230/1230 (64 files), plus readiness 42/42, trace 41/41, and G6 over the actual
ten-file change set. Typecheck, lint, build and offline frozen-lockfile install
passed. G1/G6/trace invalid and empty-input checks returned their expected
results. G4 structural probes were isolated synthetic text checks; the actual
repository G4 remains explicitly not run. These checks do not establish
future published-head CI or consumer approval.

The original 196-message OpenCode record and this review's logs/manifests are
retained outside the repository in project evidence directories
`m5-vts-acquisition-20261026` and `m5-vts-publication-prep-20261027`.

## Known gaps

- No deployment wiring exists. The connector, record-aware store, coordinator,
  identity, target and timer policy must be supplied by the later assembly. The
  `production-cli` signal handlers are installed after the deployment factory,
  so acquisition cancellation from SIGTERM is not wired in this stage; the total
  deadline is currently the only bound.
- Cancellation before an unsettled connector returns `blocked` from `release()`.
  The late handle is closed when the connector eventually returns; until then
  replacement is refused. A connector that never settles keeps that latch.
- A pending credential load also keeps replacement blocked until it settles,
  which is stricter than the required save-only rule and avoids a competing
  same-record load. This is deliberate and documented in the module.
- The post-D2 closure recheck is defense in depth. The dedicated closed-handle
  case exercises the D2 path; no deterministic test isolates the zero-await gap
  between D2 success and M5 acceptance.
- Quarantine and blocked latches are in-memory only. A process restart clears
  them; no persistent cleanup recovery exists.
- Coordination is scoped to the injected coordinator instance. A deployment
  that creates two coordinators for the same physical store defeats the
  exclusion; the one-coordinator-per-store rule is a deployment obligation and is
  documented on the factory.
- Codex appended the factual AI-use entry; the previous log text is preserved.
  Native OpenCode messages, failed regressions and independent logs are retained
  in the external project evidence directory.

## Self-review

High: none open. The acquisition timer and owner listener are removed on every
terminal path, closure is requested for every acquired handle on stale or failed paths,
cleanup failures latch instead of unlocking replacement, and cancellation that
wins before connector invocation performs no external work.

Medium: the `release()` blocked return for an unsettled connector is an explicit
trade-off, and the stricter pending-load latch is intentional. Both are stated
above rather than hidden.

Low: the `stage` field of a caller-visible cancellation names the cause, not the
pairing sub-stage; the eventual pairing code is only descriptive once D2
returns. `cleanup.connection === null` means "not observed yet", not "no
connection existed". Both are documented in the module types.
