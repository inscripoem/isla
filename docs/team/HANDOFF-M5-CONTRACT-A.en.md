# M5 Step A: delivery attribution and shared storage tests

Revision: 2026-10-15.1 · Status: under review · Publication base: main `b316080` after PR29; initial verification base: `3668e4c`.
Scope: [issue #22](https://github.com/inscripoem/isla/issues/22), FR-06, INV-09, C-45/C-46.

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
metadata, while production archived-session selection/reconstruction remains later work.

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

The publication branch is `feat/m5-delivery-attribution`, based on main after PR29.
The original Step A checkout and seven-file storage-test worktree remain preserved.
The publication contains one independent commit; affected M4/M6 consumers should review the
strict-schema rollout before merge. Source archives and original-file hashes remain outside the
checkout. Before merge, rollback means withholding this PR; after merge, use a separately reviewed
revert coordinated with consumers. Do not reset another working tree.
