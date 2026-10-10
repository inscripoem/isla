# Initial readiness design review

Date: 2026-10-10. Scope: shared preparation, not completed product features.

The user approved READINESS-PLAN after its Chinese explanation. The supervising assistant reviewed OpenCode's concrete contract and test proposal before implementation. This is a supervisory review record; it does not claim individual approval by all six team members. The original session is `ses_ede454b57ffeqqLohZuQo5IRM5`; full records are retained outside the checkout.

Approved design: browser-safe Zod schemas and inferred types under `src/contracts/app/`; separate in-process ports using AbortSignal and an injected monotonic clock; explicit data fixtures, controllable adapters and reusable per-role conformance checks under `test/`. Diagnostic protocol 1 and its null application readiness remain unchanged. M5 assigns event sequence numbers, M6 acknowledges persistence. No production scheduling or memory state machine belongs in shared contracts.

Required corrections: add explicit reaction/renderer and console/runtime ports; retain M5 validation and fallback authority; derive privileges only from trusted connection context; preserve confirmed receipt facts while allowing evidence-based resolution of unknown outcomes. Keep finite fixture checks distinct from live correctness, physical silence and durable SQLite evidence.

Expected tests approved before implementation:

- C-01/C-13: one selected message and intent produces ordered segments, receipts and delivery history through the composed fixture ports.
- C-03/C-04: Stop rejects late results and preserves a completed first segment while classifying the interrupted second segment conservatively.
- C-02/C-06/C-07/C-10/C-12/C-14/C-15/C-17: deduplication, capability/authority boundaries, receipt conflicts, replay isolation, invalid/expired selection, no unchanged-input polling, persistence acknowledgement/failure and projection behavior.
- C-11: at least two fixture implementations can replace the same provider-facing port without coordinator changes; real providers remain unverified.
- Every M1–M6 command runs actual positive/negative conformance cases. Inject deliberately faulty implementations into reusable checks and verify that the same observable assertions reject them.
- Validate requirement structure, IDs, trace references and deterministic first-slice criteria; retain pending final quality/performance targets honestly.
- Reject representative browser/backend and production/test import violations, while retaining existing diagnostics tests.
- Verify all documented onboarding commands from an isolated copy with frozen dependencies and no local credentials or ignored configuration.

Contracts remain an evolvable baseline. Changes affecting producers and consumers update their examples, assertions and documentation together. Live integrations, production modules, complete course governance and remote settings remain subsequent work.
