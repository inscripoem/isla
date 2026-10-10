# Parallel Development Readiness — Implementation Plan

Status: preparation implemented and independently verified on 2026-10-10; under review. Publication uses a task-branch PR; only a human may merge.

Verification: an isolated copy of the 86 versionable files passed frozen installation, all six role commands, composition/readiness checks, typecheck, lint, 133 tests in 15 files and build. Diagnostic HTTP/WebSocket direct and Vite-proxy startup checks passed with no provider environment variables. Real product integrations and browser visual acceptance remain outside this result.

## Objective and boundaries

Make the existing checkout ready for all six confirmed owners to start their first tasks independently against the same runnable contracts. Preserve the confirmed responsibilities, workload ratings, existing diagnostic service and all current uncommitted documentation. The original preparation authorization excluded Git publication and remote changes; subsequent task-branch publication requires separate user instructions. Never submit coursework. Repository documents remain English; Chinese understanding copies remain in OneDrive.

This increment prepares shared engineering infrastructure. Real dialogue/decision providers, Kokoro/VTS integration, production playback, SQLite business implementation and the completed VTuber coordinator remain the respective owners' work. Test adapters must be named and presented as fixtures, never reported as working product integrations.

## Planned work and completion evidence

| Work | Concrete output | Evidence required before declaring readiness |
| --- | --- | --- |
| 1. Stabilize contracts | Exact C1–C7 data shapes, shared types, strict boundary validation, cancellation/error semantics and minimal adapter interfaces. Resolve connection bootstrap, trusted control attribution, monotonic deadline ownership, storage acknowledgements and receipt reconciliation consistently with current invariants. | Valid/invalid payload tests; all consuming examples compile; browser-facing contracts contain no Node-only imports. Diagnostic protocol 1 and application contract 0.2 remain explicitly distinct. |
| 2. Supply independent development fixtures | Deterministic candidate messages, dialogue segments, capabilities, dispatches, receipts and persistence substitutes; controllable completion/cancellation/failure. Reusable conformance suites and an actual command for each M1–M6 owner, with instructions for substituting their implementation. | All six commands execute real positive and negative cases without live services. Deliberately faulty fixture implementations fail the relevant tests. No skipped suites or pass-with-no-tests shortcuts are counted as evidence. |
| 3. Verify cross-module composition | An offline contract runner using explicit test adapters, showing normal selection/intent-to-delivery flow, cancellation, stale results, duplicate handling and interrupted delivery. | C-01/C-03/C-04/C-13 traces preserve identities and observed delivery. Additional relevant C-02/C-06/C-07/C-10/C-11/C-12/C-14/C-15/C-17 boundary cases exercise invalid data, authority, isolation and failure behavior. A fixture trace is not proof of completed production runtime/audio/database behavior. |
| 4. Connect requirements and tests | Machine-readable requirements/first-slice fit criteria with sources and schema; a compact trace/approval record linking requirements, C-cases and owners. Unmeasured full-product latency/quality/cost targets remain explicitly pending. | Registry validation rejects bad entries; every first-slice acceptance obligation has a meaningful test. The record identifies actual reviewer decisions without claiming that every member personally approved them. |
| 5. Provide practical collaboration checks | Update initial CI with the implemented readiness checks; lightweight shared-boundary and browser/server import checks; accurate agent launch instructions and a short PR/handoff checklist. | Existing checks and the new readiness command pass; representative violations are caught. Test approval precedes implementation in the real work record. Remote branch protection and full production semantic gates are not claimed as configured. |
| 6. Make the starting point usable | Each role has its directory, first task, exact imports, runnable example/test command, dependency substitutes, allowed edit boundaries and acceptance result in the English repository plan. Refresh adjacent Chinese/English review copies in OneDrive. | Exercise the documented commands from an isolated clean copy of the versionable working tree, without local credentials, ignored config, node_modules or OneDrive references. Confirm no raw working evidence, generated data, credentials or Chinese documents are accidentally included in that copy. |

## Execution and review

All project code and code/configuration changes are authored through a genuine OpenCode session using the established model, pure build agent and xhigh variant. The supervisor reviews its concrete contract/test design before implementation and drives subsequent fixes. Read current library documentation first; Zod 4 is the proposed shared schema dependency, while existing Node.js/TypeScript/pnpm/Vitest remain. Install dependencies through pnpm and record exact resolved versions. Prefer a small explicit design over new frameworks or a service-per-member structure.

Sequence: preserve baseline → resolve interface gaps and review tests → implement shared contracts → add fixtures and per-role conformance suites → add composition and readiness checks → verify isolated-copy onboarding → synchronize documents and record remaining production work.

## Risks and rollback

The main risks are freezing incomplete interfaces, making fixtures look like real features, leaking backend dependencies into browser code, expanding beyond shared preparation, and overwriting existing edits. Keep separate diagnostic/application boundaries, explicit fixture naming, actual negative tests and an unchanged allocation table. Treat missing live-provider evidence as missing rather than a pass.

Before editing implementation files, capture the existing versionable worktree and hashes outside the checkout, including current uncommitted documents. If rollback is needed, restore only files changed by this increment and remove only its newly created files after checking for later edits. Do not use git reset/clean/stash or overwrite unrelated work. Preserve OpenCode and validation evidence externally.

## Approval and interface evolution

The user approved this specific six-part plan after reviewing its Chinese explanation on 2026-10-10. Ordinary implementation, dependency installation, verification and reversible fixes within this scope may proceed without repeated approvals. Git publication requires separate user instructions; PR merging remains human-only.

Contracts establish an initial shared baseline, not a permanent freeze. Compatible changes update examples and checks; breaking changes require coordinated producer/consumer migration. The supervisor records actual review decisions and does not claim that all team members have reviewed implementation details.
