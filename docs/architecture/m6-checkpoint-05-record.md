# Checkpoint 05 — M6 record (evaluation readiness)

Status: **M6 record; no acceptance claimed.** Date: 2026-11-09. Owner: M6.
Checkpoint: [#75](https://github.com/inscripoem/isla/issues/75), target 2026-11-10. A named human accepts
the checkpoint; this document records M6's state only.

Measured at `main` **`e9e7e7b`** (after #141 merged). A checkpoint is a schedule position, not a
requirement or case ID.

## M6 deliverables

| Delivery | Artifact | State |
| --- | --- | --- |
| #100 run provenance | PR **#140** | rebased onto `e9e7e7b` at `344161e`, **mergeable**, CI re-running; ADR-008 remains **proposed**; provenance 30/30 locally |
| #103 method | PR **#142** | proposal at `d9d627b` (threshold register added); M4's three corrections and two answers applied; **not approved** |
| #103 eligibility | PR **#143** | rules 1–4 implemented; stacked on `m6-02-provenance`; retarget after #140; rule 5 not evaluated |
| #103 label interface | PR **#145** | proposal; five decisions pending with M3/M4/M5 |
| #103 thresholds | `docs/architecture/evaluation-thresholds.md` (in #142 at `d9d627b`) | every value `pending`; no baseline |
| #117 QA record | PR **#144** | docs-only, CP8 work delivered early; still draft |

## Acceptance condition → evidence

| Condition (#75) | Evidence | Verdict |
| --- | --- | --- |
| Pilot reproducible | no pilot; no corpus, labels, export or credentials | **NOT RUN** |
| Evaluation set fixed | #98 corpus and #99 rubric open; #145 five answers pending | **BLOCKED** |
| Thresholds fixed | register exists; every value `pending` (protocol §5) | **pending** |
| Observed and unknown distinct | INV-16 tests on `main`; report renders `—`/`unknown` | **met for the mechanism**, not for a run |
| No scored result from unreviewed labels | no label file exists; nothing is scored | **not applicable yet** |

## Blockers and owners

- **Corpus, held-out split** — M3, #98.
- **Rubric, labels, condition eligibility** — M4, #99; five label decisions in #145.
- **Acknowledgement and timing export** — M5, #101.
- **Physical input/playback/Stop observation** — M1/M2, #102.
- **Provider access and credentials** — M5/operator.
- **ADR-008 approval** — M3/M4/M5; without it #140 cannot merge.
- **Threshold baseline** — M6, only after a measured pilot.

## Verdict

**BLOCKED for checkpoint acceptance; method-ready.** The protocol, provenance parser, eligibility rules and
threshold register are in place or in review. The pilot has not run and no threshold is fixed, so the pass
condition cannot be met on 2026-11-10.

## What this does not claim

No pilot, no threshold value, no evaluation table, no G4 pass, no quality/latency/cost result, and no CP5
acceptance. #140's local tests are not a provider run.

## Next actions

1. Merge #140 after ADR-008 approval and a green CI; then retarget #143.
2. Get #142 method approval (M3/M4/M5) and merge after #140.
3. Answer the #145 five decisions; produce the label file when the corpus exists.
4. Run the pilot only when the corpus, labels, export and credentials exist.
5. Fix thresholds only from that pilot's baseline, with head, date and approver.
