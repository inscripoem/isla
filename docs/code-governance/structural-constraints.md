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
validator cannot prevent it. The fix is to **namespace each owner's IDs** (§3.1), with a numeric-block
fallback if the team prefers zero tooling churn (§3.4).

### 3.1 Namespace new IDs by owner (primary)

New IDs carry the declaring module's **owner prefix**; the trailing number is private to that owner.

| Owner | Cases | Invariants | ADRs |
| --- | --- | --- | --- |
| M1 | `C-M1-n` | `INV-M1-n` | global `ADR-0xx` |
| M2 | `C-M2-n` | `INV-M2-n` | global |
| M3 | `C-M3-n` | `INV-M3-n` | global |
| M4 | `C-M4-n` | `INV-M4-n` | global |
| M5 | `C-M5-n` | `INV-M5-n` | global |
| M6 | `C-M6-n` | `INV-M6-n` | global |

### 3.2 Rules

1. **Grandfathering.** IDs already published (`C-01…C-51`, `INV-01…INV-15`, and any ID allocated under the
   old scheme before this document is adopted) are kept as-is and **never renumbered**.
2. **New IDs carry the owner prefix.** A module adds only IDs under its own prefix (`C-M6-1`).
3. **Prefix must match the Owner column.** The `Owner` already recorded for a row must agree with the ID
   prefix; drift (or reassignment) is a violation, not a silent renumber.
4. **Append-only.** A retired ID is never reused.
5. **Renumbering is recorded**, never silent — it goes in the change log (delta), with an old→new mapping.

### 3.3 Why a prefix, not a partial counter

The defect is a **merge-time collision in a shared namespace**; the canonical fix for that is
**namespacing**, not partitioning one global counter. A prefix guarantees distinct IDs across owners
**by construction** (no allocation step, no lookup table), is **self-documenting**, and — decisively —
**composes with the endgame** (§6): once registries are per-owner fragments, each fragment numbers its own
rows with no cross-owner coordination at all.

### 3.4 Fallback — numeric blocks (if the team rejects the tooling change)

| Owner | Cases | Invariants |
| --- | --- | --- |
| M1…M6 | `C-1xx`…`C-6xx` | `INV-1x`…`INV-6x` |

Blocks are zero-churn (`C-\d+` still matches) but only **shrink** the collision surface: they still need
a cross-owner allocation step, cap each owner at 100 IDs, need a lookup table to read ownership, and do
not compose with per-owner fragments. Acceptable only while each module has a single writer.

## 4. Verification

- The **traceability fitness function** (`src/evaluation/trace-fitness.ts`) rejects duplicate IDs and
  dangling references across the registers; the registers are schema-validated by the readiness suite.
- **Tooling cost of prefixes (one-time, shared):** widen the case recogniser at
  `trace-fitness.ts:58` from `/\bC-\d+\b/g` to accept `C-<owner>-<n>` (e.g. `/\bC-(?:M\d+-)?\d+\b/g`), and
  add a **prefix ↔ Owner-column** check. Legacy IDs keep matching unchanged.
- *(Advisory, optional)* a check may flag a **new** ID whose prefix does not match its declaring module.

## 5. Change policy

- Paths in `docs/architecture/frozen.yaml` require an ADR and human review (fail-closed).
- This document is **reviewer-managed**; changes go through a pull request with M5 coordination.

## 6. Follow-up (proposed)

The durable structural fix beyond §3 is **per-owner sources + a generator** (`cases.d/M6.yaml` →
generated combined register), which also removes merge conflicts on the shared files. With owner prefixes
each fragment numbers its own rows (`C-M6-1…`) with **no cross-owner allocation**, so the two changes are
complementary — which is why prefixes are preferred over blocks. That is a larger, coordinated change and
would be recorded as its own ADR.
