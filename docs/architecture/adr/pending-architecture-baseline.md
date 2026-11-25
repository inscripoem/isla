# ADR pending #25 — Local-first modular runtime with deterministic authority and layered AI context

**Status:** proposed. **ADR ID pending #25** — this file is not an allocated numbered ADR and no human
has accepted it. Date: 2026-11-25. Owner: M5 coordination with M4/M6.
**Base:** `main` `a58e8f0`. **Supersedes:** none.
**Related:** [`../architecture-blueprint.md`](../architecture-blueprint.md),
[`../candidate-comparison.md`](../candidate-comparison.md),
[`../context-assembly.md`](../context-assembly.md), ADR-001…ADR-009,
[`../../req/requirements.yaml`](../../req/requirements.yaml) v0.3.

This ADR records the system-level architecture choice that the component ADRs assume. It is a
**proposal**: it does not accept itself, does not allocate its number and does not claim a measured
evaluation. The qualitative comparison is in [`candidate-comparison.md`](../candidate-comparison.md) §6;
the implemented context details are in [`context-assembly.md`](../context-assembly.md).

---

## 1. Context

Isla is a local-first AI VTuber runtime. A single character receives audience text, selects a reply
intent, assembles a bounded dialogue context, generates text, synthesises speech, plays it in a browser,
and asks a local avatar adapter to react. An operator can Stop and Resume. Durable events, deliveries
and derived memory are recorded locally.

The architecture must satisfy four hard constraints before it satisfies convenience:

1. **No AI element may authorise output.** Model output may propose text, an intent or a reaction; only
   deterministic runtime code may validate and dispatch it.
2. **Evidence must survive.** What happened must be recordable, ordered and replayable without inventing
   a completion.
3. **Adapters must be replaceable.** Selection, dialogue, synthesis, playback and rendering change
   independently; callers must not depend on a provider SDK.
4. **The system runs locally.** There is no cloud account, multi-tenant service or hosted memory. The
   operator is the monitoring surface.

The project also has a delivery constraint: the coding agent must be bounded by file-level permissions,
a plan gate, tests and traceability. The architecture therefore includes the **agent workflow** and
**evidence** as first-class concerns, not as afterthoughts.

---

## 2. Architectural drivers

| Driver | Concern | Obligations |
| --- | --- | --- |
| D1 Authority and safety | Only current authorised work produces output; untrusted content cannot gain control | FR-01, FR-03, FR-05; INV-01, INV-02, INV-03; NFR-05 |
| D2 Evidence and durability | Record, order, replay and recover what happened | FR-06; INV-04…INV-11 (quality controls); INV-12 |
| D3 Replaceability | Swap providers/devices without changing callers | FR-03, FR-04; NFR-06 |
| D4 Context and quality | Give the model the right bounded context; never invent delivered speech | FR-02, FR-04; NFR-03; NFR-04/COST-01 |
| D5 Local operability | Run, stop, inspect and recover locally | FR-05; NFR-01, NFR-02 |
| D6 Governance and traceability | Bind the agent and keep the evidence chain | INV-13, INV-14, INV-16; GOV-01; SEC-01 |

**Critical drivers:** D1 and D2. A candidate that lets AI output authorise dispatch, or that cannot
preserve evidence across a restart, is eliminated regardless of convenience.

---

## 3. Options considered

### Option A — Cloud multi-service

A hosted API, managed database, model gateway and remote console.

- Strong for multi-user scale and remote operations.
- Fails the local-first/privacy boundary and adds network, auth, deployment and cost surfaces that no
  current requirement needs.
- **Rejected for this baseline.** Reopen only if a remote multi-user requirement is approved.

### Option B — Single-process monolith with direct provider calls

One process, direct SDK calls, prompt-only safety, no ports.

- Lowest initial code.
- Fails D1: the model path holds authority and no deterministic boundary can be tested independently.
- Fails D3: providers are not replaceable without editing call sites.
- **Rejected.** This is the anti-pattern the project exists to avoid.

### Option C — Local-first modular monolith with deterministic authority (chosen)

One local runtime composed of six owned modules, ports/adapters for replaceable peers, M5 as the live
authority, M6 as the evidence store, and a React/Vite console.

