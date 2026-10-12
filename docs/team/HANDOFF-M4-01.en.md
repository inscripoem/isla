# M4-01 dialogue handoff

Revision: 2026-10-13.1. Owner: M4 — lowen. Status: under review.
Branch: `m4v1`, based on merged preparation commit `384969d`. Local commit only; no push or PR.

## Implemented behavior

The dialogue module turns one validated `DialogueRequest` into at most two ordered immutable segments and, separately, admits delivery evidence into confirmed spoken history. `DialoguePort.generate` holds a candidate text; `MemoryCommitPort.commit` decides whether that text ever becomes memory. The two are deliberately not fused: generation-complete is not playback-complete.

- Generation ends in exactly one of four ways. An aborted `context.signal` returns `cancelled` without touching the provider. A passed `deadline.atMs` returns `cancelled` with `usage.disposition = timeout`. An unknown `profileId` returns `failed` rather than falling back to a fixture. A candidate that carries no substantive character (`isSubstantiveSpeech`, `\p{L}`/`\p{N}`) ends the turn as `completed` with zero emitted segments — punctuation-only text is intercepted before `sink.segment` is ever called.
- `segmentId` is derived deterministically from `(turnId, index)` and finalized once in `FinalizedSegmentRegistry`. The same id can never carry different text: a repeat with changed text is refused, so downstream replay and C6 reconciliation cannot disagree about what the second segment contained.
- Segment order is the emission order. At most `MAX_DIALOGUE_SEGMENTS` (2) segments are admitted, and `clampMaxSegments` never widens the contract ceiling.
- `MemoryCommitPort.commit` is idempotent on `sessionId:turnId:segmentId:modality`. A repeat with identical text is a no-op and must not double-count history; a repeat with different text is a `conflict`, not a silent overwrite.
- Delivery classification and terminal outcome must agree. `DELIVERY_PAIR_POLICY = 'strict'` with `ALLOWED_DELIVERY_PAIRS` permits only `fully-delivered → completed`, `partial-unknown → cancelled | unknown`, `not-delivered → failed | cancelled | unknown`. An impossible pair is a hard failure, never a downgraded write.
- FR-02 admission is decided in `classifyMemoryBucket`. Speech reaches confirmed history only as `fully-delivered` with the required receipt; `SPOKEN_RECEIPT_POLICY = 'required-for-audio'` means audio evidence without a receipt id never enters spoken history even when the text was generated. `partial-unknown` and `not-delivered` are audit-only.
- Within one turn, several modalities of the same segment collapse to one entry using `MODALITY_PREFERENCE = ['audio','subtitle','avatar']`.
- Context assembly shares one budget. `maxTurns` and `maxCharacters` come from M5; the module never raises them. Recall is charged against the same character budget as history (`availableHistoryCharacters = maxCharacters − recalledCharacters`), so recall and history trade off rather than each opening its own allowance. Trimming follows `MEMORY_TRIM_POLICY.dropOrder` and `alwaysKeepMostRecent = true`: a very old persona half-sentence goes first, then an old persona turn, then a half-sentence, then the current persona turn; the newest turn is never dropped.
- Interrupted utterances stay legible. `renderDialoguePrompt` marks a turn cut off mid-sentence with `[cut off mid-sentence]` instead of presenting it as a complete line. Prompt order is persona block → `Already said (confirmed spoken)` → `Listener said:` → `Intent:` → `Reference lines for this intent:`.
- Persona has three layers with distinct lifetimes. L1 is the author's bible (`prompts/dialogue/character.md`) and is never rendered. L2 is `persona-content.ts`, rendered every turn. L3 is on-demand recall, currently disabled. `intentTemplatesFor` is a lookup, not a bulk injection: M5 sends one `replyIntent` and only that class's templates are emitted.
- Usage is honest. When no model was called the module reports `inputTokens`/`outputTokens` as `null` with `usageMissing: true`, matching the M5 fallback convention in `contract-runner.ts`. A fixture answer is never presented as a real provider call.

