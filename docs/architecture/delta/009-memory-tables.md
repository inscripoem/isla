# Delta-009 — Memory-tables foundation (X02/X03/X07/X08)

Change record for ADR-009 (reserved by M5 in #25 on 2026-11-14; do not merge under another number). Date: 2026-11-10. Branch `m6-memory-foundation`, draft PR only, not merged.

## Change (against `main` `e9e7e7b`; rebased onto `f99e2f5`)

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
- **MODIFIED** `docs/ai-use-log.yaml` — seven supervised-session entries for this branch.
- **MODIFIED** `docs/architecture/memory-design.md` — cursor/version, owner/consent, derived memory,
  state, retention/deletion, evaluation identity; the recorded limits.
- **MODIFIED** `docs/architecture/trace-matrix.md` — five rows citing **ADR-009**, **INV-17** and **C-75…C-78**.
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

- **ADR-009 is reserved** (M5, #25, 2026-11-14) and the ADR and this Delta carry the number; the
  registration lands in one commit with INV-17 and C-75…C-78.
- The design and trace updates are local; they must merge with the ADR number.
- Operator rebuild entry and source-level cascade are recorded limits, not implemented.
- Retention scope is still open: `deleteAudience` is audience-targeted, but `deleteOlderThan` is
  global by age. “Retention never removes another audience’s rows” needs M5/M4 to confirm whether
  retention is global-by-age or per-audience.
- X02 integration waits on M4 `deriveEpisode`/`deriveTopics`; X07 real acceptance waits on M4’s
  `test/fixtures/memory/` corpora. The current X07 tests are fixture-level only and claim no quality
  result.
- **INV-17 and C-75…C-78 are allocated.** `C-77` (state audience conflict) and `C-78` (deletion and
  retention leave evidence untouched) are implemented. `C-75` stays pending because its
  rebuild-equality half needs M4's derive rules through the composition adapter. `C-76` stays pending
  on the `durable`/`consent` conflict recorded in the ADR and reported in #25.
