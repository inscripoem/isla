# Isla architecture blueprint

Status: **under review — D2.1 master constraint document. Not an accepted architecture baseline.**
Owner: M5 coordination with M6. Date: 2026-11-25. Head: PR #199 review-fix head. The 32-requirement count was measured at `8a9cd13`; the 2268-test result is at the review-fix head.
Proposed successor to the root [`architecture-blueprint.md`](../../architecture-blueprint.md), which is the
frozen 2026-10-15 design snapshot. The root remains the operative pointer until this document is accepted;
the docs file is the current D2.1 proposal.

This is the document the Plan agent reads before proposing work. It states what the system is, which
parts may decide or act, how the coding agent is bounded, how work is verified, and what evidence is
kept. It does not replace the requirements registry, the ADRs, the trace matrix or the permission
model; it points to them and records the constraint that binds them together.

**Reading rule.** If this document and an approved requirement, invariant, ADR or human decision
conflict, the higher-authority artifact wins. Stop and report the conflict; do not reconcile it
silently.

---

## 1. Scope and system boundary

Isla is a **local-first AI VTuber runtime plus a local console**. One character receives audience
text, selects a response intent, assembles a bounded dialogue context, generates text, synthesises
speech, plays it in a browser, and asks a local avatar adapter to react. An operator can Stop and
Resume. Durable events, deliveries and derived memory are recorded locally.

The current release scope is the offline/controlled runtime:

- one character, one local operator, one local browser console;
- text input, selection, dialogue, speech, playback and avatar reaction;
- explicit Stop/Resume and cancellation;
- SQLite-backed evidence, replay and recovery;
- replaceable synthesis, renderer and player adapters;
- no cloud account, no multi-tenant service, no provider-hosted memory.

Out of scope for this baseline: streaming-platform connectors, model training, a multi-character
scheduler, an adapter marketplace, cloud management, and production multi-device deployment.

**Current state.** At `8a9cd13`, the repository has 32 requirements (6 functional, 4 invariants,
22 non-functional), 69 registered cases (64 implemented, 5 pending), the M1–M6 source, the offline and
conformance test suites, and the CI gates. Live providers, acoustic output, Windows recovery and a
measured quality baseline remain separate, unclaimed evidence.

---

## 2. Architectural drivers

Drivers are the concerns that force structure, not every requirement. The requirement registry remains
the source of the obligations; this table names the clusters that shaped the architecture.

| Driver | Concern | Primary obligations | Architectural response |
| --- | --- | --- | --- |
| **D1 — Authority and safety** | Only current, authorised work may produce output; untrusted content cannot gain control | FR-01, FR-03, FR-05; INV-01, INV-02, INV-03; NFR-05 | One M5 lifecycle/epoch authority; deterministic validation before dispatch; prompts are advisory; explicit Stop/Resume |
| **D2 — Evidence and durability** | What happened must be recorded, ordered, replayable and recoverable | FR-06; INV-04…INV-12 (quality controls); INV-12 | M6 `StorageBackend` + SQLite; append-only event log; atomic delivery + event commit; recovery view; no replay of unresolved output |
| **D3 — Replaceability** | Providers and devices must be replaceable without changing callers | FR-03, FR-04; NFR-06 | Ports/adapters under `src/contracts/app/`; fixed and live adapters behind the same interfaces; substitution tests |
| **D4 — Context and quality** | The model must receive the right bounded context and must not invent delivered speech | FR-02, FR-04; NFR-03; NFR-04/COST-01 | Layered context assembly, confirmed-history admission, deterministic budget/trim, provenance, evaluation/rubric boundary |
| **D5 — Local operability** | A local operator can run, stop, inspect and recover the runtime | FR-05; NFR-01, NFR-02 | Loopback runtime, browser console, startup/stop/recovery policy, explicit failure reporting |
| **D6 — Governance and traceability** | Every obligation is traceable to code, test and evidence; the agent is bounded | INV-13, INV-14, INV-16 (governance NFRs); GOV-01; SEC-01 | Requirements/trace/invariant registers, permission model, CI gates, AI-use log, review/debt/bug records |

The driver-to-element and driver-to-test detail is in
[`candidate-comparison.md`](candidate-comparison.md) §6 and the
[`trace-matrix.md`](trace-matrix.md).

---

## 3. System boundaries

