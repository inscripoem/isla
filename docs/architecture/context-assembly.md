# Per-turn context assembly

Status: under review. Date: 2026-11-25. Source: `55e36d3` on `main`. Owner: M4
(dialogue). Reviewers: M5 (runtime), M6 (evidence).

This note records what the runtime actually assembles into one dialogue prompt
per turn: the layers, their render order, the unit each limit uses, the
deduplication and trim rules, and which constraints survive trimming. It
describes the current implementation; it is not a new architecture decision.
The token cap, compaction step and post-compaction reinjection policy in
[Proposed design](#proposed-design-not-shipped) are explicitly not shipped and
carry no agreed values.

## Layers and render order

`assembleDialogueContext` (`src/dialogue/context.ts`) builds an
`AssembledDialogueContext`. `renderDialoguePrompt` renders it, and
`OpenAiCompatibleTextSource` sends it as the `user` message of one
chat-completion request (`src/dialogue/provider-text-source.ts`). A separate
fixed `system` instruction states only the output format. That instruction is
not part of `maxCharacters`.

Rows are listed in the order the prompt renders them, oldest-first inside each
section.

| # | Layer | Producer | Budget unit and cap | Present when |
| --- | --- | --- | --- | --- |
| 1 | Persona block, including standing facts and persona summary | `renderPersonaBlock(profile)` | Not charged to `maxCharacters`; the renderer keeps at most `MAX_STANDING_FACTS = 5` standing facts, and profile validation limits each to `MAX_STANDING_FACT_CHARACTERS = 110` | Always |
| 2 | Character state block | `renderStateBlock(state, stateProfile ?? DEFAULT_STATE_PROFILE)` | Rendered characters; plan `state` cap, or `maxCharacters` without a plan; also subtracted from the shared pool | `state` is supplied, renders, and fits |
| 3 | Working-memory block | `renderWorkingMemoryBlock(entries)` | Rendered characters; plan `workingMemory` cap, or `maxCharacters`; additionally state + working memory must fit `maxCharacters` | Entries are supplied and fit |
| 4 | Recalled persona facts | `personaRecall.recall` | Recall bound (plan `recall` cap intersected with the shared pool); at most `MAX_RECALLED_FACTS = 5`; each rendered line charged | A recall port is supplied |
| 5 | Recalled older turns | `deliveryRecall.recall` over turns the window dropped | Same recall bound; at most `MAX_RECALLED_TURNS = 3` and never more than `maxTurns` | A recall port is supplied and `maxTurns > 0` |
| 6 | Heard-prefix turns: incomplete deliveries that carry a receipt | Bucket `heard-prefix` from `classifyMemoryBucket` | Remainder after history, recalls and listener rows; their own `maxTurns` allowance; each line charged | Candidates exist and fit |
| 7 | Merged listener/confirmed transcript | `mergeTranscript` | Shared history pool; each line charged; listener stream capped at `maxTurns` | At least one listener row survives |
| 7′ | Confirmed history and one rollup line | `trimToCharacterBudget` | Shared history pool; each turn line and the rollup line charged | No listener row survives |
| 8 | Current input, reply intent and reference lines | `request` and `intentTemplatesFor` | Not charged | Always, appended after trimming |

Layers 4 and 5 share one recall bound. Layers 6 and 7/7′ share the character
pool: listener rows yield before character turns, and heard-prefix turns take
only what remains. Layer 7 replaces 7′ when listener turns survive; a non-empty
transcript carries no rollup.

## Assembly pipeline in actual order

1. Resolve the layered plan with `allocateBudget` when the caller supplied one.
   Without a plan every section comparison falls back to `maxCharacters`.
2. Select one record source: durable `history` if supplied, otherwise the local
   `memory` stand-in, otherwise none. The two are never merged, so one delivery
   is counted once; the local stand-in is reported as a warning.
3. Admit records by `classifyMemoryBucket` into spoken, heard-prefix or
   audit-only. Audio needs playback evidence under
   `SPOKEN_RECEIPT_POLICY = 'required-for-audio'`. Non-admitted records are
   recorded in `exclusions`.
4. Deduplicate by `utteranceKey` (`sessionId`, `turnId`, `segmentId`): one
   utterance keeps one record, selected by `modalityRank`. A heard-prefix copy
   of an already-confirmed utterance is dropped, so complete speech wins.
5. Group segments into turns by `(sessionId, turnId)`. Sort segments by
   persisted `segmentIndex` ascending, with unknown (`null`) indices last and
   stable input order for ties.
6. Run the contradiction scan over admitted turns plus standing facts, before
   the recency window and before trimming. The scan has its own fixed bounds and
   reports incompleteness rather than hiding it.
7. Apply the recency window: keep the newest `maxTurns` turns. Older turns are
   recorded as `turn-limit` exclusions and remain candidates for delivery recall.
8. Cap pinned turns at `MAX_PINNED_TURNS = 3`; higher salience wins, and equal
   scores keep the older turn.
9. Decide the state block. A block that renders but exceeds its cap is dropped
   whole as a budget loss. A block with a non-finite dimension is a separate
   validation loss and is not counted as a budget drop.
10. Decide the working-memory block. It is dropped whole when it exceeds its own
    cap or when it and a kept state block together exceed `maxCharacters`.
11. Compute `sharedBudget = maxCharacters - kept state - kept working memory`,
    then the recall bound as the minimum of the plan's recall cap and
    `sharedBudget`.
12. Fit persona recall to the recall bound in port order; the remainder is
    recorded as `recall-budget`.
13. Fit delivery recall to the same bound. A recalled older turn displaces a
    recent turn rather than adding to the caller's `maxTurns` quota: unpinned
    turns are displaced oldest-first, then pinned turns only if needed.
14. Process listener rows: drop the current input's own event, stably sort by
    `(receivedAtMs, eventId)`, apply a per-stream `maxTurns` cap, then remove the
    oldest listener row until the transcript and history fit.
15. Trim confirmed history with `trimToCharacterBudget`. Whole turns are dropped
    in `TRIM_ORDER`: superseded-persona and interrupted, superseded-persona,
    interrupted, current persona, and pinned last. Equal ranks drop the earlier
    (older) turn. The newest turn is protected only while another candidate
    exists. If one turn remains and still exceeds the bound, it is dropped as
    well. A rollup line states the omitted count when it fits.
16. Give heard-prefix turns the remainder, ranked by `trimRank`; candidates are
    judged one by one, so a cheaper candidate may still fit after a costlier one
    is refused.
17. Emit diagnostics when a plan was supplied: per-section `limit`, `used` and
    `dropped`, plus `estimatedTokens` over exactly the charged lines.

## Budget units and what the limits do

- `contextLimits.maxCharacters` counts rendered characters (JavaScript string
  length) of the charged lines. It is not a token count. The cap covers
  confirmed history, recalls, heard-prefix turns, listener rows, a kept state
  block, a kept working-memory block and the rollup line. It does not cover the
  persona block, section headers, the current input, the intent line or the
  system instruction.
- `contextLimits.maxTurns` bounds each history stream separately. The
  confirmed/recalled stream has its own window, recall allowance and
  heard-prefix allowance; the listener stream has its own `maxTurns`. Up to
  `2 * maxTurns` history rows can therefore reach the prompt.
- The default plan is a pinned initial choice of 0.2 persona, 0.1 state,
  0.1 working memory, 0.2 recall and 0.4 history. Each non-history cap is
  `floor(share * maxCharacters)`. History receives the remainder, so unused
  section quota flows back to it, and history never falls below
  `floor(0.35 * maxCharacters)`. A plan that cannot honour both the floor and the
  total is rejected rather than silently corrected.
- The persona share is reported with `used = 0`: this batch has no persona
  content source routed through the plan. The persona block itself has no
  assembly cap; the renderer keeps at most five standing facts and profile
  validation limits each such fact to 110 characters.
- `estimatedTokens` is an approximation over the charged line sections only
  (confirmed history, recalls, heard-prefix turns, listener rows and the rollup):
  `ceil(latin / 4 + cjk / 1.5)`, with one aggregate rounding, not per line. The
  state and working-memory blocks are not lines and are excluded. It is a
  diagnostic. The module has no tokenizer, so it must not be used as a cost,
  quality or capacity conclusion.

## Deduplication, trimming and exclusions

Every loss is recorded rather than hidden. `exclusions` names the session, turn
and segment with a reason such as `duplicate-modality`, `turn-limit`,
`character-budget`, `trim-stale-persona`, `trim-truncated` or
`heard-prefix-budget`. Recall losses use `recall-budget`. Listener losses use
`listener-limit` or `listener-budget`. The returned `warnings` list names each
class of loss, including a dropped state block, a dropped working-memory block,
and the case where the newest turn did not fit.

The character cap is hard. No charged section is rendered past it, and the
newest-turn protection yields when no other turn can give way. A zero
`maxCharacters` produces no sections at all. The turn limit and the character
limit are distinct: a turn dropped by `maxTurns` is not reported as a character
budget drop.

## Preserved constraints and reassembly

The following are outside the trimming loops and are rendered on every turn:

- the persona block, which carries the standing constraints;
- the current input, the reply intent and any reference lines for that intent;
- explicit markers: the interrupted-speech marker, the heard-prefix marker, the
  `[audience, untrusted]` listener prefix, and the optional conflicting-turn
  marker when that opt-in is on.

State, working memory, recalled facts, recalled turns and heard-prefix turns are
best-effort: a block that does not fit is dropped whole and reported. Confirmed
history is the only section that absorbs leftover quota. There is no
summarization or model call in assembly.

## Proposed design, not shipped

These three items answer the D2 brief but do not exist in the current runtime.
They are separate proposals; none has an agreed value, threshold or test
result, and none should be read as accepted status.

### Token cap

Current state: the only provider-facing cap is the character cap above. The
repository has no tokenizer and no measured token count; `estimatedTokens` is a
diagnostic approximation only. Proposal: add a token cap computed with the
actual provider tokenizer, with the cap and safety margin set from measured
prompts and provider-reported usage. No value is proposed here. Validation
would need token counts per layer against real provider usage, including the
over-cap failure path. Related open item: NFR-04's cost/token caps remain TBD,
and the approval record says final numeric targets are not approved.

### Compaction

Current state: assembly never summarizes or rewrites history. Trimming drops
whole turns, and the rollup line states only how many were omitted. Proposal:
when a future token cap is approached, compact dropped turns into a summary
under a still-unset threshold and format. Any compaction must keep the delivery
status distinctions (confirmed, interrupted, heard-prefix) and must not invent
content. Validation would need deterministic tests for those distinctions plus
human review of generated summaries. Not shipped.

### Post-compaction critical-constraint reinjection

Current state: the present protection is structural rather than a reinjection
step. The persona block and the current input/intent are outside every trimming
loop, so trimming cannot remove them from the prompt. Proposal: after any future
compaction, re-inject the persona/standing constraints, the current input, the
intent and the untrusted-content markers at fixed positions. The policy,
ordering and verification are unset. No test exists because no compaction exists
yet. Honest limit: these are prompt-construction boundaries, not a verified
model-compliance guarantee; resistance to instructions embedded in recalled text
is tracked as a separate live-provider check (#44), not by this document.

## Evidence

Deterministic checks that support the description above, selected by
`pnpm test:m4`:

- `test/offline/m4-budget.test.ts`: `allocates floors that never exceed the total
  and keep history at its floor`; `flows unused recall quota back to history`;
  `keeps every section within its own cap and the total within maxCharacters`;
  `reports estimatedTokens as the pinned approximation of the charged lines`;
  `produces no sections at all when maxCharacters is 0`; `charges a kept state
  block to the plan state section`; `drops a working-memory block that fits
  alone but not alongside a kept state block`.
- `test/offline/m4-dialogue.test.ts`: `bounds context by the configured turn
  limit`; `marks an interrupted turn instead of presenting it as complete`;
  `keeps one entry per utterance when a segment is confirmed for two
  modalities`; `drops memory from an older persona before current-persona
  memory`; `honours a zero character budget instead of keeping one turn`.
- `test/offline/m4-transcript.test.ts`: `renders the legacy prompt byte-for-byte
  when no listener history exists`; `drops the oldest listener lines first when
  the transcript exceeds the character budget`; `excludes listener turns beyond
  maxTurns with listener-limit`; `yields every listener line before trimming a
  character turn, returning to the legacy prompt with the rollup`.
- `test/offline/m4-heard-prefix.test.ts`: `renders a heard-prefix turn in its own
  section with exactly one marker`; `drops heard-prefix turns first when the
  budget is short`; `renders a cross-bucket duplicate utterance only as
  confirmed speech`.

These are offline fixture tests. They do not measure tokens, live-provider
behavior, acoustic output or model compliance.