- Strong on D1, D2, D3 and D5; acceptable on D4; local operational burden is the price.
- Testable offline with fixtures; live providers are an explicit, separate deployment.
- **Selected.**

### Option D — Multi-agent orchestration

Several autonomous agents negotiate the turn.

- Adds coordination, latency and a second authority for a single-character local product.
- Fails D1 unless a deterministic supervisor duplicates the authority, which is Option C with more
  components.
- **Rejected for this baseline.** Reopen only for a multi-character product with a new requirement.

The qualitative comparison, criteria and reopen triggers are in
[`candidate-comparison.md`](../candidate-comparison.md) §6.

---

## 4. Decision

Adopt **Option C: a local-first modular monolith with deterministic authority and layered AI context.**

| Element | Decision |
| --- | --- |
| Runtime | One TypeScript/Node process (`pnpm`, Node 22) + one React/Vite browser console |
| Authority | M5 coordinator owns lifecycle, epoch, validation, scheduling, cancellation and dispatch |
| Persistence | M6 owns SQLite, migrations, replay, recovery, evaluation evidence and CI |
| AI | M3 proposes selection/reaction; M4 proposes dialogue and owns memory semantics; neither holds authority |
| Adapters | M1 synthesis/player/renderer, M3/M4 providers, M6 storage behind `src/contracts/app/` ports |
| Context | Layered assembly with a hard character budget, deterministic trim and preserved constraints |
| Evidence | Append-only events/deliveries, JSONL export, recorded evaluation runs, gate failure records |
| Governance | Default-deny role/path policy, human plan gate, trace/readiness gates, AI-use log |

The implementation lives in the existing six module directories; no new service or package is required.
The exact ports are C1–C7 in [`../../team/INTERFACES.en.md`](../../team/INTERFACES.en.md).

---

## 5. Consequences

**Positive**

- Deterministic authority is testable without a live model; Stop, stale results and untrusted control
  can be exercised offline.
- Providers and devices are replaceable behind one contract; substitution tests can prove the caller
  boundary.
- Evidence is local and durable; replay/recovery do not depend on a cloud service.
- The agent permission model and traceability gates are part of the same architecture, not a separate
  process layer.

**Negative**

- One process and one operator; no built-in multi-tenant or remote scale.
- SQLite and local files add backup, migration and platform responsibilities.
- The modular monolith relies on review, import-boundary tests and the permission policy rather than a
  compiler-enforced service boundary.
- A live provider, acoustic output and a quality baseline remain separate evidence.

**Neutral**

- The modules can be extracted later if a second consumer or deployment requires it; that would be a new
  ADR, not a silent refactor.

---

## 6. Conditions that reopen this decision

1. A requirement for remote multi-user access, cloud persistence or a hosted model gateway is approved.
2. A second consumer needs the AI/selection/dialogue elements outside the local process.
3. A forbidden dependency reaches the authority path without a failing import/boundary test.
4. SQLite cannot satisfy a new durability/recovery obligation, or a platform requirement rules out the
   local file store.
5. The proposed token cap/compaction design in §8 cannot fit the selected provider's context window.
6. The permission model or the agent workflow is adopted in a materially different form.
7. A real evaluation shows the layered context cannot meet the quality driver under the fixed conditions.

---

## 7. Architectural design process (ADD)

The decision was produced with the course's Attribute-Driven Design loop:

1. **Review inputs.** Requirements v0.3, the four invariants, the risks/unknowns, the existing ports,
   the test suites and the local-only constraint.
2. **Select drivers.** D1 authority and D2 evidence are critical; D3 replaceability and D5 local
   operability shape the module boundaries; D4 and D6 shape the context and governance layers.
3. **Decompose elements.** Six modules with one responsibility each; M5 owns live authority; M6 owns
   evidence; M3/M4 propose; M1/M2 act/present.
4. **Choose design concepts.**
   - **Ports and adapters** for providers/devices.
   - **Pipe-and-filter** for the turn pipeline (select → dialogue → synthesis → play → receipt).
   - **Checkpoint/record-replay** for durability and recovery.
   - **Layered context with a hard budget** for the AI prompt.
   - **Fail-closed policy** for invalid, stale or untrusted work.
5. **Instantiate.** Concrete modules, interfaces C1–C7, SQLite schema, browser player, Vite console.
6. **Record.** This ADR, the blueprint, the invariant register, the trace matrix, the permission model,
   the memory design and the runtime policy catalog.
