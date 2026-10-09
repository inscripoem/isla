# Isla development instructions

Address the user as Captain. Use formal English for code, comments, UI and repository documentation. All Chinese counterparts, review-only drafts, planning archives and raw working records remain in the separate OneDrive course workspace or external evidence directory, never in this repository. Never submit coursework.

## Current authorization

On 2026-10-09 the user confirmed the original runnable-foundation scope after briefly narrowing it to the official template. The official Vite React TypeScript template is now installed. Continue only with a minimal runnable page/backend health boundary, validated diagnostic messages, basic tests, CI and concise English run/module instructions. Do not implement LLM dialogue, response decisions, TTS/VTS live integration, database business logic or the full VTuber pipeline. SQLite and separate TTS/player/renderer adapters are selected future directions. No runtime provider calls or model downloads.

The supervising reviewer has approved the foundation plan and test expectations: successful honest health response; malformed, unsupported-version and unknown/unimplemented diagnostic messages rejected; loopback binding, explicit listen failures and clean shutdown. Keep diagnostics distinct from the future v0.2 application protocol; unsupported application commands must not appear successful. Additional changes within this scope may be reviewed and driven by the supervising assistant without another user confirmation.

## Layout and tools

All application code is authored by OpenCode; preserve real sessions. Use official framework scaffolding CLI and pnpm dependency commands. Keep a single package with src/console, src/runtime and src/contracts; document future module ownership without empty implementations. Tests use test/offline and test/live. The course also requires docs/req, docs/architecture, docs/code-governance, prompts, transcripts and .github/workflows as work develops; do not invent final deliverables or evidence.

Read Prompt.md and architecture-blueprint.md, then the actual existing source. The reviewer has checked Vite, pnpm, ws and Vitest documentation through Context7. New dependencies or uncertain configuration require documentation verification. Prefer flat modules, explicit state, small functions and observable tests. Trace consumers before changing shared contracts.

No Git mutations, commits, pushes, remote changes or subagents. No destructive cleanup; move unused generated assets to ignored .scaffold-temp. Never read/glob/grep/display secret values or secret-named files (.env, *secret*, *token*, *auth*, *key*, *password*, id_*, *.pem, *.p12, *.key). Do not write credentials. Existing development tools may load local credentials without exposing them. Do not alter global configuration or other projects.

AGENTS.md, Prompt.md, opencode.json and .opencode/ are reviewer-managed. The runtime uses opencode.json; tool permissions are not an OS sandbox. Keep pnpm storage under .cache/pnpm-store and all generated/cache files ignored, outside OneDrive. Do not import review-only or Chinese files into this checkout.

## Verification and handoff

Run the actual typecheck, lint, offline tests, build and local startup checks. Empty live suites are unimplemented, not passing provider tests. Initial CI must state its actual coverage and remaining course gates; do not claim branch protection or remote CI exists. The reviewer creates Chinese understanding copies separately in OneDrive.

Self-review high/medium/low findings and fix material issues. Report actual results, dependencies and limitations. Status remains under review until the user confirms; never mark the full project complete.
