# M3 selection corpus v1.1

Status: human-reviewed. Owner: M3.

`corpusVersion` is `m3-selection-v1.1`; `rubricVersion` is
`m3-quality-rubric-v0.1`. That rubric
(`docs/decision/m3-quality-rubric-v0.1.md`) governs M3 C1 candidate selection and
reply-intent suitability only. It is distinct from M4's downstream
`m4-dialogue-scoring-rubric-v0.1`
(`docs/decision/m4-dialogue-scoring-rubric-v0.1.md`), which scores spoken
dialogue and persona/history quality. The manifest's `casesSha256` is a SHA-256
digest over canonical JSON (object keys sorted, array order preserved) of the
manifest case fields and the canonical request, label and review content. It is
not a hash of raw file bytes, so Windows CRLF and Linux LF checkouts produce the
same value.

Requests, reference labels and detached review records are separate files. The
loader validates labels and reviews as corpus data before execution, but a
`SelectionPort` receives only the request. Labels are not passed to the port and
are used by the test scorer only after the result returns.

## Case layout

The corpus contains 12 `selection-port` cases. Four are development cases with
`heldOut: false` (`selection-001`..`selection-004`) and eight are held-out
evaluation cases with `heldOut: true` (`selection-005`..`selection-012`).

- `selection-001` and `selection-002` are the original greeting and
  unintelligible-input cases.
- `selection-003` covers a mixed greeting, on-topic question and noise burst.
- `selection-004` covers viewer-to-viewer side chat where a justified `defer`
  is preferred.
- `selection-005` covers an underspecified pronoun reference requiring
  `clarify`.
- `selection-006` covers a discouraged viewer needing `support`.
- `selection-007` covers lighthearted banter calling for `playful`.
- `selection-008` covers a viewer factual correction calling for
  `check-correction`.
- `selection-009` is a full five-candidate burst (`MAX_SELECTION_CANDIDATES`)
  with one substantive on-topic question among short emotes and noise.
- `selection-010` covers a held-out justified `defer` on an AFK notice and a
  keyboard smash.
- `selection-011` covers a `cohost-text` arrival under restricted
  `allowedIntents` that exclude `answer`.
- `selection-012` covers untrusted prompt-injection bait (`INV-07`) arriving
  earliest alongside a genuine topical viewer question.

Together the cases exercise all six `ReplyIntent` values: `answer`, `clarify`,
`acknowledge`, `support`, `playful` and `check-correction`, as well as justified
`defer`, the five-candidate selection bound, `cohost-text` source handling and
prompt-injection resistance.

## Review status

All 12 cases in `m3-selection-v1.1` are human-reviewed (`status: "reviewed"`,
`provenance: "human"`) by `shallight` (`reviewerId: "shallight"`):
`selection-001` recorded on `2026-10-23` and `selection-002` through
`selection-012` recorded on `2026-11-13`. The detached JSON files under
`reviews/` record, but do not cryptographically sign, this author self-review;
each record is bound to the exact `requestSha256` and `labelSha256` digests of
its request and reference label, and every intent label retains
`coverage: "partial"`.

Independent second-owner cross-review of all 12 requests and reference labels
was completed by M4 (`@L01nki1`) on `2026-11-13` at commit
`cb156c426c848cdecf2789029ac4c2957f45352d` (PR #155 review
`PRR_kwDOU7Q6_88AAAABX2SVaw`).

The `selection-001` scores are message-001 = 2, message-002 = 1 and defer = 0;
`answer` and `acknowledge` are accepted for their respective candidates, and
`heldOut` remains false. The approval does not authorize inventing the game
name or certify generated dialogue.

A `draft` review record produces no adopted score. Records with
`provenance: "synthetic-test"` are permitted only for mechanics tests; they
never certify corpus evidence. Exhaustive intent coverage requires a reviewed
`coverageRationale`; otherwise unlisted allowed intents are unassessed.

## Split freeze and evaluation boundary

All 12 cases (4 `heldOut: false` development cases and 8 `heldOut: true`
evaluation cases) were authored in PR #155
(`casesSha256 = c7c1b19d875e7510210e156656ad4749c33c82d6b54dbb1ee2bb7a6b9f68fa63`)
to establish the initial freeze before any live-provider prompt or model tuning.
Offline mock runs are mechanics checks only (`certifiesCorpus: false`) and never
constitute quality or generalisation evidence. `heldOut: true` reserves
`selection-005` through `selection-012` strictly against post-freeze prompt or
model tuning on real providers.
