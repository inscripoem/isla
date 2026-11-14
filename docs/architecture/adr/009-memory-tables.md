# ADR-009 — Memory-tables foundation (X02/X03/X07/X08)

Status: **under review (M6). ADR-009 was reserved by M5 in #25 on 2026-11-14; the design review stays
with M6 and M4. Do not merge under another number. X04's audience-level seed stays excluded.**
Date: 2026-11-10. Decision updated: 2026-11-14 (M5 resolved the durable/consent conflict and the
retention scope). Owner: M6 (storage/evaluation). Affected reviewers: **M4** (derived/state
semantics), **M5** (consent, durability, operator surface).

Related: #147, #148 · #159 · `docs/architecture/memory-design.md` · ADR-003/004/005 · NFR-03, NFR-05 ·
#25, #107.

Invariants: **INV-17** (M6, allocated by M5 in #25 on 2026-11-14) covers this mechanism: the cursor is
version-scoped and non-decreasing, derived rows and the cursor share the extractor version, owner
attribution is gated, a different state audience is a conflict, and deletion/retention never touch
evidence. Cases **C-75…C-78** are allocated to the store. `INV-06`, `INV-10`, `INV-11` and `INV-16`
cover other components and are not claimed here.

M5 resolved the recorded conflict on 2026-11-14: the storage boundary refuses an owner or derived
write unless the session binding has both `consent = true` and `durable = true`. `durable` also remains
M4's cross-session recall gate; session-scoped state may still be kept. Retention is per audience. The
conflict is closed and `C-76` is implemented.

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

### D3 — Owner and derived writes require a durable consenting binding

`recordSessionAudience` is insert-once: a different binding returns `conflict` and the original
timestamp is preserved. `recordDeliveryOwner` enforces M5's decision at the storage boundary: no
binding or an anonymous binding returns `unowned`; a binding whose `consent` or `durable` flag is `0`
returns `refused`; a different bound owner returns `conflict`; only a durable, consenting binding writes
an owner row. The refusal is data, never retried into a wrong attribution. `upsertEpisode` and
`upsertTopic` apply the same gate and return `DerivedWrite` (`recorded`/`refused`): an episode needs a
durable consenting binding for its session, and a non-null audience must equal that binding; a topic
needs at least one durable consenting binding for its audience. `durable` stays M4's cross-session
recall gate as well; the storage boundary is fail-closed so no row exists that M4 could never recall.
`delivery_owner.created_at_ms` is retention metadata, not prompt input or evidence. A session first
bound anonymously cannot later acquire a consenting audience; that v1 insert-once limit is deliberate.

### D4 — State is per session and never re-attributed

`session_state` is keyed by session. The audience binding is a property of the session (M4 review,
2026-11-13): a first non-null write may establish it, a later null write keeps it, and a write naming
a **different non-null** audience returns `conflict` and writes nothing. Writes carry an `expectedVersion`; a stale version returns `conflict` and never
overwrites. M5 decides whether to drop the conflicting write. Session state is **session-scoped and
exempt** from the durable/consent gate: a non-durable or non-consenting binding may still keep state,
but that state is not cross-session recall material.

### D5 — Deletion and retention are explicit, never automatic

`deleteAudience` and `deleteOlderThan` run only when an operator calls them; there is no startup
deletion and no default retention period. Retention applies to the derived/owner/state/audience tables
only; `events` and `deliveries` are append-only and are never deleted by this API. Tests assert that
both deletion calls leave the events and deliveries counts unchanged, and that constructing a store
performs no deletion. Both calls are audience-targeted: `deleteAudience(audienceId)` removes the rows
carrying that `audience_id`, and `deleteOlderThan(audienceId, days, nowMs)` removes those rows older
than the cutoff (M5 decision, 2026-11-14). There is no global by-age delete; an operator who wants a
whole-store cleanup enumerates audiences. This keeps retention consistent with audience-scoped export
and delete and stops one configuration from silently deleting another audience's rows. Retraction (a
semantic marker with evidence retained) stays separate from deletion (physical removal).

### D6 — Derived memory is rebuilt through M4’s callbacks

`rebuildDerived` clears the derived tables and replays events through M4-supplied `deriveEpisodes`
and optional `deriveTopics` functions. Under the same `extractor_version` it writes
`max(persisted, lastSeq)`, so a smaller event set cannot lower the cursor; under a new version it
rebuilds the rows and resets the cursor under that version. Every derived episode's `extractorVersion` must equal the rebuild
argument; a mismatch throws and rolls back. Before replay it requires every session in the rebuild to
have a durable consenting binding, and every topic audience to have one; a missing binding throws and
the transaction rolls back, so a rebuild cannot reintroduce rows the incremental path would refuse. M6
does not invent episode or topic semantics.

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
  callers; owner and derived rows are permitted only under a **durable and consenting** binding, while
  session state remains session-scoped; `durable` is also M4’s cross-session recall gate;
  derived/owner/state rows can be deleted explicitly per audience.
- M5 owns the operator entry (`forgetAudience`, per-audience retention call, audience export). The
  storage boundary independently refuses a non-durable or non-consenting owner/derived write, so M5’s
  runtime gate and the store agree rather than one relying on the other.
- M4 must supply `deriveEpisodes`/`deriveTopics`, the state projection and the **real memory corpora**.
  Until those corpora exist, X07 is fixture-only and must not be reported as a quality result.
- The evidence tables remain append-only; a source-level cascade is **deferred** until the NFR-05
  deletion policy exists.
- `C-75` remains **pending** because its rebuild-equality half needs M4's derive rules through the
  composition adapter; `C-76`, `C-77` and `C-78` are implemented and registered.

## Alternatives considered

- **Separate database for memory tables** — rejected: duplication of the store, backup and migration
  path for no benefit at this scale.
- **Store derived text instead of ids** — rejected: duplicates evidence and enlarges the privacy
  surface.
- **Vector/graph columns** — rejected: no requirement, and a new dependency.
- **Automatic retention at startup** — rejected: silent deletion; the policy is explicit and
  operator-driven.
- **Global by-age retention** — rejected by M5: one configuration would silently delete another
  audience’s rows; the operator enumerates audiences instead.
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
- **Null-audience derived rows** — `upsertEpisode` accepts `audienceId: null` under a durable
  consenting session binding; both delete paths filter on `audience_id`, so such a row is reachable by
  session but is not removed by an audience delete or retention call. Trigger: M4 decides whether a
  derived episode must inherit the session audience, and the delete path follows that decision.
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

FR-06 · NFR-03 · NFR-05 · INV-17 · C-75…C-78 · ADR-003/004/005 · ADR-009 · #147/#148 · #159 · #25/#107.

INV-17 and the four cases are registered in `docs/architecture/invariants.md` and
`docs/req/case-registry.yaml`. `C-75` is registered as **pending**, not implemented;
`C-76`, `C-77` and `C-78` are implemented.
