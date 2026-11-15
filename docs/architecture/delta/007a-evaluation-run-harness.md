# Delta-007a — Evaluation run harness and the `evaluation:run` command

Change record for **ADR-007** (amendment). Date: 2026-11-15. Branch `m6-cp05-closeout`
(based on `main` `205424f`). Scope: **additive** — no schema, contract or frozen-path change.

This record **extends** ADR-007 and Delta-007. Neither is rewritten, and no new ADR number is
claimed: the decision recorded here refines ADR-007 **D6** ("the bench does not invent a
provider"), it does not replace the bench architecture.

## Change

- **Added** `src/evaluation/run-command.ts` — `evaluation:run`. It reads a run spec
  (`meta`, `conditions`, `cases`), loads an evaluation harness module by path, executes every
  case through the supplied `runVariant` seam with `runBench`, and writes the recorded run.
- **Added** `test/offline/m6-02-run-command.test.ts` — 15 tests. `test/support/evaluation-harness-fake.ts`
  is the test-only harness.
- **Added** the harness contract: the module default-exports (or exports `createEvaluationHarness`)
  a factory returning `{ variants, runVariant, close? }`. The command validates the shape before
  executing anything.
- **Added** the `evaluation:run` script in `package.json`.
- **Modified** `src/evaluation/README.md` — capability row, command list and the harness contract.
- **Modified** `docs/architecture/trace-matrix.md` — one row for the command.

## Why

ADR-007 D6 fixes that the bench does not invent a provider, and `ComparisonDeps.runVariant` is
supplied by the caller. In practice no caller existed: `runBench` and the production `runVariant`
seam (`src/runtime/evaluation-adapter.ts`) were exercised only by their own tests, so no run could
be executed at all. The missing piece was an imperative shell, not another bench.

The command loads the harness by path — the pattern `runtime:production` already uses for
`ISLA_DEPLOYMENT_MODULE` — so `src/evaluation/` still does not import the runtime composition. The
deployment keeps its peers and its owner; the runner keeps the evidence rules.

## Decisions

- **D-A — composition stays outside evaluation.** The harness supplies `variants` and `runVariant`.
  The command imports neither the runtime composition nor a deployment, and a test-only harness
  proves the shell with no provider.
- **D-B — the artifact is parsed before it is written.** `readRunSpec` checks only the fields the
  runner itself needs; the recorded-run parser owns the full shape. The exact bytes that would be
  written are parsed with `parseRecordedRun`, so the command cannot emit an artifact the report
  command refuses. A refusal writes nothing.
- **D-C — evidence is never replaced.** An existing output path is refused, not overwritten.
- **D-D — expected refusals are data, faults throw.** A bad argument, an unreadable or empty spec,
  a missing harness module, a throwing factory and an existing output return
  `{ ok: false, violations }`. A filesystem fault during the write throws, and the temporary file is
  removed.

## What this does not change

`RecordedRunV1` / `schemaVersion: 1`, `FixedConditions`, `EvalCase`, `ComparisonDeps.runVariant`,
ADR-007 D1–D8, the report writer, the gates and `src/runtime/`. No threshold value, no case id and no
live result is added.

## Verification

- `pnpm test:m6` → 22 files, **339 passed**; the command suite is **15 passed**.
- `pnpm test:trace` → **41**; `pnpm test:readiness` → **47**; `pnpm verify` → exit 0, 88 files,
  **1872 passed**.
- Mutations, each applied alone and restored: existing-output refusal disabled; duplicate-option
  refusal disabled; missing-option refusal disabled; empty case set accepted; empty variant list
  accepted; output validation disabled. Each turned its own test red.
- End to end, locally: one real-provider case completed through a local harness and was written; an
  incomplete `conditions` object is refused and leaves no file.

## Traceability

- Trace row: `NFR-01 / NFR-04 / INV-16`, component `src/evaluation/run-command.ts`, test
  `test/offline/m6-02-run-command.test.ts`, `ADR-007`, owner M6.
- **Case id: pending #25.** The row records `— (no new case ID)`; the refusal paths are asserted by
  the test above. A case must be allocated before this record is cited as acceptance evidence.

## Open

- A product run still needs the deployment (#96), a synthesis that voices generated text (M1) and a
  playback consumer that emits receipts (M2). A provenance companion needs M5's #101 export.
- The local harness and spec used for the demonstration are untracked and are not part of this
  change.
