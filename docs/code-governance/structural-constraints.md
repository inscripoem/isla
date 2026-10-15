# Structural constraints

Status: **proposal (M6), for team review.** Owner: M6 (tooling) with M5 coordination. Date: 2026-10-15.
Course deliverable: **D3 (coding governance)**. Companion: `verification-constraints.md` (D4).

These rules bound how the coding agent may structure work: which module owns which element, how modules
extend the baseline, how every function stays traceable, the authority boundaries, and — added 2026-10-15
— how **stable identifiers are allocated** so parallel contributors cannot collide.

## 1. Module organization

1. **One home per element.** Each architectural element maps to **exactly one** module. Ownership is the
   table in `architecture-blueprint.md` (M1 `src/performance/`, M2 `src/console/`, M3 `src/decision/`,
   M4 `src/dialogue/`, M5 `src/runtime/`, M6 `src/storage/` + `src/evaluation/` + `.github/workflows/`).
2. **Extend, never replace.** New work adds to the existing baseline. A working element is not rewritten
   to make a new test pass.
3. **Trace every function.** Each module and the functions it adds reference the **ADR** and **invariant**
   they implement (REQ → Driver → Concept → Element → Interface → Code → Test → Monitor).
4. **Respect the boundary.** Feature internals stay inside the owning module; cross-module calls go
   through the published ports (`src/contracts/app/`). Production code must not import from `test/`.

## 2. Authority boundaries (advisory vs authoritative)

- **Deterministic code owns** authority, permissions, invariants and fallbacks. **Prompts and skills are
  advisory** and must never carry a safety-critical limit.
- **Live authority and `seq`** — M5. **Persistence/recording** — M6. **Memory semantics** — M4.
  **Decision / dialogue / adapters / output** — M3 / M4 / M1 / M2.
- **Safety-critical changes** require an architecture decision (ADR) and human approval.

## 3. Stable identifiers and ownership — *the collision fix*

Identifiers are **stable, globally unique and never reused**. The pain this fixes: several owners adding
rows to the same shared register (`requirements.yaml`, `case-registry.yaml`, `invariants.md`) on parallel
branches each pick "the next free number" and collide — the collision only appears at merge time, so a
validator cannot prevent it. The fix is a **reservation convention**.

### 3.1 Reserve a numeric block per module owner (new IDs only)

| Owner | Cases | Invariants | ADRs |
| --- | --- | --- | --- |
| M1 | `C-1xx` | `INV-1x` | global `ADR-0xx` |
| M2 | `C-2xx` | `INV-2x` | global |
| M3 | `C-3xx` | `INV-3x` | global |
| M4 | `C-4xx` | `INV-4x` | global |
| M5 | `C-5xx` | `INV-5x` | global |
| M6 | `C-6xx` | `INV-6x` | global |

### 3.2 Rules

1. **Grandfathering.** IDs already published (`C-01…C-50`, `INV-01…INV-15`, and any ID allocated under the
   old scheme before this document is adopted — e.g. `C-48`…`C-51`) are kept as-is and **never renumbered**.
2. **New IDs use the owner's block.** A module adds only IDs inside its own block.
3. **Allocate in the register first.** Before adding a row, reserve the ID in the register via the
   coordination thread; **never self-assign "the next number."**
4. **Append-only.** A retired ID is never reused.
5. **Renumbering is recorded**, never silent — it goes in the change log (delta), with an old→new mapping.

**Why it works:** the case/invariant `id` field is a free-form string (no schema pattern), and the
`C-\d+` / `INV-\d+` recognisers still match a block ID (`C-601`, `INV-62`). So no schema change is needed,
and two owners can no longer collide by construction.

## 4. Verification

- The **traceability fitness function** (`src/evaluation/trace-fitness.ts`) rejects duplicate IDs and
  dangling references across the registers; the registers are schema-validated by the readiness suite.
- *(Advisory, optional)* a check may flag a **new** ID whose block does not match its declaring module.

## 5. Change policy

- Paths in `docs/architecture/frozen.yaml` require an ADR and human review (fail-closed).
- This document is **reviewer-managed**; changes go through a pull request with M5 coordination.

## 6. Follow-up (proposed)

The durable structural fix beyond blocks is **per-owner sources + a generator** (`cases.d/M6.yaml` →
generated combined register), which also removes merge conflicts on the shared files. That is a larger,
coordinated change and would be recorded as its own ADR.
