# M3 selection corpus v1

Status: under review. Owner: M3.

`corpusVersion` is `m3-selection-v1`; `rubricVersion` is
`m3-quality-rubric-v0.1`. The manifest's `casesSha256` is a SHA-256 digest over
canonical JSON (object keys sorted, array order preserved) of the manifest case
fields and the canonical request, label and review content. It is not a hash of
raw file bytes, so Windows CRLF and Linux LF checkouts produce the same value.

Requests, reference labels and detached review records are separate files. The
loader validates labels and reviews as corpus data before execution, but a
`SelectionPort` receives only the request. Labels are not passed to the port and
are used by the test scorer only after the result returns.

`selection-001` is reviewed by `shallight` on `2026-10-23`, bound to the
request and label hashes in its detached review record. Its scores are
message-001 = 2, message-002 = 1 and defer = 0; `answer` and `acknowledge` are
accepted for their respective candidates, coverage remains `partial`, and
`heldOut` remains false. The approval does not authorize inventing the game
name or certify generated dialogue.

`selection-002` remains `draft` and must not produce an adopted score. A
`reviewed` record requires a named human reviewer, an actual review date, and
matching request and label hashes. `provenance: "synthetic-test"` records are
permitted only for mechanics tests; they never certify corpus evidence.
Exhaustive intent coverage requires a reviewed `coverageRationale`; otherwise
unlisted allowed intents are unassessed.
