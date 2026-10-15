# M5 Step A: delivery attribution and shared storage tests

Revision: 2026-10-15.3 · PR30 merged into main dbbbfcb; local I1/INV-15 follow-up under review. Initial verification base: 3668e4c.
Scope: [issue #22](https://github.com/inscripoem/isla/issues/22), FR-06, INV-09/INV-15, C-46/C-47.

The INV-15 header and C-47 trace correction is included in the local I1 candidate on dbbbfcb and awaits publication. Runtime behavior and assertions are unchanged.

## Delivered behavior

Storage-contract revision `2026-10-14.1` adds required nullable `segmentIndex`,
`personaProfileId` and `personaProfileVersion` to `CommitDelivery` and `ConfirmedDelivery`.
M5 captures the profile before passing its dialogue request to a peer and retains the original
segment index with output registration. Completion, Stop and late receipts use those captured
values. Delivery events use separate `versions.personaProfileId` and
`versions.personaProfileVersion` keys.

The real M6 in-memory conversion preserves these fields. Reusing a delivery identity with changed
index or persona attribution returns a conflict and preserves the original history. Explicit legacy
nulls remain null; omitted fields fail strict validation. No migration or automatic backfill is added.

`confirmedHistory(sessionId)` remains ordered by the supporting event sequence. Turn reconstruction
uses explicit segment indices within `(sessionId, turnId)`; this increment supplies and tests the
metadata. The separate local I1 increment implements archived-session selection and lifecycle
reconstruction; see [the reconstruction handoff](HANDOFF-M5-RECONSTRUCTION.en.md).

The seven previously unsubmitted storage-test files are reconciled with main. Existing real M6
regressions remain in `m6-storage.test.ts`. Shared collectors cover isolation, ordering, failed-batch
residue and retry, with deliberately faulty adapters. Two production M5 coordinators share either
the actual M6 backend or the fixture store in `shared-store.test.ts`; failure injection remains in tests.

## Validation and entry points

- Initial `pnpm verify` on main `3668e4c`: 356 tests in 18 files, typecheck, lint and build passed.
- Publication branch on merged PR29 (`b316080`): 409 tests in 18 files, typecheck, lint and build passed.
  Production M5/actual-player probes preserved attribution through completion, Stop and failure
  after observed start, with controlled media; this does not establish browser product integration.
- `pnpm test:m6`: 47 tests passed.
- `pnpm exec vitest run test/offline/m5-attribution.test.ts test/offline/shared-store.test.ts`:
  13 tests passed. These files run in the full suite; the existing role-script definitions are unchanged.
- `src/contracts/app/storage.ts`: exact record shapes.
- `src/runtime/coordinator.ts`: original attribution capture and delivery finalization.
- `src/storage/event-store.ts`: history conversion and attribution conflict handling.
- [Interfaces](INTERFACES.en.md) and [role kits](READINESS-KITS.en.md): consumer rules and shared probes.

M5 and M6 are actual implementations in the attribution tests. Dialogue, player and other unfinished
dependencies remain explicit test substitutes. Passing these checks does not establish live audio,
provider quality, SQLite migration/recovery or complete I1-01 acceptance.

## Consumer review and recovery

M4 should retain these fields when constructing/consuming delivery records and use explicit indices
for turn reconstruction. Its correctness fixes and authoritative-history integration remain separate.
M6 should map all three fields through its SQLite codec/migration and preserve genuine legacy
unknowns as null. Review the strict-schema rollout before adopting this revision in draft branches.
Port signatures, role ownership, application protocol `0.2` and diagnostic protocol `1` are unchanged.

PR30 was human-merged into main `dbbbfcb` on 2026-10-15 after formal approval.
The prior published head `7297da4` remains a historical verification baseline.
Original Step A and seven-file storage-test sources are preserved in verified external
archives; the original PR30 worktree and its local edits remain unchanged.
The rebase and pinned force-with-lease were explicitly authorized by the user; affected M4/M6 consumers should review the
strict-schema rollout when adopting it in remaining draft branches. Source archives and original-file hashes remain outside the
checkout. Any rollback of merged behavior requires a separately reviewed
revert coordinated with consumers. Do not reset another working tree.

## Contract review follow-up

The isolated follow-up passed 424 tests in 18 files, typecheck, lint and build.
Shared conformance checks now enforce attribution round-trips, explicit unknowns,
missing-field rejection, conflict preservation, consistent acknowledgements and
residue-free retries against the real store and deliberately faulty adapters.
The atomic boundary validates delivery/outcome combinations and the supporting
event schema, then cross-checks all known correlation and persona fields.

Half-known persona fields are preserved as raw legacy knowledge; a complete persona
comparison requires both identity and version. Missing event persona keys or a null
versions map do not invent attribution. Null/non-string version members are invalid;
the string "null" remains literal text. Consumers read the delivery fields, while
contradictory known event provenance rejects the pair before mutation.

Within a turn, orderTurnDeliveries (INV-15, C-47) sorts known indices ascending, then unknown
indices, preserving supporting-event input order for ties. It does not reorder the
history port. Our M5 attribution case moves to C-47, preserving C-46 and leaving
M6's draft C-45 unchanged. The existing reconstruction ordering regression now shares
the C-47 verifier prefix. INV-08 remains M6 supporting-event read order. The
[latest issue #25 agreement](https://github.com/inscripoem/isla/issues/25#issuecomment-6192331425)
keeps C-48 with M6 migration, allocates C-49/C-50 to M4 guards and C-51 to M6
append validation. Registry/code synchronization remains pending; INV-10 through
INV-14 remain assigned to M6 follow-up work. These allocations do not
claim that the M6 migration or gate implementations have landed.

Merged PR30 includes M4 contract adoption and its ten-case real-M6 consumption suite
(487 tests / 19 files on its prior branch; post-merge main passed 539/19). The local
I1 transport/reconstruction candidate on dbbbfcb passed 634/30 and requires separate
consumer review and publication. Issue #22 is closed; remaining recovery stays in #25.
