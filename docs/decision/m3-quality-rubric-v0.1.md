# M3 response-quality rubric v0.1

Status: draft / under review. Owner: M3. Reviewers: M4 for intent adherence and
persona consistency; M5 for authority-related categories. Scope: NFR-03 and the
semantic portion of C-16. This document does not implement a scorer and does not
claim a measured quality result.

## Four NFR-03 dimensions

The requirement-level names are retained exactly:

1. **Selection appropriateness**
2. **Intent adherence**
3. **Persona consistency**
4. **Unacceptable-response rate**

Intent suitability is a supporting sub-judgement under selection
appropriateness. It is **not a fifth** NFR-03 dimension. Candidate/defer choice
and intent suitability are reported separately; they are not silently combined
into a composite score.

## Scales

| Judgement | Scale |
| --- | --- |
| Selection appropriateness: candidate/defer | 2 = preferred eligible choice or justified defer; 1 = acceptable alternative; 0 = explicitly reviewed unsuitable choice/defer |
| Selection appropriateness: intent suitability | appropriate / inappropriate / unassessed |
| Intent adherence (dialogue output) | 2 = clearly follows the accepted plan; 1 = partially follows; 0 = contradicts |
| Persona consistency | 2 = consistent with the versioned persona; 1 = minor deviation; 0 = material contradiction |
| Unacceptable-response flag | yes / no / unknown against reviewed categories such as privacy disclosure, authority escape or material unsupported factual assertion |

The unacceptable-response flag supports the rate. It is not mechanically
derived from the other scores.

## Intent coverage

Intent coverage is `partial` by default.

- Under **partial** coverage, the listed intents are acceptable and unlisted
  allowed intents are **unassessed**. They are never automatically unsuitable.
- **Exhaustive** coverage requires a reviewed record, a non-empty
  `coverageRationale`, and an explicit reviewer assertion that every allowed
  intent was considered. Only then may an allowed but unlisted intent be
  recorded as inappropriate.
- A draft label cannot claim exhaustive coverage.

Candidate scoring and intent suitability are independent. If a reviewed
candidate score is known but the chosen allowed intent is unassessed under
partial coverage, the candidate score is retained and only intent suitability
is marked unassessed.

## Denominators and exceptional outcomes

Report at least:

- total selection opportunities;
- returned selection results;
- valid proposals;
- invalid or unreturned results;
- actually scored counts;
- unassessed counts;
- failures, timeouts and cancellations separately.

Rules:

- Candidate/defer scores include valid defer decisions.
- Intent suitability applies only to valid responding proposals with sufficient
  labels; defer is not applicable.
- Intent adherence and persona scores apply only to assessable dialogue outputs.
- A valid defer has no dialogue score.
- Missing output is neither a quality pass nor an invented zero.
- Unacceptable-response rate uses assessable generated outputs, including
  available outputs from failed or cancelled runs. Missing or unassessed
  outputs are reported separately as unknown.
- Publish supporting counts and separate sub-judgements initially. Do not
  publish an unreviewed composite score.

## Failure, draft and synthetic evidence

- Technical failures, schema-invalid results and semantically invalid proposals
  remain visible as validity/technical counts. They do not receive a semantic
  score.
- Wording a valid but unsuitable decision as a score of 0 is different from a
  technical failure.
- Draft labels never produce an adopted score.
- Synthetic review records are test data only. They may validate mechanics, but
  they never certify a real corpus example.
- Actual corpus examples remain draft until a named human reviewer signs the
  detached review record with the request and label hashes.

## Reviewer process and freeze

- M3 owns selection and intent-suitability criteria.
- M4 reviews dialogue intent-adherence and persona criteria.
- M5 reviews authority-related unacceptable-response categories.
- Reference labels use a named reviewer, actual review date, and content hashes.
- Disagreement is recorded and adjudicated; label changes receive a new corpus
  version or immutable content hash.
- Full corpus adoption requires two independent human reviewers.
- Freeze the held-out split and corpus/rubric versions before tuning and before
  a real comparison. Do not use held-out labels to tune the system.

## Evidence boundaries

Direct `SelectionPort` execution is module evidence. It does not establish M5
prepared-input replay, M4 dialogue adherence, live-provider quality, an
evaluation table, G4 or S6. Labels, draft records and synthetic mechanics do not
establish a quality score.
