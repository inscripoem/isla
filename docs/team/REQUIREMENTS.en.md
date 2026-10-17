# Isla — Candidate Requirements

Revision: 2026-10-17.3 · Status: under review

Team requirements under review; English engineering requirements may be promoted to formal D1 after acceptance. This Markdown table does not replace the required YAML/schema. These are proposed acceptance obligations, not implemented capabilities or an approved D1 registry. Stable IDs are retained from the archived candidate draft; FR-01 now explicitly includes reply intent, FR-02 includes dialogue generation, and NFR-06 covers the selected adapter boundaries.

The scoped YAML register, schemas and case-to-test references now exist in [docs/req](../req/requirements.yaml). They distinguish executable fixture criteria from pending product scenarios and measurements; they do not constitute accepted final D1.

## Scope and counting

The first release is a reusable AI VTuber runtime with a local console, one character, text input, replaceable decision/dialogue/TTS/avatar adapters and SQLite persistence. Reactions initially use rules. Response-plan evaluation compares rules, a general model and Jev where accessible.

Introduction p. 20 states “Add N meaningful functional requirements and non-functional requirements”. For six members, plan at least six meaningful FRs and six measurable NFRs; the source does not separately specify both quantities. Six module owners are not six requirements. The named comparison baseline and each requirement's added behavior or quality improvement remain to be established.

## Functional requirements

The module allocation is team-confirmed; priorities, fit criteria and requirement-level acceptance remain under review. Every feature needs reviewed positive and negative tests before implementation. Existing C-01–C-17 cases inform acceptance but do not replace requirement IDs.

| ID | Required behavior | Priority | Acceptance obligation | Lead / collaborators |
| --- | --- | --- | --- | --- |
| FR-01 | Select one eligible message or wait, and provide a supported reply intent. | Must | Verify eligibility, intent, reservation and expiry; invalid/unavailable provider output follows the validated fallback; unchanged waiting input causes no repeated provider calls. | M3 / M5, M2 |
| FR-02 | Generate a persona-conditioned reply from the selected message and intent, using history that distinguishes delivered and interrupted speech. | Must | Unplayed text is excluded from confirmed spoken history. Generation receives the selected intent; NFR-03 evaluates adherence. Restart/interruption cases preserve delivery status. | M4 / M5, M6 |
| FR-03 | Map an interaction to an available avatar reaction with an explicit fallback. | Should | Only current supported actions and valid parameters reach the adapter. Unsupported, expired or failed decisions follow the specified no-op/fallback. | M1 / M3, M5 |
| FR-04 | Coordinate speech, subtitles and avatar actions for the same turn and segment. | Must | Verify identity, ordering and completion/cancellation receipts. Incorrect or duplicate receipts cannot advance unrelated output. NFR-01 assesses timing. | M1 / M5, M2 |
| FR-05 | Allow the operator to stop output, cancel pending work and explicitly resume the session. | Must | Stop during generation, synthesis and playback prevents further output until Resume. Late results cannot restart output; resumption permits a new valid turn. | M5 / M1, M2 |
| FR-06 | Persist and replay events, decisions and delivery outcomes for inspection. | Should | Stored fixtures reconstruct event order and outcomes. Distinguish recorded replay from fresh model evaluation; declare recovery outcomes for interrupted writes/restarts. | M6 / M4, M2 |

## Non-functional requirements

Every final entry requires metric + threshold + verification. TBD means not ready for acceptance. Numerical targets require a reviewed baseline and measurement conditions; no course-example values are imported into this product.

| ID | Attribute / priority | Metric and proposed threshold | Verification | Lead / collaborators |
| --- | --- | --- | --- | --- |
| NFR-01 | Responsiveness and synchronization / Must | p95 input-to-first-audible-output; p95 Stop-to-silence; subtitle/action timing error. Thresholds TBD. | Document hardware, providers, workload, sample size and cold/warm state; observe actual output and account for failures/cancellations. | M5 / M1–M4; M6 aggregates |
| NFR-02 | Failure recovery / Must | Safe-outcome proportion and recovery duration; coverage/time thresholds TBD. | Inject decision/dialogue/TTS failure, disconnects, malformed results and storage interruption; check runtime policies and invariants. | M5 / all owners |
| NFR-03 | Response quality / Should | Selection appropriateness, intent adherence, persona consistency and unacceptable-response rate; thresholds/rubric TBD. | Versioned reviewed evaluation set, held-out cases and human reference labels; compare providers and combined-call baseline under fixed conditions. | M3, M4 / M6 |
| NFR-04 | Bounded resource use / Must | Proposed maximum one response-provider attempt per decision opportunity, no automatic retries; total token/cost/session resource caps TBD. | Account for all attempts and available usage, including failures; test budget exhaustion and degradation. Missing usage remains unknown. | M3, M4 / M5, M6 |
| NFR-05 | Privacy and control security / Must | Zero unauthorized privileged transitions in the reviewed adversarial suite; retention/deletion period and completion limit TBD. | Exercise untrusted inputs, control authorization, stored data and deletion. A finite suite is not a universal security proof. | M5 / M4, M6 |
| NFR-06 | Adapter replaceability / Should | Proposed zero changes to dialogue/scheduling business logic for provider substitution; every implemented substitute passes the shared contract suite. | Substitute decision, TTS and avatar implementations through adapters/composition/configuration; inspect changed files and affected contracts. Fixtures prove boundaries, not live-provider compatibility. | M1, M3 / M4–M6 |

## Deterministic invariants

