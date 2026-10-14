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
| B3 tests + `test:trace` script | `test/offline/trace-fitness.test.ts`, `package.json` | — |

## MODIFIED

| Item | Change |
| --- | --- |
| `docs/architecture/invariants.md` | **register completed**: added INV-01..03 (M5) and INV-11 rows (a gap the tool found) |

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
