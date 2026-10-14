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
