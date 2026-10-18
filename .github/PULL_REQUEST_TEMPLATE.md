<!-- Isla pull request. The cross-module handoff checklist follows INTERFACES §7
     (see docs/team/INTERFACES.en.md). Fill it in for a module handoff; keep it
     short for routine fixes. Never include credentials or raw private records. -->

## Scope and provenance
- Task / requirement / invariant / case IDs:
- ADR / Delta:
- Baseline commit and actual changes:

## Producer / consumers
- Owner:
- Consuming modules + reviewed interface version:

## Inputs / outputs
- Fixtures, exact supported variants, intentional omissions:

## State and cancellation
- Authority, idempotence, expiry/epoch behavior, outcomes that remain unknown:

## Run instructions
- Commands + dependency versions + expected observable outputs:

## Configuration
- Config names only (no keys/tokens); who supplies them:

## Verification
- Offline/live results (distinguished); negative cases; failure examples; untested scope:

## Operational limits
- Unsupported assets/actions; service availability; measurement conditions:

## Pre-review self-check (the author runs this first; the reviewer repeats it)

- [ ] **1 — Does each gate actually run in CI?** Named command, the inputs it needs, and the events that
      trigger it. A unit test of a function is not the pipeline.
- [ ] **2 — Does a failure go red?** No `|| true`, no swallowed error, no fallback that turns a broken
      check into a pass.
- [ ] **3 — Do the claims match the facts?** The counts and commands in this description equal this head's
      actual run; a file's prose agrees with its data (for example an `Owner` cell and the header).
- [ ] **4 — Does documented behaviour match the mechanism?** Every promise in a document is executable —
      "CI re-runs when the label is added" implies the workflow lists that trigger.
- [ ] **5 — Did you run it yourself?** Frozen install, the role command and `verify`, plus each gate CLI
      with a valid, an invalid and an empty input — and the numbers quoted above come from that run.

## Gates (D7)
- [ ] G1 tests approved before implementation (label `tests-approved`)
- [ ] G2 static/boundary green
- [ ] G3 requirements schema valid
- [ ] G5 regression green
- [ ] G6 AI-use log updated (`docs/ai-use-log.yaml`)
- [ ] trace — traceability fitness functions green
- [ ] Frozen paths untouched, or an ADR accompanies the change

## Consumer acknowledgement
- Consumer's actual test/inspection result and remaining integration issue:

## Records
- Real OpenCode session / commit / evidence references and review rationale:
