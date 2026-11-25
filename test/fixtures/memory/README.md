# Memory corpora — M4-owned, published in #159

Status: **three regression corpora are present** — `contradiction-update.json`,
`cross-turn-reference.json` and `temporal-reasoning.json` — published by M4 in #159 (`bb9eaa3`) with a
fixed held-out split. They are regression fixtures, not a quality, latency or cost verdict.

Only a fixture-level path consumes them today. The functions take admitted `DeriveSourceTurn` records
and an `audienceId`, do not carry `createdAtMs`/`updatedAtMs`, and stamp their own extractor version, so
they are **not directly pluggable into `rebuildDerived`**. An M4-owned adapter at M5's composition
boundary is required; until it exists, X07 acceptance remains open.

Owner: M4. M6 consumes the corpora; M6 does not invent memory cases or labels.
