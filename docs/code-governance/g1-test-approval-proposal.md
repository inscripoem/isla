# Proposal — gate G1: tests approved before implementation

Status: **proposal — needs the team's agreement (at least half: 3 of 6).** Owner: M6 (R3 tooling).
Revision 2026-10-16.1. Related: `docs/architecture/adr/006-gate-tooling.md`, `.github/PULL_REQUEST_TEMPLATE.md`,
`docs/debt-register.md` (DEBT-02), `docs/code-governance/structural-constraints.md`.

## 1. What G1 is, in one paragraph

G1 is one of the six course gates. It says: **agree the tests before writing the change.** The idea is
simple — first decide what "correct" means, then write code until the test passes. If the code is written
first, the test usually just describes whatever the code already does, so it cannot catch a mistake.

## 2. Why a machine cannot check this by itself

A computer can check the *result* of a change (does the test pass?) but not its *history* (was the test
agreed first?). Git does not record which file is a test or when a test was seen by a human. So the gate
needs one small **human signal** that a machine can read. The team already has that convention: a **label**
on the pull request.

## 3. What we propose, in one sentence

**A pull request that changes code or prompts must carry the `tests-approved` label.** The label means a
human has read and agreed the tests. CI reads the label.

## 4. How it works — step by step

**For a contributor**

1. Open (or update) a pull request that touches `src/` or `prompts/`.
2. Agree the tests with a reviewer or the module owner — say which tests will prove the change, before the
   implementation is finished.
3. A reviewer adds the label **`tests-approved`** to the pull request. One label is enough for the whole PR.
4. CI runs again when the label is added and the G1 step passes.

**For CI (what the machine does)**

1. Is this run a **pull request**? If it is a plain push to a branch, G1 does not apply.
2. Did the pull request change any file under `src/` or `prompts/`? If not (for example, a documentation
   change), G1 passes — there is no test to approve first.
3. Read the pull-request labels. If `tests-approved` is present, pass.
4. If the label is missing, report it — and, once the team switches the mode, fail the run.

## 5. The decisions the team must make

| # | Decision | Options | Proposed | Why |
| --- | --- | --- | --- | --- |
| D1 | What is the human signal? | a pull-request **label**; a CODEOWNERS rule; branch protection only; a commit-message trailer | **label** | Visible in the PR, easy to add/remove, already named in the PR template; needs no extra service |
| D2 | Which changes does it cover? | all files; **code + prompts**; tests only | **`src/` and `prompts/`** | Those are the files that can break behaviour; documentation has no test to approve |
| D3 | Enforce now, or advise first? | **advise (report) now**; enforce immediately | **advise now** | Merging the step cannot break any open PR; the team switches it on when it agrees |
| D4 | What is the label called? | any name | **`tests-approved`** | The name already used in the PR template, the README and ADR-006 — no re-teaching |
| D5 | Who may add the label? | anyone with write access; owners only | **any reviewer/owner** | Keeps it simple; GitHub already controls who can label |
| D6 | What does it *not* prove? | — | **the timing** | A label says "the tests were agreed", not "before the first commit". The timing stays a review promise — see §8 |

## 6. What changes if you agree

1. One word in `ci.yml`: `advise` → `enforce`, so the step can block.
2. A human turns on branch protection so the G1 check must pass (a remote setting — no code change).
3. Traceability rows are added to the registers (see §9) once the id convention is adopted.

## 7. Why it is safe to try

- **Merging this proposal changes no behaviour.** The CI step is *advisory*: it prints a warning and never
  fails a run. No open pull request is affected.
- **Rollback is one line:** delete the `G1` step (and the script) — nothing else depends on it.
- **No new tool, no new service, no secret.** It reads labels GitHub already provides.

## 8. What this proposal does *not* do

- It does not check that the label was added *before* the change (that needs the pull-request timeline API;
  a possible follow-up, described but not built).
- It does not add the label automatically, and it does not change who can merge.
- It does not touch any other gate.

## 9. Traceability (so the chain is crystal clear)

| Link | Artifact |
| --- | --- |
| Requirement / driver | The course's D7 gate **G1**; recorded in `docs/architecture/adr/006-gate-tooling.md` and `docs/debt-register.md` DEBT-02 |
| Concept | a *process* gate read from a pull-request label |
| Element | `src/evaluation/test-approval-gate.ts` |
| Interface | the `tests-approved` label + `pnpm gate:test-approval <advise\|enforce> <changed files>` |
| Code | `collectTestApprovalViolations`, `runCli` |
| Test | `test/offline/test-approval-gate.test.ts` (6 cases: not-a-PR, docs-only, labelled, unlabelled, prompt, modes) |
| Monitor | the `G1` step in `.github/workflows/ci.yml` |
| Decision record | this document; on approval it moves into ADR-006 with a `delta/006` entry |
| Case | **pending id** — `C-M6-1` under the convention in `structural-constraints.md` §3 once PR #32 is adopted. The register row is added **on approval**, not now, because the convention says allocate before adding, and nobody should self-assign an id. |

## 10. The ask

Please reply on issue #25 with **agree**, **agree with changes**, or **no**, and one line of reason.
- Switching the gate from *advisory* to *enforcing* needs **at least half the team (3 of 6)**.
- Until then the step stays advisory and every open pull request continues to pass.
