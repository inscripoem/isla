# Memory / state design

Status: under review. M6 contributes the persistence portion; memory semantics are owned by M4 and
live authority by M5. Shared document — M5 coordination pending. Date: 2026-10-12.

## Scope and ownership

- **M6 (this section):** the storage infrastructure — what is persisted, how, where, retention and
  privacy. M6 is the only module that writes SQL; others use the M6 ports.
- **M4:** memory *semantics* — what enters dialogue context, admission and trimming rules
  (`src/dialogue/*` on `m4v1`).
- **M5:** live authority and event `seq` assignment.

## What state survives

| State | Survives restart? | Store | Notes |
| --- | --- | --- | --- |
| Committed events (`RuntimeEvent`) | Yes | `event-store` / SQLite `events` | Append-only; `seq` strictly increasing |
| Delivery outcomes (`CommitDelivery`) | Yes | SQLite `deliveries` | Full record incl. `terminalOutcome` (see below) |
| Confirmed spoken history | Yes | `deliveries` (`fully-delivered` only) | Returned by `HistoryQueryPort` |
| Memory projection position | Yes | `appliedSeq` | Advances one event at a time; never across a gap |
| Persona attribution | Yes | `deliveries.persona_version` | Per-turn `profileId@version` |
| Active turn / pending outputs | No (by design) | — | Restart begins stopped; unresolved outputs stay `unknown` |
| Raw audio | Separate local files | DB reference only | Never inside event payloads |
| Credentials / tokens | Never persisted | — | Excluded from events and JSONL |

## Write policy

1. Events are **append-only**; identity and `seq` are unique (INV-04). Reuse with changed content is
   rejected, never overwritten.
2. A delivery and its supporting event commit **atomically** (INV-05): both or neither.
3. Delivery commit is **idempotent**: identical re-commit returns `duplicate`; changed `textHash`
   returns `conflict` (key = `sessionId:turnId:segmentId:modality`).
4. The full `CommitDelivery` is persisted, including `terminalOutcome`, so a `partial-unknown` /
   `not-delivered` segment keeps its outcome across restart and cannot replay as delivered.
5. Schema versioning is separate from contract version `0.2`. Back up before migrating; reject
   unsupported schema versions; migrations are idempotent.
6. An event **payload must be a JSON value** (INV-04): a value JSON cannot represent (undefined,
   function, symbol, bigint, non-finite number, sparse-array hole, `Date`/`Map`/`Set`, cycle) is
   rejected with `unsupported_payload` before publication, so the durable store never silently alters
   it. Accepted content compares canonically: object key order irrelevant, array order significant.

## Retrieval policy

- `readSession(sessionId)` → committed events ordered by `seq` ascending.
- `confirmedHistory(sessionId)` → only `fully-delivered` records, ordered by the supporting event
  `seq` ascending (enforced by INV-08 / case C-25; each delivery retains its supporting `event_seq`),
  independent of insertion order; partial/unknown and generated-only text excluded.
- Replay (`ReplayReaderPort.load`) is an **isolated read model**: it never mutates live state and
  never calls a live provider/renderer (C-12).

## Retention and privacy

- Default local-only archives with a **proposed 7-day retention**; any different retention is an
  explicit, recorded configuration (threshold still pending a reviewed policy — NFR-05).
- No raw audio, credentials or personal tokens in event payloads or JSONL exports by default.
- Deleting stored memory does not claim an external provider's records were deleted.
- The database, journal files and audio stay **outside OneDrive**.

## Restart behaviour

Startup begins **stopped** with a new session identity, restores only confirmed history, and leaves
unresolved outputs `unknown` without replay. Storage failure marks evidence incomplete and blocks new
turns pending recovery; **Stop and local cancellation never wait for a database write**.
