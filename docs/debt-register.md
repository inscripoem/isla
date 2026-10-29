# Debt register

Status: under review. Owner: R3 / M6 tooling (D4); all owners contribute. Tracked across the AI-era
categories: prompt rot, hallucinated dependencies, untouchable code, hidden dependencies,
agent-induced bloat, evaluation debt, guardrail debt, human/cognitive debt.

| ID | Category | Debt | Impact | Owner | Disposition |
| --- | --- | --- | --- | --- | --- |
| DEBT-01 | evaluation debt | NFR thresholds (latency/quality/cost) are TBD; no measured baseline | gate G4 has no evaluation set to check (it reports not run, never a pass) | M3/M4/M5 | pending team measurements |
| DEBT-02 | guardrail debt | G1 (test approval) is a review gate with no in-repo enforcement; G4 now runs as an honest non-blocking gate but cannot yet verify a real evaluation table | partial gate coverage | R3/M6 | G1 needs a team-agreed label check; G4 needs M6-02's evaluation set |
| DEBT-03 | hidden dependency | `persona_version` is persisted `NULL` until C6 carries it (M4 interop) | version-aware trimming degrades after restart | M4/M6 | decide at issue #22 item 3 |
| DEBT-04 | evaluation debt | trace fitness functions parse Markdown tables | fragile to format drift | R3/M6 | revisit machine-readable sources + generator |
| DEBT-05 | untouchable code | `src/contracts/app/*` frozen | coordination cost | M5 | by design (ADR-006) |
| DEBT-06 | agent-induced bloat | multiple stacked PRs pending merge (#9/#23/#24) | rebase churn | team | sequence merges |
| DEBT-07 | guardrail debt | M4 reports 5 Windows-only `test:m6` failures (`m6-sqlite` ×3, `m6-02-boundary` ×2); Linux passes 181/14 and the cleanup branch 182/14 | no Windows test claim; CI is Linux-only | M6 | separate platform investigation; do not claim Windows coverage |
| DEBT-08 | evaluation debt | documentation claims about live configuration are not machine-checked; M6-GOV-11 cannot be satisfied by a docs-only slice | a false or stale claim can ship inside a reviewable document (BUG-017) | M6 | every claim names its command; a negative claim needs a positive read; refresh the thread at write time. Trigger: refusal experiment or a read-only claims check |

## PR53 IPC literal follow-up

Owner: M5. Status: open, non-blocking, as identified in the
[M6 review](https://github.com/inscripoem/isla/pull/53#pullrequestreview-5598159923).
`src/runtime/production-cli.ts` and `test/support/production-cli-kit.ts` each define
`isla.runtime.shutdown`. They can drift because there is no explicit agreement
check. A follow-up should use a shared side-effect-free constant or add an
agreement test, preserving shutdown success, pending/failed release, duplicate
message and startup-failure coverage. This entry records the debt; it does not
claim the duplication is fixed or allocate a new stable ID.
