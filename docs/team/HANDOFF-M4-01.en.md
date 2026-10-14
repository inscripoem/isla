# M4-01 dialogue handoff

Revision: 2026-10-15.1. Owner: M4 — lowen. Status: under review.
Branch: `m4v1`, based on merged preparation commit `384969d`. Local commit only; no push or PR.

## Implemented behavior

The dialogue module turns one validated `DialogueRequest` into at most two ordered immutable segments and, separately, admits delivery evidence into confirmed spoken history. `DialoguePort.generate` holds a candidate text; `MemoryCommitPort.commit` decides whether that text ever becomes memory. The two are deliberately not fused: generation-complete is not playback-complete.

- Generation ends in exactly one of four ways. An aborted `context.signal` returns `cancelled` without touching the provider. A passed `deadline.atMs` returns `cancelled` with `usage.disposition = timeout`. An unknown `profileId` returns `failed` rather than falling back to a fixture. A candidate that carries no substantive character (`isSubstantiveSpeech`, `\p{L}`/`\p{N}`) ends the turn as `completed` with zero emitted segments — punctuation-only text is intercepted before `sink.segment` is ever called.
- `segmentId` is derived deterministically from `(sessionId, turnId, index)` and finalized once in `FinalizedSegmentRegistry`. The same id can never carry different text: a repeat with changed text is refused, so downstream replay and C6 reconciliation cannot disagree about what the second segment contained. Session identity is part of the id because the session-scoped turn counter restarts per session.
- Segment order is the emission order. At most `MAX_DIALOGUE_SEGMENTS` (2) segments are admitted, and `clampMaxSegments` never widens the contract ceiling.
- `MemoryCommitPort.commit` is idempotent on `sessionId:turnId:segmentId:modality`. A repeat with identical text is a no-op; a repeat with different text is a `conflict`, not a silent overwrite. The key matches M6's storage identity, so keys derived on either side can be compared.
- Committed records are isolated from the caller. Records are copied on the way in and on the way out, so mutating a delivery object after commit — or mutating a view the store returned — cannot rewrite history. Without this boundary, editing a stored partial delivery made it appear in spoken history with no second commit.
- Delivery classification and terminal outcome must agree. `DELIVERY_PAIR_POLICY = 'strict'` with `ALLOWED_DELIVERY_PAIRS` permits only `fully-delivered → completed`, `partial-unknown → cancelled | unknown | failed`, `not-delivered → failed | cancelled | unknown`. A `partial-unknown` delivery that failed after playback started is legitimate: C6 permits it and M5 produces it, and refusing it would leave M6 holding a delivery M4 rejected for a valid outcome. Permitted is not admitted — admission still requires `fully-delivered`.
- FR-02 admission is decided in `classifyMemoryBucket`. Speech reaches confirmed history only as `fully-delivered` with the required receipt; `SPOKEN_RECEIPT_POLICY = 'required-for-audio'` means audio evidence without a receipt id never enters spoken history even when the text was generated. `partial-unknown` and `not-delivered` are audit-only.
- Within one turn, several modalities of the same segment collapse to one entry using `MODALITY_PREFERENCE = ['audio','subtitle','avatar']`.
- Turns are grouped by `(sessionId, turnId)`, not by `turnId` alone: a session-scoped turn counter repeats across sessions, so grouping on the turn id alone would fabricate one turn out of two different sessions.
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
| `memory` | Versioned attribution and audit side. Supplies `personaVersion` per record, and is the record source only when no durable history was supplied. |
| `personaRecall` | `PersonaRecallPort`. Omitted resolves to `createDisabledPersonaRecall()`. |
| `maxSegments` | Upper bound on emitted segments; clamped to `MAX_DIALOGUE_SEGMENTS` (2). |

