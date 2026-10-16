# Structural constraints

Status: **proposal (M6), for team review.** Owner: M6 (tooling) with M5 coordination. Revision 2026-10-16.1.
Course deliverable: **D3 (coding governance)**. Companion: `verification-constraints.md` (D4).

These rules bound how the coding agent may structure work: which module owns which element, how modules
extend the baseline, how every function stays traceable, the authority boundaries, how **stable
identifiers are allocated** so parallel contributors cannot collide, **which artifacts are authoritative**,
**which register each owner may edit**, and **what enforces each rule**.

## Why this document exists (evidence, not paperwork)

Governance exists because **one class of defect has already recurred three times**, each time costing
rebases, renumber scripts and cross-team coordination in the middle of a delivery:

| Incident | What happened | Cost paid |
| --- | --- | --- |
| `C-45` | M5 and M6 both published `C-45`. | M5 renumbered to `C-47`; case references updated across branches. |
| `INV-09` | M5's delivery attribution and M6's config/recovery both claimed the `INV-09…13` range. | M6 renumbered `INV-09…13` → `INV-10…14` and re-mapped every trace row. |
| `C-49` | M6 and M4 both allocated `C-49`. | M6 yields the ID to M4 and moves to `C-51`; a renumber script + a coordination thread. |

**Root cause — one, not three:** identifiers are **global-sequential** in **shared registers** and are
**self-assigned** on **parallel branches**. Each branch is individually valid, so the clash surfaces only
**at merge**. That means **testing cannot prevent it** (there is nothing wrong to test on either branch),
and the cost lands on whoever merges — usually by surprise.

**Why the response is structural, not a reminder:** a plain convention was already in force (threads,
"take the next free number") and it failed three times, because it depends on every contributor
remembering and on allocation being serialised across teams. What holds instead is a convention **CI can
check** plus a **namespace that makes collisions impossible by construction** — the same principle the repo
already applies to invariants: put the rule in a **fail-closed gate**, not in a prompt or a memo.

This document is therefore both the **D3 deliverable** and the fix: module rules and authority boundaries
(§1–§2), the ID convention (§3), and — for every rule — the mechanism that enforces it and whether that
mechanism is on `main` yet (§4). Artifact authority and register ownership follow in §5–§6.

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

1. **Grandfathering.** Every id published, or already allocated on a branch in flight, when this convention
   is adopted is kept as-is and **never renumbered**. At this revision: `INV-01…INV-09` and `C-01…C-47` are
   published on `main`; `INV-10…INV-14` and `C-48…C-51` are allocated on branches in flight; `INV-15` is
   pending. The convention applies to ids allocated **after** adoption.
2. **New IDs carry the owner prefix.** A module adds only IDs under its own prefix (`C-M6-1`).
3. **Prefix must match the recorded owner.** The owner already recorded for a row must agree with the id
   prefix; drift (or reassignment) is a violation, not a silent renumber. Where a register exposes the owner
   as a column — the `Owner` column that lands with the R3 tooling PR (§4) — that column is the value
   checked; until then the owner is read from the row's existing component/verification text.
4. **Append-only.** A retired ID is never reused.
5. **Renumbering is recorded**, never silent — it goes in the change log (delta), with an old→new mapping.

### 3.3 Why a prefix, not a partial counter

The defect is a **merge-time collision in a shared namespace**; the canonical fix for that is
**namespacing**, not partitioning one global counter. A prefix guarantees distinct IDs across owners
**by construction** (no allocation step, no lookup table), is **self-documenting**, and — decisively —
**composes with the endgame** (§8): once registries are per-owner fragments, each fragment numbers its own
rows with no cross-owner coordination at all.

### 3.4 Fallback — numeric blocks (if the team rejects the tooling change)

| Owner | Cases | Invariants |
| --- | --- | --- |
| M1…M6 | `C-1xx`…`C-6xx` | `INV-1x`…`INV-6x` |

Blocks are zero-churn (`C-\d+` still matches) but only **shrink** the collision surface: they still need
a cross-owner allocation step, cap each owner at 100 IDs, need a lookup table to read ownership, and do
not compose with per-owner fragments. Acceptable only while each module has a single writer.

## 4. Rules and their enforcement

A rule without an enforcement mechanism is a preference. Each rule below names the mechanism that fails
when it is broken, and **whether that mechanism is on `main` yet** — so this document never claims a gate
that does not exist.

