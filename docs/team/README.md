# Team Development

Document revision: 2026-10-29.2. The team-confirmed allocation is unchanged.

For progress, start with the [submission checkpoints](DELIVERY-PLAN.en.md): all ten acceptance targets, per-member deliveries and the November 23-25 contingency window. The public [Isla Roadmap](https://github.com/users/inscripoem/projects/4) provides a table for [Team progress](https://github.com/users/inscripoem/projects/4/views/2), a roadmap for [Checkpoints](https://github.com/users/inscripoem/projects/4/views/3) and a status board for [Next checkpoint](https://github.com/users/inscripoem/projects/4/views/4). All 50 delivery items are linked. Checkpoint 01 is in progress; acceptance and owner forecasts remain pending.

The linked handoffs below retain the evidence scope and source revision in each file. Their old "local only" or PR-status wording is historical, not the current delivery queue. Original role issues #2-#7 remain the member entry points; update the linked delivery once rather than duplicating status in every document.

Start an agent from the repository root with a short request such as "I am M3. Start my first task." [AGENTS.md](../../AGENTS.md) maps the role to its task, directories, tests and planning workflow. If the tool does not load AGENTS.md automatically, explicitly ask it to read that file. Review its proposed plan before authorizing code changes; members do not need to repeat the full project instructions in each prompt.

| Document | Purpose |
| --- | --- |
| [Current delivery sequence](DELIVERY-PLAN.en.md) | Submission schedule, checkpoint acceptance, owners, PR-sized deliveries and dependencies |
| [Work plan](PLAN.en.md) | Confirmed roles, working directories, editing boundaries and first parallel tasks |
| [Candidate requirements](REQUIREMENTS.en.md) | Six functional and six non-functional candidates, invariants and acceptance gaps |
| [Interfaces and handoff](INTERFACES.en.md) | C1–C7 contracts, existing acceptance-case IDs and integration responsibilities |
| [M5-01 handoff](HANDOFF-M5-01.en.md) | Production coordinator, actual verification, configuration and per-owner I1-01 requests |
| [M4-01 handoff](HANDOFF-M4-01.en.md) | Production dialogue/persona/memory module, merged PR30 contract adoption and consumer handoff |
| [M5 Step A handoff](HANDOFF-M5-CONTRACT-A.en.md) | Delivery attribution, explicit segment indices, reconciled shared-storage tests and M4/M6 rollout review |
| [I1 application handoff](HANDOFF-I1-APPLICATION.en.md) | Local application transport, fixed-audio browser demo, authority rules and M2 integration; acceptance scoped to its recorded version |
| [M5 reconstruction handoff](HANDOFF-M5-RECONSTRUCTION.en.md) | Ordered archive selection, fail-closed validation, reconstructed runtime binding and loopback evidence; version-bound evidence |
| [M5 production composition handoff](HANDOFF-M5-PRODUCTION.en.md) | Production application over the real SQLite backend, controlled shutdown, deployment module contract and remaining peer dependencies; version-bound evidence |
| [M5 dynamic audio handoff](HANDOFF-M5-DYNAMIC-AUDIO.en.md) | Same-origin `POST /audio` resource route, authoritative lifecycle/scope rechecks, response-lifetime lease ownership and the assembled-turn and real-browser acceptance; version-bound evidence |
| [M5 physical synthesis handoff](HANDOFF-M5-PHYSICAL-SYNTHESIS.en.md) | Retained M1 adapter/provider, originating gate, physical settlement and owned release through actual worker exit; version-bound evidence |
| [M5 evaluation adapter handoff](HANDOFF-M5-EVALUATION-ADAPTER.en.md) | Real coordinator execution for the M6 runner, evidence-based outcomes, unknown metrics and cleanup diagnostics; version-bound evidence |
| [M5 mention follow-up](HANDOFF-M5-MENTIONS.en.md) | Local M4 outcome consumer integration, deadline handling, bounded input preparation and owner review limits |
| [Readiness kits](READINESS-KITS.en.md) | Per-role commands, ports to implement, fixture replacement instructions and version-change coordination |
| [Readiness review](READINESS-REVIEW.en.md) | Supervisory review of the approved contract and test design |
| [Requirements registry](../req/requirements.yaml) | Machine-readable requirements with JSON schema, PRD and trace record under `docs/req/` |

Start by running the [foundation](../../README.md), then review the first offline contract/examples in the work plan. Members can implement their existing first tasks in parallel against the shared contracts in `src/contracts/app/` and the explicit fixtures in `test/support/`. Shared schemas, ports and conformance kits exist; passing a fixture kit proves contract boundaries, not live providers, browser audio or SQLite behavior.

Directory conventions are maintained in [the architecture blueprint](../../architecture-blueprint.md). Do not create placeholder implementations merely to match the table. Current repository documents are English only. Chinese understanding copies, raw internal evidence and historical sharing ZIPs remain in OneDrive; English collaboration documents are the working reference.

These files support ordinary team coordination and are not substitutes for the course-prescribed YAML registry, schema, architecture and governance artifacts. Prepare the final coursework package from an explicit deliverable whitelist rather than archiving the entire checkout.

Agents may prepare and publish a task branch or PR when explicitly instructed. Agents must never merge PRs, enable auto-merge or enqueue a merge; the final merge is performed by a human team member.
