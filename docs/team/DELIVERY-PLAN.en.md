# Isla — Delivery Plan

Revision: 2026-10-27.1. Status: under review. Existing roles, workload ratings and task IDs are unchanged. This is a delivery-status update, not a new schedule or a change to owner responsibilities.

## Current implementation and evidence

Main is [`74e99953733eeb070f99d4b9c57554e22e928840`](https://github.com/inscripoem/isla/commit/74e99953733eeb070f99d4b9c57554e22e928840). Application transport, root HTTP/WebSocket routing, dynamic audio resources, selected-history lifecycle, retained synthesis ownership and the production evaluation adapter are merged. Their handoffs preserve the exact scope and revision of earlier process/browser checks; those checks were not all rerun against this main.

M1 VTS client/renderer, connection closure and pairing increments PR56/59/60 are merged. PR60's merge tree equals the reviewed `f5057c9b9555eecaea2071575fffa0d11ead3560` tree. Independent Linux checks passed M1 289/289, composition 12/12, full verification 1207/1207 across 63 files, typecheck, lint, build, actual-diff trace 41/41 and G6. [Main CI](https://github.com/inscripoem/isla/actions/runs/40316173978) passed. The [M5 review](https://github.com/inscripoem/isla/pull/60#pullrequestreview-5644521959) covers offline pairing only. Original Windows failures, real VTS, model/hotkey actions, audio and recovery acceptance remain outside that result.

The Linux IPC/two-process and interrupted-prefix evidence from PR53 is now merged. It proves the recorded controlled shutdown/restart cases, not torn-write, power-loss or all-green Windows recovery. Historical browser checks used the dedicated loop page through the root proxy; they do not establish complete M2 product-console adoption.

| Item | Current state | Next owner action |
| --- | --- | --- |
| PR35/36/40/43/48/49/50/51/52/53 | Merged; earlier pending-review wording is historical | Preserve merged behavior and validate remaining product adoption at the actual combined version |
| PR56/59/60 | Merged M1 VTS primitives and offline evidence | M5: review/publish the local acquisition candidate, then separately prepare deployment assembly |
| PR55 | Merged into dependency branch at `fccb0f2fbe743385df481a42a133b7e2c9ffeec4`, not main | M4: [Issue61](https://github.com/inscripoem/isla/issues/61), integrate/sync/check/open PR; M5 then reviews that combined commit |
| PR57 | Open at `d04cddc6ebfc63a7b533597c94f5b8fa6f9f0c77`, changes requested | M3: fix findings and update its branch; dependent adoption follows owner delivery |
| PR62 / PR63 | M5 changes requested at `596a8db` / `5ac5c0b` | M6: correct persistence/selected-history wording and complete the proposed provenance binding; M5 then re-reviews |

Issue61 currently has no M4 response. Previous approved coordination replies in Issues25/37/41/58 are already published; do not resend them. Each owner fixes their own module unless explicitly delegated otherwise. Final PR merges remain human-owned.

## Current M5 implementation slice

Captain approved local development of the first VTS acquisition/lifecycle stage on October 26. The [local candidate](HANDOFF-M5-VTS-ACQUISITION.en.md) now passes independent M5 200/9, composition12/1 and full1230/64 verification, with typecheck/lint/build passing and tested source hashes unchanged. It remains uncommitted, unpublished and under review. M5 owns acquisition deadlines, cancellation causes, identity/target-bound credential operations, unresolved-save exclusion, late-handle disposal and stopped replacement after actual cleanup. M1 retains D1/D2/C protocol and renderer ownership. Async acquisition precedes the existing synchronous renderer factory; no shared API change is planned. This slice does not depend on PR55 integration.

The initial protocol/renderer/request/closure policies remain explicit deployment values. Human approval 60000 ms and total acquisition 75000 ms are starting policy proposals, not measured acceptance limits. No real credential storage, endpoint discovery, automatic reconnect, trigger replay or cleanup-recovery unlock is delivered by the controlled first stage. Existing OpenCode authorship, original-evidence retention and separate publication review continue to apply.

## Remaining delivery sequence

These rows retain the original order, owner allocation and acceptance conditions. They describe remaining adoption and acceptance; several underlying implementations already exist. Independent module work and report tooling can proceed in parallel.

| Order | Work | Owner / collaborators | Acceptance |
| --- | --- | --- | --- |
| 1A | Adopt merged application transport and session recovery | M5; M1/M2 | Two turns, Stop/Resume, reconnect, explicit stopped successor, no replay or promotion of unknown delivery |
| 1B | Merged product-console adoption | M2; M1/M5 | Snapshot-first reconnect, one performer, input/profile/control, correct playback admission and pending/unknown state |
| 1C | Selection/intent and reaction rules | M3; M4/M5 | Replace fixtures; normal/Stop/defer, eligibility, identity, cancellation and bounded attempts |
| 1D | Verify adoption of merged PR35 | Module owners; M5 | Current-head approval, linear conventional history and consuming checks; resource ownership and selected-history semantics preserved |
| 2A | Real text/audio production composition | M4 text; M1 provider/registry; M5 assembly/HTTP; M2 browser consumption | Injected synthesis, controlled audio routes and leases, shared deadline gate, safe physical settlement/replacement and explicit missing-config failure |
| 2B | SQLite startup and selected-history recovery | M6 persistence/discovery; M5 selection/lifecycle; M4 semantics | Cross-process continuation with confirmed archives and partial/null attribution retained; no replay or fabricated terminal evidence |
| 2C | Effective CI and trace gates | M6 R3; M5 coordination | Actual change-range and negative gate evidence; stable ownership/trace; required-check settings need a separate decision |
| 2D | Production evaluation adapter and recorded-run tooling | M5 adapter; M6 runner/report command; observations from M1–M5; cases from M3/M4 | Coordinator-backed VariantRun, unchanged bench accounting, declared conditions and source-backed observations |
| 3A | Model/Jev comparison and VTS | M3/M1; M4/M5 | Stable real loop, fixed conditions, held-out cases, all attempts/usage/failures and actual access |
| 3B | S1 / R1–R6 delivery | M5 R1/R2/consolidation; M6 R3; all R4/R5; M3/M4/M6 R6 | Genuine owner evidence, measured NFRs, reviewed rubric, English report/demo/package |

## Evaluation and coordination boundaries

The production evaluation adapter and M6 recorded-run/report tooling are implemented; this does not establish a real comparison table or G4 acceptance. [M5's current Issue41 response](https://github.com/inscripoem/isla/issues/41#issuecomment-6382509551) records the split: M5 captures admission acknowledgements, M3 supplies corpus/labels, M4 owns dialogue conditions, and M6 proposes companion provenance/report binding, text-source wording, clock definitions, the C-05/C-16 gap map and S6 run card.

PR55's bounded 1–5 prepared inputs are not corpus replay. The adapter does not yet export per-input acknowledgement mappings. Preserve original input provenance and correlate with requestMessageId/eventId, never text or order. Missing or ambiguous correlation makes affected quality results unscored with a reason. A separate companion artifact should retain recorded-run v1 unchanged, distinguish variant and repeated attempts, and have owner-agreed fields and report discovery before implementation.

Provider/model/decoding/hardware/pricing and cold/warm conditions remain to be confirmed. Prepared-input provenance differs from the source of generated dialogue. Timing endpoints and clock domains must be explicit; planMs, firstAudibleMs and stopToSilenceMs remain unknown pending verified observation paths. No quality, cap-compliance, acoustic or S6/G4 acceptance is inferred from offline tests.

[Issue25](https://github.com/inscripoem/isla/issues/25) remains the global-ID and storage coordination thread. Retention/deletion policy, further fault coverage and Windows/product recovery acceptance remain separate. Actual-range trace/G6 checks already exist; adopting mandatory CI checks is a separate repository-policy decision. No case/invariant IDs are allocated by this status update. Course deadlines and branch-protection settings were not re-audited here.

Earlier detailed implementation/review histories remain available in the [prior delivery-plan revision](https://github.com/inscripoem/isla/blob/74e99953733eeb070f99d4b9c57554e22e928840/docs/team/DELIVERY-PLAN.en.md), module handoffs and original external evidence. Restore published source from full commit URLs; retain unique unpublished work and authentic logs outside the repository.
