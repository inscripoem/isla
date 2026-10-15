# ADR-001 — Storage persistence through an injected backend

Status: under review (M6). Shared-architecture coordination with M5 pending.
Date: 2026-10-12 · Owner: M6 · Requirements: FR-06 · Invariants: INV-04, INV-05, INV-06.

## Context

M6 owns the persistence layer (SQLite, migrations, recording/replay). The event store's
behaviour — identity/sequence conflict rules, atomic delivery commit, ordered reads, JSONL
export — must be defined independently of the persistence technology so that SQLite can replace
the in-memory implementation without changing the store's logic. Storage failures must be testable
without exposing fault-injection switches on production API (`READINESS-KITS`: keep fault-injection
controls in the test adapter).

## Decision

Define a `StorageBackend` interface (reads + one atomic `commit`) in
`src/storage/backend.ts`. `createEventStore(backend = createInMemoryBackend())` depends only on that
interface. A backend supplies failure by throwing during `commit`; the store converts that into
`failed` acknowledgements with no partial mutation. The test adapter injects a failing backend
under `test/`.

## Design process (ADD)

1. **Review inputs** — FR-06 (persist/replay events, decisions, delivery outcomes); C-17;
   READINESS-KITS (no production fault controls); architecture blueprint (SQLite owns persistent
   records; M4 must not write SQL).
2. **Select drivers** — durability & replay; test isolation; production-API safety.
3. **Decompose** — store *logic* (conflict rules, atomic commit, ordering, export) vs persistence
   (reads + one atomic write). Distinct responsibilities → distinct elements.
4. **Choose design concepts** — Information Hiding + port/adapter: a `StorageBackend` seam;
   swappable backend (Microkernel-style).
5. **Instantiate** — `StorageBackend`, `createInMemoryBackend`, `createEventStore(backend)`.
6. **Record decisions** — this ADR + trace-matrix rows + INV-04..06 + Delta-001 + option ledger.
7. **Evaluate** — conformance suite returns empty violations; no fault flags in `src/`; `pnpm verify`
   green. PASS.

## Alternatives considered

1. **Production fault hooks** (`beforeAppend`/`beforeCommit` options on the factory) — **rejected.**
   Exposes a "fail the next write" switch on the evidence layer; violates READINESS-KITS:26; makes
   the conformance failure test exercise an artificial mode, not a real storage failure.
2. **No seam; in-memory only** — **rejected.** No path to SQLite durability, which the blueprint
   requires ("SQLite will own persistent records"); fixtures do not prove SQLite behaviour.
3. **Test-only Proxy wrapper around the store** — **rejected.** A wrapper that throws before the
   store runs cannot exercise the store's own failure handling; a real failure originates in the
   persistence layer.

## Consequences

- One seam, database-agnostic store logic; SQLite implements the same interface with no store change.
- Failure injection lives in `test/`; production exposes no fault switch.
- One indirection between the store and its data.

## Re-open triggers

- A backend cannot express a required guarantee (e.g. atomic multi-record commit).
- The `node:sqlite` driver changes or is replaced.
- A future requirement needs a store capability not expressible via the backend interface.

## References

- `src/storage/backend.ts`, `src/storage/in-memory-backend.ts`, `src/storage/event-store.ts`
- `test/offline/m6-storage.test.ts` (failing backend), `test/conformance/storage.conformance.ts`
- `isla/README.md` (D7 gate design), `docs/code-governance/verification-constraints.md`
