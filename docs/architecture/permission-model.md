# Permission model for task-local coding agents

Status: **proposal (M5), under review.** This document is not adopted by the team, not enforced by
branch protection, and not evidence that a member accepted it. No human author or human adoption is
claimed.

Revision: 2026-11-25.1. Reconciled against `main` `e2166cd047537042bd58a3c9999515fa9caf96e1`.
The earlier candidate was prepared against `main` `e32bf1a6b532112ae00d9f29345668016f0f3a3a`; its
version-bound observations are kept separately in §10.

## 1. Purpose and course basis

The project specification requires a permission model with file-level read/write rights for each AI
coding-agent role, default no read and no write, and an explicit whitelist for every permitted path
(D2 item 6, PDF page 5). The coding-governance deliverable additionally requires a machine-readable
policy in `.opencode/permissions.jsonc` with guard rules and enforcement mechanisms (D3, PDF pages 5–6).

This model covers six module roles, M1–M6. It separates **policy** (what a role may do) from **runtime
configuration** (which provider, model or plugin a member uses). Provider, model, credentials and global
plugin state are local; they are not committed in the policy.

## 2. Design

1. **Default deny.** Every action and resource is denied unless a later rule allows it.
2. **Explicit read whitelist.** Reads are limited to the repository paths listed in
   `.opencode/permissions.jsonc`. Anything outside that list, including `.git`, `node_modules`,
   `.env*`, databases, caches and raw evidence, is denied.
3. **Role-scoped writes.** A role may edit only its own source, its named tests, its handoff and the
   append-only AI-use log. Every other write requires a named approval class.
4. **One build agent.** The generated configuration contains one agent, `build`. The model and plugin
   exclusions are supplied by the member at generation time and recorded in the sidecar; they are not
   part of the committed policy.
5. **Policy is not auto-loaded.** `.opencode/permissions.jsonc` is a policy source. It is not an
   OpenCode configuration file. The compiler in `tools/opencode/` reads it and emits ordinary JSON under
   `.cache/opencode/`; that generated file is the task-local configuration.
6. **No OS sandbox claim.** A path policy and a shell allowlist are tool policies, not operating-system
   containment. Allowed test commands execute arbitrary project code with the member's OS rights.

## 3. Role and path matrix

| Role | Owned source | Named tests | Handoff |
| --- | --- | --- | --- |
| M1 | `src/performance/**` | `m1-*` tests, conformance/support kits and live Kokoro files listed in the policy | none |
| M2 | `src/console/**` | `test/offline/m2-console.test.ts`, console conformance and browser files | none |
| M3 | `src/decision/**` | `test/offline/m3-decision.test.ts`, decision conformance/support/fixtures | none |
| M4 | `src/dialogue/**`, `prompts/dialogue/**` | `test/offline/m4-*.test.ts`, dialogue conformance and kit | `docs/team/HANDOFF-M4-01.en.md` |
| M5 | `src/runtime/**` | `m5-*` tests, `production-cli.test.ts`, runtime conformance and support kits | `docs/team/HANDOFF-M5-*.md`, `docs/team/HANDOFF-I1-APPLICATION.en.md` |
| M6 | `src/storage/**`, `src/evaluation/**`, `.github/workflows/**` | `m6-*` tests plus the gate/readiness test files listed in the policy | none |

All roles may append to `docs/ai-use-log.yaml`. Append-only behaviour is a review rule, not something a
path policy can enforce.

## 4. Read whitelist

Reads are allowed for the repository's documentation, source, tests, prompts, public assets, CI files,
the two rule directories, the local tooling directory and the generated configuration directory. The
exact list is in `.opencode/permissions.jsonc` under `read`. It includes root documents (`AGENTS.md`,
`Prompt.md`, `README.md`, `architecture-blueprint.md`), package and TypeScript configuration,
`docs/**`, `src/**`, `test/**`, `prompts/**`, `public/**`, `.github/**`, `.opencode/**`, `.agent/**`,
`tools/**` and `.cache/opencode/**`.

The list is deliberately broad inside the checkout because a member must be able to trace callers before
changing an interface. It is still an explicit whitelist: a path not matched by the list is denied.
Directories outside the checkout are denied.

## 5. Approval classes

A write outside the role's own paths needs one of five named approvals:

| Class | Opens | Notes |
| --- | --- | --- |
| `shared_contracts` | `src/contracts/**` | Producer/consumer review still applies. |
| `manifests` | `package.json`, lockfile, workspace, tsconfigs, Vite/Vitest/oxlint config | M5 coordinates shared manifests. |
| `frozen` | The three paths in `docs/architecture/frozen.yaml` | A distinct approval; `shared_contracts` alone does not open a frozen path. |
| `governance` | `AGENTS.md`, `Prompt.md`, `.opencode/**`, `.agent/**`, `docs/code-governance/**`, `docs/architecture/**`, `docs/req/**`, `.github/PULL_REQUEST_TEMPLATE.md` | Reviewer-managed documents. |
| `other_modules` | Other modules' source, tests, prompts and handoffs | Cross-module edits need the owning member's review. |

A generated configuration records the grants used. A later `--check` run must pass the same grants to
match.

## 6. Protected paths

These paths are never grantable by an approval class:

