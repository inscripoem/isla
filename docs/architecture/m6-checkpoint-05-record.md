# Checkpoint 05 — M6 record (evaluation readiness)

Status: **M6 record; no acceptance claimed.** Updated M5 coordination snapshot: 2026-11-09, based on PR #144 head `055ca0d`. Owner: M6. Later decisions and results are recorded in the linked issues and PRs.
Checkpoint: [#75](https://github.com/inscripoem/isla/issues/75), target 2026-11-10. A named human accepts
the checkpoint; this document records M6's state only.

Measured at `main` **`e9e7e7b`** (after #141 merged). A checkpoint is a schedule position, not a
requirement or case ID.

## M6 deliverables

| Delivery | Artifact | State |
| --- | --- | --- |
| #100 run provenance | PR **#140** | **merged** as `80e115b`; M5 approved `0dc4ec0`, M4 approved the merge-forward head and merged; ADR-008 remains **proposed**; the acknowledgement export is still unpinned |
| #103 method | PR **#142** | proposal at `d9d627b` (threshold register added); M4's three corrections and two answers applied; **not approved** |
| #103 eligibility | PR **#143** | rules 1–4 implemented; **retargeted to `main`** after #140 and #157 merged; ready at `8e32848`; rule 5 not evaluated |
| #103 label interface | PR **#145** | proposal; M4 answered the five questions as proposed positions, while the interface and remaining affected-owner decisions are not yet agreed |
| #103 thresholds | `docs/architecture/evaluation-thresholds.md` (in #142 at `d9d627b`) | every value `pending`; no baseline |
| #117 QA record | PR **#144** | docs-only records for CP5/CP6/CP8; ready for review |

## Acceptance condition → evidence

| Condition (#75) | Evidence | Verdict |
| --- | --- | --- |
| Pilot reproducible | no pilot; corpus, labels, export and CP05 provider readiness were not confirmed at this snapshot. M4 reported receiving the separate #93 text-provider configuration; that alone does not establish CP05 pilot readiness. | **NOT RUN** |
| Evaluation set fixed | #98 corpus and #99 rubric open; #145 interface not yet agreed | **BLOCKED** |
| Thresholds fixed | register exists; every value `pending` (protocol §5) | **pending** |
| Observed and unknown distinct | INV-16 tests on `main`; report renders `—`/`unknown` | **met for the mechanism**, not for a run |
| No scored result from unreviewed labels | no label file exists; nothing is scored | **not applicable yet** |

## Blockers and owners

- **Corpus, held-out split** — M3, #98.
- **Rubric, labels, condition eligibility** — M4, #99: the rubric is filed in-repo via #154 (`f99e2f5`, proposed v0.1); #99 acceptance remains open pending M3/M6 confirmation. M4
  [answered the five #145 questions](https://github.com/inscripoem/isla/pull/145#pullrequestreview-5822403599)
  as proposed positions, not an interface approval. At this snapshot the M3/M5 answers were not yet
  recorded; M5 answered on 2026-11-09 and M3 on 2026-11-10, after it.
- **Acknowledgement and timing export** — M5, #101.
- **Physical input/playback/Stop observation** — M1/M2, #102.
- **CP05 provider access and credentials** — M5/operator; pilot readiness is unconfirmed.
- **ADR-008 coordination** — M3/M4/M5 are affected reviewers for #100. M3 answered the identity scope and M4 answered D7 on #66 at `9bd5bcf`; neither is an approval of ADR-008 as a whole. M5 coordinates the still-unpinned acknowledgement export. ADR-008 decision 3 blocks CP05 scoring, not the companion merge by itself. The #140 code review is resolved and merged; separate team design decisions and GitHub branch rules remain distinct.
- **Threshold baseline** — M6, only after a measured pilot.

## Verdict

**BLOCKED for checkpoint acceptance at this snapshot; M6 method materials are in place or ready for
review.** This does not mean M4's rubric/labels or M5's export are ready. No pilot has run and no threshold
is fixed; the 2026-11-10 target is a planning target, not a measured result.

## What this does not claim

No pilot, no threshold value, no evaluation table, no G4 pass, no quality/latency/cost result, and no CP5
acceptance. #140's local tests are not a provider run.

**Status refresh (2026-11-14).** #140 merged as `80e115b`; #157 merged as `d86dbc1`; #143 is retargeted
and ready at `8e32848`. The verdict above remains a snapshot of the records that justified CP5 at the
time; it is not an acceptance.

## Next actions

1. #140 and #157 are merged; #143 is retargeted and ready at `8e32848`. Complete its final M4 review.
2. Review #142 method and #144 QA records. Keep #142's description of report behavior consistent with the merged code.
3. Complete the remaining #145 decisions with affected owners; produce the label file when the corpus exists.
4. Run the pilot only when the corpus, labels, export and credentials exist.
5. Fix thresholds only from that pilot's baseline, with head, date and approver.
