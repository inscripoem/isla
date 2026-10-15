# ADR-005 — Restart and recovery semantics

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-14 · Owner: M6 · Requirements: FR-06 · Invariants: INV-11 · Cases: C-32, C-33.
Relates to: ADR-001..004. Revision type: ADD.

## Context

B3 (sub-issue #12): after B1/B2 the store is durable. The remaining contract is *recovery*:
`INTERFACES` C7 states that a restart "uses a new stopped session, restores confirmed history and
keeps unresolved output unknown without replay", and C-17 forbids fabricating completion. **M5 owns
the lifecycle** (new stopped session, blocking new turns pending recovery); **M6 owns the data and
evidence** that make those decisions correct.

## Decisions

### D1 — A recovery view separates confirmed history from unresolved records
- `createRecoveryView(source)` returns:
  - `confirmed(sessionId)` — `fully-delivered` records, ordered by supporting event `seq`;
  - `unresolved(sessionId)` — `partial-unknown`/`not-delivered` records with their terminal outcome
    and supporting `seq`.
- `StoredDelivery` now exposes the persisted `terminalOutcome` (read-back), so an interrupted segment
  stays `unknown` after restart.
- No lifecycle decision is made here; M5 composes startup from this read.
- Enabled by `INV-11`; verified by C-32 (view) and C-33 (restart, no replay).

### D2 — Unresolved outcomes are never upgraded; nothing is replayed
- A non-`fully-delivered` classification is preserved as-is; the store never fabricates completion.
- Replay reads committed events and never mutates live state (C-12).

## Alternatives considered

1. **Reconstruct recovery ad hoc in each consumer** — rejected (duplicated, untested).
2. **A new shared port for recovery** — rejected (unnecessary; an M6 helper, no contract change).

## Consequences

- M5/M4 get one tested recovery read; the boundary stays **M5 lifecycle / M6 data**.
- Persona attribution is carried by the delivery id/version pair (migration 2); no legacy
  `persona_version` column remains.

## Design process (ADD)

1. Review inputs — C7/C-17; ADR-003/004. 2. Drivers — recoverability, truthful evidence.
3. Decompose — recovery read vs lifecycle. 4. Concepts — Information Hiding; isolated read.
5. Instantiate — `recovery-view.ts`. 6. Record — this ADR + trace rows + INV-11 + C-32/C-33 + Delta-005.
7. Evaluate — 3-tier verify.

## Re-open triggers

- M5 needs a richer recovery read (e.g. unresolved at output granularity, not delivery).
- `terminalOutcome` is superseded by a C6 field.

## References

- `src/storage/recovery-view.ts`, `src/storage/backend.ts`
- `test/offline/m6-recovery.test.ts`; `docs/architecture/{memory-design,runtime-policy-catalog,trace-matrix}.md`
