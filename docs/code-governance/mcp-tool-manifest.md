# MCP and tool manifest

Status: **proposal (M6), for team review.** Owner: M6 (tooling) with M5 coordination. Revision 2026-10-16.1.
Course deliverable: **D3 (coding governance)**. Companion: [`structural-constraints.md`](structural-constraints.md).

The agent's external surface — the tools and context sources it may use — is part of the coding
governance, because a tool can read or change state the repository does not control. This manifest records
what is configured today and governs every extension of it.

## Current configuration

**No MCP servers are configured.** `list_mcp_resources` returns no servers, resources or templates, so no
third-party resource is exposed to the agent at this time. This is the honest current state; it is not a
gap to be filled by inventing a server.

## What is authoritative

The repository is the single source of truth ([`structural-constraints.md`](structural-constraints.md) §5).
A tool result is **evidence about** the world, not an override of the repository: it may inform an edit, but
it never replaces a committed artifact, and a claim that cannot be reproduced from the repository whenever
the repository can establish it is not evidence the gates read.

## Declared surface (beyond MCP)

| Source | Kind | Governance |
| --- | --- | --- |
| Language model provider (OpenCode + official DeepSeek) | generation | the session is recorded in `docs/ai-use-log.yaml`; raw exports stay outside the checkout (§5) |
| Context7 documentation lookup | read-only reference | consulted before introducing an unestablished library/API or uncertain configuration (`AGENTS.md`) |
| Repository filesystem, test runner, `git`/`gh` CLI | local tools | mutations only on explicit instruction; **agents never merge** (`AGENTS.md`) |

## Policy for adding an MCP server or tool

1. **Propose, do not silently enable.** A new server is a governance change: propose it in the coordination
   thread with the resource(s) it exposes **before** any configuration lands.
2. **Least privilege.** Read-only unless a specific, reviewed use requires a write; a write-capable tool must
   name the paths or state it may change.
3. **Approval and ownership.** The configuration is reviewer-managed (`AGENTS.md`); the proposer owns the
   manifest update in the same change.
4. **Secrets.** Never read, display or log secret values (`.env`, `*secret*`, `*token*`, `*auth*`, `*key*`,
   `*password*`, `id_*`, `*.pem`, `*.p12`, `*.key`); credentials are never written to the repository. A tool
   that needs a credential takes it from the environment, never from a committed file.
5. **Evidence, not trust.** Where a resource's output supports a claim, reference it by id or hash; the
   claim must remain reproducible without the tool whenever the repository can establish it.
6. **Record it here.** Every enabled server or tool appears in this manifest with its scope and approval; an
   enabled tool that is not listed is a defect.

## Review checklist for a proposed server

- [ ] Named owner and the resource(s) exposed.
- [ ] Read-only, or a write scope that is stated and reviewed.
- [ ] No secret value in the configuration or in any committed file.
- [ ] Evidence path recorded, consistent with §5 tiers.
- [ ] This manifest updated in the same change.
