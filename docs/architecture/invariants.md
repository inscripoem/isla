# Invariant register

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
Step A coordination under review. Updated: 2026-10-15.

An invariant is a rule that must NEVER be violated. Each entry states its source requirement, the
deterministic component that enforces it, how it is verified, and the operational fallback if it is
ever violated (a concrete action, not "fix the bug").

| ID | Statement | Source REQ | Enforcing component | Verification | Fallback |
| --- | --- | --- | --- | --- | --- |
| INV-04 | Within a session, a committed event id and a session sequence number are unique (identity is session-scoped, C7); the same event id in another session is independent; content equality is canonical (object key order irrelevant, array order significant) and an event payload must be a JSON value | FR-06 | `src/storage/event-store.ts` (`append`, `commitDeliveryWithEvent`) + `src/storage/payload.ts` over `StorageBackend` (keyed `sessionId:eventId`) | C-18, C-23, C-39, C-40, C-41, C-43, C-44 → `m6-storage.test.ts`; conformance `append-duplicate`, `append-changed-content`, `append-seq-unique`, `append-session-scoped-identity` | Reject with `failed`/`conflict`/`unsupported_payload`; keep the existing record unchanged; never reject across sessions (see ADR-002) |
| INV-05 | A delivery update and its supporting event commit atomically — never partially; a failure preparing the batch leaves every index and history view unchanged | FR-06; C-17 | `src/storage/backend.ts` `commit` (atomic: prepare the whole batch, then publish) + `event-store.ts` | C-19, C-38 → `m6-storage.test.ts::INV-05`; conformance `atomic-failure-reported`, `atomic-no-partial-mutation` | Report `failed` for both; leave no partial record; mark evidence incomplete (see ADR-002) |
| INV-06 | A memory projection never advances across a gap and is idempotent | FR-06; C-12 | `src/storage/memory-projection.ts` | C-20 → `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim`, `projection-idempotent` | Do not advance `appliedSeq`; an incomplete projection must not claim current history |
| INV-07 | Committed event and delivery records are isolated from caller mutation | FR-06 | `src/storage/in-memory-backend.ts` (deep copy on write and read) | C-24 → `m6-storage.test.ts` (isolation tests) | The backend returns copies; mutating an input or a returned record leaves committed state and JSONL output unchanged (see ADR-002) |
| INV-08 | Confirmed history is ordered by the supporting event sequence | FR-06 | `src/storage/history-query.ts` over `StoredDelivery.eventSeq` | C-25 → `m6-storage.test.ts` (ordering test) | Return ascending by `eventSeq`; never rely on insertion order (see ADR-002) |
| INV-09 | Delivery evidence retains original segment index and generating persona identity/version; unknown legacy values remain null | FR-06; issue #22 | M5 output registration/finalization; M6 record conversion and conflict checks | C-45/C-46 → `m5-attribution.test.ts` | Reject changed attribution as a conflict; preserve the original record and do not fabricate missing provenance |

Related existing invariants (owned elsewhere): INV-01, INV-02, INV-03 in `docs/team/REQUIREMENTS.en.md`
and `docs/req/requirements.yaml`.
