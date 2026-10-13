# Invariant register

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
M5 coordination pending. Date: 2026-10-12.

An invariant is a rule that must NEVER be violated. Each entry states its source requirement, the
deterministic component that enforces it, how it is verified, and the operational fallback if it is
ever violated (a concrete action, not "fix the bug").

| ID | Statement | Source REQ | Enforcing component | Verification | Fallback |
| --- | --- | --- | --- | --- | --- |
| INV-04 | Within a session, a committed event id and a session sequence number are unique (identity is session-scoped, C7); the same event id in another session is independent | FR-06 | `src/storage/event-store.ts` (`append`, `commitDeliveryWithEvent`) over `StorageBackend` (keyed `sessionId:eventId`) | C-18, C-23 → `m6-storage.test.ts`; conformance `append-duplicate`, `append-changed-content`, `append-seq-unique`, `append-session-scoped-identity` | Reject with `failed`/`conflict`; keep the existing record unchanged; never reject across sessions (see ADR-002) |
| INV-05 | A delivery update and its supporting event commit atomically — never partially | FR-06; C-17 | `src/storage/backend.ts` `commit` (atomic) + `event-store.ts` | C-19 → `m6-storage.test.ts::INV-05`; conformance `atomic-failure-reported`, `atomic-no-partial-mutation` | Report `failed` for both; leave no partial record; mark evidence incomplete |
| INV-06 | A memory projection never advances across a gap and is idempotent | FR-06; C-12 | `src/storage/memory-projection.ts` | C-20 → `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim`, `projection-idempotent` | Do not advance `appliedSeq`; an incomplete projection must not claim current history |

Related existing invariants (owned elsewhere): INV-01, INV-02, INV-03 in `docs/team/REQUIREMENTS.en.md`
and `docs/req/requirements.yaml`.
