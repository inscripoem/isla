<!-- Use existing work links. Keep routine fixes short and remove irrelevant
     prompts. Module handoffs still follow docs/team/INTERFACES.en.md §7.
     Required CI, human approvals and frozen-path rules remain in effect. -->

## Change
- What problem does this solve, and what will a user or consumer observe?
- Existing task/PR, original task and applicable requirement/invariant/case IDs; baseline and actual change.

## Verification and records
- Actual commands and results on the stated revision; relevant failure/Stop cases, skips and untested limits.
- Distinguish offline, live and physical-output observations. Report applicable gates honestly, including advisory or not-run results.
- If a gate changes, include a failing control that demonstrates its enforcement; routine changes do not need to re-prove every unchanged gate.
- For source/prompt changes: AI-use-log entry, genuine session/commit references and review evidence; keep raw private records outside the repository.

## Review and remaining work
- Owner and affected consumers; identify the concrete review or handoff requested.
- Link an existing acceptance issue if implementation alone does not complete the delivery. Record the consumer result when available; do not invent a closing keyword or create a duplicate task.
- Known blocker and requested owner; estimate when supplied.

## Handoff details, when applicable
- Changed interface/version, supported examples and substitutes.
- State, idempotence, cancellation/deadline/authority behavior and outcomes that remain unknown.
- Configuration names and supplier, migration/cleanup, service or platform limits; never include credentials.
- Shared/frozen changes and the required ADR/Delta or owner decision.

Before requesting review, check that the claims match this revision and actual output, applicable checks passed, and remaining limits are explicit. A consumer's inspection, a CI result and product acceptance each retain their actual scope.