7. **Evaluate.** Qualitative candidate comparison, offline conformance/regression tests, trace and
   readiness gates. A measured quality/latency evaluation is **not run**; G4 remains `not run` and no
   threshold value is claimed.

---

## 8. AI context design

The detailed implementation is in [`context-assembly.md`](../context-assembly.md). This section records
the decision the implementation must follow.

### 8.1 Layered context per turn

| Layer | Content | Source | Budget position | Status |
| --- | --- | --- | --- | --- |
| **L0 — Identity** | Persona summary, style notes, profile id/version | `src/dialogue/persona*.ts`, `prompts/dialogue/character.md` | Outside `maxCharacters`; always rendered | implemented |
| **L1 — Standing constraints** | Boundaries ("Never"), standing facts ("Always true"), untrusted-content markers | Persona profile, `context.ts` | Outside trimming; always rendered | implemented |
| **L2 — Current task** | Selected input text, reply intent, intent reference lines | `DialogueRequest` + response plan | Outside trimming; appended last | implemented |
| **L3 — Conversation history** | Merged listener/character transcript, confirmed history, heard-prefix section, rollup | `HistoryQueryPort` / M4 memory | Charged to the history pool | implemented |
| **L4 — Retrieved knowledge** | Persona recall facts, older delivery recall | `PersonaRecallPort`, `DeliveryRecallPort` | Charged to the recall section | implemented |
| **L5 — Resumable state** | Character state block, working-memory block, session identity | `state.ts`/`state-render.ts`, `working-memory.ts` | Charged to state/working-memory caps and the shared pool | implemented; state is in-process |
| **L6 — Evidence/audit metadata** | Provenance tags, exclusion warnings, consistency audit | `provenance.ts`, `consistency.ts`, assembly warnings | Metadata; only some lines reach the prompt | implemented as diagnostics |

The fixed provider `system` instruction states only the output format; it is not part of
`maxCharacters`. The persona block and current input/intent are structurally outside every trim loop,
so trimming cannot remove the identity or the current task.

### 8.2 Assembly pipeline

1. **Collect** — select one record source (durable history, local stand-in or none), listener turns,
   recall and state.
2. **Normalise** — admit only spoken records; classify heard-prefix/audit-only; record exclusions.
3. **Deduplicate** — one utterance per `(sessionId, turnId, segmentId)`; choose by modality rank;
   confirmed speech beats a heard-prefix copy.
4. **Order** — group by `(sessionId, turnId)`, sort segments by persisted `segmentIndex`, unknowns last,
   stable input order for ties.
5. **Prioritise** — persona → state → working memory → recall → history; history keeps at least 35% of
   the character budget.
6. **Budget** — allocate section caps; charge rendered characters; unused quota flows to history.
7. **Compact** — no summarisation today: drop whole turns in `TRIM_ORDER`, drop state/working-memory
   blocks whole when they do not fit, add a rollup line when it fits. Pinned turns are last victims.
8. **Assemble** — render in the order persona → state → working memory → recall → heard-prefix →
   transcript/history → current input/intent → reference lines.
9. **Verify** — `estimatedCharacters <= maxCharacters`; `estimatedTokens` is a diagnostic approximation,
   not a token count.

### 8.3 Token budget and compaction threshold

**Implemented today**

| Parameter | Value | Status |
| --- | --- | --- |
| Rendered character cap | `contextLimits.maxCharacters`, default 2,000 | implemented |
| Turn window | `contextLimits.maxTurns`, default 8 | implemented |
| Section plan | 0.2 persona / 0.1 state / 0.1 working memory / 0.2 recall / 0.4 history | pinned initial choice |
| History floor | 35% of `maxCharacters` | implemented |
| Token count | `estimateTokensFromLines` = `ceil(latin/4 + cjk/1.5)` over charged lines | **approximate diagnostic, not a measurement** |
| Tokenizer / token cap / compaction | none | **not implemented** |

**Proposed design (not shipped; M4 owner review required)**

