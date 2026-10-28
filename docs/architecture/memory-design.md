# Memory / state design

Status: under review. M6 contributes the persistence portion; memory semantics are owned by M4 and
live authority by M5. Step A record-shape coordination is under review. D2.5 clarifies persistence,
retention and the M6/M4 visibility boundary. Updated: 2026-10-27.
Anchors: FR-06 (persist and replay); NFR-05 (privacy, owner M5; M4/M6 collaborate).

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
restores confirmed history and exposes unresolved records for recovery (M6-01); application/process
restart acceptance remains M5's (#25).

| State | Survives restart? | Store | Notes |
| --- | --- | --- | --- |
| Committed events (`RuntimeEvent`) | Yes | `event-store` / SQLite `events` | Append-only; `seq` strictly increasing |
| Delivery outcomes (`CommitDelivery`) | Yes | SQLite `deliveries` (`StoredDelivery`) | The full record, including `terminal_outcome`, is persisted; `ConfirmedDelivery` is the narrower read shape |
| Confirmed spoken history | Yes | `deliveries` (`fully-delivered` only) | Returned by `HistoryQueryPort` |
| Memory projection position | No — in-process only; a new projection starts at 0 on restart | in-process `appliedSeq` | One bookmark per session internally; advances one event at a time; never across a gap or across sessions. The shared scalar getter reports the last attempted session, including a gap or duplicate that did not advance; `apply` returns the event session’s position. The bookmark is not persisted, so restart does not restore it; a durable cursor is deferred. A public per-session getter (`appliedSeq(sessionId)`) is a proposal only, not the frozen `MemoryProjectionPort` contract. The component has no production caller today; it is exercised by tests only. |
| Persona attribution and segment order | Yes — persisted in SQLite and present in memory | `personaProfileId`, `personaProfileVersion`, `segmentIndex` | Captured from the original request/segment; written by `src/storage/sqlite/backend.ts` and restored by `codec.ts`; legacy unknowns stay null. `ConfirmedDelivery` is the narrow read shape; `StoredDelivery` is the recovery shape. |
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
   and the supporting event; the `ConfirmedDelivery` read record deliberately
   omits `terminalOutcome`. SQLite persists the full `StoredDelivery`, including
   `terminal_outcome`, and `src/storage/recovery-view.ts` exposes unresolved
   records; `test/offline/m6-recovery.test.ts` covers in-memory separation and
   SQLite reopen. No projection table exists yet.
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
- **Automatic** cross-session memory is out of v0.2: no audience-linked recall across sessions until
  M3/M4/M5 define identity, consent and retention. M4 maintains a per-memory scope and recall *policy*;
  it is not an aggregation path.
- **Explicit archive reconstruction is implemented and retained.** `src/runtime/session-archives.ts:307-330`
  combines only the explicitly selected archive histories with the live session (archives in selection
  order, then live); `src/runtime/production.ts:342-371` wires it into the SQLite-backed composition.
  `test/offline/m5-process-restart.test.ts` covers selected prior-session history reaching the new
  session's dialogue context. Scope: Linux/controlled peers; it does not establish product-console or
  Windows acceptance.
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

### Bounded consistency audit (adopted by M4, 2026-10-23)

The synchronous scan now has four fixed work ceilings: 128 visited statements, 32,768 UTF-16
text units, 256 generated claims, and 10,000 pair iterations. Text is charged before splitting or
tokenizing. Statements that exceed the remaining text or clause allowance are skipped whole;
they are never truncated into a different claim. Input order and findings within the inspected
range are retained. The default finding limit remains eight; non-finite values use that default,
fractional values are rounded down, and non-positive values request no audit.

These ceilings are M4's adopted policy values, not a reviewer proposal. They are counts, not
latency guarantees; changing one is a policy change and should carry recorded evidence.

`scanContradictions` is exported by `src/dialogue/index.ts` and now returns a
`ConsistencyScanResult` object instead of an array; callers read `.findings`. The production
caller in `context.ts` and the direct scanner tests are updated. `AssembledDialogueContext`
adds the required `consistencyAudit` summary, and `MemoryInspectPayload` adds `consistency`.
Both summaries contain counts and `incomplete`, without memory or persona text. Context warnings
explicitly identify incomplete scans, including early termination at the findings cap. Reaching
a limit on the final inspected item does not by itself make an otherwise complete scan partial.

**The partial-audit contract is adopted as a semantic rule, not merely a field.** `incomplete`
true means the audit is partial: an empty `findings` array alongside `incomplete: true` is *not*
"no contradictions" and must never be reported as a clean or complete audit. Only `incomplete:
false` licenses reading the findings as covering the whole input. The inspection payload and the
context warnings carry the same distinction so a consumer cannot silently present a partial scan
as an all-clear.

The contraction patterns now require a word boundary before the word run. This prevents a long
Latin word from restarting the same failed contraction search at each character; supported
negation markers and ASCII/curly-apostrophe contractions retain their meanings.

These are M4 module API changes, not changes to the shared C1–C7 schemas or the storage schema.
The inspection builder is not a connected diagnostics endpoint or an M2 panel. Confirmed-history
admission, outcome reporting and character charges for the optional conflict marker are retained.
The ceilings limit scan work, not total context
assembly, storage reads, wall-clock latency, or the rest of the dialogue pipeline. Large histories
can omit later standing facts from the audit because the existing input order is preserved.

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
- **`unknown` is terminal for the record in v0.2.** There is no `resolveUnknown` port; late evidence does
  not upgrade a confirmed fact. A later-resolution contract requires M3/M4/M5 agreement and an ADR.
