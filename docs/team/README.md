# Team Development

Revision: 2026-10-31.2. Proposed coordination update, under review. Module allocation and product acceptance requirements remain unchanged.

## Find your work

Start from your role issue and follow its current task or PR. Inspect what already exists before starting another implementation.

| Role | Responsibility | Entry |
| --- | --- | --- |
| M1 | Speech, playback and avatar adapters | [Role issue #2](https://github.com/inscripoem/isla/issues/2) |
| M2 | Console input, controls and output state | [Role issue #3](https://github.com/inscripoem/isla/issues/3) |
| M3 | Response selection, intent and reactions | [Role issue #4](https://github.com/inscripoem/isla/issues/4) |
| M4 | Dialogue, persona and memory | [Role issue #5](https://github.com/inscripoem/isla/issues/5) |
| M5 | Runtime and team integration | [Role issue #6](https://github.com/inscripoem/isla/issues/6) |
| M6 | Storage, replay and evaluation tooling | [Role issue #7](https://github.com/inscripoem/isla/issues/7) |

Write an update on the actual PR when work is ready, a blocker needs another owner, or an estimate changes. Use the existing task issue if no PR exists. Include the result and its evidence link, next action and requested help. A result already recorded on the PR does not need another report on every linked issue.

Record consequential interface, scope and acceptance decisions briefly on the relevant task, PR or repository document. M5 maintains the [six-member progress summary](https://github.com/users/inscripoem/projects/4/views/2) and [next product check](https://github.com/users/inscripoem/projects/4/views/4); members do not maintain duplicate board fields or weekly capacity forms.

## Next product results

| Target, UTC+8 | Observable result |
| --- | --- |
| November 1, 21:00 | [First I1 check](https://github.com/inscripoem/isla/issues/72): run the agreed console combination and record actual results and gaps. |
| November 5, 21:00 | [Complete offline I1](https://github.com/inscripoem/isla/issues/73): console, rule decisions, dialogue, fixed audio/subtitles, receipts and recording work together. |
| November 8, 21:00 | [Live reference application](https://github.com/inscripoem/isla/issues/74): approved real services and target-machine output work through the product. |
| November 22, 21:00 | Complete submission candidate, with November 23-25 contingency. |

The [delivery plan](DELIVERY-PLAN.en.md) contains the full schedule and acceptance tests. Checkpoint 01 is M5's setup record under the proposed simpler process. Joint checks may use asynchronous consumer observations of the same agreed revision; record who actually ran each part and leave unobserved results as not-run.

## Develop and review

Use the [project README](../../README.md) for setup and run commands. Ask an agent to read [AGENTS.md](../../AGENTS.md), identify your role and inspect the next unfinished slice. Confirm its plan before code changes. Members do not need to repeat the project instructions or read every handoff before starting. [PLAN](PLAN.en.md) preserves the allocation and working directories; [READINESS-KITS](READINESS-KITS.en.md) gives the role commands and fixture-replacement instructions. [INTERFACES](INTERFACES.en.md) defines shared changes and consumer handoffs.

Use the short PR template for routine changes and include interface/state details when they change. Required checks and affected-consumer review still apply. Agents may publish only when explicitly authorized; a human performs the final PR merge and coursework upload.

## Reference material

Consult the relevant document when the task needs it; its original measurements and source versions remain historical evidence.

- Requirements and design: [candidate requirements](REQUIREMENTS.en.md), [machine-readable registry](../req/requirements.yaml), [architecture](../../architecture-blueprint.md), [readiness review](READINESS-REVIEW.en.md).
- Core handoffs: [M5 coordinator](HANDOFF-M5-01.en.md), [M4 dialogue](HANDOFF-M4-01.en.md), [delivery attribution](HANDOFF-M5-CONTRACT-A.en.md), [I1 application](HANDOFF-I1-APPLICATION.en.md).
- Runtime integration: [reconstruction](HANDOFF-M5-RECONSTRUCTION.en.md), [production composition](HANDOFF-M5-PRODUCTION.en.md), [dynamic audio](HANDOFF-M5-DYNAMIC-AUDIO.en.md), [physical synthesis](HANDOFF-M5-PHYSICAL-SYNTHESIS.en.md).
- Further consumers: [evaluation adapter](HANDOFF-M5-EVALUATION-ADAPTER.en.md), [VTS acquisition](HANDOFF-M5-VTS-ACQUISITION.en.md), [outcome and prepared-input follow-up](HANDOFF-M5-MENTIONS.en.md).

Repository collaboration documents are English. Chinese understanding copies and private evidence remain in OneDrive. Final course artifacts use the required paths and an explicit submission whitelist.
