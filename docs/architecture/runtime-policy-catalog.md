# Runtime policy catalog

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
M5 coordination pending. Date: 2026-10-12.

What the system does when each degraded or failure path is triggered. Each failure mode has a
defined response and operational fallback.

| Failure mode | Detection | Response | Fallback (concrete) | Owner |
| --- | --- | --- | --- | --- |
| Storage write unavailable (`append`/`commit`) | Backend throws on `commit`; store returns `failed` (`storage_unavailable`) | Do not acknowledge persistence | Mark evidence incomplete; block new turns pending recovery; **Stop and local cancellation never wait for the write** | M6 |
| Duplicate event / delivery | Existing identity and accepted content match, including delivery classification/index/persona attribution | Return `duplicate`; do not duplicate state | Keep first record; no replay of output | M6 |
| Conflicting content (same id, changed text or attribution) | `textHash`/content, `segmentIndex`, `personaProfileId` or `personaProfileVersion` mismatch | Return `conflict`; never overwrite | Preserve recorded fact; record the conflict | M6 |
| Inconsistent delivery record | `classification`/`terminalOutcome` pair invalid, malformed supporting event (omitted `versions` or a null/non-string version member), or known delivery↔event provenance / `sessionId`/`turnId`/`segmentId`/`outputId` mismatch | Reject as one paired `failed` (`invalid_delivery` / `invalid_event` / `inconsistent_delivery`); persist nothing | Keep the prior record; a corrected retry reusing the identity and sequence applies; unknown event provenance stays absent, never inferred | M6 / M5 |
| Unsupported event payload (not a JSON value) | Payload validated before publication | Reject with `unsupported_payload`; persist nothing | Keep the prior record unchanged; the producer must send a JSON value | M6 |
| Interrupted atomic commit | Backend failure mid-commit | `commit` is atomic — no partial state | Resume from last committed state; unresolved outputs stay `unknown` | M6 |
| Projection gap | `event.seq > appliedSeq + 1` | Do not advance `appliedSeq` | Projection must not claim current history until it catches up | M6 |
| Restart with unresolved output | Startup reconciliation | Begin stopped; restore only confirmed history | Unresolved outputs remain `unknown`; no automatic replay | M6 / M5 |
| Migration failure (unsupported schema version, or apply error) | `migrate` rejects or rolls back | Refuse to open the database; keep the prior version | Restore from the pre-migration backup under `<dbDir>/backups/` | M6 |
| Startup recovery (restart) | `recovery-view` reads committed deliveries | Restore only confirmed history; keep unresolved `unknown` | No replay; an unresolved segment is never quoted as spoken | M6 / M5 |
| Standalone corpus-runner selection failure | `runSelectionCase` catches a `SelectionCallError` (including abort, deadline and invalid-deadline codes), a generic throw, or empty candidates/intents | Record one per-case `technical-failure` with `adoptedScore: null`, reason and diagnostic; continue remaining corpus cases | No fallback and no semantic score; the failed case remains visible | M3 |
| Runtime selection timeout, cancellation, expired authority or superseded snapshot | M5 coordinator observes timeout/abort, expired authority/deadline, or a superseded snapshot | Mark the turn `stale`; produce no plan/output | No fallback into output; late results remain stale | M3 / M5 |
| Fresh runtime selection rejection or invalid proposal | Ordinary rejection or schema-invalid/mis-correlated/unoffered/disallowed-intent result while authority is fresh; M5 does not inspect `SelectionCallError.code` | Record the provider attempt as failed; do not accept the proposal | Use the authorised `m5-fallback` when eligible and allowed; otherwise defer; never bypass Stop or expiry | M3 / M5 |
| Runtime reaction cancellation or revocation | M5 coordinator observes an aborted reaction call (Stop or superseded epoch) | Record the provider attempt as `aborted`; revoke the segment before output dispatch | Abort the segment (`revoked`); speech does not continue for the revoked turn | M3 / M5 |
| Runtime reaction timeout, rejection, invalid decision or stale capability | M5 coordinator observes timeout (`timeout`), ordinary rejection (`failed` — M5 does not inspect `ReactionCallError.code`), schema-invalid/mis-correlated result (`invalid`), or a correlated result with stale capability revision (`accepted` with `no-op`) | Record the corresponding provider disposition; do not dispatch an unadvertised or stale-capability avatar action | Fall back to `no-op` for the segment while otherwise-valid speech continues | M3 / M5 |

Decision rows are recorded above; synthesis failure and renderer disconnect remain owned by M1/M5
and pending their entries here.

## Pipeline gates (M6)

These rows are decisions about the CI pipeline, not the deployed service. Isla has no deployed runtime
yet, so the actor is the pull-request author and the M6 reviewer reading the required check; there is no
pager and no on-call. A row is `enforced` only when the named test proves it; `convention` means the job
itself fails but no dedicated record is written. A failure record is written under
`.cache/gate-failures/` and uploaded by CI.

