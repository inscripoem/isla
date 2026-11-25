# Architecture candidate comparison (qualitative)

Status: **proposal, under review.** Owner: M5 coordination. Revision 2026-11-25.4. Base:
`main` `dba25e0`. The qualitative comparison covers the storage, governance, evaluation and memory
sub-decisions already recorded in the ADRs, plus the system-level and AI-context candidates added for
D2.2.

## 1. Scope and relationship to the G4 evaluation table

This file consolidates the alternatives that the existing architecture decision records and the
system-level design considered, so a reviewer can compare the choices in one place. It is
**qualitative**: it states which
candidate was chosen and why the others were rejected, with a pointer to the record that owns the
decision. It contains **no measurements, scores, latencies or pass rates**.

Measured results belong in `docs/architecture/evaluation-table.md`, which G4 reserves for claims
carrying fixed conditions and observed values. A one-attempt pilot table now exists
(`pilot-selection-local-magpie-20261125`) and passes G4's condition scan, but it is **not** a threshold
baseline and no semantic comparison is claimed here.

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
| Evaluation bench | One provider-free bench in two halves: `src/evaluation/metrics.ts` (record and aggregation) and `src/evaluation/comparison.ts` (the runner), with the performer injected; every attempt recorded; missing values stay unknown; first-attempt and later windows separate; nearest-rank percentiles without a dependency | A statistics dependency (supply-chain and review cost for one function); a test runner's benchmark mode (measures the runner, cannot express cancellation or missing usage); reusing the storage fault seam (measures the storage port, not the performer); dropping failed attempts (flattering numbers that hide failures); estimating missing cost from prompt size (fabricates a number) | ADR-007 | A statistical method beyond nearest-rank is required, or the bench must report runner-level cost |
| Prepared-input provenance | A separate, run-bound companion artifact bound by position and content; explicit per-input status; refusal rather than a partial join | `schemaVersion: 2` on the run record (changes a frozen shared artifact); inference by text or order (unsound when inputs share text or a batch stops early); restating fixed conditions (two copies drift); `runId` only (cannot separate attempts sharing a case and variant); `null` for a known-empty set (destroys stratification); promoting a missing link to `exact` (unknown is not a pass) | ADR-008; INV-16 | The run record itself may be versioned with owner review |
| Memory tables | Six tables, no contract change; a durable monotonic extractor-scoped cursor; owner and derived writes behind a durable consenting binding; per-session state; explicit operator-driven deletion/retention; derived memory rebuilt through M4 callbacks; evaluation as a separate artifact | A separate database (duplicated store, backup and migration paths); storing derived text instead of ids (duplicates evidence, enlarges the privacy surface); vector/graph columns (no requirement, new dependency); automatic retention at startup (silent deletion); global age-based retention (one configuration silently deletes another audience's rows); foreign-key cascade from an audience table that does not exist; extending the frozen `RecordedRunV1` | ADR-009 | A semantic-retrieval requirement, an audience table, or a schema-version change is approved |

## 5. What this comparison does not establish

- No candidate is compared by measured latency, cost, token use or quality. The pilot table is one
  attempt, not a comparative measurement; Tier 3 semantic evaluation is not run.
- The ADR decisions are the records' own claims. This file does not re-adopt them, and it does not
  extend any owner's approval.
- The permission model in [`permission-model.md`](permission-model.md) is a D2.6/D3 proposal under
  review; it is not part of the storage or evaluation choices above and does not activate a gate.

## 6. System-level architecture candidates

This section compares the whole runtime shape, not the storage or evaluation sub-decisions in §3–§4.
The labels are **qualitative**; no score, latency, cost or pass rate is claimed.

| Criterion | A: cloud multi-service | B: direct-provider monolith | C: local modular monolith (chosen) | D: multi-agent orchestration |
| --- | --- | --- | --- | --- |
| D1 deterministic authority (critical) | Partial — service boundaries add a second policy surface | **Weak** — model path holds authority | **Strong** — M5 is the single live authority | Weak unless a deterministic supervisor duplicates C |
| D2 evidence/durability (critical) | Strong, but depends on a remote service | Partial — no shared evidence boundary | **Strong** — M6 owns SQLite/replay/recovery | Partial — per-agent state fragments |
| Local privacy / no cloud account | **Weak** — data leaves the host | Strong | **Strong** | Strong, but coordination state grows |
| Adapter replaceability | Strong | **Weak** — direct SDK calls | **Strong** — ports C1–C7 | Strong but more peers |
| Local operability | Weak — deployment/auth/network | **Strong** | **Strong** — one process + browser | Partial — more moving parts |
| Testability offline | Partial — services need doubles | Partial | **Strong** — fixtures + conformance | Partial — coordination doubles |
| Implementation complexity | High | **Low** | Medium | High |
| Fit to current scope | Poor — no multi-user requirement | Poor — safety boundary absent | **Chosen** | Poor — single-character product |

**Decision:** C. A and B fail a critical driver; D adds coordination for a product that has one
character and one local operator. The modular monolith keeps the option to extract services later,
which is a new ADR rather than a silent refactor.

**Reopen triggers:** a remote multi-user requirement; a second consumer outside the process; a
platform requirement that rules out local SQLite; a boundary check that cannot be enforced without a
service boundary.

## 7. AI context candidates

This compares how the per-turn prompt is bounded. The implemented detail is in
[`context-assembly.md`](context-assembly.md); the proposed decision is in the system ADR §8.

| Criterion | A: flat prompt + provider truncation | B: layered character budget + deterministic trim (current) | C: layered token cap + compaction + reinjection (proposed) |
| --- | --- | --- | --- |
| Preserve identity/standing constraints/current task (critical) | **Weak** — truncation can remove them | **Strong** — outside trim loops | **Strong by design** — immutable envelope re-injected |
| Bounded prompt | Weak — provider limit is the only bound | **Strong** — hard character cap | Strong — token cap + hard stop |
| Token accounting | None | Approximate diagnostic only | Real tokenizer + measured margin |
| Conversation continuity | Unbounded or lost | Deterministic drop + rollup | Summary + drop + rollup |
| Implementation cost | **Low** | Medium | High — tokenizer, summary quality, new tests |
| Current status | rejected | **implemented** | proposal; no value or test result |

**Decision now:** B. It is the only shipped design, it preserves the fixed layers, and it records every
loss. A is rejected because a provider-side truncation can silently remove a boundary. C is the next
candidate **only if** a measured token baseline and M4 review justify it; the 4,096/70%/90% values in
the ADR are proposed, not agreed.

**Reopen triggers:** a provider context window that cannot fit the current character cap; measured
prompt overflow; a quality failure attributable to dropped history; M4 approval of a compaction design.