| Rule | Enforcement | State |
| --- | --- | --- |
| Module boundary: production must not import `test/`; cross-module calls go through ports (§1.4) | import-boundary tests | ✅ on `main` |
| Registers are schema-valid; ids are unique and reference existing rows (§3) | readiness suite over `requirements.yaml` / `case-registry.yaml` | ✅ on `main` |
| The trace chain is complete; dangling references fail (§1.3) | `src/evaluation/trace-fitness.ts` + the `trace` gate | ⏳ **R3 (#27)** |
| Frozen paths require an ADR and human review (§7) | `docs/architecture/frozen.yaml` + the `frozen-modified` check | ⏳ **R3 (#27)** |
| Every change updates the AI-use log (G6) | `ai-use-log-gate.ts` + the G6 gate | ⏳ **R3 (#27)** |
| One task = one commit; no agent merges; PR checklist | `.github/PULL_REQUEST_TEMPLATE.md` (+ `AGENTS.md`) | ⏳ **R3 (#27)** / ✅ `AGENTS.md` |
| A new id's prefix matches its `Owner` (§3.2) | *proposed* check in `trace-fitness.ts` | ⏳ **to be added** (needs the §3 decision) |
| The case recogniser accepts prefixed ids (§3.1) | *proposed* widening of `trace-fitness.ts` | ⏳ **to be added** |

Until the ⏳ rows land, they are **convention + review**, not gates — and the document says so rather than
implying otherwise. The R3 tooling PR is the enforcement half of this document; the two halves are
deliberately separate so the rules can be reviewed on their own.

**Tooling cost of the prefix convention (one-time, shared):** widen the case recogniser at
`trace-fitness.ts` from `/\bC-\d+\b/g` to accept `C-<owner>-<n>` (e.g. `/\bC-(?:M\d+-)?\d+\b/g`), and add
the **prefix ↔ `Owner`-column** check. Legacy ids keep matching unchanged.

## 5. Artifacts: authority and lifecycle

Every artifact belongs to exactly one of three tiers, and the tier decides whether it may be treated as
truth.

| Tier | Where it lives | Examples | Rule |
| --- | --- | --- | --- |
| **Authoritative** | in-repo, English, version-controlled | ADRs, deltas, the registers, `src/contracts/`, source, these governance docs | the **single source of truth** — what review approves and what the gates read |
| **Derived** | in-repo, regenerable | `docs/architecture/evaluation-table.md` (once M6-02 generates it), indexes, knowledge-base copies | must cite the authoritative artifact it is generated from; never hand-edited as truth; regenerate from source |
| **External** | **outside** the checkout | raw session transcripts/exports, Chinese understanding copies, evidence ZIPs, historical review snapshots | referenced by id/hash; **never** substituted for a repo artifact and never committed when the submission whitelist excludes it |

1. **The repository is the single source of truth.** A derived or external copy never overrides it — for
   example the superseded October review snapshot must not be cited as current when an in-repo document
   covers the same subject.
2. **Every artifact has a documented path and an owner.** ADRs land at `docs/architecture/adr/NNN-*.md`,
   change records at `docs/architecture/delta/NNN-*.md`, registers under `docs/req/` and
   `docs/architecture/`, governance under `docs/code-governance/`.
3. **Nothing is committed that the whitelist excludes** — raw evidence, secrets and Chinese copies stay
   outside, with only a reference (id or hash) in the repository. Do not fabricate a deliverable to fill a
   path.
4. **Names are stable.** Sequential `NNN-<slug>` files are numbered once; a rename or move is recorded, not
   silent.

## 6. Registers: ownership and no orphan artifacts

1. **No orphan artifact.** Every artifact is reachable in the chain
   (`REQ → Driver → Concept → Element → Interface → Code → Test → Monitor`) and listed in the trace matrix,
   the case registry or the requirements registry. An artifact that no requirement or owner can reach is a
   defect, not a spare.
2. **Additions are validated, not asserted.** A register row must use an allocated id (§3) and reference
   rows that exist; the readiness suite schema-checks the register on every change.
3. **Shared registers are edited by coordination, not by habit.** Allocate the id **before** adding the row,
   announce it in the coordination thread, and expect the shared file to merge-conflict while several
   owners are active — resolve by **union** (keep every owner's row), never by dropping a row that is not
   yours.
4. **The register records its own owner.** Where a register carries an owner (the `Owner` column that lands
   with the R3 tooling PR on `invariants.md` and `trace-matrix.md`) it is authoritative for who answers for
   the row, and it must agree with the id prefix (§3.2). Until that column is on `main`, ownership is read
   from the row's existing `Enforcing component` text.

## 7. Change policy

- Paths in `docs/architecture/frozen.yaml` require an ADR and human review (fail-closed). *(The manifest and
  its `frozen-modified` check land with the R3 tooling PR; see §4.)*
- This document is **reviewer-managed**; changes go through a pull request with M5 coordination.

## 8. Follow-up (proposed)

The durable structural fix beyond §3 is **per-owner sources + a generator** (`cases.d/M6.yaml` →
generated combined register), which also removes merge conflicts on the shared files. With owner prefixes
each fragment numbers its own rows (`C-M6-1…`) with **no cross-owner allocation**, so the two changes are
complementary — which is why prefixes are preferred over blocks. That is a larger, coordinated change and
would be recorded as its own ADR.
