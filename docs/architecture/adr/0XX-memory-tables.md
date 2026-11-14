# ADR-0XX — Memory-tables foundation (X02/X03/X07/X08)

Status: **proposal — number pending allocation in #25; do not merge under this name. A draft PR
carries it for M4/M5 review.**
Date: 2026-11-10. Owner: M6 (storage/evaluation). Affected reviewers: **M4** (derived/state
semantics), **M5** (consent, durability, operator surface).

Related: #147, #148 · `docs/architecture/memory-design.md` · ADR-003/004/005 · NFR-03, NFR-05 ·
#25, #107.

Invariants: **no invariant row governs this mechanism.** `INV-06` enforces the in-process projection
bookmark in `src/storage/memory-projection.ts`, `INV-10` enforces config validation, `INV-11` the
migration runner and `INV-16` evaluation accounting. Citing them here for the durable cursor would
over-claim, so this ADR does not. A memory-store invariant is requested in #25; until it exists, the
cursor and owner rules are enforced only by the tests named in the trace rows.

## Context

M4 proposed six durable capabilities for the memory system: derived episodes/topics (X02), a
persistent projection cursor (X02), audience-bound owner attribution (X03), character state (X04),
privacy/deletion/retention (X08) and a memory evaluation harness (X07). The accepted design currently
says the projection cursor is in-process, automatic cross-session memory is out of v0.2, and v0.2
deletes no evidence. The implementation in `src/storage/memory-store.ts` and
`src/evaluation/memory-bench.ts` is tested and carried on a draft PR (not merged); this ADR records the decision it
implements and the policy change it requires.

X04's `session_state` storage ships here (D1, D4). X04's **audience-level latest-state seed** is out of
scope: it has no decision, no API and no test in this change, and waits on #151 and M4's
`CharacterState` mapping. It is therefore absent from the title and from the trace rows' claims.

## Decision

### D1 — Six tables, no contract change

Schema v3 adds `derived_episode`, `derived_topic`, `projection_state`, `session_audience`,
`delivery_owner` and `session_state`. `RecordedRunV1`, `src/contracts/app/**` and the `events` /
`deliveries` tables are unchanged. Derived rows store ids, never copied text; no vector or graph
columns.

### D2 — The cursor is durable, monotonic and extractor-scoped

`createMemoryStore` persists `applied_seq` and `extractor_version` per session. An incremental
`writeProjection` refuses a non-increasing value (`stale`) and refuses a different extractor version
(`version-mismatch`), so a restart resumes and a cursor cannot rewind. A rebuild under the same
extractor version writes `max(persisted, rebuild_result)`, so a smaller event set cannot lower the
cursor. A rebuild under a new extractor version rebuilds the derived rows and the cursor together under
that version; carrying the old cursor across a semantic change would break “rebuild equals
incremental” in the other direction. A derived episode whose `extractorVersion` differs from the
rebuild argument throws inside the transaction, so a row and its cursor can never disagree. Evidence
tables are unchanged. The `MemoryProjectionPort` itself
remains in-process; the durable cursor is a storage helper for callers that need restart continuity.

### D3 — Owner identity only on an explicit consenting write

`recordSessionAudience` is insert-once: a different binding returns `conflict` and the original
timestamp is preserved. `recordDeliveryOwner` now enforces consent at the storage boundary: no binding
or an anonymous binding returns `unowned`; a binding whose `consent` is `0` returns `refused`; a
different bound owner returns `conflict`; only a consenting binding writes an owner row. The refusal is
data, never retried into a wrong attribution. `delivery_owner.created_at_ms` is retention metadata, not
prompt input or evidence. A session first bound anonymously cannot later acquire a consenting audience;
that v1 insert-once limit is deliberate.

### D4 — State is per session and never re-attributed

`session_state` is keyed by session. The audience binding is a property of the session (M4 review,
2026-11-13): a first non-null write may establish it, a later null write keeps it, and a write naming
a **different non-null** audience returns `conflict` and writes nothing. Writes carry an `expectedVersion`; a stale version returns `conflict` and never
overwrites. M5 decides whether to drop the conflicting write.

### D5 — Deletion and retention are explicit, never automatic

`deleteAudience` and `deleteOlderThan` run only when an operator calls them; there is no startup
deletion and no default retention period. Retention applies to the derived/owner/state/audience tables
only; `events` and `deliveries` are append-only and are never deleted by this API. Tests assert that
both deletion calls leave the events and deliveries counts unchanged, and that constructing a store
performs no deletion. `deleteAudience` is audience-targeted; `deleteOlderThan` is **global by age**.
“Retention never removes another audience’s rows” therefore needs M5/M4 to confirm whether retention is
global-by-age or per-audience; the current code implements the former. Retraction (a semantic marker
with evidence retained) stays separate from deletion (physical removal).

