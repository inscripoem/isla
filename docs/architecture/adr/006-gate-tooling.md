# ADR-006 — Governance gate tooling and traceability fitness functions

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-14 · Owner: M6 · Invariants: INV-13 · Cases: C-34, C-35, C-37.
Relates to: ADR-001..005. Revision type: ADD (new capability, R3 / #17).

## Context

The traceability chain (`REQ → Driver → Concept → Element → Interface → Code → Test → Monitor`) is
currently human-maintained prose, and the six blocking gates (D7) are only partially wired (G3/G5 run
inside `pnpm test`, but are not named gates; G1/G4/G6 are absent). The course directs
*"enforce in code, not convention"* and the visibility playbook's ten-point "am I lost?" test.

## Decisions

### D1 — Traceability fitness functions over the existing artifacts (no schema change)
- `collectTraceViolations(fs, options)` machine-checks the chain:
  1. registry cross-check (REQ → implemented case → present test);
  2. every invariant is registered with a verification;
  3. every trace-matrix row references an existing component path and an existing case id;
  4. every runtime-policy row has an operational fallback;
  5. every `ADR-00N` reference resolves, and every ADR file is referenced;
  6. the option ledger records ≥1 entry;
  7. frozen paths are unmodified (CI supplies the changed-file list);
  8. every governed shared table (`invariants.md`, `trace-matrix.md`) carries an explicit **Owner**
     column with a non-empty owner per row — so a row contributed by several roles stays classifiable
     when PRs are merged.
- Uses a tolerant Markdown-table parser (`src/evaluation/markdown.ts`) — **no new schema**; revisit
  machine-readable YAML sources + a generator later.
- Enabled by `INV-13`; verified by **C-34** (valid repo → no violations), **C-35** (injected defect → violation)
  and **C-37** (governed row without an owner → violation).

### D2 — The gates are explicit and blocking
- `.github/workflows/ci.yml` names them as blocking steps: **G2** `pnpm typecheck && pnpm lint`; **G3**
  `pnpm test:readiness`; **trace** `pnpm test:trace`; **G5** `pnpm test`; **G6** `pnpm gate:ai-use-log`
  over the pull-request diff; then `pnpm build`.
- **G6** is `src/evaluation/ai-use-log-gate.ts` — a code/prompt change must also update
  `docs/ai-use-log.yaml` (INV-14).
- **G1** is an **advisory step inside the `verify` job**: it reads the `tests-approved` label on a
  pull request that changes code or prompts. It becomes blocking when the team agrees and branch
  protection requires `verify` — the check is the job, not a separately named check. **G4** is
  `src/evaluation/eval-gate.ts`, wired as the `G4` step (`pnpm gate:eval`): it reports **not run** without
  an evaluation set + provider access (team-gated) — never a pass — and fails an evaluation table that
  omits the fixed conditions NFR-01 requires.
- The traceability fitness function recognises both the legacy numeric id (`C-12`) and the owner-prefixed
  id of the convention in `docs/code-governance/structural-constraints.md` §3 (`C-M6-1`), and rejects a
  prefixed id whose row Owner does not name the module the id claims (`invariant-owner-mismatch`,
  `trace-case-owner-mismatch`).
- The README documents the gate design (D7); branch protection remains a human/remote setting.

### D3 — Governance documents
- `docs/architecture/frozen.yaml` — the frozen-path manifest (fail-closed: a change requires an ADR
  and human review; the trace fitness function raises `frozen-modified` / `frozen-path-missing`).
- `.github/PULL_REQUEST_TEMPLATE.md` — the `INTERFACES` §7 handoff checklist plus the gate checklist.
- `docs/review-memo.md`, `docs/debt-register.md`, `docs/bug-diary.md` — the D4 QA records.

## Alternatives considered

1. **Ad hoc document review** — rejected (not machine-checked; drifts silently).
2. **Machine-readable artifact sources + a generator now** — deferred (bigger change; the parser
   suffices for v1).

## Consequences

- A broken link in the chain fails a gate. The tool **already caught real gaps** (INV-01..03 and INV-11
  were missing from the register).
- Future improvements (YAML sources, generator, `function → concept`, duplicate-authority) are additive.

## Design process (ADD)

1. Review inputs — D7 gates; the visibility playbook. 2. Drivers — verifiable governance.
3. Decompose — parse vs checks. 4. Concepts — fitness functions; injected filesystem. 5. Instantiate —
`markdown.ts`, `trace-fitness.ts`. 6. Record — this ADR + rows + INV-13 + C-34/C-35/C-37 + Delta-006.
7. Evaluate — 3-tier verify.

## Re-open triggers

- The Markdown parse becomes a maintenance burden → move to machine-readable sources + a generator.
- A gate cannot be expressed as a static check (e.g. G1/G4 process/semantic gates).

## References

- `src/evaluation/{markdown,trace-fitness}.ts`, `test/offline/trace-fitness.test.ts`
- `docs/code-governance/verification-constraints.md`, `.github/workflows/ci.yml`, `README.md`
