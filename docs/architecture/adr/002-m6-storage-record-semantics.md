# ADR-002 — M6 storage record semantics: session-scoped identity, record isolation, history ordering

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-13 · Owner: M6 · Requirements: FR-06 · Invariants: INV-04, INV-05, INV-07, INV-08 · Cases: C-19, C-23, C-24, C-25, C-38, C-39, C-40.
Relates to: ADR-001 (persistence seam). Revision type: ADD-R (review feedback; structure intact).

## Context

M5's review of PR #9 raised three corrections to the in-memory storage slice, each a real
correctness gap against the existing contract:

1. **Event identity was global.** `createInMemoryBackend` indexed events by `eventId` alone and the
   store used that global lookup for conflict detection. `INTERFACES.en.md` (C7) states
   *event/delivery/sequence uniqueness is session-scoped*; M5's coordinator generates event ids from a
   counter **local to each session**, so two sessions can both produce `evt-1`.
2. **Committed records were mutable references.** The backend stored the caller's object and returned
   internal references from reads, so mutating an input or a returned record changed committed state.
3. **History was unordered.** `confirmedHistory` filtered deliveries without ordering and without the
   supporting event sequence, though the memory-design retrieval policy promises ascending order.

A later re-review found a **fourth** gap: `StorageBackend.commit` applied mutations one at a time and
performed the fallible deep copy *inside* that loop, so a failure preparing a later mutation (for
example a payload that cannot be structurally cloned) could leave an earlier mutation already
published — a partial write with a `failed` acknowledgement. INV-05 therefore understated what the
code guaranteed.

## Decisions

### D1 — Event identity is session-scoped
- Key events by `(sessionId, eventId)`; `StorageBackend.eventById(sessionId, eventId)`.
- Sequence uniqueness remains per session (`sessionId:seq`), unchanged.
- A conflicting `commitDeliveryWithEvent` (reused event id with changed content, or a reused session
  sequence) reports **`conflict`** — not `storage_unavailable` — on **both** the delivery and the event
  acknowledgement, matching the runtime-policy catalog. Verified by `C-39`.
- "Same content" is **canonical**: object key order is irrelevant, so a re-serialised equivalent event
  is a `duplicate`, not a `conflict`. Verified by `C-40`.
- Enabled by `INV-04`; verified by `C-23`, `C-39` and `C-40`.
- **Alternatives:** global `eventId` (rejected — violates C7; collides across sessions); a single
  generic `storage_unavailable` reason for every failed atomic commit (rejected — erases the cause and
  contradicts the catalog's `conflict` response).

### D2 — Committed records are isolated from caller mutation
- The backend is the isolation boundary: it deep-copies on write and on read (`structuredClone`).
- SQLite reads produce fresh rows, so the same boundary holds for the future backend.
- Enabled by `INV-07`; verified by `C-24`.
- **Alternatives:** shallow copy / caller discipline (rejected — leaks nested `payload`).

### D3 — Confirmed history is ordered by the supporting event sequence
- Each stored delivery retains its supporting event `seq`; `confirmedHistory` filters
  `fully-delivered` for the session and **sorts ascending by that seq**.
- Matches the ordering sentence requested in M5/M4 issue #22 (no schema change).
- Enabled by `INV-08`; verified by `C-25`.
- **Alternatives:** rely on insertion order (rejected — not guaranteed, especially under SQLite).

### D4 — The whole commit batch is prepared before any mutation is published
- `StorageBackend.commit` is atomic across the **whole batch**: a backend completes every fallible
  step (e.g. deep-copying each event/record) **before** publishing any mutation, so a failure on a
  later mutation cannot leave an earlier one applied.
- The in-memory backend splits the former `apply` into a fallible `prepare` pass and an infallible
  `publish` pass (`src/storage/in-memory-backend.ts`). A payload that cannot be structurally cloned
  makes the whole batch fail with **no** index or history view changed.
- Enabled by `INV-05`; verified by **C-38** (a later unpublishable mutation leaves no partial state)
  in addition to **C-19**.
- **Alternatives:** apply-then-roll-back (rejected — needs an undo log covering every index and view);
  validate and reject unpublishable payloads before committing (a valid option, but rejection must
  still leave state unchanged, so preparation is the mechanism either way).

## Consequences

- The persistence seam now encodes the real contract; SQLite must satisfy the same guarantees.
- Event identity, isolation and ordering are machine-checked (conformance + M6 tests).
- Atomicity is total for a prepared batch (D4): a partial write with a `failed` acknowledgement is
  no longer possible; a backend must prepare the whole batch before publishing.
- `EventStore.deliveries` (an unordered, mutable view) is removed; history is built from the backend.

## Design process (ADD-R)

1. **Review results** — PR #9 review feedback + issue #22.
2. **Gap drivers** — REQ-Type/Pattern misapplication: session scope, isolation boundary, ordering.
3. **Re-decompose** — T1 split (identity key), T2 add deterministic guard (isolation), T4 instantiate
   pattern (Information Hiding: backend owns copies; ordered projection).
4. **Replacement patterns** — Information Hiding; Record/Playback (ordered read view).
5. **Instantiate** — freeze `src/contracts/*`; add per-fix assertions; write Delta-002.
6. **Record** — this ADR + trace rows + INV-04/05/07/08 + C-19/23/24/25/38.
7. **Evaluate** — 3-tier verify (structural → regression → behavioral).

## Re-open triggers

- A backend cannot express `(sessionId, eventId)` identity or ordering (e.g. SQLite index limits).
- Isolation becomes a measurable cost and a different boundary is agreed.
- The ordering sentence is changed in `INTERFACES`.

## References

- `src/storage/{backend,event-store,history-query,in-memory-backend}.ts`
- `test/conformance/storage.conformance.ts`; `test/offline/m6-storage.test.ts`
- `docs/architecture/{invariants,trace-matrix,memory-design,runtime-policy-catalog}.md`
- PR #9 review; issue #22.