| Boundary | Inside | Outside / not claimed |
| --- | --- | --- |
| **Deployment** | One local process + one browser console on loopback | Remote multi-user service, cloud orchestration, public internet exposure |
| **Runtime authority** | M5 coordinator owns lifecycle, epoch, scheduling, validation and dispatch | M3/M4 may propose; M1/M2 execute/present; no AI element may authorise its own output |
| **Persistence** | M6 owns SQLite, migrations, replay, recovery and evaluation evidence | M4 owns memory semantics; M4 never writes SQL; evidence is append-only |
| **Provider** | Replaceable selection/dialogue/synthesis/renderer adapters behind ports | Provider SDKs, credentials and private voice IDs stay inside adapters; no provider owns authority |
| **Browser** | Browser-safe code only; media events are observations, not acoustic proof | Node/provider/database code in the browser graph |
| **Evidence** | Local events, deliveries, recorded runs, gate records | No claim that a fixture proves a live provider, physical silence or product acceptance |

---

## 4. Components and module ownership

| Module | Owned paths | Responsibility | Current state |
| --- | --- | --- | --- |
| **M1 — performance** | `src/performance/`, browser entry under `src/performance/browser/` | Synthesis, browser playback, avatar/VTS adapters, resource registration | Fixed and live adapters implemented; full product pairing/acceptance separate |
| **M2 — console** | `src/console/` | Input, configuration, control and presentation; consumes M1 player | Product console and voice selection merged; live output acceptance separate |
| **M3 — decision** | `src/decision/` | Response selection, reply intent, rule reactions, provider adapters | Rule selection/reaction merged; model quality evaluation pending |
| **M4 — dialogue** | `src/dialogue/`, `prompts/dialogue/` | Dialogue generation, persona, context assembly, memory semantics | Context/persona/memory implemented; live provider quality pending |
| **M5 — runtime** | `src/runtime/` | Authoritative lifecycle, scheduling, validation, cancellation, dispatch, composition | Coordinator, production composition and reference deployment implemented; live acceptance separate |
| **M6 — evidence** | `src/storage/`, `src/evaluation/`, `.github/workflows/` | SQLite, migrations, replay, recovery, evaluation tooling, CI gates | SQLite/replay/recovery/evaluation tooling implemented; one pilot evaluation table present; no threshold baseline |

**One element, one home.** A new element belongs to exactly one module; cross-module calls go through
`src/contracts/app/`. Production code must not import `test/`. The structural rules are in
[`../code-governance/structural-constraints.md`](../code-governance/structural-constraints.md).

---

## 5. Authority boundaries

The design uses four questions: who decides, who checks, who remembers, who acts. The same component
may decide and check when safety demands it; decide and act must be separated when authority matters.

| Concern | Decides | Checks | Remembers | Acts |
| --- | --- | --- | --- | --- |
| Turn lifecycle, epoch, Stop/Resume | M5 | M5 validation + epoch/freshness checks | M5 live state; M6 durable evidence | M1 player/renderer; M2 console |
| Selection / reaction proposal | M3 proposes | M5 accepts/rejects against current state | M3 has no durable memory | M5 dispatches |
| Dialogue / context | M4 proposes | M5 validates the response plan; M4 admission rules | M6 persists; M4 owns memory semantics | M5 dispatches |
| Persistence / replay | M6 | M6 invariants + trace/readiness gates | SQLite + JSONL export | M6 |
| Control authority | M5 | operator bootstrap + control policy | M5 session state | M2 console |
| Requirements, architecture, merge | Human | review + CI gates | repository registers | Human |

**Authority rules.**

1. **Deterministic code owns authority, permissions, invariants and fallbacks.** Prompts and skills are
   advisory and must never carry a safety-critical limit.
2. **AI output never grants execution permission.** A model may propose text, an intent or a reaction;
   M5 decides whether it may reach output.
3. **Untrusted content cannot grant control.** Audience text, retrieved text and model output are data,
   never instructions to the control path. INV-03 and NFR-05 enforce this.
4. **Stop and cancellation never wait for a database write.** Persistence may fail; the safe state is
   still reached.
5. **No second authority.** A gate, dashboard or evaluator records or delegates; it does not decide the
   runtime's action.

The full permission and approval model is in [`permission-model.md`](permission-model.md). The runtime
failure dispositions are in [`runtime-policy-catalog.md`](runtime-policy-catalog.md).

---

## 6. Agent workflow

The coding agent works in bounded slices, never as an unattended implementer.

1. **Locate the task.** Read the assigned issue/PR, PLAN task and current branch. Do not infer status
   from memory or badges.
