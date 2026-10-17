# Isla development instructions

Revision: 2026-10-15.1. Address the user as Captain. Use formal English for repository documents, code comments and UI. Chinese understanding copies, historical drafts and private evidence remain outside the checkout. Never submit coursework.

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

**Stable identifiers.** Case, invariant and requirement IDs are global, stable and never reused. New IDs are **reserved in the coordination thread (#25)** until the convention in [structural-constraints](docs/code-governance/structural-constraints.md) §3 is adopted: adoption requires the corrected documentation and the supporting ID validation to be merged and an adoption revision to be recorded, so no naming scheme is operative before then. When you add a row to a shared register (`docs/req/requirements.yaml`, `docs/req/case-registry.yaml`, `docs/architecture/invariants.md`), take the ID from the thread's allocation — do not invent one and do not take "the next number" — make the row's `Owner` agree with the ID, and remember that a reservation takes effect only when the row exists in the register, and an ID is free only when no registered row uses it. Renumbering an already-published ID needs a recorded delta and M5 coordination.

## Tools and boundaries

Application code is authored through genuine OpenCode sessions with the configured DeepSeek-V4-Flash provider and `--pure --agent build --variant xhigh`. Preserve authentic exports outside the checkout; READINESS-KITS contains the launch form. Use one package and pnpm dependency commands; keep storage under `.cache/pnpm-store`. Use official framework scaffolding when needed. Check Context7 before introducing an unestablished library/API or uncertain configuration.

Prefer explicit state, flat modules and observable tests. M2 may import M1's browser interface; transitive imports must remain browser-safe. Keep Node/provider code and databases out of the browser graph. Dependencies, databases, audio and caches remain outside OneDrive. Prepare course artifacts at their documented paths; do not fabricate deliverables or evidence.

No Git mutations (including branch creation/switching, staging, commits or pushes) or remote changes without explicit user instructions. Never push directly to main; authorized publication uses a task branch and PR under current remote rules. Agents must never merge pull requests, enable auto-merge, enqueue a merge or trigger a merge through the CLI, API, browser or automation. Review approval and permission to publish do not authorize merging. A human team member must perform the final merge. No subagents, destructive cleanup, global-configuration changes or work in other projects. AGENTS.md, Prompt.md, opencode.json and .opencode/ are reviewer-managed; module agents need explicit authorization to change them. Tool permissions are not an OS sandbox.

Never read/glob/grep/display secret values or secret-named files (.env, *secret*, *token*, *auth*, *key*, *password*, id_*, *.pem, *.p12, *.key). Do not write credentials. Existing tools may load local credentials without exposing them. Keep Chinese documents, private records, historical drafts and ZIPs outside the checkout; synchronize paired team guides in OneDrive.

## Review and handoff

Provide task/requirement IDs, changed interfaces, actual commands/results, failure/cancellation behavior, gaps and requested consumer review. Self-review findings as High/Medium/Low; fix material issues without unrelated restructuring. Status remains under review until the user confirms. Distinguish local checks, remote CI, branch rules and full course gates. Never claim live providers, physical silence, durable recovery or completed product behavior from fixtures alone.
