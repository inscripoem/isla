# Requirements trace and approval record

Date: 2026-10-10. Status: under review. Scope: shared preparation and the M5-01 coordinator increment; not complete product acceptance or coursework D1.

This record links candidate requirements to machine-checkable acceptance criteria, cases, owners and automated checks. It records the actual supervisory review decision; it does not claim individual approval by all six team members.

## Registry, schema and case-to-test map

- Requirements: `docs/req/requirements.yaml`; schema `docs/req/req-schema.json` (exported from `src/contracts/requirements.ts`).
- Case-to-test registry: `docs/req/case-registry.yaml`; schema `docs/req/case-schema.json`.
- Validation: `src/evaluation/requirements-registry.ts` cross-checks each deterministic acceptance against the case registry: it rejects unknown case IDs, missing test files, absent test strings, deterministic entries without criteria, and deterministic entries citing pending cases. Checked by `test/offline/requirements.test.ts`.

## Case-to-test map

| Case | Status | Verifier file | Test / check |
| --- | --- | --- | --- |
| C-01 | implemented | `test/offline/composition.test.ts` | C-01/C-13 selection-to-delivery |
| C-02 | implemented | `test/offline/composition.test.ts` | duplicate input and control |
| C-03 | implemented | `test/offline/composition.test.ts` | late result after Stop is stale |
| C-04 | implemented | `test/conformance/runtime.conformance.ts` | `c04-second-partial` |
| C-05 | pending | — | decision timeout (full product) |
| C-06 | implemented | `test/conformance/runtime.conformance.ts` | `noop-zero-renderer` |
| C-07 | implemented | `test/conformance/runtime.conformance.ts` | `untrusted-control-refused` |
| C-08 | pending | — | reconnect while audio pending |
| C-09 | pending | — | synthesis failure after dialogue |
| C-10 | implemented | `test/offline/regressions.test.ts` | unknown resolves, no overwrite |
| C-11 | implemented | `test/offline/regressions.test.ts` | substitution preserves plan/delivery |
| C-12 | implemented | `test/conformance/runtime.conformance.ts` | `replay-no-live-change` |
| C-13 | implemented | `test/offline/composition.test.ts` | selected message and intent |
| C-14 | implemented | `test/offline/regressions.test.ts` | fallback for invalid/expired selection |
| C-15 | implemented | `test/offline/regressions.test.ts` | attempt accounting |
| C-16 | pending | — | intent and late fallback semantics |
| C-17 | implemented | `test/offline/composition.test.ts` | storage failure degrades, Stop responsive |
| C-18 | implemented | `test/offline/m6-storage.test.ts` | INV-04 event identity/sequence uniqueness |
| C-19 | implemented | `test/offline/m6-storage.test.ts` | INV-05 atomic commit persists nothing |
| C-20 | implemented | `test/offline/m6-storage.test.ts` | INV-06 projection does not advance across a gap |
| C-21 | implemented | `test/conformance/storage.conformance.ts` | confirmed history is fully-delivered only |
| C-22 | implemented | `test/offline/m6-storage.test.ts` | JSONL export carries event version attribution |
| C-23 | implemented | `test/offline/m6-storage.test.ts` | event identity is session-scoped |
| C-24 | implemented | `test/offline/m6-storage.test.ts` | committed records are isolated from caller mutation |
| C-25 | implemented | `test/offline/m6-storage.test.ts` | confirmed history is ordered by the supporting event sequence |
| C-38 | implemented | `test/offline/m6-storage.test.ts` | a commit whose later mutation cannot be published leaves no partial state |
| C-39 | implemented | `test/offline/m6-storage.test.ts` | a conflicting atomic commit reports the conflict cause on both sides |
| C-40 | implemented | `test/offline/m6-storage.test.ts` | event content equality is insensitive to object key order |
| C-41 | implemented | `test/offline/m6-storage.test.ts` | event content equality keeps array order significant |
| C-43 | implemented | `test/offline/m6-storage.test.ts` | an event whose payload is not a JSON value is rejected before publication |
| C-44 | implemented | `test/offline/m6-storage.test.ts` | a sparse array payload is not conflated with an empty array |

## Requirement trace

| Requirement | Owner | Deterministic cases | Pending |
| --- | --- | --- | --- |
| FR-01 | M3 | C-13, C-14, C-15 | C-16 |
| FR-02 | M4 | C-01, C-04, C-13 | — |
| FR-03 | M1 | C-06, C-11 | — |
| FR-04 | M1 | C-01, C-04, C-10 | — |
| FR-05 | M5 | C-03, C-04 | C-08 |
| FR-06 | M6 | C-12, C-17, C-21, C-22 | — |
| NFR-01 | M5 | — | metric baseline |
| NFR-02 | M5 | C-10, C-17 | C-05, C-09, recovery duration |
| NFR-03 | M3 | — | C-16, human rubric |
| NFR-04 | M3 | C-15 | cost/token caps |
| NFR-05 | M5 | C-07 | retention/deletion |
| NFR-06 | M1 | C-11 | — |
| INV-01 | M5 | C-03, C-04 | — |
| INV-02 | M5 | C-06 | — |
| INV-03 | M5 | C-07 | — |
| INV-04 | M6 | C-18, C-23, C-39, C-40, C-41, C-43, C-44 | — |
| INV-05 | M6 | C-19, C-38 | — |
| INV-06 | M6 | C-20 | — |
| INV-07 | M6 | C-24 | — |
| INV-08 | M6 | C-25 | — |

## Approval record

| Item | Decision | Basis |
| --- | --- | --- |
| READINESS-PLAN | Approved by the user on 2026-10-10 after a Chinese explanation | AGENTS.md authorization |
| Contract/test design | Approved by the supervisor after corrections | `docs/team/READINESS-REVIEW.en.md` |
| First-slice acceptance cases | Reviewed before implementation | READINESS-REVIEW |
| Final numeric quality/performance/cost/retention targets | Not approved | Await a reviewed measured baseline |

## Honest limitations

- The first-slice checks prove contract boundaries and Stop/receipt semantics for the cited cases only; they do not prove C-05/C-08/C-09/C-16 or any live provider, browser audio or durable SQLite behavior.
- NFR-02 recovery duration and NFR-05 retention remain pending, not accepted.
- A finite fixture suite is not a universal security or correctness proof.

## M5-01 production increment

The composition and regression suites now run the same assertions against the independent fixture reference and `src/runtime/coordinator.ts`, through the test-only adapter. `test/offline/m5-coordinator.test.ts` adds production-specific deadline, cancellation, receipt, persistence and input-boundary checks. This supplies scoped M5 evidence for the existing requirement/case links; it does not change requirement owners or promote pending product cases. See the [M5-01 handoff](../team/HANDOFF-M5-01.en.md) for actual commands/results and remaining I1-01 reviews. Status: under review.
