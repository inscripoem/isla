# Option ledger

Status: under review. M6 rows contributed here; shared document — M5 coordination pending.
Date: 2026-10-12; system-level rows added 2026-11-25.

Rejected architectural options and the conditions under which they should be reconsidered.

| ID | Option | Decision | Reason | Reconsider when | Related |
| --- | --- | --- | --- | --- | --- |
| OL-001 | Fault injection as production API (`beforeAppend`/`beforeCommit`) | **Rejected** | Exposes a failure switch on the evidence layer; violates READINESS-KITS:26; misleading failure tests | A genuine production lifecycle/telemetry hook is required (then it is a feature, not a test control) | ADR-001 |
| OL-002 | In-memory only (no persistence seam) | **Rejected** | No path to SQLite durability the blueprint requires; fixtures do not prove SQLite behaviour | Only if durable persistence were dropped from scope (not planned) | ADR-001 |
| OL-003 | Test-only proxy wrapper around the store to simulate failure | **Rejected** | Cannot exercise the store's own failure handling; a real failure originates in the persistence layer | If the store gained an internal transaction callback | ADR-001 |
| OL-004 | Linear scans for identity/conflict checks (as in the fixture) | **Rejected** | O(n) per check; does not scale to real storage | If datasets are guaranteed tiny (not the case) | ADR-001 |
| OL-005 | Keep extending the hand-rolled canonical serializer for "same content" | **Rejected** | Each review round exposed another edge case (key order → `Date`/`Map` → sparse arrays); unbounded. Instead, define the payload domain (JSON values) and compare canonically | If a non-JSON payload must be supported — then a lossless codec is required | ADR-002 D1 |
| OL-006 | Cloud multi-service runtime with a managed database and model gateway | **Rejected** | No current requirement for remote multi-user access; adds network, auth, deployment and cost surfaces; conflicts with the local-first privacy boundary | A remote multi-user or hosted-memory requirement is approved | ADR pending #25 §3A |
| OL-007 | Single-process monolith with direct provider SDK calls and prompt-only safety | **Rejected** | The model path would hold authority; no deterministic boundary to test independently; providers are not replaceable | None within the current safety requirements; a new ADR would have to remove the authority boundary | ADR pending #25 §3B |
| OL-008 | Multi-agent orchestration for one character and one local operator | **Rejected** | Adds coordination, latency and a second authority for a single-character product; a deterministic supervisor would duplicate the M5 authority with more parts | A multi-character or multi-operator requirement is approved | ADR pending #25 §3D |
| OL-009 | Vector database or embeddings for dialogue memory now | **Rejected** | No semantic-retrieval requirement; adds a dependency, a privacy surface and a new failure mode; lexical recall + confirmed history suffice for the current scope | A semantic-recall requirement with a measured quality gap is approved | ADR-009; `memory-design.md` |
| OL-010 | gRPC or a remote IPC service between the modules | **Rejected** | A local single-process runtime does not need a network protocol; it adds serialization and lifecycle failure paths | A second process or remote consumer is required | ADR pending #25 §3A/§6 |
| OL-011 | Unbounded prompt or full-history summarisation now | **Rejected** | No tokenizer or measured baseline; summarisation can remove evidence or boundaries; the current hard character cap and deterministic trim are honest and testable | A measured token baseline and M4 approval justify compaction; see the ADR §8.3 proposal | ADR pending #25 §8; `context-assembly.md` |