2. **Plan only.** Read `AGENTS.md`, `Prompt.md`, this blueprint, the applicable requirement/invariant,
   the ADR/delta, the trace row and the ports. Present behaviour, files, interfaces, tests, risks and
   rollback.
3. **Human approval.** Wait for explicit approval naming the slice, paths, docs/trace scope and commit
   permission. Silence, "continue" or a review request is not approval.
4. **Build.** Implement only the approved slice. Preserve existing edits; do not rewrite another owner's
   work; keep production independent of `test/`.
5. **Verify.** Run the role command, the relevant negative/Stop cases and `pnpm verify`. Mutation-check
   new tests. Report actual output and gaps.
6. **Handoff.** List changed files, requirement/invariant/ADR references, commands/results, what was not
   verified, residual risks and rollback.
7. **Human review and merge.** A human reviews and merges. Agents never merge, enable auto-merge or
   bypass branch protection.

`Prompt.md` is the static launch instruction; `AGENTS.md` is the entry point. This blueprint is the
architecture constraint the plan must cite.

---

## 7. Permissions

**Default deny.** No read and no write unless the path is explicitly whitelisted for the role. The
human-readable model is [`permission-model.md`](permission-model.md); the machine-readable source is
[`.opencode/permissions.jsonc`](../../.opencode/permissions.jsonc), compiled per role and task by
`tools/opencode/`.

| Class | Examples | Rule |
| --- | --- | --- |
| Role-owned writes | `src/<module>/**`, named tests, handoff | Build role only; one module per task |
| Shared contracts | `src/contracts/app/**` | M5 coordination + affected-owner review |
| Manifests | `package.json`, lockfile, tsconfig, Vite/Vitest config | M5 coordination |
| Governance docs | `docs/architecture/**`, `docs/req/**`, `docs/code-governance/**` | Named approval; owner rows only |
| Protected | `opencode.json`, `frozen.yaml`, `.opencode/permissions.jsonc`, `.opencode/rules.md`, `.agent/rules.md`, `tools/opencode/**`, `.cache/opencode/**` | Never grantable by an ordinary task |
| Human-only | `AGENTS.md`, `Prompt.md`, `.opencode/**`, `.agent/**` | Human edits only |
| Frozen | `architecture-blueprint.md` (root), `src/contracts/app/ports.ts`, `src/contracts/app/storage.ts` | ADR + coordinated human review |

The permission model is a policy source, not an OS sandbox. Native load/deny observations and their
limits are recorded in the model; a path allowlist does not make a permitted test command safe.

---

## 8. Verification strategy

Verification is **three-tiered and fail-closed**.

