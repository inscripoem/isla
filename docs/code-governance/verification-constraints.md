# Verification constraints

Status: under review. Owned by M6. Date: 2026-10-12.

The rules the verification agent applies and the QA records the team maintains.

## Rules

1. Every fit criterion has at least one test.
2. Every invariant has at least one test that **fails when the invariant is violated**
   (a test that always passes proves nothing).
3. Every test references the requirement or invariant it verifies.
4. Every new round of work runs all previous rounds' test suites with **zero regressions**.

## Three-tier verification (gated; no skipping)

| Tier | Applies | Command / evidence |
| --- | --- | --- |
| 1 — Structural | imports, module boundaries, permissions, architectural fitness functions | `pnpm test:readiness` (`contracts`, `requirements`, `boundaries`); `pnpm lint`; `pnpm typecheck` |
| 2 — Regression | all prior suites pass | `pnpm test` (all offline suites) |
| 3 — Behavioral | quality thresholds (faithfulness/relevance; zero safety escapes) | pending (semantic eval; provider access required) — NFR-03 |

## M6 coverage map (requirement/invariant → case → test)

| Invariant / requirement | Case | Test that would fail if violated |
| --- | --- | --- |
| INV-04 (session-scoped identity/sequence uniqueness) | C-18, C-23, C-39, C-40, C-41, C-43, C-44, C-49 | `m6-storage.test.ts`; conformance `append-duplicate`, `append-changed-content`, `append-seq-unique`, `append-session-scoped-identity`; conflicting commit reports `conflict` on both sides; canonical content equality (key order irrelevant, array order significant); a non-JSON payload is rejected with `unsupported_payload` (incl. sparse arrays) |
| INV-05 (atomic delivery + event) | C-19, C-38, C-42 | `m6-storage.test.ts::INV-05` (failed commit persists nothing; a later unpublishable mutation leaves no partial state); `m6-sqlite-backend.test.ts` (batch rollback); conformance `atomic-failure-reported`, `atomic-no-partial-mutation` |
| INV-06 (projection no gap / idempotent) | C-20 | `m6-storage.test.ts::INV-06`; conformance `projection-no-gap-claim`, `projection-idempotent` |
| INV-07 (record isolation) | C-24, C-29 | `m6-storage.test.ts` (isolation tests); conformance `input-isolation`, `read-isolation` → runs over **both** in-memory and SQLite |
| INV-08 (history ordering) | C-25, C-29 | `m6-storage.test.ts` (ordering test); conformance `history-ordered` → over **both** backends |
| INV-09 (delivery attribution and consistent evidence) | C-46, C-47 | `m5-attribution.test.ts` (capture, persistence and reconstruction ordering); conformance `delivery-invalid-combination:*`, `delivery-invalid-event:*`, `delivery-correlation:*`, `delivery-provenance:*`; negative adapters `createCombinationNormalizingEventStore`, `createProvenanceIgnoringEventStore` |
| INV-10 (config + schema version validated) | C-26, C-27 | `m6-sqlite.test.ts` (config + migrations) |
| INV-11 (migration recoverable) | C-27, C-28 | `m6-sqlite.test.ts` (backup before apply; rollback on failure) |
| FR-06 (SQLite conformance) | C-29 | `m6-sqlite-backend.test.ts` (conformance suite over SQLite) |
| FR-06 (SQLite persistence/reopen) | C-30 | `m6-sqlite-backend.test.ts` (reopen + isolation) |
| FR-06 (delivery terminal outcome persisted) | C-31 | `m6-sqlite-backend.test.ts` (terminal outcome for recovery) |
| INV-12 (restart restores only confirmed history; no replay) | C-32, C-33 | `m6-recovery.test.ts` (recovery view; restart + isolation) |
| FR-06 (history excludes non-delivered) | C-17, C-21 | `m6-storage.test.ts` (confirmed-history tests); conformance `history-fully-delivered-only` |
| FR-06 (JSONL export carries `versions`) | C-22 | `m6-storage.test.ts` (version attribution) |
| FR-06 (in-memory vs SQLite agreement) | C-45 | `m6-sqlite-backend.test.ts` (cross-backend integration: state, export, history, payload rejection) |
| FR-06 / C-12 (replay isolation) | C-12 | `m6-storage.test.ts` (replay-isolation test) |

`docs/req/case-registry.yaml` links each implemented case to its verifier file and test string; the
readiness suite (`src/evaluation/requirements-registry.ts` via `test/offline/requirements.test.ts`)
rejects a missing file or absent test string.

## Honest limitations

- Fixtures do not prove live providers, browser audio or durable SQLite recovery.
- Fault injection for storage failure is supplied by the **test adapter** (READINESS-KITS:26); the
  production API exposes no failure switch (ADR-001).
- Tier 3 behavioral thresholds and full-course gates remain pending.
