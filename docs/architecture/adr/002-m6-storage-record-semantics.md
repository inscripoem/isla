# ADR-002 — M6 storage record semantics: session-scoped identity, record isolation, history ordering

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-13 · Owner: M6 · Requirements: FR-06 · Invariants: INV-04, INV-07, INV-08 · Cases: C-23, C-24, C-25.
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

## Decisions

### D1 — Event identity is session-scoped
- Key events by `(sessionId, eventId)`; `StorageBackend.eventById(sessionId, eventId)`.
- Sequence uniqueness remains per session (`sessionId:seq`), unchanged.
- Enabled by `INV-04`; verified by `C-23`.
- **Alternatives:** global `eventId` (rejected — violates C7; collides across sessions).

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

## Consequences

- The persistence seam now encodes the real contract; SQLite must satisfy the same guarantees.
- Event identity, isolation and ordering are machine-checked (conformance + M6 tests).
- `EventStore.deliveries` (an unordered, mutable view) is removed; history is built from the backend.

## Design process (ADD-R)

1. **Review results** — PR #9 review feedback + issue #22.
2. **Gap drivers** — REQ-Type/Pattern misapplication: session scope, isolation boundary, ordering.
3. **Re-decompose** — T1 split (identity key), T2 add deterministic guard (isolation), T4 instantiate
   pattern (Information Hiding: backend owns copies; ordered projection).
4. **Replacement patterns** — Information Hiding; Record/Playback (ordered read view).
5. **Instantiate** — freeze `src/contracts/*`; add per-fix assertions; write Delta-002.
6. **Record** — this ADR + trace rows + INV-04/07/08 + C-23/24/25.
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
