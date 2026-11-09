# #106 — product SQLite, restart and selected-history acceptance

Status: **M6 evidence record; no checkpoint acceptance claimed.** Date: 2026-11-09.
Measured at `main` **`e9e7e7b`**. Issue: #106 (checkpoint #76, CP6). Accepter: M2.
Windows is out of scope (no Windows environment; DEBT-07).

## Claims checked

| Claim | Evidence | Verdict |
| --- | --- | --- |
| Confirmed history is restored; unresolved output stays unknown | C-33 (`m6-recovery`), C-68 (`m6-i1-storage-recovery`), C-74 (`m5-process-restart`) | **PASS** |
| Unknown output is never promoted or replayed | C-74 second process; C-33 no-replay case | **PASS** |
| Selected prior-session history reaches the assembled context | C-74: `ISLA_TEST_ARCHIVE_SESSIONS`; context history is `[LIVE_A, LIVE_A, ARCHIVE]` | **PASS** |
| A crash leaves committed data recoverable | `m6-durability`: crash-state copy with a non-empty `-wal`; committed row visible without clean close | **PASS for committed data** |
| An uncommitted WAL tail is recovered | — | **NOT RUN** (the suite says so; needs a cache-spill fixture or a killed subprocess) |
| Shutdown awaits owned release and reports faults | C-73 (`production-cli`: pending release, failed release, startup-failure cleanup, output drain) | **PASS for owned release**; not acoustic silence |
| Windows shutdown/recovery | — | **NOT RUN / out of scope** |

## Evidence runs at `e9e7e7b`

```
pnpm exec vitest run \
  test/offline/m6-recovery.test.ts \
  test/offline/m6-i1-storage-recovery.test.ts \
  test/offline/m6-durability.test.ts \
  test/offline/m5-process-restart.test.ts \
  test/offline/production-cli.test.ts
```

Result: **27 passed / 27, 5 files** at `e9e7e7b`. On a branch that predates #141 the same command yields
**26**, because the two-turn Stop case is the #141 addition; the counts above belong to `e9e7e7b`.

| Suite | Cases | What it asserts |
| --- | --- | --- |
| `m6-recovery` (4) | C-32, C-33 | recovery view separates confirmed from unresolved; reopen restores confirmed only and keeps the rest unknown with no replay; the projection is re-derived from committed events; an unsupported schema version refuses to start |
| `m6-i1-storage-recovery` (4) | C-32/C-33, C-68 | the real coordinator writes SQLite and a reopen restores only confirmed history; an earlier completed segment stays eligible and the interrupted one is excluded; empty confirmed history when nothing completed; two turns with Stop, a late result and a duplicate leave one confirmed turn and no false record |
| `m6-durability` (2) | INV-12, FR-06 | a crash-state copy (`isla.db` + non-empty `-wal`) recovers every committed row and keeps the schema version; a committed row is visible to a second handle without a clean close |
| `m5-process-restart` (2) | C-74 | two spawned production CLI processes over one real SQLite database; the second uses a fresh live id and the explicitly selected archive, receives only confirmed history, and neither replays old audio nor promotes the partial-unknown tail; a second case SIGKILLs the first process between commits, preserves the committed prefix and never promotes the unfinished tail |
| `production-cli` (15) | C-73 | shutdown waits for a genuinely pending owned release before reporting completion; a failed release reports an incomplete shutdown; startup failure still awaits the owned release; output is drained until both streams end |

## What this does not prove

- No live provider, acoustic output or physical silence.
- No product-console path; the process tests use controlled peers.
- No Windows result: the direct-signal tests are skipped there and no Windows run was made.
- No uncommitted-WAL-tail recovery and no kill **during** a database write; the kill lands **between commits**.
- No CP6 acceptance: the other CP6 rows (M3/M5 fault cases, M1/M2 playback, privacy) are not evaluated
  here, and a named human decides the checkpoint.

## Traceability

FR-06 (persist and replay) · INV-12 (confirmed history only; no replay) · ADR-005 (restart recovery) ·
cases C-32, C-33, C-68, C-73, C-74. Windows gap: DEBT-07.

## Reproduction note

The evidence is fixture- and process-based on Linux/macOS; it is not a substitute for the product-console
or platform acceptance. A re-run must record its own head; the counts above belong to `e9e7e7b`.
