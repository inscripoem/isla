# Delta-0XX — Memory-tables foundation (X02/X03/X04/X07/X08)

Change record for the memory-tables ADR (number pending allocation in #25; do not publish under this
name). Date: 2026-11-10. Branch `m6-memory-foundation`, local only.

## Change (against `main` `e9e7e7b`)

- **ADDED** `src/storage/memory-store.ts` — `createMemoryStore` over six tables: idempotent
  episode/topic upserts, filtered reads, the durable extractor-version-scoped projection cursor
  (same-version max; version change resets), rebuild through M4’s callbacks, consent-enforced
  insert-once audience/owner attribution with `created_at_ms` metadata, optimistic state writes,
  explicit audience deletion, opt-in retention and audience-scoped export.
- **ADDED** `src/evaluation/memory-bench.ts` — separate memory report: recall@k, precision@k
  (`min(k, retrievedCount)`), labelled answer accuracy, identity fields, tokens per turn, p95 latency,
  excluded count; `unassessed`/`not-run`; recall/precision/accuracy comparison.
- **ADDED** `test/offline/m6-memory-store.test.ts`, `test/offline/m6-memory-bench.test.ts` — 29 cases (19 store, 10 bench).
- **MODIFIED** `src/storage/sqlite/migrations.ts` — schema **v3**: the six tables and indexes.
- **MODIFIED** `src/storage/index.ts` — export the store.
- **MODIFIED** `package.json` — the two suites join `test:m6`.
- **MODIFIED** `docs/ai-use-log.yaml` — two supervised-session entries.
- **MODIFIED** `docs/architecture/memory-design.md` — cursor/version, owner/consent, derived memory,
  state, retention/deletion, evaluation identity; the recorded limits.
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

- memory store **19**, memory bench **10**; `test:m6` **215/215** (16 files); trace **41/41**;
  readiness **47/47**; full **1578/1578** (76 files); `pnpm verify` exit 0; G6 pass.
- Mutations: projection guard, topic clear, state attribution, audience binding, precision math — each
  turned its own test red.

## Open items

- The ADR number is **not allocated**; #25 has the request. The ADR and this Delta use `0XX` and must
  be renamed when M5 allocates the number.
- The design and trace updates are local; they must merge with the ADR number.
- Operator rebuild entry and source-level cascade are recorded limits, not implemented.
- Retention scope is still open: `deleteAudience` is audience-targeted, but `deleteOlderThan` is
  global by age. “Retention never removes another audience’s rows” needs M5/M4 to confirm whether
  retention is global-by-age or per-audience.
- X02 integration waits on M4 `deriveEpisode`/`deriveTopics`; X07 real acceptance waits on M4’s
  `test/fixtures/memory/` corpora. The current X07 tests are fixture-level only and claim no quality
  result.
- No case or invariant ID is allocated; no threshold or acceptance claim is added.
