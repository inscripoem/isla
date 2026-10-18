# Delta Specification 006 — Governance gate tooling

Status: under review (M6). Date: 2026-10-14. ADR: ADR-006. Invariants: INV-13. Cases: C-34, C-35, C-37.
Revision type: ADD.

## OBSOLETED

None.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| Markdown table parser (`parseTables`, `columnIndex`) | `src/evaluation/markdown.ts` | `trace-fitness.ts` |
| Traceability fitness functions (`collectTraceViolations`, `nodeTraceFs`) | `src/evaluation/trace-fitness.ts` | CI gate; `test:trace` |
| Verified main-baseline restoration (`readRestorationContext`, `verifyFrozenRestoration`, `nodeRestorationGit`) | `src/evaluation/frozen-restoration.ts` | `trace-fitness.ts`; CI trace gate |
| Traceability tests + `test:trace` script | `test/offline/trace-fitness.test.ts`, `package.json` | — |
| AI-use-log gate (`collectAiUseLogViolations`) | `src/evaluation/ai-use-log-gate.ts` | CI gate G6; `gate:ai-use-log` |
| G6 tests | `test/offline/ai-use-log-gate.test.ts` | — |
| Named blocking CI gates | `.github/workflows/ci.yml` | — |
| Frozen-path manifest | `docs/architecture/frozen.yaml` | trace fitness functions |
| PR handoff template | `.github/PULL_REQUEST_TEMPLATE.md` | — |
| QA records | `docs/review-memo.md`, `docs/debt-register.md`, `docs/bug-diary.md` | — |

## MODIFIED

| Item | Change |
| --- | --- |
| `docs/architecture/invariants.md` | **register completed**: added INV-01..03 (M5), INV-11 and INV-12/13 rows (gaps the tool found); added an explicit **Owner** column (M5/M6) |
| `docs/architecture/trace-matrix.md` | added an explicit **Owner** column so shared rows stay classifiable |
| `docs/req/{requirements.yaml,case-registry.yaml,trace.en.md}` | INV-13 acceptance + case **C-37** (owner indicators required) |
| `README.md` | documents the blocking-gate design (D7) |
| `docs/architecture/adr/006-gate-tooling.md` | D2 updated with the exact CI gate steps; D3 (governance documents) added |
| `src/evaluation/trace-fitness.ts` | frozen check also validates that frozen paths exist; governed tables now require an Owner column; a changed frozen path is exempt only on a proven main-baseline restoration, including the actual regular file content/mode and strict UTF-8; provenance is logged |
| `.github/workflows/ci.yml` | pins the fetched default branch into `TRUSTED_BASELINE_SHA` for a feature-branch push only, and passes it (with the ref metadata) to the trace step |
| `test/offline/trace-fitness.test.ts` | added restoration cases over an injected git view: exact restore, changed blob, mode change, deletion, not-frozen-at-baseline, missing/non-ancestor/unresolvable baseline, self-approval, dirty worktree, canonical IDs, strict UTF-8/BOM handling, production adapter failures, and the feature-push-only gate |

## FROZEN

| Item | Reason |
| --- | --- |
| `src/contracts/app/*` | Shared contracts; unchanged |
| `src/storage/*` | Storage slice unchanged; the tooling is additive |
| Other modules (`src/runtime`, `src/console`, ...) | Other owners; untouched |

## Verification

Tier 1 structural: `pnpm typecheck`, `pnpm lint`, `test/offline/boundaries.test.ts`, `pnpm test:trace`.
Tier 2 regression: `pnpm test` (all prior suites).
Tier 3 behavioral: pending. Scope: sub-issue #17 (R3).
