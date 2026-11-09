# Isla development instructions

Revision: 2026-11-09.1. Repository documents, code comments and UI text are English. Chinese copies, raw evidence and historical drafts stay outside the checkout; see [docs/team/README.md](docs/team/README.md).

## Start from a role

When a member says "I am M3; start my first task" or names another M1–M6 role, locate the task below. A role declaration identifies ownership; a request to start triggers investigation and a plan. Use a supplied task ID from [PLAN](docs/team/PLAN.en.md). Otherwise inspect the first task's implementation and tests before proposing its next unfinished slice; do not recreate completed work. Ask for the role only when it is missing and cannot be inferred. Do not assume every member is M5 or the leader.

| Role | First task | Owned directory | Baseline command |
| --- | --- | --- | --- |
| M1 | M1-01 | `src/performance/`; browser entry in `src/performance/browser/` | `pnpm test:m1` |
| M2 | M2-01 | `src/console/` | `pnpm test:m2` |
| M3 | M3-01 | `src/decision/` | `pnpm test:m3` |
| M4 | M4-01 | `src/dialogue/` | `pnpm test:m4` |
| M5 | M5-01 | `src/runtime/` | `pnpm test:m5` |
| M6 | M6-01 | `src/storage/`, `src/evaluation/`, `.github/workflows/` | `pnpm test:m6` |

1. Read the selected task in PLAN and its row and replacement instructions in [READINESS-KITS](docs/team/READINESS-KITS.en.md). Consult relevant sections of [INTERFACES](docs/team/INTERFACES.en.md), [REQUIREMENTS](docs/team/REQUIREMENTS.en.md) and [architecture-blueprint](architecture-blueprint.md); do not require reading every document first.
2. Inspect the branch/worktree without changing Git state, then relevant source, contracts and tests. Preserve existing edits. Run the role baseline; on a fresh checkout use `pnpm install --frozen-lockfile` first. Identify missing external prerequisites together and continue work that can use fixtures.
3. Before writing code, present the behavior, files/ownership, interfaces/substitutes, acceptance tests, risks and rollback plan. Wait for explicit member confirmation unless that plan is already approved in the session. Routine fixes and checks within approved scope do not require repeated confirmation.
4. Implement only the approved task slice. Use fixtures for unfinished dependencies, retain conformance assertions, and add tests against the actual implementation. Keep fixture controls and ContractRunner under `test/`; production code must not import them. M5 follows the test-only harness adaptation in READINESS-KITS.
5. Run the role command and relevant failure/Stop cases, then `pnpm verify` before handoff. Run startup checks when runtime or console integration changes. Report actual results and gaps; passing unchanged fixture tests alone does not validate new code.

## Scope and shared changes

Shared C1–C7 contracts, role fixtures and offline composition already exist. READINESS-PLAN and READINESS-REVIEW record the completed preparation increment, not instructions to repeat it. The former preparation-only exclusion of product modules does not prevent a member from explicitly authorizing their planned task, including playback, scheduling or SQLite. This document itself does not authorize business implementation, live service calls or another role's work.

Preserve PLAN's confirmed responsibilities and ratings. M5 coordinates shared contracts, entry points, manifests and lockfiles; affected producers and consumers review interface changes. Trace callers before changing APIs; update implementations, tests and documents together. Interfaces may evolve. Do not silently weaken assertions or overwrite another owner's work. Keep diagnostic protocol 1 separate from application contracts 0.2.

**Stable identifiers.** Case, invariant and requirement IDs are global, stable and never reused. Reserve a new ID in the coordination thread (#25); it is free only when no registered row uses it. The owner-prefix scheme in [structural-constraints](docs/code-governance/structural-constraints.md) §3 is not operative until its three adoption conditions are met; follow that document for register, owner and renumbering details.

## Tools and boundaries

Application code is authored through genuine OpenCode sessions. Use the current V2 launch, resume and export form in [READINESS-KITS](docs/team/READINESS-KITS.en.md); the historical V1 flags are not the verified form. Preserve authentic exports outside the checkout. Use one package and pnpm dependency commands; keep pnpm storage under `.cache/pnpm-store`. Consult Context7 before introducing an unestablished library/API, and update the [tool manifest](docs/code-governance/mcp-tool-manifest.md) when the tool surface changes.

M2 may import M1's browser interface; transitive imports must remain browser-safe. Keep Node/provider code and databases out of the browser graph. Trace callers before changing shared APIs; update implementations, tests and documents together.

Authorized publication uses a task branch and pull request under the current remote rules; never push directly to main. Agents must never merge pull requests, enable auto-merge, enqueue a merge or trigger a merge through the CLI, API, browser or automation. A human team member performs the final merge; see [docs/team/README.md](docs/team/README.md) and [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).

`AGENTS.md` and `Prompt.md` are reviewer-managed. The local `opencode.json` is not versioned. Tool permissions are not an OS sandbox. Never commit credentials; `.env.example` documents variable names only.

## Review and handoff

Provide task/requirement IDs, changed interfaces, actual commands/results, failure/cancellation behavior, gaps and requested consumer review. Run the pre-review self-check in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md); fix material issues without unrelated restructuring. Distinguish local checks, remote CI, branch rules and full course gates. Never claim live providers, physical silence, durable recovery or completed product behavior from fixtures alone. Status remains under review until the owning member and reviewer confirm.
