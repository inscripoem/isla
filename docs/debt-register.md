# Debt register

Status: under review. Owner: R3 / M6 tooling (D4); all owners contribute. Tracked across the AI-era
categories: prompt rot, hallucinated dependencies, untouchable code, hidden dependencies,
agent-induced bloat, evaluation debt, guardrail debt, human/cognitive debt.

| ID | Category | Debt | Impact | Owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| DEBT-01 | evaluation debt | NFR thresholds (latency/quality/cost) are TBD; no measured baseline | gate G4 cannot run | M3/M4/M5 | pending team measurements |
| DEBT-02 | guardrail debt | G1 (test approval) and G4 (semantic eval) are documented/scaffolded, not fully blocking | partial gate coverage | R3/M6 | next gate increment |
| DEBT-03 | hidden dependency | `persona_version` is persisted `NULL` until C6 carries it (M4 interop) | version-aware trimming degrades after restart | M4/M6 | decide at issue #22 item 3 |
| DEBT-04 | evaluation debt | trace fitness functions parse Markdown tables | fragile to format drift | R3/M6 | revisit machine-readable sources + generator |
| DEBT-05 | untouchable code | `src/contracts/app/*` frozen | coordination cost | M5 | by design (ADR-006) |
| DEBT-06 | agent-induced bloat | multiple stacked PRs pending merge (#9/#23/#24) | rebase churn | team | sequence merges |