### D6 — Derived memory is rebuilt through M4’s callbacks

`rebuildDerived` clears the derived tables and replays events through M4-supplied `deriveEpisodes`
and optional `deriveTopics` functions. Under the same `extractor_version` it writes
`max(persisted, lastSeq)`, so a smaller event set cannot lower the cursor; under a new version it
rebuilds the rows and resets the cursor under that version. Every derived episode's `extractorVersion` must equal the rebuild
argument; a mismatch throws and rolls back. M6 does not invent episode or topic semantics.

### D7 — Evaluation is a separate artifact

`runMemoryBench` writes `memoryReportVersion: 1` (JSON + summary), not `RecordedRunV1`: the frozen
selection-run schema has no recall/precision/accuracy fields. The report carries identity fields (QA
set id + SHA-256, snapshot, chunking, embedding, retrieval and LLM identity) beside the metrics, so two
runs are comparable only under named conditions. `precision@k` divides by
`min(k, retrievedCount)`, not by `k`, and each probe records `retrievedCount`; an empty retrieval has
`null` precision, never a fabricated zero. `compareMemoryReports` gates recall, precision and labelled
answer accuracy; tokens per turn and p95 latency are informational. `unassessed` and `not-run` remain
distinct; no zero substitution.

## Consequences

- The design note must be updated: the cursor is durable and extractor-version-scoped for store
  callers; owner identity is permitted only on a **consenting** binding, and `durable` remains M4’s
  cross-session recall gate, not the storage owner gate; derived/owner/state rows can be deleted
  explicitly.
- M5 must enforce its own durability/consent gate and own the operator entry (`forgetAudience`,
  retention call, audience export); the storage boundary refuses a non-consenting owner write.
- M4 must supply `deriveEpisodes`/`deriveTopics`, the state projection and the **real memory corpora**.
  Until those corpora exist, X07 is fixture-only and must not be reported as a quality result.
- The evidence tables remain append-only; a source-level cascade is **deferred** until the NFR-05
  deletion policy exists.
- No case or invariant ID is allocated; trace rows use “ids pending” until #25 allocates them.

## Alternatives considered

- **Separate database for memory tables** — rejected: duplication of the store, backup and migration
  path for no benefit at this scale.
- **Store derived text instead of ids** — rejected: duplicates evidence and enlarges the privacy
  surface.
- **Vector/graph columns** — rejected: no requirement, and a new dependency.
- **Automatic retention at startup** — rejected: silent deletion; the policy is explicit and
  operator-driven.
- **Foreign-key cascade from a parent audience table** — rejected for now: there is no audience table
  and the explicit delete transaction is simpler to explain and test.
- **Extend `RecordedRunV1` for memory metrics** — rejected: frozen shared schema; a separate artifact
  is additive.

## Limits and debt

- **Operator rebuild entry** — not built; the store exposes the API and M5 owns the operator surface.
  Trigger: M4’s derive functions exist and an operator needs the command.
- **Source-level cascade** — not built; derived rows are deleted by audience, not by deleted source.
  Trigger: the formal NFR-05 deletion policy.
- **Retention scheduling** — deliberately absent; the operator call is the only path.
- **M4 derive adapter (open)** — #159 publishes `deriveEpisode`/`deriveEpisodes`/`deriveTopics` and
  the corpora, but the functions are not directly pluggable into `rebuildDerived`: they take admitted
  `DeriveSourceTurn` records and an `audienceId`, do not carry `createdAtMs`/`updatedAtMs`, and stamp
  their own `DERIVED_EXTRACTOR_VERSION`. An M4-owned adapter at M5's composition boundary is required;
  X02 "rebuild equals incremental" remains unaccepted until it exists.

## Re-open triggers

- The NFR-05 retention/deletion policy is recorded (#107).
- M4 changes the derived/state semantics or the corpora.
- A future release deletes or rewrites evidence rows.
- Multi-tenant identity or a separate audience table is introduced.

## Traceability

FR-06 · NFR-03 · NFR-05 · ADR-003/004/005 · #147/#148 · #25/#107.

No invariant row governs `src/storage/memory-store.ts` or `src/evaluation/memory-bench.ts`. INV-06,
INV-10, INV-11 and INV-16 cover `memory-projection.ts`, `config.ts`, the migration runner and
evaluation accounting respectively; they are not claimed here. A dedicated invariant and the case IDs
are pending #25.
