# ADR-0XX — Memory-tables foundation (X02/X03/X04/X08)

Status: **draft — number pending allocation in #25; do not publish or merge under this name.**
Date: 2026-11-10. Owner: M6 (storage/evaluation). Affected reviewers: **M4** (derived/state
semantics), **M5** (consent, durability, operator surface).

Related: #147, #148 · `docs/architecture/memory-design.md` · INV-06, INV-10, INV-11, INV-16 ·
ADR-003/004/005 · NFR-03, NFR-05 · #25, #107.

## Context

M4 proposed six durable capabilities for the memory system: derived episodes/topics (X02), a
persistent projection cursor (X02), audience-bound owner attribution (X03), character state (X04),
privacy/deletion/retention (X08) and a memory evaluation harness (X07). The accepted design currently
says the projection cursor is in-process, automatic cross-session memory is out of v0.2, and v0.2
deletes no evidence. The implementation in `src/storage/memory-store.ts` and
`src/evaluation/memory-bench.ts` is local, tested and unpublished; this ADR records the decision it
implements and the policy change it requires.

## Decision

### D1 — Six tables, no contract change

Schema v3 adds `derived_episode`, `derived_topic`, `projection_state`, `session_audience`,
`delivery_owner` and `session_state`. `RecordedRunV1`, `src/contracts/app/**` and the `events` /
`deliveries` tables are unchanged. Derived rows store ids, never copied text; no vector or graph
columns.

### D2 — The cursor is durable and monotonic

`createMemoryStore` persists `applied_seq` per session. `writeProjection` refuses a non-increasing
value (`stale`), so a restart resumes and a cursor cannot rewind. The `MemoryProjectionPort` itself
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

`session_state` is keyed by session; `audience_id` is metadata and is set only when absent
(`COALESCE`). Writes carry an `expectedVersion`; a stale version returns `conflict` and never
overwrites. M5 decides whether to drop the conflicting write.

### D5 — Deletion and retention are explicit, never automatic

`deleteAudience` and `deleteOlderThan` run only when an operator calls them; there is no startup
deletion and no default retention period. Retention applies to the derived/owner/state tables only;
`events` and `deliveries` are append-only and are never deleted by this API. Retraction (a semantic
marker with evidence retained) stays separate from deletion (physical removal).

### D6 — Derived memory is rebuilt through M4’s callbacks

`rebuildDerived` clears the derived tables and replays events through M4-supplied `deriveEpisodes`
and optional `deriveTopics` functions, then writes the cursor from the last event. M6 does not invent
episode or topic semantics.

### D7 — Evaluation is a separate artifact

`runMemoryBench` writes `memoryReportVersion: 1` (JSON + summary), not `RecordedRunV1`: the frozen
selection-run schema has no recall/precision/accuracy fields. `unassessed` and `not-run` remain
distinct; no zero substitution.

## Consequences

- The design note must be updated: the cursor is durable for store callers, owner identity is
  permitted only on a durable+consent binding, and derived/owner/state rows can be deleted explicitly.
- M5 must enforce consent/durability and own the operator entry (`forgetAudience`, retention call,
  audience export).
- M4 must supply `deriveEpisodes`/`deriveTopics`, the state projection and the memory corpora.
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

## Re-open triggers

- The NFR-05 retention/deletion policy is recorded (#107).
- M4 changes the derived/state semantics or the corpora.
- A future release deletes or rewrites evidence rows.
- Multi-tenant identity or a separate audience table is introduced.

## Traceability

FR-06 · NFR-03 · NFR-05 · INV-06 · INV-10 · INV-11 · INV-16 · ADR-003/004/005 · #147/#148 · #25/#107.
