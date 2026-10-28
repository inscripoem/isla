# Evaluation conditions — text source, clock and planMs

Status: proposed wording for review. No code, no schema change, no `schemaVersion` change.
Updated: 2026-10-27.

## `textSource`

`FixedConditions.textSource` describes where the **generated dialogue text** came from, not where the
inputs came from:

- `provider` — a real dialogue provider produced the text;
- `fixture` — controlled or fixed text.

A prepared corpus input executed through a real provider is `provider`. The input's provenance belongs to
the companion record, not to this field. With `history.source: 'durable'`, I1 session recovery (PR #45)
re-delivers provider-generated text after a Resume; that text is still `provider`, not `fixture` —
`textSource` describes where the generated dialogue came from regardless of how many sessions it spans.
The report refuses `fixture` for a published benchmark because fixture text consumes no tokens and is not
comparable to a provider run (`src/evaluation/report.ts:57, 173, 179-182`); the refusal is the honest
outcome, not a missing value. No third value is introduced.

## Clock

`FixedConditions.clock` records the source of elapsed-time measurement:

- `wall` — elapsed time observed by the production monotonic clock (`ClockPort` backed by the process
  clock);
- `injected` — synthetic time supplied by a test or fixture.

Dependency injection alone does not make a run `injected`: a production `ClockPort` implementation is
`wall`. The report refuses measured stage durations under `injected` because they are not observations of
real time (`src/evaluation/report.ts:184-187`).

## `planMs`

`planMs` measures the selection stage only: from selection entry to the terminal selection outcome,
including validation, deadline and cancellation handling, local processing and waiting on the provider. It
stops when the selection returns; late physical settlement is a separate stage. `planMs` is `null` when
the stage was not observed (`src/evaluation/comparison.ts:90`, `src/evaluation/metrics.ts:45`). Stages are
never summed into an end-to-end latency.

## What this does not claim

No S6, quality, latency, cap or acoustic result. No existing recording is relabelled. M3 confirms the
`wall` sentence; M5 confirms the `planMs` boundary.
