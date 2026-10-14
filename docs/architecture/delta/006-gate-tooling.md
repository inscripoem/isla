# Delta Specification 006 — Governance gate tooling

Status: under review (M6). Date: 2026-10-14. ADR: ADR-006. Invariants: INV-12. Cases: C-34, C-35.
Revision type: ADD.

## OBSOLETED

None.

## ADDED

| Item | Location | Declared callers |
| --- | --- | --- |
| Markdown table parser (`parseTables`, `columnIndex`) | `src/evaluation/markdown.ts` | `trace-fitness.ts` |
| Traceability fitness functions (`collectTraceViolations`, `nodeTraceFs`) | `src/evaluation/trace-fitness.ts` | CI gate; `test:trace` |
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
| `docs/architecture/invariants.md` | **register completed**: added INV-01..03 (M5), INV-11 and INV-12/13 rows (gaps the tool found) |
| `README.md` | documents the blocking-gate design (D7) |
| `docs/architecture/adr/006-gate-tooling.md` | D2 updated with the exact CI gate steps; D3 (governance documents) added |
| `src/evaluation/trace-fitness.ts` | frozen check also validates that frozen paths exist |

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