## Entry points and local configuration

Import `createDialoguePort` and `DialoguePortOptions` from `src/dialogue/dialogue-port.ts`, `createDeliveryMemoryStore` from `src/dialogue/memory-commit.ts`, and the persona/recall helpers from `src/dialogue/persona.ts` and `src/dialogue/persona-recall.ts`. Everything is re-exported from `src/dialogue/index.ts`. The production module imports no test code and never reads `process.env`; only the composition root may do that.

`DialoguePortOptions.clock` is required and has no default. `CallContext.deadline.atMs` is in the injected clock domain, not wall-clock: the fixture deadline is `60_000`, so pairing it with `Date.now()` would mark every request as already timed out and emit zero segments without any error. Tests inject a fixed clock such as `{ nowMs: () => 1_000 }`.

| Option | Purpose / default |
| --- | --- |
| `clock` | Injected time source. Required; no default. Must share the domain of `CallContext.deadline.atMs`. |
| `textSource` | Dialogue text source. Defaults to the fixture source; M4-02 supplies a real provider implementation. |
| `history` | `HistoryQueryPort` for confirmed spoken history. Omitted means an empty history, not a fabricated one. |
| `memory` | `MemoryCommitPort` sink. Omitted means generation runs and memory is not committed. |
| `personaRecall` | `PersonaRecallPort`. Omitted resolves to `createDisabledPersonaRecall()`. |
| `maxSegments` | Upper bound on emitted segments; clamped to `MAX_DIALOGUE_SEGMENTS` (2). |

Authoring and policy constants, all exported:

| Constant | Value | Meaning |
| --- | --- | --- |
| `PERSONA_AUTHORING_STATUS` | `'ready'` | Enforces content validation. `'draft'` reports issues without blocking. |
| `PERSONA_RECALL_POLICY` | `'off'` | Recall seam is wired but inert. No call path reaches a recall corpus yet. |
| `MAX_STANDING_FACTS` | `5` | Standing facts rendered every turn. |
| `MAX_STANDING_FACT_CHARACTERS` | `110` | Per-fact cap. 5 × 110 = 550 characters, about a quarter of the default 2,000-character budget. |
| `DELIVERY_PAIR_POLICY` | `'strict'` | Permits only the pairs in `ALLOWED_DELIVERY_PAIRS`. |
| `SPOKEN_RECEIPT_POLICY` | `'required-for-audio'` | Audio without a receipt id stays audit-only. |
| `MEMORY_TRIM_POLICY.alwaysKeepMostRecent` | `true` | The newest turn is never trimmed. |

The bible is linked by `sourceDocument: 'prompts/dialogue/character.md'` and `sourceVersion: '1'`; the runtime profile is `profileId: 'Elleya'`, `version: '2'`, exposed as `personaVersionKey()` → `Elleya@2`. `src/dialogue/` owns the bible and the standing persona; they do not enter M6 storage, and there is no second writable source.

`standingFactsFromBible` reads only blockquote lines (`/^\s*>/`) carrying the `[S]` marker, so the marker legend table never counts as content. `BIBLE_MARKERS` defines `[S]` standing, `[R]` recall candidate, `[H]` human-only. A drift guard in the test suite compares the bible's `[S]` lines against `standingFacts` item by item, turning "the two agree" from a convention into an enforced check. `PERSONA_PLACEHOLDER_MARKERS` keeps unfinished text from shipping as persona.

Shared C1–C7 schemas and port signatures are unchanged. `src/contracts/` is untouched by M4.

## Verification

