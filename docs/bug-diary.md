# Bug diary

Status: under review. Owner: R3 / M6 tooling (D4); all owners contribute. One entry per significant
bug: **symptom, reproduction, classification, root cause, fix, and the invariant gap it exposed**.

## BUG-001 — Fault-injection controls exposed as production API
- Symptom: `createEventStore` accepted `beforeAppend`/`beforeCommit` failure hooks.
- Reproduction: construct a store with a throwing `beforeCommit`.
- Classification: governance / boundary (`READINESS-KITS`:26).
- Root cause: the fixture's fault flags were mirrored into production code.
- Fix: inject a `StorageBackend`; fault injection moved to the test adapter (`ec0c370`).
- Invariant gap: production API surface.

## BUG-002 — Event identity was global, not session-scoped
- Symptom: two sessions sharing a store could collide on `evt-1`.
- Reproduction: append the same `eventId` in two sessions.
- Classification: correctness (`INTERFACES` C7).
- Root cause: the index was keyed by `eventId` alone.
- Fix: key by `(sessionId, eventId)` (`b4decf3`). Invariant: INV-04.

## BUG-003 — Committed records were mutable references
- Symptom: mutating an input or a returned event changed committed state and JSONL export.
- Reproduction: append an event, mutate its `payload`, re-read.
- Classification: correctness / isolation.
- Root cause: the backend stored and returned caller references.
- Fix: deep-copy on write and read (`b5da14e`). Invariant: INV-07.

## BUG-004 — Confirmed history was unordered
- Symptom: `confirmedHistory` depended on insertion order, not the supporting event `seq`.
- Classification: correctness (`INTERFACES` C7; issue #22).
- Fix: order by supporting event `seq` (`b52e12e`). Invariant: INV-08.

## BUG-005 — WAL backup could be incomplete
- Symptom: copying `isla.db` alone could miss committed data still in the `-wal` file.
- Classification: durability / recovery.
- Fix: `PRAGMA wal_checkpoint(TRUNCATE)` before the copy (`9a54663`). Invariant: INV-10.

## BUG-006 — Migrations were not atomic as a unit
- Symptom: a failing migration could leave partial schema (each migration had its own transaction).
- Classification: durability / recovery.
- Fix: apply all pending migrations and the version bump in one transaction; rollback on failure.
  Invariant: INV-10.

## BUG-007 — Invariants missing from the register
- Symptom: INV-01..03 and INV-11 were absent from `docs/architecture/invariants.md`.
- Classification: governance / traceability.
- Found by: the new traceability fitness functions.
- Fix: the register was completed (INV-01..13). Invariant: INV-12.
