# Architecture candidate comparison (qualitative)

Status: **proposal, under review.** Owner: M5 coordination. Revision 2026-11-25.1. Base:
`main` `e2166cd047537042bd58a3c9999515fa9caf96e1`.

## 1. Scope and relationship to the G4 evaluation table

This file consolidates the alternatives that the existing architecture decision records already
considered, so a reviewer can compare the choices in one place. It is **qualitative**: it states which
candidate was chosen and why the others were rejected, with a pointer to the record that owns the
decision. It contains **no measurements, scores, latencies or pass rates**.

Measured results belong in `docs/architecture/evaluation-table.md`, which G4 reserves for claims
carrying fixed conditions and observed values. For this candidate the G4 gate was **not run**: there is
no evaluation set and no provider access, so no measured comparison exists and none is claimed here. A
"not run" result is not a pass.

The failure-response side of D2 is recorded separately in
[`runtime-policy-catalog.md`](runtime-policy-catalog.md); this file does not duplicate those rows.

## 2. How to read the table

- **Candidate chosen** is the design in the current source.
- **Rejected candidates** are listed with the reason recorded in the owning document. The list is a
  summary; the ADR text is authoritative.
- **Reopen trigger** is the condition under which the rejected option should be reconsidered.

## 3. Storage, persistence and recovery

| Area | Candidate chosen | Rejected candidates and reason | Owner record | Reopen trigger |
| --- | --- | --- | --- | --- |
| Persistence seam | A `StorageBackend` port with in-memory and SQLite adapters; store logic owns conflict rules, atomic commit, ordering and export | Production `beforeAppend`/`beforeCommit` fault hooks (exposes a failure switch on the evidence layer); in-memory only (no path to required durability); test-only proxy that throws before the store (cannot exercise the store's own failure handling); linear identity scans (does not scale) | ADR-001; OL-001–OL-004 | A genuine production lifecycle/telemetry hook is required, or durable persistence leaves scope |
| SQLite schema and migration | `node:sqlite` configured fail-fast; a `schema_version` table plus a migration runner; scalar columns with JSON for `payload`/`versions` | `PRAGMA user_version` (less explicit, harder to audit/back up); one JSON blob per event (weak uniqueness/indexing); JSONL only (export/replay, not the authoritative store) | ADR-003 | A different engine or a schema-audit requirement appears |
| SQLite mapping of delivery | Four composite key parts and persisted terminal outcome | Parsing the `sessionId:turnId:segmentId:modality` string (ambiguous when a field contains `:`); a redundant `delivery_key` column (the four columns are already the primary key); leaving `terminalOutcome` unpersisted (contradicts recovery) | ADR-004 | The delivery key shape changes |
| Restart recovery | A single recovery view over committed deliveries; unresolved outcomes stay `unknown`; nothing is replayed | Reconstructing recovery ad hoc in each consumer (duplicated, untested); a new shared recovery port (unnecessary contract change) | ADR-005 | A second consumer needs a recovery contract of its own |
| Record semantics | Session-scoped event identity; committed records isolated from caller mutation; history ordered by the supporting event sequence; a whole batch prepared before publication | Reusing the fixture's linear conflict scan; extending the hand-rolled canonical serializer for "same content" (each review round found another edge case). Instead the payload domain is defined as JSON values and compared canonically | ADR-002; OL-004–OL-005 | A non-JSON payload must be supported (then a lossless codec is needed) |

## 4. Governance and evaluation

| Area | Candidate chosen | Rejected candidates and reason | Owner record | Reopen trigger |
| --- | --- | --- | --- | --- |
| Governance checks | Traceability fitness functions over the existing Markdown artifacts, run as explicit blocking gates | Ad hoc document review (not machine-checked; drifts silently). Machine-readable artifact sources plus a generator were deferred for v1 because the parser sufficed | ADR-006 | The Markdown parse becomes a maintenance burden, or a gate cannot be expressed statically |
| Evaluation bench | One bench with a shareable core and per-provider halves; every attempt recorded; missing values stay unknown; cold and warm separate; nearest-rank percentiles without a dependency | A statistics dependency (supply-chain and review cost for one function); a test runner's benchmark mode (measures the runner, cannot express cancellation or missing usage); reusing the storage fault seam (measures the storage port, not the performer); dropping failed attempts (flattering numbers that hide failures); estimating missing cost from prompt size (fabricates a number) | ADR-007 | A statistical method beyond nearest-rank is required, or the bench must report runner-level cost |
| Prepared-input provenance | A separate, run-bound companion artifact bound by position and content; explicit per-input status; refusal rather than a partial join | `schemaVersion: 2` on the run record (changes a frozen shared artifact); inference by text or order (unsound when inputs share text or a batch stops early); restating fixed conditions (two copies drift); `runId` only (cannot separate attempts sharing a case and variant); `null` for a known-empty set (destroys stratification); promoting a missing link to `exact` (unknown is not a pass) | ADR-008; INV-16 | The run record itself may be versioned with owner review |
| Memory tables | Six tables, no contract change; a durable monotonic extractor-scoped cursor; owner and derived writes behind a durable consenting binding; per-session state; explicit operator-driven deletion/retention; derived memory rebuilt through M4 callbacks; evaluation as a separate artifact | A separate database (duplicated store, backup and migration paths); storing derived text instead of ids (duplicates evidence, enlarges the privacy surface); vector/graph columns (no requirement, new dependency); automatic retention at startup (silent deletion); global age-based retention (one configuration silently deletes another audience's rows); foreign-key cascade from an audience table that does not exist; extending the frozen `RecordedRunV1` | ADR-009 | A semantic-retrieval requirement, an audience table, or a schema-version change is approved |

## 5. What this comparison does not establish

- No candidate is compared by measured latency, cost, token use or quality; the G4 evaluation table does
  not exist and the gate was not run.
- The ADR decisions are the records' own claims. This file does not re-adopt them, and it does not
  extend any owner's approval.
- The permission model in [`permission-model.md`](permission-model.md) is a D2.6/D3 proposal under
  review; it is not part of the storage or evaluation choices above and does not activate a gate.
