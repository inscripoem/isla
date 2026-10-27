# Memory / state design

Status: under review. M6 contributes the persistence portion; memory semantics are owned by M4 and
live authority by M5. Step A record-shape coordination is under review. D2.5 clarifies persistence,
retention and the M6/M4 visibility boundary. Updated: 2026-10-27.

## Scope and ownership

- **M6 (this section):** the storage infrastructure — what is persisted, how, where, retention and
  privacy. M6 is the only module that writes SQL; others use the M6 ports.
- **M4:** memory *semantics* — what enters dialogue context, admission and trimming rules
  (`src/dialogue/*` on `m4v1`).
- **M5:** live authority and event `seq` assignment.

**Visibility boundary.** “Confirmed by M6” means the record is persisted and readable through the storage
ports; it is not “admitted by M4” into spoken memory. Where both states are shown, they are labelled
separately; M4 admission is preferred when only one is shown. Audience/actor identity is a claim, not an
identity key, and M6 does not store it as a key.

## What state survives

The table separates what is durable today, what is only in process, and what is planned: the
`Survives restart?` column states the position for the current code, and the Notes explain anything
planned or deliberately absent. SQLite is implemented
(`src/storage/sqlite/*`) and is what the production composition uses (`src/runtime/production.ts:342-343`);
`createEventStore` falls back to the in-memory backend only when no backend is supplied. SQLite reopen
restores only confirmed history (M6-01); application/process restart acceptance remains M5's (#25).

| State | Survives restart? | Store | Notes |
| --- | --- | --- | --- |
| Committed events (`RuntimeEvent`) | Yes | `event-store` / SQLite `events` | Append-only; `seq` strictly increasing |
| Delivery outcomes (`CommitDelivery`) | Yes | SQLite `deliveries` | SQLite target; `terminalOutcome` is validated at the write boundary but is not yet part of the in-memory read record (see below) |
| Confirmed spoken history | Yes | `deliveries` (`fully-delivered` only) | Returned by `HistoryQueryPort` |
| Memory projection position | No — in-process only; a new projection starts at 0 on restart | in-process `appliedSeq` | One bookmark per session internally; advances one event at a time; never across a gap or across sessions. The shared scalar getter reports the last attempted session, including a gap or duplicate that did not advance; `apply` returns the event session’s position. The bookmark is not persisted, so restart does not restore it; a durable cursor is deferred. A public per-session getter (`appliedSeq(sessionId)`) is a proposal only, not the frozen `MemoryProjectionPort` contract. The component has no production caller today; it is exercised by tests only. |
| Persona attribution and segment order | Planned for SQLite; present in memory | `personaProfileId`, `personaProfileVersion`, `segmentIndex` | Captured from the original request/segment; M6 must map each field explicitly in its SQLite adapter, retaining legacy unknowns as null |
| Active turn / pending outputs | No (by design) | — | Restart begins stopped; unresolved outputs stay `unknown` |
| Raw audio | Separate local files | DB reference only | Never inside event payloads |
| Credentials / tokens | Never persisted | — | Excluded from events and JSONL |

## Write policy

1. Events are **append-only**; identity and `seq` are unique (INV-04). Reuse with changed content is
   rejected, never overwritten.
2. A delivery and its supporting event commit **atomically** (INV-05): both or neither.
3. Delivery commit is **idempotent**: identical re-commit returns `duplicate`; changed `textHash`, `segmentIndex`,
   `personaProfileId`, `personaProfileVersion`, or a changed delivery classification/outcome for the same key
   returns `conflict` (key = `sessionId:turnId:segmentId:modality`). The original delivery record remains
   unchanged; a contradictory supporting event is retained as audit evidence (C-67). `textHash` is a
   **write-time integrity/idempotency aid**, not a read-time authorization check. If M4 validates a
   retraction against it, M4 recomputes the hash from the text and compares; a read-time mismatch
   rejection requires a new invariant and ADR.
4. A delivery write is **internally consistent**: `classification`/`terminalOutcome` must pair
   validly (`fully-delivered` ↔ `completed`; a `cancelled`/`failed`/`unknown` outcome may be
   `partial-unknown` or `not-delivered`), and the supporting event's known provenance and
   `sessionId`/`turnId`/`segmentId`/`outputId` must agree. An inconsistent pair or a known
   provenance mismatch is rejected as one paired `failed` with nothing persisted; an absent or
   `null` event component is legacy raw knowledge and is never inferred.
5. The write boundary validates the full `CommitDelivery` (including its
   `classification`/`terminalOutcome` pair) and the supporting `RuntimeEvent`,
   rejecting an inconsistent or malformed pair as one paired `failed` with
   nothing persisted. The in-memory store persists the confirmed-delivery fields
   and the supporting event only; the `ConfirmedDelivery` read record omits
   `terminalOutcome`, and no projection table exists yet, so durable outcome
   recording for `partial-unknown` / `not-delivered` segments remains an M6
   SQLite gap rather than an implemented in-memory behavior.