- `opencode.json` (the member's private effective configuration)
- `docs/architecture/frozen.yaml`
- `.opencode/permissions.jsonc`
- `.opencode/rules.md`
- `.agent/rules.md`
- `tools/opencode/**`
- `.cache/opencode/**`

The protected list prevents an agent from changing the policy, the compiler, the frozen manifest or the
rule documents through an ordinary task grant. The derivation CLI remains the intended writer of
`.cache/opencode/`.

## 7. Credential boundary

The credential denial list is intentionally broad but must not block ordinary source names. The current
proposal denies:

```text
.env  .env.*  **/.env  **/.env.*  **/*.env
**/*secret*  **/*token*  **/*password*  **/*credential*
**/*auth.*  **/.auth*  **/auth/**
id_*  **/id_*  **/*.pem  **/*.p12  **/*.key
**/.ssh/**  **/.aws/**  **/.gnupg/**
```

It does not deny `src/dialogue/delivery-key.ts`, which is a normal source file. The earlier candidate
denied it through `**/*key*`; that false positive is removed. `.env.example` remains denied by `.env.*`;
it is not needed for coding tasks.

Tests may evaluate fake path strings against the matcher. Native canaries must never use a real
credential-shaped file or a real secret value. A harmless synthetic path is used instead.

## 8. Shell and command boundary

The shell allowlist contains exact command strings for common checks and each role's test command. It
includes both plain and observed RTK-rewritten forms (`git status --short`, `rtk git status --short`,
`git diff`, `rtk git diff`, `pnpm lint`, `rtk lint`). The rewrite was observed with RTK 1.1.0 in the M5
controller on 2026-11-01; it is an environment fact, not a team-wide assumption.

The allowlist is not containment. A permitted `pnpm test` can execute arbitrary project code, and an
unlisted wrapper is denied only if the native matcher sees the exact command string. Native behaviour
must be observed in a disposable worktree, not inferred from the policy file.

## 9. Enforcement and load procedure

1. `.opencode/permissions.jsonc` is the policy source. It is not read by OpenCode automatically.
2. The compiler emits ordinary JSON under `.cache/opencode/` for one role and one task. The generated
   file contains the selected agent, the member-supplied model, optional plugin exclusions, and the
   ordered permission rules.
3. In a disposable worktree with no existing `opencode.json`, the generated file may be activated as
   that worktree's `opencode.json`.
4. `OPENCODE_CONFIG` is not necessarily the final effective layer. Project, inline or administrator
   configuration can override it. The load is proven only by a native observation in the target
   worktree.
5. The sidecar records the policy hash, configuration hash, role, task, grants, agent, model, plugin
   exclusions and `status: "under-review"`. `--check` recompiles and fails on drift.
6. Plugin exclusion uses the observed V2 form `plugins: ["-<name>"]`; a bare name would request the
   plugin rather than exclude it.

## 10. Version-bound evidence and reconciliation

The earlier candidate (`local/m5-governance-20261101` `88ab330`, refreshed as
`local/governance-main687-20261106` `38ab1f1` on `main` `687a5c8`, and again as
`local/governance-refresh-20261120` `438fa41`/`e5f631d` on `main` `e32bf1a`) recorded:

- a native `/api/agent/build` read accepted the generated `plugins` and `agents.build.permissions` shape;
- an explicit resolver matched 12/12 ordinary path/command cases;
- a bounded native session matched eight expected tool outcomes;
- the corrected compiler emitted 301 effective rules and the focused test suite passed.

Those results are historical and version-bound to that candidate, its policy text and that environment.
They are not current-`main` evidence. The refresh removes the candidate's committed provider, model and
plugin values, so the generated configuration shape differs from the observed one until it is regenerated
and re-observed.

The 2026-11-25 refresh runs on `main` `e2166cd`. OpenCode is `v2.4.1`. In a disposable directory outside
the checkout, the generated configuration was activated as that directory's `opencode.json`:

- `opencode debug config` listed the generated document with 317 ordered rules, model
  `self-api/deepseek-v4-flash` and `plugins: ["-oh-my-opencode-slim"]`.
- A bounded native session read `README.md` (allowed) and `synthetic-canary.txt` (denied with
  `Permission denied: read`).
- A second bounded native session wrote `src/runtime/preflight-allowed.txt` (allowed) and
  `src/decision/preflight-denied.txt` (denied with `Permission denied: edit`).

The synthetic paths were harmless text files; no credential-shaped file or real secret value was used.
These observations establish native load and deny behaviour for this candidate in that directory. They
do not establish branch protection, team adoption or any G4 result. The original session exports and
environment details are kept in the external evidence directory, not in the checkout.

The policy path audit against `e2166cd` resolves every existing path; the only unresolved entries are the
`.opencode/**`, `.agent/**`, `.cache/opencode/**` and protected paths that this proposal introduces or
generates.

## 11. Limits and open decisions

- The read whitelist is directory-level and broad inside the checkout. If the reviewer reads
  "file-level" strictly, replace directory globs with an explicit file inventory before adoption.
- `.opencode/rules.md` is human-only. An agent-prepared draft is not adoption.
- `.agent/rules.md` remains reviewer-managed and needs owner review.
- The model, provider and plugin exclusion are local inputs. The committed policy contains no credential
  or gateway route.
- The policy is advisory until a native load and branch-protection decision are recorded. It does not
  activate G1, G4 or any blocking gate.
- RTK rewriting and exact shell matching are environment-specific and must be re-observed after a tool
  upgrade.

## 12. Related D2 records

The qualitative architecture candidate comparison is
[`candidate-comparison.md`](candidate-comparison.md). Measured results are reserved for
`docs/architecture/evaluation-table.md` under G4; that gate is **not run** for this candidate, and this
document makes no numeric claim.

## 13. Rollback

Delete the new files and revert the small index/AGENTS/Prompt additions. Generated configurations and
canaries live under `.cache/opencode/` and are not part of the change. No database, dependency or remote
setting is modified.
