# First I1 joint inspection

Status: preparation under review; the joint inspection has not taken place. Prepared for delivery [#87](https://github.com/inscripoem/isla/issues/87) and checkpoint [#72](https://github.com/inscripoem/isla/issues/72). Target: **2026-11-01 21:00 UTC+8**. This preparation document does not record an accepted inspection.

## Source and participants

- M5 candidate basis: [PR131 / 6fda59b1dd039516ea89f29cb098ae8da2a7df37](https://github.com/inscripoem/isla/commit/6fda59b1dd039516ea89f29cb098ae8da2a7df37), including main [c1decc2631c53cbb1d6b1376b030f87301fc1303](https://github.com/inscripoem/isla/commit/c1decc2631c53cbb1d6b1376b030f87301fc1303).
- This inspection preparation accompanies the real-selection follow-up. Record its exact source SHA and any working-tree diff hashes before the actual inspection; independent results and file hashes are preserved in the task evidence.
- Separate formal-console evidence: PR67 [d44d7114b7541d0c122941b2e72bf410965484da](https://github.com/inscripoem/isla/commit/d44d7114b7541d0c122941b2e72bf410965484da) combined diagnostically with PR130 [76ba27b76de28a92c3654c2756ef41df95e1fc3f](https://github.com/inscripoem/isla/commit/76ba27b76de28a92c3654c2756ef41df95e1fc3f). Those October 29 observations do not certify the new candidate or the current PR130 head.
- Record the exact combined revision and all uncommitted diff hashes before the November 1 run. Do not assemble evidence from different source trees into one accepted run.
- Coordinator: M5. Required consumer evidence: M1 playback, M2 console, M3 decisions, M4 dialogue, M6 recording. Name the human accepter in the actual inspection record.

## Known implementation boundary

The new local increment adopts real M3 rule selection with real M4 dialogue/context and the M5/M1 application path. ReactionPort, deterministic catalogue text, fixed WAV material, test renderer and in-memory storage remain explicit substitutes where used. The isolated loop page is not the formal M2 console. No live provider, physical avatar, acoustic silence, Windows result or SQLite process-restart claim follows from this run.

PR67 still has a known High finding: after playback connection loss and reload, both recovery controls stay disabled before the first recovery request. M2 owns its correction. Preserve this failed result; do not bypass the controls or relabel a direct protocol request as successful console recovery.

## Run preparation

1. Choose and record one source combination. Include the corrected PR67 and audio deployment only after their actual versions are available; otherwise retain a named gap.
2. Record OS, Node/pnpm versions, browser version, output device and substituted peers. Do not capture bootstrap credentials or private request bodies.
3. Run the existing role/composition checks and `pnpm verify`. Keep individual and combined results separate.
4. For the isolated I1 page, use `pnpm dev:loop` and `pnpm exec vite --config test/browser/vite.config.ts`; open `http://127.0.0.1:5173/loop.html`. The maintained browser recovery script can be run with externally supplied Playwright/Chromium paths. This is independent supporting evidence, not formal-console acceptance.
5. For the formal console, use its actual M2 application transport against the approved combined deployment. Record both browser and server/store observations; a fixture console does not count.

## Inspection record

The November 1 column is intentionally NOT RUN until the joint inspection occurs. Original case identifiers are references, not new registrations or accepted case statuses.

| Check | Observable result required | Prior evidence / current gap | November 1 result |
| --- | --- | --- | --- |
| Start and authority (C-07) | Initial session stopped; snapshot arrives before controls; an untrusted connection cannot control output. | Maintained application tests; repeat on the chosen console/deployment. | NOT RUN |
| Two normal turns (C-01/C-13) | Accepted input IDs match selection and dialogue; two distinct turns each produce the expected two segments and matching confirmed records. | October 29 formal-console combination passed; new source requires its own run. | NOT RUN |
| Real rule selection | Persisted plan identifies `m3-rules`; chosen event and intent reach real M4; no fixture decision is presented as M3 output. | This local increment supplies the missing selection adoption; rule ReactionPort remains #89. | NOT RUN |
| Stop during playback (C-04) | A Stop cancels the current output; terminal facts and uncertain/partial records remain truthful; no new stale output is admitted. | October 29 combination recorded cancellation; no acoustic-silence claim. | NOT RUN |
| Manual Resume | Resume is explicitly requested and a new turn completes only when authoritative state permits it. | October 29 combination passed after Stop; repeat on the combined revision. | NOT RUN |
| Duplicate input/control/receipts (C-02/C-10) | No duplicate turn or contradictory overwrite; retained outcome remains stable. | Existing tests support this; formal-console combined observation still required. | NOT RUN |
| Late results and deadlines (C-03/C-05/C-16) | An expired or stopped selection cannot start dialogue/playback; later fresh input remains possible. | Controlled negative tests exist; C-05/C-16 stay pending in the shared register. | NOT RUN |
| Synthesis failure (C-09) | No phantom delivered history; a delivered prefix stays confirmed and the failed remainder stays unconfirmed. | PR131 adoption checks; shared case remains pending. | NOT RUN |
| Loss, reload and first recovery (C-08) | Unknown prior output is not promoted/replayed; explicit UI recovery can request a fresh stopped successor. | FAIL on unchanged PR67 d44d711; waiting for M2 correction. | NOT RUN |
| Recovery successor | Successor uses the same clock domain, starts stopped, carries only confirmed history and requires manual Resume. | Isolated loop supporting evidence is distinct from formal-console recovery. | NOT RUN |
| Playback resource mapping (#69/#86) | WAV hash/duration and same-origin byte route match the offered ref and current session/epoch; stale resources are refused. | M1 partial mapping evidence and PR130; latest-head consumer review remains. | NOT RUN |
| Recording and shutdown (#92) | Browser, runtime and recording refer to the same source/turn IDs; shut down without replay or an unowned live output. | M6 consumer result and final combined trace still required. | NOT RUN |

## Decision and remaining deliveries

Checkpoint 02 records that the inspection occurred, including failures and missing work. It can close only after a named human accepts that inspection record. It does not accept complete I1.

Complete I1 remains checkpoint #73 on **November 5, 21:00 UTC+8**. At preparation time, #88 is accepted; #89 ReactionPort, #90 full composition, #91 M4 consumption and #92 combined playback/console/recording remain open. M3 forecasts #89 review-ready on November 3 at 21:00, leaving 48 hours before full-I1 acceptance.

For every failed/not-run row, record the exact source, actual result, responsible owner, review-ready forecast, required consumer and retest evidence. Missing forecasts remain unknown.
