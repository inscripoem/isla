# Project covenant for coding agents

Status: **proposal, under review.** Reviewer-managed. Not adopted. `AGENTS.md` remains the operative
entry point; this file states the project-level constraints every M1–M6 coding agent must preserve.

## 1. Abstraction limits

- One home per architectural element. The ownership table in `architecture-blueprint.md` and
  `docs/team/PLAN.en.md` is authoritative.
- Extend the existing baseline; do not rewrite a working element to make a new test pass.
- Do not introduce a new abstraction unless at least two concrete consumers need it. Prefer explicit,
  flat modules over indirection, metaprogramming or generated layers.
- Keep control flow linear and pass state explicitly. Do not create a second authority for a decision
  that deterministic code already owns.

## 2. Dependency constraints

- Use one package and pnpm. Do not add a runtime dependency without a documented need, a named owner and
  review under the `manifests` approval class.
- Production code must not import `test/`. Cross-module calls go through the published ports under
  `src/contracts/app/`.
- Browser code must remain browser-safe. Node/provider code and databases stay out of the browser graph.
- Shared contracts, root entry points, manifests and lockfiles require M5 coordination and affected-owner
  review. Frozen paths require an ADR and human approval.
- Do not modify global configuration, credentials or another member's private configuration.

## 3. Test independence and negative tests

- Tests for a change are approved before implementation begins (G1). Record the approval in
  `docs/code-governance/test-approvals.yaml` or the current approved mechanism.
- Every feature has at least one negative test: an input or condition that must be refused, cancelled or
  left unknown. A test that cannot fail when the feature is absent is not evidence.
- Every invariant has at least one test that fails when the invariant is violated. Every test references
  the requirement, invariant or case it verifies.
- Do not weaken, skip or delete an assertion to make a change pass. Preserve prior suites and require
  zero regressions.

## 4. Safety-critical changes

- Deterministic code owns authority, permissions, invariants and fallbacks. Prompts and skills are
  advisory and must not carry a safety-critical limit.
- A change to safety-critical behaviour or a frozen path requires an architecture decision record and
  human approval before merge. An agent review or a passing test is not a substitute for that approval.
- The relevant owners review contract, security, API-surface and permission effects. A permission grant
  is not an ADR.

## 5. Context freshness

- When a requirement changes, update the affected `AGENTS.md` rule, `Prompt.md` instruction, permission
  model, tool manifest, tests and trace rows within one sprint.
- Record the change in `docs/ai-use-log.yaml` and re-run the affected gates. Do not leave a rule that
  describes a superseded baseline.
- If a rule and the implementation disagree, stop and report the conflict rather than choosing silently.

## 6. Credentials and privacy

- Never read, display, log or commit secret values or credential-named files.
- Raw transcripts and private evidence stay outside the checkout unless an approved submission path
  explicitly includes an annotated, redacted copy. Redactions are listed.
- Do not invent authorship, hours or a member's direct action. Label coordinator actions and agent
  actions accurately.

## 7. Verification and reporting

- Run the role command, the negative cases and `pnpm verify` before handoff.
- Report the exact source version, commands, results, failures, skips and gaps. Distinguish deterministic
  offline checks from live-service observations.
- Status remains under review until the owning member and the named reviewer confirm.

## Adoption

This covenant is a proposal. The team must review it together with `.opencode/permissions.jsonc` and
`docs/architecture/permission-model.md`. Until adoption, `AGENTS.md` and the existing governance
documents remain authoritative.
