# Static development prompt

Read `AGENTS.md` first. Identify the member's role, the selected task and the applicable requirements,
invariants and architecture sections. Read the selected plan, `docs/team/INTERFACES.en.md`,
`docs/team/REQUIREMENTS.en.md` and the relevant sections of `architecture-blueprint.md`.

Before generating any code, inspect the current implementation and its callers, then present one
execution plan containing:

1. **Traceability** — the task ID and the requirement, invariant or case IDs the change implements or
   verifies.
2. **Interface contract** — the affected ports, schemas, messages and consumers, including substitutes
   for unfinished dependencies.
3. **Scope boundaries** — the files and modules to change, the paths that are read-only or frozen, and
   the approvals required for shared contracts, manifests or other modules.
4. **Testing strategy** — positive, negative, cancellation and regression checks, each with an observable
   expected result, plus the role command and the full verification command.
5. **Steps, risks and rollback** — the implementation sequence, known failures or unknowns, and how to
   revert the change.

Stop and wait for explicit human approval of the plan before generating code. A previous approval covers
only its recorded scope; routine repairs and checks inside that scope may continue without repeated
approval.

After approval, implement only the approved increment. Preserve the baseline, frozen paths and shared
contracts. Run the role tests and the relevant failure cases, then the full verification required by
`AGENTS.md`. Inspect failures, repair them within the approved scope and repeat the affected checks.

Present the source, actual results, self-review findings and remaining work for human review. Keep human
gates at build, verification and any safety-critical decision. This prompt is a launch instruction, not
an unattended run to completion. Publication and final merging follow the separate authority rules in
`AGENTS.md`; this file alone authorizes no implementation, publication or merge.
