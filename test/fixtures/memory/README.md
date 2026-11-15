# Memory corpora — M4-owned, not present

Status: **no real memory corpus exists in this branch.** The X07 tests use synthetic fixture
cases in `test/offline/m6-memory-bench.test.ts`; those cases are not a corpus and are not quality
evidence.

Real X07 acceptance — cross-turn reference, temporal reasoning, contradiction/update, a fixed
held-out split, and a strategy swap that changes recall@3 visibly — requires M4’s
`test/fixtures/memory/` corpora. Until M4 delivers them, X07 is **fixture-only** and must not be
reported as a quality, latency or cost result.

Owner: M4. M6 consumes the corpora; M6 does not invent memory cases or labels.

## M4 artifact published elsewhere

M4's derived-memory functions and three corpora (`contradiction-update`, `cross-turn-reference`,
`temporal-reasoning`) are published in **PR #159**, not in this branch. They are regression fixtures
with a fixed held-out split, not a quality, latency or cost verdict, and they are not directly
pluggable into `rebuildDerived` — an M4-owned adapter is required. This branch still contains no real
corpus, so X07 remains fixture-only here.
