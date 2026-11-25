# Control permissions and privacy policy verification

Status: **verification record for [#107](https://github.com/inscripoem/isla/issues/107)** (checkpoint
[#76](https://github.com/inscripoem/isla/issues/76)). Owner: M5. Reviewers/accepters: M1/M4/M6. This
record states what was checked and what remains; it does not close #107 without the named
confirmations.

## 1. Configuration in scope

The checks below apply to the live target declared in
[`supported-platform.md`](supported-platform.md) and the recorded run at
[`9577069`](https://github.com/inscripoem/isla/commit/95770691cc927bb82d747024b6be193420648b21).

## 2. Control permissions

- **Operator authority is explicit, never inferred.** The console obtains a one-time same-origin
  bootstrap token and the runtime authorizes control from it
  (`src/contracts/app/transport.ts`, `src/runtime/control-policy.ts`,
  `src/console/operator-bootstrap.ts`). The live run reported `Operator authority: yes`; an operator
  Stop produced the `cancelled / partial-unknown` delivery, the player returned to idle, and no
  later `playing` event was observed ([M1 receipts](https://github.com/inscripoem/isla/issues/97#issuecomment-6918501769)).
- **Untrusted content cannot grant control privileges or change policy** (INV-03 / NFR-05, C-07).
  The verifier is `test/conformance/runtime.conformance.ts::untrusted-control-refused`; the case is
  registered as implemented in `docs/req/trace.en.md`.
- **Stop and local cancellation never wait for a storage write.** Stop advances the epoch, revokes
  the active turn and starts cancellation without waiting for persistence. A failed cancellation
  commit leaves `outputConfirmation: pending` with zero deliveries
  (`test/offline/m5-coordinator.test.ts::keeps cancellation evidence unconfirmed when the held commit fails`);
  the runtime policy catalog records that Stop and local cancellation proceed regardless, and no
  output is replayed.
- **Recovery requires operator authority.** Recovery is the explicit `session.recover` action,
  accepted only from the operator role (`src/runtime/application.ts::handleRecover` rejects a
  non-operator with `unauthorized`). A process restart begins stopped and restores only confirmed
  history; unresolved output is not promoted or replayed (runtime policy catalog, C-32/C-33).

Negative checks: untrusted control attempts are refused by the conformance verifier; Stop during
playback settles to idle with no subsequent `playing`; restart does not turn unknown output into
spoken history.

## 3. Privacy policy

- **What is stored.** Events and deliveries, persona attribution and segment index, and the
  memory tables described by ADR-009. Raw audio is not stored in event payloads; credentials and
  tokens never enter events or JSONL exports.
- **Consent and durability.** Owner and derived memory writes require a binding that is both
  `durable` and consenting; a non-durable or non-consenting binding is refused, anonymous or
  non-consenting listeners stay session-scoped, and a different audience is a conflict
  (INV-17 / ADR-009; C-76/C-77).
- **Retention and deletion.** There is no automatic expiry and no default retention period.
  `deleteOlderThan(audienceId, days, nowMs)` is operator-called, audience-scoped, and leaves
  `events` and `deliveries` append-only; one audience's retention cannot remove another audience's
  rows (C-78). Retraction is defined as a withdrawal marker plus recall suppression and is not
  implemented in v0.2; it remains distinct from deletion. Physical erasure and a user-facing forget
  action are also not implemented.
- **Budgets are not retention.** `maxTurns` and `maxCharacters` only drop content from a rendered
  context; they do not delete stored evidence.

The agreed policy in one paragraph: store only what the run needs, keep raw audio and credentials
out of event payloads and exports, write owner/derived memory only under a durable consenting
binding, and delete or retain only per audience on an explicit operator call without touching
append-only evidence.

## 4. Verification evidence

| Check | Evidence | Result |
| --- | --- | --- |
| Untrusted control refused (C-07) | `test/conformance/runtime.conformance.ts::untrusted-control-refused`; `docs/req/trace.en.md` marks C-07 implemented | implemented verifier |
| Consent/durable gate, unowned/refused/conflict (C-76) | `test/offline/m6-memory-store.test.ts` — insert-once binding, durable/consent refusal, owner/derived gate | passing |
| Session-scoped state and audience conflict (C-77) | `test/offline/m6-memory-store.test.ts` — state read-back, stale-version conflict, audience immutability, state under a non-durable binding | passing; a two-session seed would add a cross-session replay case, not change the current audience-conflict verifier |
| Audience-scoped deletion/retention leaves evidence (C-78) | `test/offline/m6-memory-store.test.ts` — cross-table delete, unchanged evidence counts, per-audience retention, audience export scope | passing |
| Invalid output refused without delivery (#107 delivery scope) | `test/offline/m5-coordinator.test.ts::rejects a malformed segment and ends the cycle safely`; `::rejects a malformed direct execute receipt without throwing` | passing — a malformed segment emits `segment.rejected` with zero player executions and zero deliveries; a malformed direct receipt yields zero deliveries and `outputConfirmation: unknown` |
| Operator Stop settles to idle without replay | [M1 six browser receipts](https://github.com/inscripoem/isla/issues/97#issuecomment-6918501769) and [M1 Windows live evidence](https://github.com/inscripoem/isla/issues/96#issuecomment-6920647994) | observed on the live target |

Commands and results at `main` `e32bf1a6`: `pnpm test:m6` → 22 files / 343 tests passed;
`pnpm verify` → 94 files / 2084 tests, typecheck, lint and build passed.

## 5. Gaps and limits

- The D3-required `.opencode/permissions.jsonc`, `.opencode/rules.md` and `.agent/rules.md` are not
  in git; the current permission surface is `AGENTS.md`/`opencode.json` plus the code policy. This is
  a #114/CP08 gap and is not claimed as complete here.
- NFR-05 retention/deletion remains a **pending-metric**: no retention period has been agreed, so
  this record states "no automatic expiry" rather than a threshold.
- Retraction/forget is semantic only and not implemented in v0.2; physical erasure is not
  implemented.
- The live control observation is one controlled run on the declared target; it does not establish
  another device, platform or adversarial deployment.
- Named reviewer confirmations (M1/M4/M6) are still required to close #107.

## 6. Acceptance statement

This record provides the verification evidence and the limits. It does not tick the named-reviewer
acceptance box, does not close #107, and does not claim CP06 acceptance.
