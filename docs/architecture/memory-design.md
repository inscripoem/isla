# Memory / state design

Status: under review. M6 contributes the persistence portion; memory semantics are owned by M4 and
live authority by M5. Step A record-shape coordination is under review. Updated: 2026-10-20.

## Scope and ownership

- **M6 (this section):** the storage infrastructure — what is persisted, how, where, retention and
  privacy. M6 is the only module that writes SQL; others use the M6 ports.
- **M4:** memory *semantics* — what enters dialogue context, admission and trimming rules
  (`src/dialogue/*` on `m4v1`).
- **M5:** live authority and event `seq` assignment.

## What state survives

The table describes the persistence target. Current main supplies an in-memory backend; Step A does not implement SQLite migration or restart recovery.

| State | Survives restart? | Store | Notes |
| --- | --- | --- | --- |
| Committed events (`RuntimeEvent`) | Yes | `event-store` / SQLite `events` | Append-only; `seq` strictly increasing |
| Delivery outcomes (`CommitDelivery`) | Yes | SQLite `deliveries` | SQLite target; `terminalOutcome` is validated at the write boundary but is not yet part of the in-memory read record (see below) |
| Confirmed spoken history | Yes | `deliveries` (`fully-delivered` only) | Returned by `HistoryQueryPort` |
| Memory projection position | Yes | in-process `appliedSeq` | One bookmark per session internally; advances one event at a time; never across a gap or across sessions. The shared scalar getter reports the last attempted session, including a gap or duplicate that did not advance; `apply` returns the event session’s position. |
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
   unchanged; a contradictory supporting event is retained as audit evidence (C-67).
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
- Replay (`ReplayReaderPort.load`) is an **isolated read model**: it never mutates live state and
  never calls a live provider/renderer (C-12).

### Lexical recall scoring (M4, offline)

Recall over turns that aged out of the recency window is deterministic keyword overlap — no model
call, no embeddings, no I/O, so it stays free for NFR-03 attribution.

- Tokens are Latin words (3+ characters) and CJK bigrams. A CJK one-character run yields no token at
  all: a lone 我 is a pronoun, and matching it across turns is a false positive.
- Stopword tables are per tokenizer (whole Latin words; CJK bigrams), because an English-only list
  never matched Chinese text. Glue bigrams are kept but weighted **thin**.
- A token is **informative** (weight 2) when it is a 5+ character Latin word, a number, or a CJK
  bigram of two content characters; otherwise it is thin (weight 1). Admission needs the weighted
  score to reach `MIN_RECALL_SCORE` **and** at least one informative token, so two shared glue words
  cannot drag in an unrelated old turn.
- This is lexical and therefore coarse by construction; it errs toward precision, because a false
  recall costs budget and misleads the model.

### Consistency scan (M4, audit only)

Admitted confirmed statements and the profile's standing facts are compared by clause before the
prompt is rendered: opposite polarity about the same content, incompatible numbers about the same
content, and opposite attributes about the same object.

- The scan **reports**; it never decides truth, rewrites text, drops a record or changes admission.
  Silently dropping one side would pick a winner on lexical evidence alone.
- Findings carry statement ids, the disagreement kind and a shared-token **count** — never statement
  text, so they stay inside the redaction boundary of the operator inspection payload.
- `CONFLICT_MARKER` (` [conflicting]`) is opt-in and off by default: it is prompt text and is charged
  to `maxCharacters`, so enabling it can displace another turn. With it off, the prompt, the budget
  and the rendered block are unchanged from before the detector existed.
- Scope limits, stated rather than hidden: clause-level only, lexical (no paraphrase), negation read
  from a small marker list (so an idiom such as 不错 reads as negated).

## Retention and privacy

- Default local-only archives with a **proposed 7-day retention**; any different retention is an
  explicit, recorded configuration (threshold still pending a reviewed policy — NFR-05).
- No raw audio, credentials or personal tokens in event payloads or JSONL exports by default.
- Deleting stored memory does not claim an external provider's records were deleted.
- The database, journal files and audio stay **outside OneDrive**.

### "Confirmed by M6" is not "admitted by M4"

These are two independent, intentionally separate questions (issue #44 §3).

- **M6 confirmed** — durable `fully-delivered` evidence, ordered by the supporting event `seq`. This
  answers "was this durably delivered". It is the audit/durability view.
- **M4 admitted** — a record that actually enters spoken context after the receipt policy
  (`required-for-audio`). This answers "may the character recall this as something it said". A record
  M6 confirms can be refused by M4 (e.g. `fully-delivered` audio with no receipt), and a record M4
  admits must already be confirmed.

The operator console must show **both, labelled**: "admitted to memory" (M4, with reason) and
"durable confirmed" (M6, audit). If only one is shown, show M4 admission; M6 confirmed belongs in the
audit surface. Neither filter is changed to match the other.

### Retraction versus deletion

- **Retracted** — semantic memory is no longer admitted; evidence retained; replay/audit still shows
  what was said. This is the smallest safe "forget this fact" operation and is an append-only
  retraction/override record keyed to the source event/delivery, applied by M4.
- **Deleted** — data erasure; removes evidence/data. A separate data-lifecycle/privacy operation with
  its own policy and audit consequences. "Delete the whole session" is this operation, not a
  projection-row delete.

v0.2 builds no user-facing forget action and no evidence deletion; the two words must never be
conflated.

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
