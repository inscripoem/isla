# ADR-006 — Governance gate tooling and traceability fitness functions

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-14 · Owner: M6 · Invariants: INV-12 · Cases: C-34, C-35.
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
  7. frozen paths are unmodified (CI supplies the changed-file list).
- Uses a tolerant Markdown-table parser (`src/evaluation/markdown.ts`) — **no new schema**; revisit
  machine-readable YAML sources + a generator later.
- Enabled by `INV-12`; verified by **C-34** (valid repo → no violations) and **C-35** (injected defect → violation).

### D2 — The gates are explicit and blocking
- CI names **G2** (static/boundary), **G3** (schema), **G5** (regression), **G6** (ai-use-log) and the
  **trace** fitness function as blocking steps; **G1** is documented (required PR label); **G4** is
  scaffolded and reports **not run** without provider access (team-gated).

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
`markdown.ts`, `trace-fitness.ts`. 6. Record — this ADR + rows + INV-12 + C-34/C-35 + Delta-006.
7. Evaluate — 3-tier verify.

## Re-open triggers

- The Markdown parse becomes a maintenance burden → move to machine-readable sources + a generator.
- A gate cannot be expressed as a static check (e.g. G1/G4 process/semantic gates).

## References

- `src/evaluation/{markdown,trace-fitness}.ts`, `test/offline/trace-fitness.test.ts`
- `docs/code-governance/verification-constraints.md`, `.github/workflows/ci.yml`, `README.md`