6. Schema versioning is separate from contract version `0.2`. Back up before migrating; reject
   unsupported schema versions; migrations are idempotent.
7. An event **payload must be a JSON value** (INV-04): a value JSON cannot represent (undefined,
   function, symbol, bigint, non-finite number, sparse-array hole, `Date`/`Map`/`Set`, cycle) is
   rejected with `unsupported_payload` before publication, so the durable store never silently alters
   it. Accepted content compares canonically: object key order irrelevant, array order significant.

## Retrieval policy

- `readSession(sessionId)` → committed events ordered by `seq` ascending.
- `confirmedHistory(sessionId)` → only `fully-delivered` records, ordered by the supporting event
  `seq` ascending (enforced by INV-08 / case C-25; each delivery retains its supporting `event_seq`),
  independent of insertion order; partial/unknown and generated-only text excluded.
- Turn reconstruction uses explicit `segmentIndex` within `(sessionId, turnId)`; it does not reorder the single-session history port or infer ordering from identifier spelling. Unknown indices remain unknown.
- Cross-session aggregation is **out of v0.2**. There is no cross-session storage port until M3/M4/M5
  define identity, consent and retention. M4 maintains a per-memory scope and recall *policy* for
  audience-bound memory; that policy is not a cross-session storage port and not aggregation, and no
  cross-session data path exists in v0.2.
- Replay (`ReplayReaderPort.load`) is an **isolated read model**: it never mutates live state and
  never calls a live provider/renderer (C-12).

## Retention and privacy

- **Retention:** automatic expiry/deletion is **deferred for v0.2**. Do not claim an enforced seven-day
  default; no default retention period is adopted. Local archives persist until an explicit supported
  storage operation is agreed and implemented. NFR-05 retention/deletion acceptance remains pending.
- **Rendering budgets are not retention.** `maxTurns` and `maxCharacters` drop content from a rendered
  context; they do not delete stored evidence or make a turn unreachable later.
- **Scope:** the stricter of session scope and any configured retention limit applies. A session-only
  turn must not outlive its session under a longer global window.
- **Retraction:** a withdrawal marker plus recall suppression, not row deletion. Evidence remains
  append-only, and replay/audit can show what was said. M4 owns the semantic marker; it is **not
  implemented in v0.2**. When implemented, it must suppress both automatic recall and explicit archive
  selection, with a reason-bearing exclusion, and must not rewrite a terminal outcome. No case row or
  verifier exists yet; an ID must be allocated in #25 before this requirement is traceable.
- **Deletion:** physical erasure is a separate privacy operation with its own policy and audit
  consequences; it is not implemented in v0.2. Deriving a projection from evidence does not by itself
  preserve forgetting.
- **No user-facing forget action** exists in v0.2.
- No raw audio, credentials or personal tokens in event payloads or JSONL exports by default.
- Deleting local stored records does not claim an external provider's records were deleted.
- The database, journal files and audio stay **outside OneDrive**.

## Restart behaviour

Startup begins **stopped** with a new session identity, restores only confirmed history, and leaves
unresolved outputs `unknown` without replay. Storage failure marks evidence incomplete and blocks new
turns pending recovery; **Stop and local cancellation never wait for a database write**.

## Schema, migration and configuration (B1; ADR-003)

- **Configuration:** `resolveStorageConfig` — `ISLA_STORAGE_DB_PATH` override; default
  `.cache/isla/isla.db` (ignored local storage, outside OneDrive). An empty override is rejected
  (fail-fast, never a silent default).
- **Schema version:** a single-row `schema_version` table, independent of contract `0.2` and diagnostic
  protocol `1`. An unsupported (newer) version is rejected — never silently opened or forward-migrated.
- **Migrations:** applied in a transaction (rollback on failure) and idempotent when current; an
  existing database is backed up under `<dbDir>/backups/` before pending migrations.
- **Pragmas:** WAL journal, foreign keys, busy timeout.
- **Backend (B2; ADR-004):** `src/storage/sqlite/backend.ts` implements `StorageBackend` over this
  schema — reads build fresh rows (INV-07), `commit` is one transaction (INV-05), `event_seq` orders
  history (INV-08); the full delivery including `terminal_outcome` is persisted for recovery (C-17).

## Recovery (B3; ADR-005)

- On restart, `createRecoveryView` separates `confirmed` (fully-delivered, ordered by supporting event
  `seq`) from `unresolved` (partial/unknown or not-delivered, with their terminal outcome).
- **Only confirmed history is restored**; unresolved records remain `unknown` and are **never
  replayed** (INV-11). M5 owns the lifecycle (new stopped session, blocked turns); M6 owns the data.
- **`unknown` is terminal for the record in v0.2.** There is no `resolveUnknown` port; late evidence does
  not upgrade a confirmed fact. A later-resolution contract requires M3/M4/M5 agreement and an ADR.
