# Bug diary

Status: under review. Owner: R3 / M6 tooling (D4); all owners contribute. One entry per significant
bug: **symptom, reproduction, classification, root cause, fix, and the invariant gap it exposed**.

## BUG-001 — Fault-injection controls exposed as production API
- Symptom: `createEventStore` accepted `beforeAppend`/`beforeCommit` failure hooks.
- Reproduction: construct a store with a throwing `beforeCommit`.
- Classification: governance / boundary (`READINESS-KITS`:26).
- Root cause: the fixture's fault flags were mirrored into production code.
- Fix: inject a `StorageBackend`; fault injection moved to the test adapter (`ec0c370`).
- Invariant gap: production API surface.

## BUG-002 — Event identity was global, not session-scoped
- Symptom: two sessions sharing a store could collide on `evt-1`.
- Reproduction: append the same `eventId` in two sessions.
- Classification: correctness (`INTERFACES` C7).
- Root cause: the index was keyed by `eventId` alone.
- Fix: key by `(sessionId, eventId)` (`b4decf3`). Invariant: INV-04.

## BUG-003 — Committed records were mutable references
- Symptom: mutating an input or a returned event changed committed state and JSONL export.
- Reproduction: append an event, mutate its `payload`, re-read.
- Classification: correctness / isolation.
- Root cause: the backend stored and returned caller references.
- Fix: deep-copy on write and read (`b5da14e`). Invariant: INV-07.

## BUG-004 — Confirmed history was unordered
- Symptom: `confirmedHistory` depended on insertion order, not the supporting event `seq`.
- Classification: correctness (`INTERFACES` C7; issue #22).
- Fix: order by supporting event `seq` (`b52e12e`). Invariant: INV-08.

## BUG-005 — WAL backup could be incomplete
- Symptom: copying `isla.db` alone could miss committed data still in the `-wal` file.
- Classification: durability / recovery.
- Fix: `PRAGMA wal_checkpoint(TRUNCATE)` before the copy (`9a54663`). Invariant: INV-10.

## BUG-006 — Migrations were not atomic as a unit
- Symptom: a failing migration could leave partial schema (each migration had its own transaction).
- Classification: durability / recovery.
- Fix: apply all pending migrations and the version bump in one transaction; rollback on failure.
  Invariant: INV-10.

## BUG-007 — Invariants missing from the register
- Symptom: INV-01..03 and INV-11 were absent from `docs/architecture/invariants.md`.
- Classification: governance / traceability.
- Found by: the new traceability fitness functions.
- Fix: the register was completed (INV-01..13). Invariant: INV-12.

## BUG-008 — The frozen-path check could not fail in CI
- Symptom: changing a path listed in `frozen.yaml` did not redden the `trace` gate.
- Reproduction: touch `src/contracts/app/ports.ts`; `pnpm test:trace` passes.
- Classification: governance / gate wiring (M5 review finding 1 on #27).
- Root cause: CI invoked the committed-repository trace test **without the changed-file list**, so
  `frozen-modified` never received the input it needs; only an isolated unit test supplied one.
- Fix: `changed-files.ts` reads `CHANGED_FILES_FILE`; the committed-repository check passes it; a negative
  case asserts `frozen-modified` through the same path (`31700a5`).
- Invariant gap: a gate that cannot fail is not a gate (INV-13).

## BUG-009 — The gate change-set acquisition was fail-open
- Symptom: with the diff unavailable, G6 read "no changes" and passed.
- Reproduction: run the G6 step where `git diff` fails; the step exits 0.
- Classification: governance / gate wiring (M5 review finding 2 on #27).
- Root cause: `|| true` and a `HEAD~1` fallback turned an acquisition error into an empty list, and the list
  was passed as unquoted argv, so a path containing a space split into two.
- Fix: one acquisition step; explicit base resolution (an all-zero `before` diffs the tip against its
  parent); NUL-separated end to end; a failed acquisition fails the job (`a32cbec`, `f8da3b9`).
- Invariant gap: a missing value must be `unknown` or an error, never a silent pass.

## BUG-010 — The AI-use log rule could be satisfied without recording a run
- Symptom: a one-character edit to `docs/ai-use-log.yaml` passed G6.
- Reproduction: add a blank line to the log and change `src/`; the gate passes.
- Classification: governance / gate strength.
- Root cause: G6 required only that the file appear in the diff.
- Fix: validate every entry's shape, then require the change to **add a complete entry** — the CI step
  records the log's own diff (`100bc9f`, `688e0c1`).
- Invariant gap: INV-14 — the log must record what changed, not merely change.

## BUG-011 — The Owner column re-owned three of M5's invariant rows
- Symptom: `invariants.md` said M5 owns INV-01..03 in its header while those rows said M6.
- Reproduction: read the register.
- Classification: traceability (M5 review finding 3 on #27).
- Root cause: the Owner column was added by R3 and filled with the contributor rather than the established
  owner.
- Fix: INV-01..03 set to M5 (`c6508bf`); the register's own suites rejected the first attempt, which left a
  double pipe and an extra empty cell.
- Invariant gap: a register must not contradict itself.
