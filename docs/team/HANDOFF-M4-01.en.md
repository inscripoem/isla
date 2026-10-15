# M4-01 dialogue handoff

Revision: 2026-10-15.3. Owner: M4 — lowen. Status: under review.
Base: PR23 was squash-merged into main as `a28d76f`. This candidate combines published PR30 `4e4a49e` with local M4 compatibility and the updated consumption tests. This revision is the M4 compatibility increment included in the rebased PR30. It remains under M4/M5/M6 owner review; the standalone PR23 approval does not approve this contract change.

## Implemented behavior

The dialogue module turns one validated `DialogueRequest` into at most two ordered immutable segments and, separately, admits delivery evidence into confirmed spoken history. `DialoguePort.generate` holds a candidate text; `MemoryCommitPort.commit` decides whether that text ever becomes memory. The two are deliberately not fused: generation-complete is not playback-complete.

- Generation ends in exactly one of four ways. An aborted `context.signal` returns `cancelled` without touching the provider. A passed `deadline.atMs` returns `cancelled` with `usage.disposition = timeout`. An unknown `profileId` returns `failed` rather than falling back to a fixture. A candidate that carries no substantive character (`isSubstantiveSpeech`, `\p{L}`/`\p{N}`) ends the turn as `completed` with zero emitted segments — punctuation-only text is intercepted before `sink.segment` is ever called.
- `segmentId` is derived deterministically from `(sessionId, turnId, index)` and finalized once in `FinalizedSegmentRegistry`. The same id can never carry different text: a repeat with changed text is refused, so downstream replay and C6 reconciliation cannot disagree about what the second segment contained. Session identity is part of the id because the session-scoped turn counter restarts per session.
- Segment order is the emission order. At most `MAX_DIALOGUE_SEGMENTS` (2) segments are admitted, and `clampMaxSegments` never widens the contract ceiling.
- `MemoryCommitPort.commit` is idempotent on `sessionId:turnId:segmentId:modality`. A repeat with identical text, segment index and persona attribution is a no-op; a repeat that changes any of them is a `conflict`, not a silent overwrite, matching M6's storage rule. The key matches M6's storage identity, so keys derived on either side can be compared.
- Committed records are isolated from the caller. Records are copied on the way in and on the way out, so mutating a delivery object after commit — or mutating a view the store returned — cannot rewrite history. Without this boundary, editing a stored partial delivery made it appear in spoken history with no second commit.
- Persona attribution is persisted on the delivery itself, not held in a process-local map. The coordinated `CommitDelivery` and `ConfirmedDelivery` carry the original `segmentIndex` and the generating `personaProfileId`/`personaProfileVersion`; M4 derives a persona key only from a *complete* persisted pair. A half-known or all-null pair stays unknown — it is never filled from the current profile or a local note — and unknown is treated as current rather than stale, because absence of evidence is not evidence that the memory is outdated.
- Delivery classification and terminal outcome must agree. `DELIVERY_PAIR_POLICY = 'strict'` with `ALLOWED_DELIVERY_PAIRS` permits only `fully-delivered → completed`, `partial-unknown → cancelled | unknown | failed`, `not-delivered → failed | cancelled | unknown`. A `partial-unknown` delivery that failed after playback started is legitimate: C6 permits it and M5 produces it, and refusing it would leave M6 holding a delivery M4 rejected for a valid outcome. Permitted is not admitted — admission still requires `fully-delivered`.
- FR-02 admission is decided in `classifyMemoryBucket`. Speech reaches confirmed history only as `fully-delivered` with the required receipt; `SPOKEN_RECEIPT_POLICY = 'required-for-audio'` means audio evidence without a receipt id never enters spoken history even when the text was generated. `partial-unknown` and `not-delivered` are audit-only.
- Within one turn, several modalities of the same segment collapse to one entry using `MODALITY_PREFERENCE = ['audio','subtitle','avatar']`.
- Turns are grouped by `(sessionId, turnId)`, not by `turnId` alone: a session-scoped turn counter repeats across sessions, so grouping on the turn id alone would fabricate one turn out of two different sessions. Within a turn, segments are ordered by the persisted `segmentIndex`: known indices ascending, unknown last, ties in supporting-event order. Identifier spelling is never an ordering key.
- **The character budget is hard.** `maxCharacters` covers the rendered confirmed history AND the rendered recalled facts, which share it and therefore trade off against each other. It does not cover the persona block or the rest of the prompt. Nothing assembled exceeds it: recall that cannot fit is dropped with an auditable exclusion, and the newest turn is protected only while some other turn can give way. When a single turn exceeds the whole budget it is dropped too, and a warning reports it — `MEMORY_TRIM_POLICY.keepNewestWithinBudget` replaced an earlier `alwaysKeepMostRecent` flag that made the cap advisory and still produced content under a zero budget. Stored evidence is unchanged; only the context view is trimmed.
- Character accounting is exact for what the budget covers: each kept turn and each recalled fact is charged as rendered, including the `- ` item prefix, the `[cut off mid-sentence]` marker and the `(bible: id)` provenance suffix. `renderHistoryLine` and `renderRecallLine` produce both the prompt text and the counted length, so the two cannot drift. Section headings, the persona block and the rest of the prompt are not charged.
- Trimming follows `MEMORY_TRIM_POLICY.dropOrder`: a very old persona half-sentence goes first, then an old persona turn, then a half-sentence, then the current persona turn.
- Interrupted utterances stay legible. `renderDialoguePrompt` marks a turn cut off mid-sentence with `[cut off mid-sentence]` instead of presenting it as a complete line. Prompt order is persona block → `Relevant background:` → `Already said (confirmed spoken)` → `Listener said:` → `Intent:` → `Reference lines for this intent:`.
- Persona has three layers with distinct lifetimes. L1 is the author's bible (`prompts/dialogue/character.md`) and is never rendered. L2 is `persona-content.ts`, rendered every turn. L3 is on-demand recall, currently disabled. `intentTemplatesFor` is a lookup, not a bulk injection: M5 sends one `replyIntent` and only that class's templates are emitted.
- Usage is honest. When no model was called the module reports `inputTokens`/`outputTokens` as `null` with `usageMissing: true`, matching the M5 fallback convention. A fixture answer is never presented as a real provider call.

