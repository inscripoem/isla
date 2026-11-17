# M6 evaluation module

Status: offline tooling implemented; S6 not run. Owner: M6.

Scope: comparison, measurement, recorded-run/report evidence and verification gates.

## Purpose

`src/evaluation/` turns evaluation attempts into attributable evidence. It contains the
shared bench, aggregation, recorded-run/report tooling and the repository gates.

It does not compose the product pipeline and does not call providers. The caller supplies
`runVariant`; the bench records what that variant returns. A thrown variant is recorded as
a failure, and a deliberate not-run case is recorded as not-run, not as a zero-valued
attempt.

## Main capabilities

| Area | Files |
| --- | --- |
| Attempt records and aggregation | `metrics.ts` |
| Comparison runner | `comparison.ts` |
| Offline bench producer | `bench.ts` |
| Evaluation run command | `run-command.ts` |
| Report renderer/writer | `report.ts`, `artifacts.ts` |
| Recorded-run parser and report command | `recorded-run.ts`, `report-command.ts` |
| Traceability and frozen-path checks | `trace-fitness.ts`, `frozen-restoration.ts`, `markdown.ts` |
| AI-use log gate | `ai-use-log-gate.ts` |
| Semantic evaluation gate | `eval-gate.ts` |
| Test-approval gate | `test-approval-gate.ts` |
| Change range acquisition | `change-range.ts`, `changed-files.ts` |
| Requirement registry/schema | `requirements-registry.ts`, `emit-req-schema.ts` |

There is no `src/evaluation/index.ts`; callers import the specific module, the run
command or the report command entry point.

## Evidence model

- **Not run is not an attempt.** A variant that cannot run returns an explicit not-run
  result and produces no `AttemptRecord`.
- **Failure is not missing.** A thrown variant is recorded as failed with a reason.
- **Unknown is not zero.** Missing usage and unobserved timings remain `null`/`unknown`.
- **The bench owns identity.** `caseId`, `variantId` and cold/warm labeling are assigned
  by the runner, not accepted from the variant.
- **First attempt is not automatically cold.** Real cold/warm state is a declared
  condition.
- **The report is a receipt.** It states what was measured, the fixed conditions and what
  was not measured.
- **No receipt without a real run.** Fixture text sources and latencies from a synthetic
  clock are refused by report validation.

The recorded-run schema is currently `schemaVersion: 1` and is frozen. Adding corpus,
rubric or other provenance fields requires an explicit reviewed schema decision and,
where structural, an ADR/Delta.

## Evaluation table and G4

The generated table path is:

```text
docs/architecture/evaluation-table.md
```

The table is currently absent. S6 has not run. G4 therefore reports **not run**; a
synthetic or adapter-only run must not be presented as the table.

## Testing and commands

```bash
pnpm test:m6
pnpm test:trace
pnpm test:readiness
pnpm verify
```

Useful evaluation commands:

```bash
pnpm evaluation:run      # execute a run through a named harness module
pnpm evaluation:report   # write a report from a recorded run
pnpm gate:eval           # G4
pnpm gate:ai-use-log     # G6
pnpm gate:change-base    # change-range helper
pnpm gate:test-approval  # G1, advisory
```

`evaluation:run` takes `--spec`, `--harness` and `--out`:

```bash
pnpm evaluation:run --spec spec.json --harness ./harness.ts --out run.json
```

The spec carries `meta`, `conditions` and `cases`. The harness module is loaded by
path and supplies `variants` and the `runVariant` seam, so the command never imports
the product composition; a deployment keeps its own peers. Before the harness is
loaded, the spec's conditions are checked by shaping a zero-record run and parsing it
with the recorded-run parser, and an existing output path is refused. After the run,
the exact bytes that would be written are parsed again, and the file is created with a
hard link so an existing artifact is never replaced.

## Boundaries

- Do not import `src/runtime`, `src/dialogue` or other production composition into the
  generic bench. Pipeline composition is injected through `runVariant`.
- Do not import `test/` helpers from production code.
- Do not invent cases, labels, scores, timings, usage or pricing.
- Do not claim quality, cap compliance, live-provider, acoustic or Windows evidence from
  offline fixtures.
- Do not change `schemaVersion: 1`, `FixedConditions`, `EvalCase` or `runVariant` without
  the owning review and a recorded decision.
- A direct selection-port run is module evidence, not full-pipeline S6.

## Related documents

- `docs/architecture/adr/007-evaluation-bench.md`
- `docs/architecture/delta/007-evaluation-bench.md`
- `docs/architecture/invariants.md` (INV-16)
- `docs/req/requirements.yaml` (NFR-01, NFR-03, NFR-04)
- `docs/req/trace.en.md`
- `docs/architecture/evaluation-table.md` (absent until S6)