| ID | Rule / related requirements | Enforcer | Verification and operational fallback |
| --- | --- | --- | --- |
| INV-01 | No pending or late output restarts playback while stopped. FR-04, FR-05; NFR-02. | M5 authority, M1 output boundary | Zero unauthorized dispatches in late-result/Stop cases; disable output and require operator recovery on violation. |
| INV-02 | Only current, validated avatar commands may be dispatched. FR-03; NFR-05. | M5 validation, M1 adapter | Zero invalid dispatches in capability/parameter tests; reject and apply the approved safe fallback. |
| INV-03 | Audience content and model output cannot grant control privileges or change control policy. FR-01, FR-05; NFR-05. | M5 control/configuration boundary | Zero privileged transitions from untrusted inputs; reject and record a redacted event. |
| INV-04 | Event identity is session-scoped: within a session a committed event id and a session sequence number are unique; the same event id in another session is independent; content equality is canonical (object key order irrelevant, array order significant) and an event payload must be a JSON value. FR-06; C7. | M6 storage (`event-store` + `payload` over `StorageBackend`, keyed `sessionId:eventId`) | Conformance `append-seq-unique` / `append-changed-content` / `append-session-scoped-identity` and cases C-18/C-23/C-39/C-40/C-41/C-43/C-44; reject with `failed`/`conflict`/`unsupported_payload`, keep the existing record, never reject across sessions. |
| INV-05 | A delivery update and its supporting event commit atomically — never partially. FR-06; C-17. | M6 storage (`StorageBackend.commit`) | Conformance `atomic-no-partial-mutation` and case C-19; report `failed` for both and persist nothing. |
| INV-06 | A memory projection never advances across a gap and is idempotent. FR-06; C-12. | M6 storage (`memory-projection`) | Conformance `projection-no-gap-claim` and case C-20; do not advance `appliedSeq`. |
| INV-07 | Committed event and delivery records are isolated from caller mutation. FR-06. | M6 storage (`in-memory-backend` deep-copies on write and read) | Case C-24; mutating an input or a returned record cannot change committed state or JSONL output. |
| INV-08 | Confirmed history is ordered by the supporting event sequence (ascending). FR-06; issue #22. | M6 storage (`history-query` over `StoredDelivery.eventSeq`) | Case C-25; `confirmedHistory` returns seq order independent of insertion order. |
| INV-09 | Original segment index and generating persona identity/version remain attached to delivery evidence. FR-06; issue #22. | M5 capture and M6 record conversion | C-46/C-47; preserve original values on Stop/late receipts, reject changed attribution as a conflict, reject an inconsistent classification/outcome pair and contradictory known provenance before mutation, retain legacy unknowns as null. |
| INV-10 | Storage configuration and schema version are validated before use; an empty override or an unsupported schema version is rejected. FR-06. | M6 storage (`config`, `sqlite/migrations`) | Cases C-26/C-27; fail-fast on empty override; reject unsupported version. |
| INV-11 | A schema migration is recoverable: back up before apply; migrations and the version bump apply as one transaction. FR-06. | M6 storage (`sqlite/migrations`) | Cases C-27/C-28; a failure rolls back, leaves the prior version intact, and a backup exists. |
| INV-12 | On restart only confirmed history is restored; unresolved outputs remain unknown and are never replayed. FR-06; C7, C-17. | M6 storage (`recovery-view`) + M5 lifecycle | Cases C-32/C-33; the recovery view separates confirmed from unresolved; no fabricated completion. |
| INV-13 | The traceability chain is machine-checked; a broken link fails the gate. | M6 evaluation (`trace-fitness`) + CI | Cases C-34/C-35/C-37; valid repo → no violations; injected defect or missing owner → violation. |
| INV-14 | A code or prompt change must update `docs/ai-use-log.yaml` (gate G6). | M6 evaluation (`ai-use-log-gate`) + CI | Case C-36; a code/prompt change without a log update fails. |
| INV-15 | Within one (sessionId, turnId), known segmentIndex values sort ascending before unknowns; ties and unknowns retain input order, with null indices preserved and other sessions/turns excluded. FR-06; issue #25. | M5 reconstruction (`src/runtime/delivery-order.ts`) | C-47 ordering regression; preserve the input history order and never infer an unknown index. INV-08 remains the M6 history-port read order. |

INV-13/INV-14 and their gate tooling are adopted from merged PR27; main `c2f9b38` also includes PR32 governance documentation and PR42/C-51. INV-09 remains M5-owned with M6 collaboration, consistent with the YAML register; INV-15/C-47 is retained. M4 C-49/C-50 are registered on unmerged PR35 `b6c078d`. M6 INV-16/C-52–C-55 are registered on unmerged PR40 `d1a2139`, which has a [requested provider-attempt-count correction](https://github.com/inscripoem/isla/pull/40#pullrequestreview-5557266501); those rows are not imported here. Numeric reservations continue in Issue25; no future naming-scheme adoption or application acceptance is implied.

## Promotion to D1

S0-01 must establish the baseline, per-requirement sources, numerical targets, conditions, named owner/reviewer and MoSCoW tradeoffs. Prefer control correctness over completing a turn, and integration quality over additional platforms. Streaming connectors and model-driven reactions are Could; multi-character coordination, model training and an adapter marketplace are Won't for the first release.

Extend the existing scoped YAML PRD/registry and schemas to final D1, including each requirement's component, test/evidence and runtime monitor. Governance constraints also require entries; six NFR rows do not replace them. Compound obligations may receive stable child IDs without counting duplicates as new features.

Sources: [Introduction](https://canvas.cityu.edu.hk/courses/70607/files/15921983/download), p. 20; [project specification](https://canvas.cityu.edu.hk/courses/70607/files/15805980/download), pp. 5–6; [plan](PLAN.en.md); [interfaces](INTERFACES.en.md); [primary course requirements](https://canvas.cityu.edu.hk/courses/70607/files/15805980/download). Product choices originate in user preferences and planning, not a completed stakeholder study or a teacher-prescribed VTuber design.
