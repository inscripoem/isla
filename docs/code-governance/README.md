# Coding governance

Status: **proposal (M6), for team review.** Owner: M6 (tooling) with M5 coordination. Revision 2026-10-16.1.
Course deliverables: **D3 (coding governance)** and **D4 (verification)** — see the table below.

This folder holds the rules that bound the coding agent (D3) and the way its work is verified (D4). It is
**reviewer-managed**: a change goes through a pull request with M5 coordination.

## Normative scope of each document

| File | Deliverable | Normative for | Status |
| --- | --- | --- | --- |
| [`structural-constraints.md`](structural-constraints.md) | D3 | module organization, authority boundaries, stable identifiers, artifact authority, register ownership, and the enforcement state of every rule | PR #32 |
| [`../architecture/permission-model.md`](../architecture/permission-model.md) | D2.6 / D3 | role/path read-write matrix, default-deny policy, approvals, protected paths and enforcement state | local proposal |
| [`../architecture/candidate-comparison.md`](../architecture/candidate-comparison.md) | D2 | qualitative comparison of the alternatives already recorded in the ADRs | local proposal |
| [`verification-constraints.md`](verification-constraints.md) | D4 | structural / regression / behavioral verification tiers and the evidence each requires | on `main` |
| [`mcp-tool-manifest.md`](mcp-tool-manifest.md) | D3 | the agent's external tool/context surface and the policy for extending it | this PR |

## Where the always-on instruction lives

The instruction every coding agent reads on start is **[`AGENTS.md`](../../AGENTS.md)** at the repository
root — role selection, workflow, and tool/authority boundaries. It is the **operative** copy; this folder
is the **normative reference** it points to. Where the two could disagree, `AGENTS.md` states the rule and
this folder states the detail — the rule is not duplicated in both.

## Agent permissions

The proposed role/path permission model is
[`docs/architecture/permission-model.md`](../architecture/permission-model.md). Its machine-readable source is
[`.opencode/permissions.jsonc`](../../.opencode/permissions.jsonc), compiled per role and task by
[`tools/opencode/`](../../tools/opencode/) into ordinary JSON under `.cache/opencode/`. The model is a
local, under-review candidate: it is not auto-loaded, does not activate a blocking gate, and has not
established native enforcement beyond the version-bound observations recorded in the model document.

The always-on rule files are `.opencode/rules.md` (human-only) and `.agent/rules.md` (project covenant).
A human reviewer must adopt them; an agent-prepared draft is not adoption. The qualitative D2 candidate
comparison is [`../architecture/candidate-comparison.md`](../architecture/candidate-comparison.md);
numerical results remain reserved for the G4 evaluation table.

## Enforcement

Each rule names the mechanism that fails when it is broken, and whether that mechanism is on `main` yet —
see [`structural-constraints.md`](structural-constraints.md) §4. The **tooling half** (fitness functions,
frozen manifest, PR template, AI-use gate) lands with the R3 tooling PR (#27), deliberately separate from
the rules in this folder so each can be reviewed on its own.

## How to change a governance document

1. Propose the change on a task branch; do not edit a reviewer-managed document in place.
2. If the change alters a rule another owner depends on, announce it in the coordination thread first
   (the register/ID rules in `structural-constraints.md` §3 and §6 apply).
3. Update the enforcement table in `structural-constraints.md` §4 in the same change whenever a rule gains
   or loses a mechanism — a rule with no enforcement is a preference and must be labelled as such.
