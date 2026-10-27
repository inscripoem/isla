# Evaluation evidence gap map — C-05 and C-16

Status: analysis only. **C-05 and C-16 remain open.** This document closes no case, allocates no ID and
claims no S6 evidence. Updated: 2026-10-27.

## Why this exists

M5's 2026-10-24 reply records that C-03/C-14/C-15 do not complete C-05/C-16 and asks for the existing
evidence to be mapped before anything new is requested. This map states what the registered evidence
actually covers, so a later case allocation starts from facts rather than from an impression.

## Method

Read `docs/req/case-registry.yaml` on `main` (`74e9995`) and the named verifier files. A case is
**covered** only when a registered verifier asserts that case's own claim; a test that exercises the same
mechanism is **partly**.

## Map

| Case | Claim | Registered verifier | Adjacent evidence (mechanism only) | Verdict |
| --- | --- | --- | --- | --- |
| C-03 | Generation stop with a late result | `test/offline/composition.test.ts` :: `C-03: a result arriving after Stop is stale and never delivered` | — | covered |
| C-14 | Invalid selection and fallback | `test/offline/regressions.test.ts` :: `uses the M5 fallback for malformed and wrong-revision selection` | `m5-coordinator.test.ts` :: stale-epoch/wrong-revision fallback; invalid selection with usage; defer when fallback is not allowed | covered |
| C-15 | Wait and attempt accounting | `test/offline/regressions.test.ts` :: `adds exactly one attempt per new eligible input and none while unchanged` | `m5-coordinator.test.ts` :: invalid-selection accounting | covered |
| C-05 | Decision timeout | **none** (`verifier: null`) | `i1-deadline.test.ts` :: already-expired, non-finite and elapsing deadline gate; `regressions.test.ts` :: expired selection treated as stale without fallback | **partly** |
| C-16 | Intent and late fallback semantics | **none** (`verifier: null`) | `m5-coordinator.test.ts` :: allowed-intent constraint and defer when fallback is not allowed; `regressions.test.ts` :: intent preserved under substitution; `m4-dialogue.test.ts` :: a template for every reply intent | **partly** |

## Remaining gap

C-05 and C-16 are covered only at the mechanism level: the deadline gate, fallback selection and intent
templates exist and are tested, but no registered verifier asserts either case's own claim. The evaluation
adapter refuses `replyIntent`, so an S6 run cannot close C-16 today. Closing either case needs a verifier
and, if a new case is required, an ID allocated in #25.

## What this does not claim

No S6, quality, latency or cap result. No case is closed, reopened or re-scoped. The three "covered" rows
record existing registered verifiers; they are not new evidence produced by this document.
