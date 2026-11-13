# Memory corpora — M4-owned, not present

Status: **no real memory corpus exists in this branch.** The X07 tests use synthetic fixture
cases in `test/offline/m6-memory-bench.test.ts`; those cases are not a corpus and are not quality
evidence.

Real X07 acceptance — cross-turn reference, temporal reasoning, contradiction/update, a fixed
held-out split, and a strategy swap that changes recall@3 visibly — requires M4’s
`test/fixtures/memory/` corpora. Until M4 delivers them, X07 is **fixture-only** and must not be
reported as a quality, latency or cost result.

Owner: M4. M6 consumes the corpora; M6 does not invent memory cases or labels.
