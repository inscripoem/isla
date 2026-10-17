# ADR-004 — SQLite backend implementing StorageBackend

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-14 · Owner: M6 · Requirements: FR-06 · Invariants: INV-04, INV-05, INV-07, INV-08 · Cases: C-29, C-30, C-42.
Relates to: ADR-001 (seam), ADR-002 (record semantics), ADR-003 (SQLite + migrations). Revision: ADD.

## Context

B2 (sub-issue #11): the store logic is defined against `StorageBackend` (ADR-001/002) and B1 provides
the schema (ADR-003). B2 implements the backend over SQLite so persistence is durable while the store's
observable behaviour — and its invariants — stay identical to the in-memory slice.

## Decisions

### D1 — Map `StorageBackend` to SQL, preserving every guarantee
- `eventById`, `sequenceOwner`, `sessionEvents`, `deliveryByKey`, `storedDeliveries` use prepared
  statements; `commit` applies every mutation in one transaction.
- INV-04 via `PRIMARY KEY(session_id, event_id)` + `UNIQUE(session_id, seq)`; INV-07 via fresh objects
  on read (`rowToEvent`/`rowToDelivery`); INV-08 via `event_seq`.
- **INV-05 (batch atomicity).** `commit` applies the whole batch in one `BEGIN`/`COMMIT` and
  `ROLLBACK`s on any failure — including a constraint violation on a *later* mutation — so no partial
  state survives. This is the "equivalent rollback" the backend contract permits in place of preparing
  the batch before publishing (ADR-002 D4). Verified by **C-42** (`m6-sqlite-backend.test.ts`), in
  addition to the conformance check.
- The delivery mutation carries `terminalOutcome`, so it is persisted for recovery (C-17) — the
  in-memory slice drops it, which is acceptable only because it is ephemeral.
- Verified by C-29 (conformance suite runs over SQLite) and C-30 (data survives reopen).
- **Cross-backend agreement (C-45).** The in-memory and SQLite backends are exercised with the same
  mixed scenario end-to-end; committed state, JSONL export and confirmed history agree, and
  unsupported payloads are rejected identically by both.

### D2 — `deliveryByKey` takes the composite parts
- `deliveryByKey(sessionId, turnId, segmentId, modality)` instead of a single string key, so the SQL
  backend queries by columns without parsing a `:`-joined string (which is unsafe when ids contain
  `:`). M6-internal; no shared-contract impact.

## Alternatives considered

1. **Parse the `sessionId:turnId:segmentId:modality` string** — rejected (ambiguous if a field
   contains `:`).
2. **A redundant `delivery_key` column** — rejected (the four columns are already the primary key).
3. **Keep `terminalOutcome` unpersisted** — rejected (contradicts the C-17 recovery guarantee).

## Consequences

- Durable store with the same observable behaviour; the conformance suite passes over SQLite.
- #22 attribution: the delivery record's `segmentIndex`, `personaProfileId` and `personaProfileVersion`
  are persisted (migration 2); the legacy `persona_version` column is dropped once verified empty.

## Design process (ADD)

1. Review inputs — FR-06; the seam contract; B1 schema. 2. Drivers — durability, contract fidelity.
3. Decompose — SQL statements + row codec + transaction. 4. Concepts — port/adapter; Information Hiding.
5. Instantiate — `sqlite/{backend,codec}.ts`. 6. Record — this ADR + trace rows + C-29/C-30 + Delta-004.
7. Evaluate — 3-tier verify.

## Re-open triggers

- A guarantee cannot be expressed in SQL (e.g. an ordering/index limitation).
- The composite-key change proves problematic for a consumer.

## References

- `src/storage/sqlite/{backend,codec}.ts`, `src/storage/backend.ts`
- `test/offline/m6-sqlite-backend.test.ts`; `docs/architecture/{invariants,trace-matrix,memory-design}.md`