## Entry points and local configuration

Import `createDialoguePort` and `DialoguePortOptions` from `src/dialogue/dialogue-port.ts`, `createDeliveryMemoryStore` from `src/dialogue/memory-commit.ts`, and the persona helpers from `src/dialogue/persona.ts` and `src/dialogue/persona-recall.ts`. Everything is re-exported from `src/dialogue/index.ts`. The production module imports no test code and never reads `process.env`; only the composition root may do that.

`DialoguePortOptions.clock` is required and has no default. `CallContext.deadline.atMs` is in the injected clock domain, not wall-clock: the fixture deadline is `60_000`, so pairing it with `Date.now()` would mark every request as already timed out and emit zero segments without any error. Tests inject a fixed clock such as `{ nowMs: () => 1_000 }`.

| Option | Purpose / default |
| --- | --- |
| `clock` | Injected time source. Required; no default. Must share the domain of `CallContext.deadline.atMs`. |
| `textSource` | Dialogue text source. Defaults to the fixture source; M4-02 supplies a real provider implementation. |
| `history` | Durable history source (M6). When supplied it is **authoritative** and defines the record set. |
| `memory` | Local record source, offered to `MemoryEntrySource`. Used only when no durable history was supplied; persona attribution still comes from each record's persisted fields, so this side cannot fill in a missing component. |
| `personaRecall` | `PersonaRecallPort`. Omitted resolves to `createDisabledPersonaRecall()`. |
| `maxSegments` | Upper bound on emitted segments; clamped to `MAX_DIALOGUE_SEGMENTS` (2). |

