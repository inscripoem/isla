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
  Superseded in part by BUG-012: the all-zero fallback reviewed only the tip.
- Invariant gap: a missing value must be `unknown` or an error, never a silent pass.

## BUG-010 — The AI-use log rule could be satisfied without recording a run
- Symptom: a one-character edit to `docs/ai-use-log.yaml` passed G6.
- Reproduction: add a blank line to the log and change `src/`; the gate passes.
- Classification: governance / gate strength.
- Root cause: G6 required only that the file appear in the diff.
- Fix: validate every entry's shape, then require the change to **add a complete entry** — the CI step
  records the log's own diff (`100bc9f`, `688e0c1`). Superseded by BUG-013: an edited entry produced the
  same added lines.
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

## BUG-012 — A branch-creation push was reviewed as its last commit
- Symptom: a push whose first commit changed code and whose last commit changed only documentation had
  only the documentation commit reviewed; the trace and AI-use-log gates never saw the code.
- Reproduction: push a new branch whose tip is a docs commit; read the `changed files` step — it diffed
  `HEAD~1..HEAD`. The tip of #27 was such a push.
- Classification: governance / gate correctness (M5 review finding 1 on #27).
- Root cause: an all-zero `before` has no previous commit on the branch, and the code answered that by
  narrowing the range instead of resolving it.
- Fix: `src/evaluation/change-range.ts` resolves the intended range — PR base, push `before`, or
  `merge-base(origin/main, HEAD)` for a branch-creation push — and reports **unavailable** (failing the
  step) when it cannot. A root commit is reviewed against the empty tree; a manual run against the tip
  parent, and says so (`7f512c8`).
- Invariant gap: a gate whose range silently shrinks reports on a change nobody made.

## BUG-013 — G6's entry rule was satisfied by editing an existing entry
- Symptom: a code change plus an edit to an existing entry's date/task/change/agent passed G6; the entry
  count stayed the same.
- Reproduction: run `pnpm gate:ai-use-log` with a code file and the log in the change set, editing the
  log's only entry; the gate exits 0.
- Classification: governance / gate strength (M5 review finding 2 on #27).
- Root cause: the check looked for added `- date:`/field lines anywhere in the diff, which an edit also
  produces; it never established that an entry was **added**.
- Fix: CI writes the log **at the base revision** and the gate requires the head to have **more entries**
  than the base; the new entries' completeness is already covered by the shape check (`100bc9f` pattern
  superseded). At PR scope the base is the merge base, so the rule proves the change added a record, not
  that every commit added one.
- Invariant gap: INV-14 — the log must record new work, not restate old work.

## BUG-014 — A force-push made the gate diff unacquirable
- Symptom: after rebasing and force-pushing #27, the push-event CI run failed at the
  `changed files` step with `fatal: bad object 2a791bf…`, so no gate could run.
- Reproduction: force-push a branch whose rebase rewrites history; the push event carries the
  **old tip** in `before`, which is unreachable and therefore absent from a fresh checkout.
- Classification: governance / gate robustness.
- Root cause: `src/evaluation/change-range.ts` trusted any non-zero `before` without checking that
  the commit exists; `git diff <missing>..HEAD` then failed. Failing closed was correct, but the
  gate could not run at all.
- Fix: verify `git cat-file -e <before>^{commit}`; use `before` only when it exists, otherwise fall
  back to `merge-base(origin/main, HEAD)`; if neither resolves and a parent exists, still report
  **unavailable** (`d87a08a`-series fix).
- Invariant gap: a missing starting point is *unknown*, not an empty diff and not a pass.

## BUG-015 — A restored frozen blueprint failed the push gate
- Symptom: after the PR36 integration restored `architecture-blueprint.md` byte for byte to main's
  copy, the push run's `trace` gate reported `frozen-modified`; the pull-request run (`main..HEAD`)
  did not, because only the push diff (`before..HEAD`) still contained the path.
- Reproduction: on a branch whose earlier commit edited the frozen blueprint and whose later commit
  restored it to main's blob, run `pnpm test:trace` with `CHANGED_FILES_FILE` over `before..HEAD`.
- Classification: governance / gate correctness (false positive).
- Root cause: the frozen check rejected any frozen path in the changed-file list; it could not
  distinguish a restoration to the trusted baseline from a change against it.
- Fix: `src/evaluation/frozen-restoration.ts` proves, per changed frozen path and only for a
  feature-branch push, that a canonical pinned default-branch commit is an ancestor of the
  checked head, differs from that head, and already freezes the path. The committed blob/mode
  and the actual regular file contents/mode must match the baseline. Strict decoding retains
  BOMs and rejects malformed UTF-8. Dirty files, symlinks, deletion and unavailable evidence
  still fail; default-branch pushes, tags, PRs and manual runs receive no exception. CI retains
  the full event diff and logs the pinned baseline and per-path verdict (C-34/C-35, INV-13).
- Status: local repair under review; the original failed push run remains historical until a
  separately authorized publication produces new CI evidence.
- Invariant gap: an exception that is not itself verified turns a strict gate into a whitelist.
