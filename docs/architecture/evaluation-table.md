# Evaluation report

> Run `pilot-selection-local-magpie-20261125` — generated 2026-11-25.

> The conditions below are **declared by the run harness**, not inferred from the records.
> Gate **G4** checks that hardware, provider, workload, sample size and cold/warm state are
> recorded; it cannot check that they are true.

## Fixed conditions

| Condition | Value |
| --- | --- |
| Hardware | local Linux host (NixOS 26.11, x86_64; briefcase) |
| Providers | local Magpie gateway group/deepseek-flash (loopback HTTP) |
| Workload | m3-selection-v1.1 selection-001 / message-001; text path, audio substituted |
| Sample size (attempts) | 1 |
| Cold/warm state (declared) | cold |
| Persona profile | `Elleya` @ `2` |
| Model version | group/deepseek-flash (local Magpie gateway; served unconfirmed) |
| Prompt version | openai-compatible-v1 |
| Text budget | 2000 characters — rendered characters |
| History | local / empty set (no prior turns) |
| Text source | provider |
| Clock | wall |
| maxTurns | — |
| Recall port | not supplied |

## Prepared-input provenance

> No companion was supplied, so **every attempt is `unscored (no-provenance-record)`**
> (ADR-008 D8). This table reports latency, cost and outcome only; no attempt is scored.

## Results by variant

| Variant | Kind | Combined | Bench attempts | Completed | Cancelled | Failed | Failure rate | Usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reference-text | model | no | 1 | 1 | 0 | 0 | 0.0% | unknown |

> `—` in the failure-rate column means no attempt was recorded for that variant; the rate is unknown.

## Latency (ms)

> **First attempt** means the variant's first actual attempt in this run. It is **not** evidence of a
> cold process, provider, worker or cache; the declared cold/warm state above is the run condition.
> `n` is the number of attempts that actually reported the stage; `—` means it was not observed.

| Variant | Window | Stage | n | p50 | p95 |
| --- | --- | --- | --- | --- | --- |
| reference-text | first attempt | submit (M5) | 0 | — | — |
| reference-text | first attempt | plan (M3) | 0 | — | — |
| reference-text | first attempt | dialogue (M4) | 0 | — | — |
| reference-text | first attempt | synthesis (M1) | 0 | — | — |
| reference-text | first attempt | first audible (M1) | 0 | — | — |
| reference-text | first attempt | stop→silence (M1/M2) | 0 | — | — |
| reference-text | later attempts | submit (M5) | 0 | — | — |
| reference-text | later attempts | plan (M3) | 0 | — | — |
| reference-text | later attempts | dialogue (M4) | 0 | — | — |
| reference-text | later attempts | synthesis (M1) | 0 | — | — |
| reference-text | later attempts | first audible (M1) | 0 | — | — |
| reference-text | later attempts | stop→silence (M1/M2) | 0 | — | — |

## Every attempt

| Case | Variant | Window | Outcome | total ms | Provider attempts | Note |
| --- | --- | --- | --- | --- | --- | --- |
| selection-001 | reference-text | first | completed | — | — |  |

> `—` in the attempts column means the provider-attempt count was not observed, for example when an
> adapter threw before reporting one. It is unknown, never zero.

## Not run

No case was skipped: every case was attempted for every variant.
