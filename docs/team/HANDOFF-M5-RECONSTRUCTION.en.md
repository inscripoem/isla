# M5 archived-session selection and reconstruction handoff

Revision: 2026-10-15.1. Owner: M5 — CHANG Xuben. Status: under review, local only.
Scope: issue #22 cross-session reconstruction; FR-06 history assembly. Durable SQLite
recovery remains M6 #25 and is not part of this slice.

## Implemented behavior

M5 composes the fresh live session's `HistoryQueryPort` from an explicit, ordered
selection of archive sources and a trusted session-to-persona catalogue. M4 consumes
the composed port unchanged and never discovers databases or guesses their contents.

- `src/runtime/session-archives.ts`: `validateArchiveSelection` validates and
  snapshots the selection (sources and each nested profile are copied and frozen, so
  later external mutation cannot change it). It rejects duplicate sources, the live
  session in the archive list, a live id that reuses a catalogued session, an
  unknown or identity-incompatible catalogue entry, and an over-large source list.
  Numerical bounds are finite safe integers; exceeding them is an error, never a
  silent truncation. `createReconstructedHistoryPort` returns the selected archives
  in the given order followed by the live session last, retaining original record
  session ids and each source's supporting-event order. Session-local `seq` is never
  compared globally, and a new local delivery never hides restored records. The view
  is scoped to its configured live session: a query for a selected source is still
  validated, and any other session is rejected (`unscoped_session_request`) rather
  than forwarded; raw archive reads use the base history port.
- Fail-closed validation. A source record whose session does not match the requested
  source, or whose known persona identity contradicts the trusted catalogue, is a
  hard failure, checked for the live source as well as archives. A direct query for a
  selected source is still validated, so it cannot bypass the catalogue. A source
  read failure throws before any speech is dispatched; empty or local-only history is
  never substituted. Null and half-known attribution is preserved, never inferred; an
  older known version of the same identity is permitted, so M4's stale-version
  trimming remains meaningful.
- `src/runtime/composition.ts`: `createReconstructedRuntimeComposition` is the
  coherent production entry. It owns the binding between reconstruction and the
  running session (the runtime session id and character identity come from the
  validated selection), and preflights a fresh, unique live id through the existing
  store port before startup — events or partial deliveries count, not only confirmed
  history. A conflict or read failure fails visibly before startup. The returned
  runtime starts stopped and dispatches nothing on construction.
  `createDialogueComposition` remains the non-reconstructing production entry.

## Evidence

- `test/offline/session-archives.test.ts`: selection validation, snapshot isolation,
  ordered composition, scoped-query rejection and selected-source validation,
  session/persona/read failures, bounds,
  legacy preservation and no-inference.
- `test/offline/reconstruction-composition.test.ts`: the same immutable selection
  binds runtime and M4 history across asynchronous store preflight, even when the
  caller mutates its configuration while preflight is held; read failures reject startup.
- `test/offline/m4-reconstruction-loopback.test.ts`: real loopback over the
  production composition and transport, reusing one in-memory M6 backend across
  composition lifecycles. It verifies two archives with repeated turn ids,
  out-of-order explicit indices and legacy nulls, then a new live completed turn,
  observing the actual M4 context on the next turn; empty selection, incompatible
  selection, a stored live id with no confirmed deliveries, failed source read
  (fail-closed, no speech), fresh stopped startup, no replay/upgrade of partial
  outputs, and prior-source immutability.
- `test/offline/m4-loopback.test.ts` and `test/offline/m4-integration.test.ts`:
  real M4/M5/M1/M6 composition over loopback and at the coordinator level, including
  two completed turns, playback-started-then-failed audit-only without degradation,
  and a failed M6 atomic commit never reaching M4.

Latest local result: `pnpm verify` passed (typecheck, lint, all tests, build). Exact
counts are recorded in the change report, not here, to avoid drift.

## Ownership and remaining external acceptance

- M4 consumes the port; it does not select sources. M6 owns the store, migrations,
  discovery and durable recovery (#25). M5 owns selection, ordering, validation and
  the runtime binding.
- This is lifecycle reconstruction over an existing store, not disk/process-crash
  durability. SQLite catalogue/discovery/migrations and durable recovery are not
  implemented or claimed, and C-17 remains a boundary-level check.
- Provider text is a deterministic substitute; no owner review or merge is implied
  by this document. Durable recovery, the product console and final quality targets
  remain pending.
