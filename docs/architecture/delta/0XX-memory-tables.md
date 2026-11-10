# Delta-0XX — Memory-tables foundation (X02/X03/X04/X07/X08)

Change record for the memory-tables ADR (number pending allocation in #25; do not publish under this
name). Date: 2026-11-10. Branch `m6-memory-foundation`, local only.

## Change (against `main` `e9e7e7b`)

- **ADDED** `src/storage/memory-store.ts` — `createMemoryStore` over six tables: idempotent
  episode/topic upserts, filtered reads, the durable projection cursor (monotonic), rebuild through
  M4’s callbacks, insert-once audience/owner attribution, optimistic state writes, explicit audience
  deletion, opt-in retention and audience-scoped export.
- **ADDED** `src/evaluation/memory-bench.ts` — separate memory report: recall@k, precision@k,
  labelled answer accuracy, tokens per turn, p95 latency, excluded count; `unassessed`/`not-run`.
- **ADDED** `test/offline/m6-memory-store.test.ts`, `test/offline/m6-memory-bench.test.ts` — 17 cases.
- **MODIFIED** `src/storage/sqlite/migrations.ts` — schema **v3**: the six tables and indexes.
- **MODIFIED** `src/storage/index.ts` — export the store.
- **MODIFIED** `package.json` — the two suites join `test:m6`.
- **MODIFIED** `docs/ai-use-log.yaml` — two supervised-session entries.
- **MODIFIED** `docs/architecture/memory-design.md` — cursor, owner/consent, derived memory, state,
  retention/deletion; the two recorded limits.
- **MODIFIED** `docs/architecture/trace-matrix.md` — five rows, **ids pending**.
- **FROZEN and unchanged:** `RecordedRunV1`, `src/contracts/app/**`, the `events` and `deliveries`
  schemas (append-only evidence).
- **OBSOLETED:** none.

## Why

M4’s #147/#148 ask for durable derived memory, a restart-safe cursor, owner attribution, character
state, privacy/deletion/retention and a memory evaluation harness. The code is additive; the only
policy change is that owner identity and deletion now exist **behind explicit, consenting, operator
calls**, replacing the earlier “not in v0.2” wording.

## Verification

- memory store **11**, memory bench **6**; `test:m6` **200/200** (16 files); trace **41/41**;
  readiness **45/45**; full **1558/1558** (76 files); `pnpm verify` exit 0; G6 pass.
- Mutations: projection guard, topic clear, state attribution, audience binding, precision math — each
  turned its own test red.

## Open items

- The ADR number is **not allocated**; #25 has the request. The ADR and this Delta use `0XX` and must
  be renamed when M5 allocates the number.
- The design and trace updates are local; they must merge with the ADR number.
- Operator rebuild entry and source-level cascade are recorded limits, not implemented.
- No case or invariant ID is allocated; no threshold or acceptance claim is added.
