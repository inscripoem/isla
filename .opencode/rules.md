# Always-on coding-agent rules

Status: **DRAFT FOR HUMAN REVIEW — not adopted.** This file is human-only by the course
specification. It was prepared by an agent under CHANG Xuben's local authorization and does not claim
human authorship or adoption. Until a human reviewer edits this file and records adoption, `AGENTS.md`
governs and this file has no operative authority.

## Authority

`AGENTS.md` is the single entry point. `Prompt.md` is the static launch instruction. The machine-readable
role/path policy is `.opencode/permissions.jsonc`; the compiler is in `tools/opencode/`. This file states
the always-on behavioural rules a human reviewer expects the build agent to follow.

## Rules

1. **Default deny.** Act only within the role and paths named by the current task. Anything else is
   denied, not inferred.
2. **One role per task.** A role owns its source directory, its named tests and its handoff. A
   cross-module change needs the owning member's review and the matching approval class.
3. **Plan before code.** Read `AGENTS.md`, `Prompt.md` and the selected task, inspect the implementation
   and callers, then present the execution plan required by `Prompt.md`. Wait for explicit human
   approval before generating code.
4. **Approvals are named.** Shared contracts, manifests, frozen paths, governance documents and other
   modules are separate approvals. A shared-contract approval does not open a frozen path.
5. **Protected files stay closed.** Do not edit `opencode.json`, `docs/architecture/frozen.yaml`,
   `.opencode/permissions.jsonc`, this file, `.agent/rules.md`, `tools/opencode/**` or generated output
   under `.cache/opencode/**`.
6. **Credentials are never read.** Do not read, display, log or commit `.env`, secret, token, password,
   credential, private-key, PEM/P12, `id_*`, `.ssh`, `.aws` or `.gnupg` material. `.env.example`
   documents variable names only and is not a credential file.
7. **No delegation.** Do not spawn subagents or hand the task to another agent.
8. **No Git or remote mutation.** Do not stage, commit, push, merge, rebase, reset, delete branches or
   publish without an explicit human instruction. Never merge a pull request.
9. **Shell is not a sandbox.** The allowlist is a convenience boundary. A permitted test command can
   execute arbitrary project code. An unlisted wrapper is denied only if the native matcher sees the
   exact string. RTK rewrites observed in one environment are listed explicitly; they are not a wildcard
   grant.
10. **Verify honestly.** Run the role command, the relevant failure cases and the full suite required by
    `AGENTS.md`. Report failures, skips and unknowns. Fixture results do not establish live providers,
    acoustic output or product acceptance.
11. **Keep context fresh.** When a requirement changes, update the affected rules, prompt, permission
    model and tool manifest within one sprint, and record the change in `docs/ai-use-log.yaml`.

## Adoption

A human reviewer must adopt, rewrite or reject these rules. Until then this file is a proposal, and the
local tests do not make it operative.