| Parameter | Proposed value | Rationale |
| --- | --- | --- |
| Prompt token cap | **4,096 tokens**, input only | Smallest round cap above the current worst-case CJK context (2,000 chars ≈ 1,334 tokens) plus persona/task/system overhead, leaving room for history and recall; must be confirmed against the selected provider's window |
| Compaction trigger | **70% of cap ≈ 2,867 tokens** | Start deterministic trimming before the hard stop; leaves room for the fixed layers |
| Hard stop | **90% of cap ≈ 3,686 tokens** | If the assembled prompt still exceeds this after trimming, fail closed |
| Output budget | separate from the prompt cap | Never let output reserve silently shrink the input cap |
| Compaction order | history → recall → working memory → state | Never drop identity, standing constraints or current task |
| Over-cap action | `context_overflow`, no provider call | A prompt missing a boundary is worse than no answer |

The values are a **proposal**, not a measured baseline. The current implementation enforces a character
cap, not a token cap. The design must be validated with the real provider tokenizer and measured usage
before it becomes a threshold.

### 8.4 Re-injecting critical constraints after compaction

The current protection is structural: the persona block, standing constraints and current input/intent
are outside the trim loops, so no existing compaction step can remove them. There is no summarisation.

The proposed rule for a future compaction step:

1. **Immutable envelope.** Rebuild identity, standing constraints, current input, reply intent and
   untrusted-content markers from their original sources after every compaction; never summarise them.
2. **Fixed order.** Render the envelope first, then the compacted history/recall, then the task.
3. **Boundary check.** Hash the envelope block and verify that the assembled prompt contains the same
   block at the expected position and remains under the cap.
4. **Fail closed.** If the envelope cannot fit, emit `context_overflow` and make no provider call. Never
   send a prompt that silently lost a boundary.
5. **Audit.** Record the estimator version, token count, compaction reason and dropped-section counts in
   the call provenance.

The rule is prompt construction, not a model-compliance guarantee. Resistance to instructions embedded
in recalled text remains a separate live-provider check.

---

## 9. Traceability

| Concern | Requirement / invariant | Architectural element | Evidence |
| --- | --- | --- | --- |
| Deterministic authority | FR-01, FR-03, FR-05; INV-01…03 | M5 coordinator, M1 adapters | M5/M1 conformance, Stop/receipt cases |
| Evidence/recovery | FR-06; INV-12; quality data-integrity rows | M6 event store/SQLite/recovery | storage conformance, SQLite restart, C-74 |
| Replaceability | FR-03, FR-04; NFR-06 | ports C1–C7 | substitution/regression suites |
| Context | FR-02, FR-04; NFR-03, NFR-04/COST-01 | M4 context/persona/memory | `m4-budget`, `m4-dialogue`, `m4-transcript`, `m4-heard-prefix` |
| Local operation | FR-05; NFR-01, NFR-02 | M5 production composition | production application/CLI suites |
| Governance | INV-13, INV-14, INV-16; GOV-01; SEC-01 | trace/AI-use/memory gates | trace, gate, memory-store suites |

The canonical requirement-to-component-to-test-to-monitor matrix is
[`../trace-matrix.md`](../trace-matrix.md). The four system invariants are in
[`../invariants.md`](../invariants.md).

---

## 10. Open questions

1. **ADR number.** This file is `pending #25`; a human must reserve a number before it becomes a
   numbered ADR. It must not be cited as an accepted ADR before then.
2. **Token cap.** The 4,096/70%/90% values need M4 owner review and a real tokenizer/measured prompt
   before enforcement.
3. **Permission model adoption.** `.opencode/permissions.jsonc` is a policy source compiled per task;
   human adoption and the file-level read-inventory decision remain open.
4. **G4 semantic evaluation.** The current G4 checks conditions/claims, not faithfulness/relevance; a
   fixed evaluation set and thresholds are not run.
5. **Requirement split IDs.** `COST-01`, `SEC-01` and `GOV-01` are proposed allocations pending #25.
6. **D5/D6.** Transcripts and the process report are submission artifacts outside this ADR.

---

## 11. What this ADR does not claim

- It is not accepted; it does not allocate its own number.
- It does not claim a measured candidate evaluation, a quality score, latency, cost or provider result.
- It does not claim that the proposed token cap/compaction/reinjection policy is implemented.
- It does not replace the component ADRs, the requirements registry, the invariant register, the trace
  matrix or the permission model.
- It does not authorise implementation, publication, merge or branch-protection changes.