| Policy | Trigger | Action | Decision | Evidence | Escalation | Test | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| POL-PIPE-01 | a gate step did not run, was skipped or was cancelled | report it as not-verified, never as pass; record the outcome map | fail-closed | `gate_outcomes` | none; the summary names the skipped gates | `gate-record.test.ts::records a gate that did not run` | M6 |
| POL-PIPE-02 | `verify` is red on a push to `main` | record the run; a human reverts or fixes forward within one working day | fail-closed | `run`, `failed_gates` | the red run on `main` is the signal | convention (post-merge run) | M6 |
| POL-G1-01 | changed code path not covered by any approval record, or a named test is missing | block; never create, edit or backdate a record | fail-closed | `files`, `approval_id`, `record_commit`, `first_code_commit`, `approved_at` | none; the red check notifies the author | `test-approval-gate.test.ts::fails when an approval does not cover a changed code file` | M6 |
| POL-G1-02 | record commit is not an ancestor of the first code commit, or the approval is dated later | block; reorder commits, never rewrite history to fake order | fail-closed | `approval_id`, `approved_at`, `first_code_commit` | none | `test-approval-gate.test.ts::fails when the record was committed after implementation began` | M6 |
| POL-G1-03 | history or object database unavailable | block; unknown is not approval | fail-closed | `reason` | none | `test-approval-gate.test.ts::fails closed when the history answer is unavailable` | M6 |
| POL-G4-01 | measured claim without an evaluation table, or the table omits a fixed condition | block; mark the number unverified, never substitute zero | fail-closed | `document`, `line`, `claim`, `missing` | none; the document owner acts | `eval-gate.test.ts::fails a measured claim when no evaluation table exists` | M6 |
| POL-G4-02 | claim row without a value or conditions | block until the row is complete | fail-closed | `claim`, `missing` | none | `eval-gate.test.ts::fails a claim row with no value` | M6 |
| POL-G4-03 | no table and no claim | pass the step, record not-run, refuse any numeric claim | three-state | `reason` | none | `eval-gate.test.ts::is not run when there is no table and no claim` | M6 |
| POL-G4-04 | a claim exemption passed its expiry | block; re-review the sentence instead of renewing | fail-closed | `document`, `line`, `expires` | none | `eval-gate.test.ts::fails the same line after the exemption expires` | M6 |
| POL-G6-01 | code or prompt changed without a log update | block; never append an entry for the author | fail-closed | `changed_files`, `log_changed` | none | `ai-use-log-gate.test.ts::requires the log when a code file changes` | M6 |
| POL-G6-02 | a new entry cites a commit not reachable from HEAD, or any cited case/invariant does not exist | block; the entry owner corrects it. A historical entry whose commit is absent in a fresh clone is advisory | fail-closed | `entry`, `field`, `value` | none; entry owner named | `ai-use-log-gate.test.ts::rejects a new entry whose commit is not reachable from HEAD` | M6 |
| POL-G6-03 | register or object database unreadable | block; an unreadable register is never empty | fail-closed | `register` | none | `ai-use-log-gate.test.ts::fails closed when the object database is unavailable` | M6 |
| POL-G6-04 | a baseline exemption expired | block; the debt cannot renew silently | fail-closed | `value`, `expires` | none | `ai-use-log-gate.test.ts::rejects a baselined missing commit after its expiry` | M6 |
| POL-TR-01 | missing component, unknown case, missing test file or unknown test title | block; the row owner repairs code, test or citation | fail-closed | `row_key`, `code`, `detail` | none | `trace-fitness.test.ts::rejects a citation whose title the file does not contain` | M6 |
| POL-TR-02 | ADR cell names no number and has no unexpired exemption | block; allocate the number or record an em dash | fail-closed | `row_key`, `cell` | none | `trace-fitness.test.ts::rejects an ADR cell that names no ADR number` | M6 |
| POL-TR-03 | citation without a `test/` path, or a row outside any parsed table | block; silence is not evidence | fail-closed | `code`, `detail` | none | `trace-fitness.test.ts::rejects a citation that names a test file without a path` | M6 |
| POL-TR-04 | test cited without an exact title | pass with an advisory count | fail-open-with-debt | `detail` | none | `trace-fitness.test.ts::reports a prose-only citation as advice, not a failure` | M6 |
| POL-G2-01 | typecheck or lint failure | block; no auto-fix and no suppressed diagnostic | fail-closed | `step`, `outcome` | none | convention (job fails) | M6 |
| POL-G3-01 | requirements registry or boundary failure | block; never regenerate the registry | fail-closed | `step`, `outcome` | none | convention (job fails) | M6 |
| POL-G5-01 | any prior test fails | block; never skip, delete or weaken a test | fail-closed | `step`, `outcome` | none | convention (job fails) | M6 |
