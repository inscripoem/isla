# First I1 joint inspection

Status: preparation under review as of October 31; the joint inspection had not taken place. Prepared for delivery [#87](https://github.com/inscripoem/isla/issues/87) and checkpoint [#72](https://github.com/inscripoem/isla/issues/72). The team's target is **2026-11-01 21:00 UTC+8**. This document does not record an accepted inspection.

## Source and participants

- M2 console checked during preparation: [PR67 / 35a077430f59b7a51487c22f41432fb7ad938ece](https://github.com/inscripoem/isla/commit/35a077430f59b7a51487c22f41432fb7ad938ece). M2's [formal browser results](https://github.com/inscripoem/isla/issues/85#issuecomment-6531631101) used the fixed-audio composition from PR130 temporarily; they are not a post-merge joint inspection.
- Published M5 bases at preparation: [PR130 / a8bf6cb63af69b3e70313d7dc36e80cb05005bbe](https://github.com/inscripoem/isla/commit/a8bf6cb63af69b3e70313d7dc36e80cb05005bbe) and [PR131 / 9a6758734b5137f940f18f68df35e596e8227030](https://github.com/inscripoem/isla/commit/9a6758734b5137f940f18f68df35e596e8227030). At preparation, updated M5 candidates were local and had not been reviewed at a published head; record the actual versions used in the joint run.
- M5 separately ran PR67 `35a0774` with then-unpublished audio and I1 candidates based on [main 5e7abfb7dfa758a462b97ef891266c7d911637d9](https://github.com/inscripoem/isla/commit/5e7abfb7dfa758a462b97ef891266c7d911637d9). That local combination is supporting evidence, not a merged source revision or a team acceptance. Its fixed candidate-patch hashes and local logs are retained by M5.
- Before the joint run, record the exact combined commit and any explicitly accepted working-tree patch hashes. Do not assemble observations from separate source versions into one claimed run.
- Coordinator: M5. Obtain scoped consumer evidence from M1 playback, M2 console, M3 decisions, M4 dialogue and M6 recording; name the human who accepts the inspection record.

## Known implementation boundary

The local I1 candidate uses real M3 rule selection and exercises the real M4 dialogue/context in its adoption checks. ReactionPort, deterministic catalogue text, fixed WAV material and the test renderer remain substitutes where used. The formal-console browser run used the actual M2 console and M1 browser controller; M5's local combined run used SQLite. The isolated loop page is not the formal M2 console. Neither run establishes live-provider, physical avatar, acoustic sound/silence or Windows acceptance.

The original first-recovery High was observed on PR67 `d44d711`; M2 corrected it in the `35a0774` line. M5's scoped local re-review and browser recovery check found no blocking issue in that scope. As of preparation, the GitHub re-review had not been submitted and M1's playback review was separate; check the current PR thread before inspection. Preserve the earlier failed result as evidence for its own source; do not present it as the outcome of the corrected head.

## Run preparation

1. Choose and record one source combination and the versions of the console, audio deployment and other participants; record unmerged or substitute components as gaps.
2. Record OS, Node/pnpm and browser versions, output-device conditions and substituted peers. Do not capture credentials or private request bodies.
3. Run the agreed role/composition checks and `pnpm verify` on that source. Keep individual and combined results distinct; record failures and skips.
4. If using the isolated I1 page, use `pnpm dev:loop` and `pnpm exec vite --config test/browser/vite.config.ts`, then open `http://127.0.0.1:5173/loop.html`. Its observations are supporting evidence, not formal-console acceptance.
5. For the formal console, use the actual M2 application transport against the chosen deployment. Record browser and server/store outcomes for the same run; identify substituted peers.

## Inspection record

The joint-inspection column stays NOT RUN until the team performs it. Original case IDs are references, not new registrations or accepted case statuses.

| Check | Observable result required | Existing individual evidence / remaining gap | Joint inspection |
| --- | --- | --- | --- |
| Start and authority (C-07) | Session initially stopped; snapshot precedes controls; an untrusted connection cannot control output. | Existing application tests; repeat on the chosen console/deployment. | NOT RUN |
| Two normal turns (C-01/C-13) | Input IDs match selection and dialogue; two distinct turns produce expected segments and confirmed records. | M2's `35a0774` browser matrix records completed turns; repeat on the chosen combined source. | NOT RUN |
| Real rule selection | Persisted plan identifies `m3-rules`; chosen input and intent reach real M4. | M5's separate local combination recorded six rule plans; adoption tests exercise M4. ReactionPort remains #89. | NOT RUN |
| Stop during playback (C-04) | Stop cancels current output; terminal facts and partial/unknown records stay truthful. | M2's `35a0774` matrix records partial/unknown cancellation. Physical silence was not measured. | NOT RUN |
| Manual Resume | Resume is explicit and a new turn completes when authoritative state permits. | M2's `35a0774` matrix records Resume and a completed subsequent turn. | NOT RUN |
| Duplicate input/control/receipts (C-02/C-10) | No duplicate turn or contradictory overwrite. | M2's matrix covers duplicate/late input and receipt frames; repeat the applicable control checks. | NOT RUN |
| Late results and deadlines (C-03/C-05/C-16) | An expired or stopped selection cannot start dialogue/playback; fresh input remains possible. | Controlled negative tests exist; C-05/C-16 remain pending in the shared register. | NOT RUN |
| Synthesis failure (C-09) | No phantom delivered history; a delivered prefix remains confirmed and the failed remainder is not admitted to spoken memory. | The local I1 candidate asserts M6 history and M4 memory for the delivered prefix and failed second segment; it is not a joint browser result. | NOT RUN |
| Loss, reload and first recovery (C-08) | Unknown output is not promoted/replayed; explicit UI recovery requests a stopped successor. | The old `d44d711` browser run failed. M2's corrected-head matrix and M5's local re-review observed the first acknowledged recovery while `retiring=no`. | NOT RUN |
| Recovery successor | Successor shares the intended clock domain, starts stopped, carries only confirmed history and requires manual Resume. | Browser evidence at `35a0774` covers reattach, Resume and a successor turn; confirm the full history/clock assertions on the selected joint revision. | NOT RUN |
| Playback resource mapping (#69/#86) | WAV hash/duration and same-origin bytes match the offered reference and current session/epoch; stale resources are refused. | M1 has partial mapping evidence and reviewed PR130 `a8bf6cb`; updated audio candidate and final combined run need review. | NOT RUN |
| Recording and shutdown (#92) | Browser, runtime and recording refer to the same source/turn IDs; shutdown does not replay or leave unowned output. | The local browser run has SQLite records; M6's scoped confirmation and the final combined trace are still required. | NOT RUN |

## Decision and remaining deliveries

Checkpoint 02 records that the inspection occurred, including failures and missing work. A named human must accept the inspection record before closure; it does not accept complete I1. Record owner, forecast, required consumer and retest evidence for each remaining gap; do not invent missing forecasts.

Complete I1 remains checkpoint [#73](https://github.com/inscripoem/isla/issues/73), target **November 5 at 21:00 UTC+8**. #88 is accepted; #89 ReactionPort, #90 full composition, #91 M4 consumption and #92 combined playback/console/recording remain open. M3's [forecast](https://github.com/inscripoem/isla/issues/82#issuecomment-6517571574) for #89 is review-ready on November 3 at 21:00.