**Composition rule** (settled in issue #22 after M5's correction). The durable source is authoritative and defines which records exist. The local store never substitutes for it while it is available: a local view holds only what this process has seen, so choosing it merely because it is non-empty would let one newly committed delivery replace reconstructed history. The local store becomes the record source only when no durable source was supplied, which is reported through `historySource` and raised as a warning. Attribution is no longer a local concern: it travels on each persisted record's own `personaProfileId`/`personaProfileVersion`, so the local store is not consulted as an attribution map and cannot fill in a missing persisted component. The two sources are never merged into one list, so a delivery held by both cannot be counted twice.

Authoring and policy constants, all exported:

| Constant | Value | Meaning |
| --- | --- | --- |
| `PERSONA_AUTHORING_STATUS` | `'ready'` | Enforces content validation. `'draft'` reports issues without blocking. |
| `PERSONA_RECALL_POLICY` | `'off'` | Recall seam is wired but inert. |
| `MAX_STANDING_FACTS` | `5` | Standing facts rendered every turn. |
| `MAX_STANDING_FACT_CHARACTERS` | `110` | Per-fact cap. 5 × 110 = 550 characters, about a quarter of the default 2,000-character budget. |
| `DELIVERY_PAIR_POLICY` | `'strict'` | Permits only the pairs in `ALLOWED_DELIVERY_PAIRS`. |
| `SPOKEN_RECEIPT_POLICY` | `'required-for-audio'` | Audio without a receipt id stays audit-only. |
| `MEMORY_TRIM_POLICY.keepNewestWithinBudget` | `true` | The newest turn is protected only while it fits the cap. |
| `MAX_RECALLED_FACTS` | `5` | Upper bound on recalled facts; the character cap is enforced separately. |
| `ITEM_PREFIX`, `INTERRUPTED_SPEECH_MARKER` | `'- '`, `' [cut off mid-sentence]'` | Rendered form, and therefore part of the charged length. |

The bible is linked by `sourceDocument: 'prompts/dialogue/character.md'` and `sourceVersion: '1'`; the runtime profile is `profileId: 'Elleya'`, `version: '2'`, exposed as `personaVersionKey('Elleya', '2')` → `["Elleya","2"]`. The key is the JSON pair, not an `id@version` join, so a delimiter inside an id or version cannot make two personas collide. `src/dialogue/` owns the bible and the standing persona; they do not enter M6 storage, and there is no second writable source.

`standingFactsFromBible` reads only blockquote lines (`/^\s*>/`) carrying the `[S]` marker, so the marker legend table never counts as content. `BIBLE_MARKERS` defines `[S]` standing, `[R]` recall candidate, `[H]` human-only. A drift guard in the test suite compares the bible's `[S]` lines against `standingFacts` item by item. `PERSONA_PLACEHOLDER_MARKERS` keeps unfinished text from shipping as persona; its CJK entry is data that detects an author who was writing in Chinese, and is deliberately not translated.

The coordinated storage-contract revision (owned by M5) added the required nullable `segmentIndex`, `personaProfileId` and `personaProfileVersion` to `CommitDelivery` and `ConfirmedDelivery`; M4 adopts them and adds no field of its own. Port signatures, the application protocol version `0.2` and the diagnostic protocol `1` are unchanged. `src/contracts/` is not M4's to edit; the strict decoders roll out together with their constructors, so M4's own strict parse now sees the fields instead of rejecting them.

## Verification

Verified on 2026-10-15 with Node 22.23.2 and pnpm 12.3.4 on macOS (Darwin): 67 M4 tests passed — 57 in `test/offline/m4-dialogue.test.ts` and 10 in `test/offline/m4-storage-integration.test.ts`. Typecheck, lint (0 warnings / 0 errors) and build passed. The full suite reports 487 passed / 0 failed (487 tests in 19 files). A previous revision of this handoff recorded a Windows run with 7 failing tests (`cli.test.ts` ×3 for `tsx.cmd` spawning, `boundaries.test.ts` ×3 for path-resolution cases, and `requirements.test.ts` ×1 for `core.autocrlf`), which that revision attributed to the Windows environment; those failures do not reproduce on this machine and are recorded here only as an environment difference, not as a coverage change. Commands from the repository root:

```sh
pnpm test:m4
pnpm verify
```

Coverage, stated precisely. **Production dialogue** is exercised by `test/offline/m4-dialogue.test.ts`, which also runs the shared dialogue conformance collector against `createDialoguePort`. **Cross-module consumption** is exercised by `test/offline/m4-storage-integration.test.ts`, which drives the production port against the production M6 store — `createEventStore` / `createHistoryQuery` over `createInMemoryBackend` — rather than against a stand-in. It asserts consumer-visible behaviour only: that M4 reads history and never appends to it; that the durable source defines both the record set and the attribution while a contradictory local store is ignored; that a receiptless record is listed as confirmed history by M6 yet kept out of spoken memory by M4; that a failed atomic commit leaves no memory at all; that history follows the supporting event `seq` rather than arrival order; that within a turn the persisted `segmentIndex` (known ascending, unknown last, ties in source order, unrelated identifier spelling) restores speaking order; that unknown and half-known persisted attribution never borrows a persona from local state; that two sessions stay apart when both reuse the same turn id; and that a restart over the same durable state rebuilds an identical prompt. Every atomic commit in these cases is asserted to have been `applied`/`stored`, so a silently rejected write cannot pass as coverage.

The composition and regression suites still do **not** drive the production port: `test/support/runner-factories.ts` substitutes `createFixtureDialoguePort` when the caller supplies no dialogue port, and `test/offline/composition.test.ts` passes none. `createFixtureDialoguePort` in `test/support/correct-ports.ts` is an independent fixture implementation, not this module. M4 does not change that wiring, so the coordinator-driven cases remain M5's; they are listed below.

The M4 tests cover generation invariants and the four termination paths; delivery memory, duplicate/conflict handling and caller-mutation isolation; session isolation of the registry, the delivery key and the persona attribution; context assembly, turn and character trimming, and the hard cap including a zero budget and an over-long newest turn; recall charging and recall that cannot fit; the durable-source composition rule and the local stand-in flag; FR-02 admission including `partial-unknown` + `failed`; interrupted-utterance marking; and persona authoring including the bible drift guard.

## Next collaboration point: I1-01

M4 supplies `createDialoguePort` and the delivery memory store, then reviews how the coordinator drives them. M5 assembles the factories and resolves shared-boundary issues.

| Owner | Requested implementation/review | Acceptance evidence |
| --- | --- | --- |
| M5 | Add cross-module cases that drive the **production** dialogue port rather than the fixture: failed delivery and session isolation through the coordinator. | A composed turn where a delivery fails after playback started, and one port instance serving two sessions, both against `createDialoguePort`. Direct M4→M6 consumption is already covered by `test/offline/m4-storage-integration.test.ts`; what remains is the coordinator-driven path. |
| M4/M5 | Review M4's adoption of the coordinated attribution revision before the strict-schema rollout is published. | M4's integration suite plus a coordinated re-run on the shared branch; no field re-negotiation and no weakened assertion. |
| M1 | Confirm which receipt ids accompany audio evidence, so `SPOKEN_RECEIPT_POLICY` admits the right deliveries. | Interrupted second segment leaves no confirmed spoken history; a later valid receipt completes the delivery once. |
| M3 | Confirm that one `replyIntent` per turn is enough for the template lookup, and that allowed-intent filtering happens before the request reaches M4. | An out-of-set intent never reaches M4 as a valid request. |
| M6 | Keep `HistoryQueryPort` in the conformance collector and return `confirmedHistory` ordered by supporting event `seq` ascending, preserving `terminalOutcome`. | Ordered history across a restart, and an `unknown` outcome that stays unknown after replay. |
| M4 | Wire a real `DialogueTextSource` in M4-02. | Provider call with schema-valid usage, no fixture fallback on a missing key, and no credential in the repository. |

Decided in issue #22, recorded here so the implementation and this handoff agree.

- **Event ownership: option 2.** M5 constructs the `RuntimeEvent`, allocates its session-scoped `seq` and calls M6's `commitDeliveryWithEvent`. M4's `commit` is a **local view update invoked only after** the atomic acknowledgement succeeds; the ordering guarantee is persistence before spoken-memory admission. M4 owns context admission and trimming, M6 owns storage.
- **Ordering.** Supporting-event `seq` orders history within a session; the persisted `segmentIndex` preserves emission order within a turn. `segmentId` spelling must **not** be authoritative. Implemented: the coordinated revision persists the index on both `CommitDelivery` and `ConfirmedDelivery`, and the read side orders by it directly, with no identifier-derived fallback.
- **`personaVersion`** is supplied by the coordinated contract update as the persisted `personaProfileId`/`personaProfileVersion` pair; M4 derives its key from a complete pair only. The former process-local turn-to-persona map was removed: attribution no longer depends on an entry that could be evicted, and a late receipt finalizes against the values captured at dispatch.
- **Cross-session recall is out of scope for this slice.** For restart integration M5 will supply an ordered list of relevant source sessions for the same profile, and turns will be grouped by `(sessionId, turnId)`; session-local `seq` values must never be compared as a global sequence. Until that exists M4 can only query the session id it is handed, and the module claims no cross-session recovery.

Two limitations this slice states rather than hides.

1. **The in-memory store is not durable history.** It is a stand-in, and `historySource` plus a warning say so on every assembly that uses it. Restart recovery depends on M6; M4 complies with `confirmedHistory` rather than performing recovery itself. The "restart" case in the integration suite reopens a store and query over the same in-memory backend; it is not a process-restart proof, which requires the SQLite backend (M6-01 B1-B3).
2. **Archived-session selection and durable persistence remain later work.** M4 orders and attributes only the records it is handed. Cross-session recall needs an ordered list of relevant source sessions from M5, grouped by `(sessionId, turnId)`, and M6 still has to carry `segmentIndex`, `personaProfileId` and `personaProfileVersion` through its SQLite codec/migration while preserving genuine legacy unknowns as `null`. Until then M4 queries the single session id it is handed and claims no cross-session recovery. The coordinated fields, strict decoders and correlation rule are shared contract work owned by M5; M4 adopts them and does not re-negotiate them here.

Genuine OpenCode session exports, Chinese understanding copies and raw internal evidence are retained outside the checkout.
