# Runtime policy catalog

Status: under review. M6 rows contributed here; other owners' rows pending. Shared document —
M5 coordination pending. Date: 2026-10-12.

What the system does when each degraded or failure path is triggered. Each failure mode has a
defined response and operational fallback.

| Failure mode | Detection | Response | Fallback (concrete) | Owner |
| --- | --- | --- | --- | --- |
| Storage write unavailable (`append`/`commit`) | Backend throws on `commit`; store returns `failed` (`storage_unavailable`) | Do not acknowledge persistence | Mark evidence incomplete; block new turns pending recovery; **Stop and local cancellation never wait for the write** | M6 |
| Duplicate event / delivery | Existing identity match | Return `duplicate`; do not duplicate state | Keep first record; no replay of output | M6 |
| Conflicting content (same id, changed text) | `textHash`/content mismatch | Return `conflict`; never overwrite | Preserve recorded fact; record the conflict | M6 |
| Unsupported event payload (not a JSON value) | Payload validated before publication | Reject with `unsupported_payload`; persist nothing | Keep the prior record unchanged; the producer must send a JSON value | M6 |
| Interrupted atomic commit | Backend failure mid-commit | `commit` is atomic — no partial state | Resume from last committed state; unresolved outputs stay `unknown` | M6 |
| Projection gap | `event.seq > appliedSeq + 1` | Do not advance `appliedSeq` | Projection must not claim current history until it catches up | M6 |
| Restart with unresolved output | Startup reconciliation | Begin stopped; restore only confirmed history | Unresolved outputs remain `unknown`; no automatic replay | M6 / M5 |

Non-storage failure paths (decision timeout, synthesis failure, renderer disconnect) are owned by
M3/M1/M5 and are pending their entries here.
