# Option ledger

Status: under review. M6 rows contributed here; shared document — M5 coordination pending.
Date: 2026-10-12.

Rejected architectural options and the conditions under which they should be reconsidered.

| ID | Option | Decision | Reason | Reconsider when | Related |
| --- | --- | --- | --- | --- | --- |
| OL-001 | Fault injection as production API (`beforeAppend`/`beforeCommit`) | **Rejected** | Exposes a failure switch on the evidence layer; violates READINESS-KITS:26; misleading failure tests | A genuine production lifecycle/telemetry hook is required (then it is a feature, not a test control) | ADR-001 |
| OL-002 | In-memory only (no persistence seam) | **Rejected** | No path to SQLite durability the blueprint requires; fixtures do not prove SQLite behaviour | Only if durable persistence were dropped from scope (not planned) | ADR-001 |
| OL-003 | Test-only proxy wrapper around the store to simulate failure | **Rejected** | Cannot exercise the store's own failure handling; a real failure originates in the persistence layer | If the store gained an internal transaction callback | ADR-001 |
| OL-004 | Linear scans for identity/conflict checks (as in the fixture) | **Rejected** | O(n) per check; does not scale to real storage | If datasets are guaranteed tiny (not the case) | ADR-001 |
