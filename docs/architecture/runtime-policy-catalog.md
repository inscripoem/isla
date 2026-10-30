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

Decision rows are recorded above; synthesis failure and renderer disconnect remain owned by M1/M5
and pending their entries here.
