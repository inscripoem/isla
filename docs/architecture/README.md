# Architecture artifact index

Status: **under review. Navigation and status only — this index accepts nothing.** Date: 2026-11-25.
Base: `main` `a58e8f0`. Owner: M5 coordination with M6.

The architecture set has one canonical file per concern. Links point to the normative file; where an
optional artifact is not produced, the row says so rather than pointing at a placeholder.

## D2 — architecture artifacts

| # | Artifact | Canonical file | Status | Notes |
| --- | --- | --- | --- | --- |
| D2.1 | Architecture blueprint | [`architecture-blueprint.md`](architecture-blueprint.md) | under review | Operative D2.1 constraint document. The root `architecture-blueprint.md` is the frozen 2026-10-15 snapshot and is retained for the required repository tree; it is not the current constraint. |
| D2.2 | Architecture Decision Record | [`adr/pending-architecture-baseline.md`](adr/pending-architecture-baseline.md) | proposed; ADR ID pending #25 | System-level choice, alternatives, consequences, reopen triggers, ADD process, layered AI context, assembly, token budget and reinjection policy. [`context-assembly.md`](context-assembly.md) records the implemented context and the unshipped proposal. |
| D2.3 | Invariant register | [`invariants.md`](invariants.md) | under review | Four current system invariants: INV-01, INV-02, INV-03, INV-12. The separate `Former ID` table exists only for historical AI-use references; it is not a current invariant claim. |
| D2.4 | Trace matrix | [`trace-matrix.md`](trace-matrix.md) | under review | 32/32 registered requirements have a canonical row; every monitor cell is a signal or a reasoned `—`. The trace gate rejects missing rows, empty/unreasoned monitors and a non-invariant row in the current invariant register. |
| D2.5 | Memory / state design | [`memory-design.md`](memory-design.md) | under review | Persistence, write/retrieval, ownership, retention, privacy and restart. The session/restart/version-survival matrix was added 2026-11-25; the multi-audience split is recorded in D1 as SEC-01/GOV-01. |
| D2.6 | Permission model | [`permission-model.md`](permission-model.md) | proposed; not adopted | Human-readable role/path model. The machine-readable source is [`../../.opencode/permissions.jsonc`](../../.opencode/permissions.jsonc), compiled per task by `tools/opencode/`. The file-level read-inventory decision remains open. |
| D2.7 | Runtime policy catalog | [`runtime-policy-catalog.md`](runtime-policy-catalog.md) | under review | Failure/degradation response and concrete fallback per path. Dialogue, synthesis, renderer, playback, startup and budget rows were added 2026-11-25; provider-auth and database-corruption rows name their evidence gaps; token overflow is a proposed, unshipped row. |
| D2.8 | Candidate evaluation table | [`candidate-comparison.md`](candidate-comparison.md) + [`evaluation-table.md`](evaluation-table.md) | under review | Qualitative system/storage/governance/evaluation/memory comparison plus the measured pilot table (`pilot-selection-local-magpie-20261125`, one attempt, declared conditions). G4's condition scan passes on the table; no semantic Tier 3 result and no threshold baseline are claimed. |
| D2.9 | Evaluation logbook (optional) | — | **not produced** | Evidence is currently in [`evaluation-protocol.md`](evaluation-protocol.md), [`evaluation-thresholds.md`](evaluation-thresholds.md), [`evaluation-table.md`](evaluation-table.md), the AI-use log and PR records. A dedicated logbook remains a closure item. |
| D2.10 | Risk list (optional) | — | **not produced as a standalone file** | Risks are tracked in [`../debt-register.md`](../debt-register.md) and the issue tracker. A standalone risk list with review triggers remains a closure item. |
| D2.11 | Option ledger | [`option-ledger.md`](option-ledger.md) | under review | Rejected storage and system-level options with reconsideration triggers. |

## D3 — coding governance

| Artifact | Canonical file | Status |
| --- | --- | --- |
| Agent entry point | [`../../AGENTS.md`](../../AGENTS.md) | reviewer-managed; operative |
| Structural constraints | [`../code-governance/structural-constraints.md`](../code-governance/structural-constraints.md) | under review |
| Verification constraints | [`../code-governance/verification-constraints.md`](../code-governance/verification-constraints.md) | under review |
| MCP/tool manifest | [`../code-governance/mcp-tool-manifest.md`](../code-governance/mcp-tool-manifest.md) | under review |
| Permission policy | [`../../.opencode/permissions.jsonc`](../../.opencode/permissions.jsonc) | proposed policy source |
| Always-on rules | [`../../.opencode/rules.md`](../../.opencode/rules.md) | draft for human adoption |
| Project covenant | [`../../.agent/rules.md`](../../.agent/rules.md) | proposal for human adoption |

## D4 — verification and QA records

| Artifact | Canonical file | Status |
| --- | --- | --- |
| Verification rules | [`../code-governance/verification-constraints.md`](../code-governance/verification-constraints.md) | under review |
| Review memo | [`../review-memo.md`](../review-memo.md) | under review; entries accrue per reviewed change |
| Debt register | [`../debt-register.md`](../debt-register.md) | under review |
| Bug diary | [`../bug-diary.md`](../bug-diary.md) | under review |
| Gate inventory | [`../code-governance/gate-inventory.md`](../code-governance/gate-inventory.md) | under review; one row per gate with positive/negative test or recorded limit. |

## Reading order

1. [`../../AGENTS.md`](../../AGENTS.md)
2. [`../../Prompt.md`](../../Prompt.md)
3. [`architecture-blueprint.md`](architecture-blueprint.md)
4. [`adr/pending-architecture-baseline.md`](adr/pending-architecture-baseline.md) — proposed, not accepted
5. [`../req/requirements.yaml`](../req/requirements.yaml) + [`../req/case-registry.yaml`](../req/case-registry.yaml)
6. [`invariants.md`](invariants.md) + [`trace-matrix.md`](trace-matrix.md)
7. [`permission-model.md`](permission-model.md) + [`../../.opencode/permissions.jsonc`](../../.opencode/permissions.jsonc)
8. [`../code-governance/structural-constraints.md`](../code-governance/structural-constraints.md) +
   [`../code-governance/verification-constraints.md`](../code-governance/verification-constraints.md)
9. [`../team/INTERFACES.en.md`](../team/INTERFACES.en.md) and the owning module's ports/tests

## Status vocabulary

- **under review** — written and reviewable; not human-accepted.
- **proposed** — a decision or model awaiting a named human/owner decision.
- **not produced** — the artifact does not exist in this checkout; the row names the substitute evidence.
- **adopted** — a human has recorded adoption. No D2/D3 artifact is marked adopted by this index.

## What this index does not claim

- It does not accept an ADR, blueprint, permission model, rule file or QA record.
- It does not turn an optional artifact into a required one, or a missing artifact into a pass.
- It does not claim a blocking gate beyond the measured `verify` ruleset, a semantic G4 result, a live
  provider result, acoustic output or a quality score.