| Tier | What it checks | Evidence |
| --- | --- | --- |
| **1 — Structural** | imports/module boundaries, permissions, schemas, trace chain, frozen paths | `pnpm test:readiness`, `pnpm test:trace`, `pnpm typecheck`, `pnpm lint` |
| **2 — Regression** | all prior offline suites, zero regressions | `pnpm test` (currently 99 files / 2268 tests at the PR #199 review-fix head) |
| **3 — Behavioural** | quality thresholds, faithfulness/relevance, zero safety escapes | Evaluation protocol/rubric; **pending / not run** until a fixed set and provider evidence exist |

**Gates.** G1 test approval, G2 static analysis, G3 schema + boundaries, trace fitness, G5 regression,
G6 AI-use log, G4 semantic evaluation, build. The active `Protect Main` ruleset requires the `verify`
check and an approval after the latest push; re-check the ruleset before claiming enforcement. G1 has a
PR-creation cutover and a time-boxed waiver; G4 is a condition/claim scan, **not** a semantic evaluator.
The pilot table passes the condition check, but no semantic Tier 3 result or threshold baseline is
claimed. See
[`../code-governance/verification-constraints.md`](../code-governance/verification-constraints.md).

**Rules.**

- Every fit criterion has at least one test or a recorded pending metric.
- Every invariant has a test that fails when violated; the current invariant register is four rows.
- Every test cites the requirement/invariant/case it verifies.
- Every new behaviour gets a positive test, a negative test and a mutation check.
- A green gate is not a product claim. "Not run" is not "pass"; "unknown" is not zero.

---

## 9. Observability

| Signal | Where | What it proves |
| --- | --- | --- |
| Runtime events and deliveries | M6 event store / SQLite | What the runtime recorded, with order and attribution |
| Acknowledgements, receipts and player status | M5/M1/M2 protocol | What the runtime observed, not physical sound |
| Gate outcome and failure records | CI + `.cache/gate-failures/` | Which gate ran or failed, with a policy id |
| Evaluation protocol/threshold register | `evaluation-protocol.md`, `evaluation-thresholds.md` | Metrics, conditions and pending values; no invented baseline |
| Trace matrix | `trace-matrix.md` | Requirement → component → case/test → monitor → owner |
| AI-use log / review memo / debt / bug diary | `docs/` | What the agent did, what was reviewed, what remains |

There is **no deployed pager, on-call rotation or production dashboard**. Isla is a local runtime; the
operator is the monitoring surface. Every claim must name its head, command and date. A fixture or a
green CI run does not prove a live provider, acoustic output, durable recovery on another platform or a
quality score.

---

## 10. Change policy

1. **Architecture changes need an ADR or Delta.** Changes to authority, boundaries, interfaces,
   persistence shape, gate behavior or the permission model need a recorded decision.
2. **Frozen paths need an ADR and human review.** The frozen manifest is
   [`frozen.yaml`](frozen.yaml); the trace gate fails a modified frozen path.
3. **Requirements and IDs are stable.** A new requirement/case/invariant/ADR id is reserved in #25
   before a numbered file/row is created. A legacy `INV-` prefix records the original allocation, not
   the current category.
4. **Traceability ships with the change.** Update the requirement row, trace row, case registry,
   invariant register, AI-use log and relevant QA record in the same change.
5. **Context freshness.** Within one sprint of a requirement/interface change, update this blueprint,
   the affected ADR, `AGENTS.md`, the permission model and the trace row.
6. **One task, one reviewable slice.** Do not hide a refactor or a second task in the same commit.
7. **Honest limits.** A missing value is `unknown` or `—`; a not-run case is not a failure and not a
   pass. Do not invent a number, approval, transcript or measurement.

---

## 11. File-system map and reading order

```text
isla/
├── AGENTS.md                 coding-agent entry point
├── Prompt.md                 static launch instruction
├── README.md                 purpose, run commands, gate design
├── docs/
│   ├── req/                  requirements.yaml v0.3, schemas, case registry, PRD
│   ├── architecture/         this blueprint, ADRs, invariants, trace, memory,
│   │                         permission, runtime policy, candidate comparison,
│   │                         context assembly, option ledger
│   ├── code-governance/      structural + verification constraints, tool manifest
│   ├── team/                 plan, interfaces, requirements snapshot, handoffs
│   └── decision/             quality rubrics
├── .opencode/                permissions.jsonc, rules.md
├── .agent/rules.md           project covenant
├── src/
│   ├── contracts/app/        C1–C7 schemas and ports
│   ├── performance/          M1
│   ├── console/              M2
│   ├── decision/             M3
│   ├── dialogue/             M4
│   ├── runtime/              M5
│   ├── storage/              M6
│   └── evaluation/           M6
├── test/
│   ├── offline/              deterministic tests
│   ├── conformance/          shared contract suites
│   ├── support/              fixture and runner kits
│   ├── live/                 opt-in provider tests
│   ├── browser/              browser acceptance
│   └── fixtures/             corpora and fixtures
├── prompts/                  character bible and decision prompt references
└── .github/workflows/ci.yml  G1–G6, trace, build
```

**Reading order for a coding session**

1. `AGENTS.md`
2. `Prompt.md`
3. this blueprint
4. `docs/architecture/adr/010-local-first-modular-runtime.md` (proposed; not accepted)
5. `docs/req/requirements.yaml` + `docs/req/case-registry.yaml`
6. `docs/architecture/invariants.md` + `trace-matrix.md`
7. `docs/architecture/permission-model.md` + `.opencode/permissions.jsonc`
8. `docs/code-governance/structural-constraints.md` + `verification-constraints.md`
9. `docs/team/INTERFACES.en.md` and the owning module's ports/tests

Read items 5–9 to the depth the task needs. Do not infer approval state from the existence of a file.

---

## 12. What this blueprint does not claim

- It does not claim an accepted architecture baseline. The master ADR is proposed, and no human has
  accepted it.
- It does not claim a blocking gate where the remote ruleset has not been re-checked.
- It does not claim live providers, physical audio, Windows recovery or a measured quality result.
- It does not claim that the permission model is an OS sandbox or that every path is mechanically
  enforced.
- It does not replace the requirements registry, invariant register, trace matrix, ADRs or review
  records. Those remain the normative sources.

The artifact index is [`README.md`](README.md).