**Composition rule** (settled in issue #22 after M5's correction). The durable source is authoritative and defines which records exist. The local store never substitutes for it while it is available: a local view holds only what this process has seen, so choosing it merely because it is non-empty would let one newly committed delivery replace reconstructed history. The local store is therefore consulted for **attribution** — it can name the persona behind a record, which the durable record does not carry yet — and becomes the record source only when no durable source was supplied, which is reported through `historySource` and raised as a warning. The two are never merged into one list, so a delivery held by both cannot be counted twice.

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

The bible is linked by `sourceDocument: 'prompts/dialogue/character.md'` and `sourceVersion: '1'`; the runtime profile is `profileId: 'Elleya'`, `version: '2'`, exposed as `personaVersionKey()` → `Elleya@2`. `src/dialogue/` owns the bible and the standing persona; they do not enter M6 storage, and there is no second writable source.

`standingFactsFromBible` reads only blockquote lines (`/^\s*>/`) carrying the `[S]` marker, so the marker legend table never counts as content. `BIBLE_MARKERS` defines `[S]` standing, `[R]` recall candidate, `[H]` human-only. A drift guard in the test suite compares the bible's `[S]` lines against `standingFacts` item by item. `PERSONA_PLACEHOLDER_MARKERS` keeps unfinished text from shipping as persona; its CJK entry is data that detects an author who was writing in Chinese, and is deliberately not translated.

Shared C1–C7 schemas and port signatures are unchanged. `src/contracts/` is untouched by M4.

## Verification

Verified on 2026-10-15 with Node 22.22.2 and pnpm 12.11.2: 51 M4 tests passed in `test/offline/m4-dialogue.test.ts`. Typecheck, lint (0 warnings / 0 errors) and build passed. The full suite reports 287 passed / 7 failed (294 tests in 16 files, 3 files failing), and all 7 failures are pre-existing Windows-platform issues unrelated to this change: `cli.test.ts` ×3 (spawning `node_modules/.bin/tsx` needs `.cmd` on Windows), `boundaries.test.ts` ×3 (path-resolution negative cases are not observable on Windows) and `requirements.test.ts` ×1 (this machine has `core.autocrlf = true`, so the file is CRLF while the test compares LF; the repository has no `.gitattributes`). Commands from the repository root:

```sh
pnpm test:m4
pnpm verify
```

Coverage, stated precisely. **Production dialogue** is exercised by `test/offline/m4-dialogue.test.ts`, which also runs the shared dialogue conformance collector against `createDialoguePort`. The composition and regression suites do **not** drive the production port: `test/support/runner-factories.ts` substitutes `createFixtureDialoguePort` when the caller supplies no dialogue port, and `test/offline/composition.test.ts` passes none. `createFixtureDialoguePort` in `test/support/correct-ports.ts` is an independent fixture implementation, not this module. M4-01 does not change that wiring, so **the production port has no cross-module coverage yet**; the cases that need it are listed below.

The M4 tests cover generation invariants and the four termination paths; delivery memory, duplicate/conflict handling and caller-mutation isolation; session isolation of the registry, the delivery key and the persona attribution; context assembly, turn and character trimming, and the hard cap including a zero budget and an over-long newest turn; recall charging and recall that cannot fit; the durable-source composition rule and the local stand-in flag; FR-02 admission including `partial-unknown` + `failed`; interrupted-utterance marking; and persona authoring including the bible drift guard.

## Next collaboration point: I1-01

M4 supplies `createDialoguePort` and the delivery memory store, then reviews how the coordinator drives them. M5 assembles the factories and resolves shared-boundary issues.

| Owner | Requested implementation/review | Acceptance evidence |
| --- | --- | --- |
| M5 | Add cross-module cases that drive the **production** dialogue port rather than the fixture: failed delivery and session isolation through the coordinator. | A composed turn where a delivery fails after playback started, and one port instance serving two sessions, both against `createDialoguePort`. |
| M5 | Carry `DialogueSegment.index` through the coordinated C6/C7 update — see limitation 2 below. | An explicit ordinal present on a persisted delivery and on a confirmed-history record. |
| M1 | Confirm which receipt ids accompany audio evidence, so `SPOKEN_RECEIPT_POLICY` admits the right deliveries. | Interrupted second segment leaves no confirmed spoken history; a later valid receipt completes the delivery once. |
| M3 | Confirm that one `replyIntent` per turn is enough for the template lookup, and that allowed-intent filtering happens before the request reaches M4. | An out-of-set intent never reaches M4 as a valid request. |
| M6 | Keep `HistoryQueryPort` in the conformance collector and return `confirmedHistory` ordered by supporting event `seq` ascending, preserving `terminalOutcome`. | Ordered history across a restart, and an `unknown` outcome that stays unknown after replay. |
| M4 | Wire a real `DialogueTextSource` in M4-02. | Provider call with schema-valid usage, no fixture fallback on a missing key, and no credential in the repository. |

Decided in issue #22, recorded here so the implementation and this handoff agree.

- **Event ownership: option 2.** M5 constructs the `RuntimeEvent`, allocates its session-scoped `seq` and calls M6's `commitDeliveryWithEvent`. M4's `commit` is a **local view update invoked only after** the atomic acknowledgement succeeds; the ordering guarantee is persistence before spoken-memory admission. M4 owns context admission and trimming, M6 owns storage.
- **Ordering.** Supporting-event `seq` orders history within a session; the segment index preserves emission order within a turn. `segmentId` spelling must **not** be authoritative. Not yet implemented — see limitation 2.
- **`personaVersion`** stays in the coordinated contract update rather than being deferred. M4 keeps it internal until C6 carries it. Attribution for a late receipt already resolves locally, because the turn-to-persona mapping is never evicted.
- **Cross-session recall is out of scope for this slice.** For restart integration M5 will supply an ordered list of relevant source sessions for the same profile, and turns will be grouped by `(sessionId, turnId)`; session-local `seq` values must never be compared as a global sequence. Until that exists M4 can only query the session id it is handed, and the module claims no cross-session recovery.

Two limitations this slice states rather than hides.

1. **The in-memory store is not durable history.** It is a stand-in, and `historySource` plus a warning say so on every assembly that uses it. Restart recovery depends on M6; M4 complies with `confirmedHistory` rather than performing recovery itself.
2. **Segment position is still derived from the identifier.** `ConfirmedDelivery` carries no explicit ordinal, so `segmentPositionHint` recovers position from the derived segment id. That makes identifier spelling a de facto carrier of order, which #22 ruled out. Two things block the switch, both on the contract side: neither `CommitDelivery` nor `ConfirmedDelivery` carries the field, so M4 is never handed an index it could preserve; and `confirmedDeliverySchema` is a strictObject, so an added field would be stripped by M4's own parse until the schema is extended. The function is named a hint and documented as temporary so that it is deleted rather than kept as a fallback once C6/C7 carry the index.

Genuine OpenCode session exports, Chinese understanding copies and raw internal evidence are retained outside the checkout.