Verified on 2026-10-13 with Node 22.22.2 and pnpm 12.11.2: 41 M4 tests passed in `test/offline/m4-dialogue.test.ts`. Typecheck, lint (0 warnings / 0 errors) and build passed. The full suite reports 287 passed / 7 failed (294 tests in 16 files, 3 files failing), and all 7 failures are pre-existing Windows-platform issues unrelated to this change: `cli.test.ts` ×3 (spawning `node_modules/.bin/tsx` needs `.cmd` on Windows), `boundaries.test.ts` ×3 (path-resolution negative cases are not observable on Windows) and `requirements.test.ts` ×1 (this machine has `core.autocrlf = true`, so the file is CRLF while the test compares LF; the repository has no `.gitattributes`). Commands from the repository root:

```sh
pnpm test:m4
pnpm verify
```

The same conformance, composition and regression assertions run against both fixture and production dialogue implementations. Tests cover generation invariants, the four termination paths, delivery memory and duplicate/conflict handling, context assembly and trimming, FR-02 admission, interrupted-utterance marking, the recall seam (disabled by default; enabled, it renders bible provenance and shares the character budget) and persona authoring including the bible drift guard.

## Next collaboration point: I1-01

M4 supplies `createDialoguePort` and the delivery memory store, then reviews how the coordinator drives them. M5 assembles the factories and resolves shared-boundary issues.

| Owner | Requested implementation/review | Acceptance evidence |
| --- | --- | --- |
| M5 | Decide who constructs the `RuntimeEvent` for `commitDeliveryWithEvent`, and add the `confirmedHistory` ordering sentence to `INTERFACES.en.md` §C6/C7. Review segment backpressure and the C6 classification handoff. | A named event constructor, the ordering wording recorded in INTERFACES, and one end-to-end turn where delivery and event arrive together. |
| M5 (continue) | Confirm whether `ConfirmedDelivery.personaVersion` is included now or explicitly deferred. If included, C6 coordination is required. | Either the settled schema with the nullable field, or a dated deferral note. |
| M1 | Confirm which receipt ids accompany audio evidence, so `SPOKEN_RECEIPT_POLICY` admits the right deliveries. | Interrupted second segment leaves no confirmed spoken history; a later valid receipt completes the delivery once. |
| M3 | Confirm that one `replyIntent` per turn is enough for the template lookup, and that allowed-intent filtering happens before the request reaches M4. | An out-of-set intent never reaches M4 as a valid request. |
| M6 | Keep `HistoryQueryPort` in the conformance collector and return `confirmedHistory` ordered by supporting event `seq` ascending, preserving `terminalOutcome` so `unknown` cannot be replayed as `delivered`. | Ordered history across a restart, and an `unknown` outcome that stays unknown after replay. |
| M4 | Wire a real `DialogueTextSource` in M4-02. | Provider call with schema-valid usage, no fixture fallback on a missing key, and no credential in the repository. |

Two items remain open on the M5 side. The blocking one is event ownership: `MemoryCommitPort.commit(delivery)` carries no event, and `seq` is allocated by M5, so M5 must construct the `RuntimeEvent` and hand it over — M6 has confirmed it never assigns `seq` and cannot supply the event. M4 prefers `commit(delivery, event)` as the settled signature because it keeps the delivery and its event atomic and auditable. The second is the ordering sentence for `INTERFACES.en.md`: `confirmedHistory(sessionId)` returns entries ordered by supporting event `seq` ascending, and M4's "never drop the newest turn" rule depends on that guarantee rather than on an incidental database behaviour. Both are tracked in issue [#22](https://github.com/inscripoem/isla/issues/22).

Already agreed and not needing further coordination: M4 accepts M6's storage defaults, does not require delivery-memory search (deferred in PLAN), and needs no new recall port — persona facts come from M4's own bible, while the recall mechanism may be shared with history while keeping the corpus separate. M4-02 will read `ISLA_DIALOGUE_API_KEY`, `ISLA_DIALOGUE_BASE_URL` and `ISLA_DIALOGUE_MODEL` only at the composition root; a missing key must fail explicitly rather than silently fall back to fixture text.

Genuine OpenCode session exports, Chinese understanding copies and raw internal evidence are retained outside the checkout.
