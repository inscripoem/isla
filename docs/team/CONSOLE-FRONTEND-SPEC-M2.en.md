# Console Frontend Development Specification (M2)

Revision: 2026-11-20.1. Owner: M2 — Warpshlczy. Status: draft for review in [#182](https://github.com/inscripoem/isla/issues/182). Applies to the rewrite of `src/console/` and the composition in `src/App.tsx`. Repository-wide rules in [AGENTS.md](../../AGENTS.md) take precedence; this document only adds M2-internal rules.

## 1. Scope and authority

- Owned: `src/console/`, the console composition in `src/App.tsx`, console styles and console tests.
- Not owned: shared C1–C7 contracts (`src/contracts/`), runtime transport and bootstrap behaviour (M5), playback and audio semantics (M1), plan/reply/delivery payloads (M3/M4), storage and evaluation (M6).
- Application contract 0.2 and diagnostics protocol 1 stay separate. The diagnostics surface never reads or drives session state.
- Interface changes still need review from the affected producer and consumer; a refactor does not carry authority to change a wire message.
- The console must not import Node-only, database or provider code. Everything reachable from `src/App.tsx` must be browser-safe.

## 2. Non-negotiable behaviour

These come from repo rules and from recorded review findings; a slice that breaks one is rejected regardless of visual quality.

1. **Explicit uncertainty.** A request is `pending` until its own acknowledgement settles it. A lost transport turns outstanding requests into `unknown`, never `accepted`.
2. **Correlation by identity.** Every input and control request carries its own `messageId`; an acknowledgement settles only the request with the matching identity.
3. **Draft ownership.** The composer clears only against its own acknowledgement. Acknowledgements or failures for other requests never clear or rewrite newer operator edits (`#181` C10).
4. **Connection generation fencing.** Asynchronous work started under one connection is dropped when that connection is replaced; a failure from a previous connection is never rendered as the current connection's error (`#181` C08).
5. **Snapshot and sequence fencing.** A snapshot is accepted only when it is not older than the accepted session, epoch and `lastSeq`. Replayed history is never rendered, and a reconnect never replays or resumes by itself.
6. **No optimistic state.** `attached`, `operator`, `accepted`, `delivered` are shown only when the runtime reports them. Before that the console shows `unknown` or `pending`.
7. **Evidence is labelled.** Locally observed playback receipts are labelled "local evidence only". Runtime-confirmed delivery lives on a different surface and is never inferred from a local receipt.
8. **Diagnostics isolation.** `/health` and `/diag` traffic may never mutate session, input, control or playback state.

## 3. Module map

```
src/console/
  runtime/       composition only: transport factory, performer factory, operator token, audio resolver
  connection/    transport lifecycle, bootstrap, generation counter, reconnect policy
  commands/      operator intents -> protocol messages, acknowledgement correlation
  projections/   ConsoleState -> page view models (pure)
  pages/         SessionPage, PlaybackPage, SelectionPage, DiagnosticsPage
  design/        tokens, status vocabulary, formatting primitives, ui wrappers
```

`ConsoleApp.tsx` keeps only layout, page routing and hook wiring. A module that grows past roughly 300 lines without a distinct test file is a signal to split it.

### Dependency direction

| Module | May import | Must not import |
| --- | --- | --- |
| `runtime/` | everything below, `performance/browser`, `contracts` | page components |
| `connection/` | `contracts`, `app-transport` | `pages/`, `design/` |
| `commands/` | `contracts`, `connection/` handle, `performance/browser` types | `pages/`, `projections/` |
| `projections/` | `contracts` read-only types, `design/format` | transport, machine, `runtime/` |
| `pages/` | `projections/`, `design/`, `commands/` handles | transport, wire schemas, `performer-machine` |
| `design/` | `animal-island-ui`, CSS tokens | any state module |

Additional rules:

- A page receives data and callbacks through props; it never constructs a transport or a machine.
- `projections/` functions are pure: no `fetch`, no timers, no `window` reads. Formatting that needs the clock takes an injected value.
- The diagnostics page owns its own client module; it is the only place that opens `/diag`.

## 4. State model

One `ConsoleState` container remains the source of truth. Page view models are derived, not stored. `useRef` is allowed only to read the latest state inside event handlers.

Required state fields per surface:

| Surface | Fields |
| --- | --- |
| Connection | status, detail, generation |
| Session | `sessionId`, `epoch`, `lifecycle`, `activeTurnId`, `performerStatus`, `outputConfirmation`, `capabilityRevision`, `lastSeq`, `retiring` |
| Input ledger | `messageId`, source, text, outcome, `eventId`, `seq`, detail |
| Control ledger | `messageId`, action, requestId, previous/new epoch, lifecycle, outcome, detail |
| Selection | waiting stage, plan disposition, selected event ids, reply intent, reason code, synthetic flag |
| Delivery | classification, output id, turn id, segment id |
| Playback | idle, active output id, last stage, subtitle, receipts, faults |
| Diagnostics | health fields, socket state, last reply |

Fixed vocabulary: `pending`, `unknown`, `accepted`, `applied`, `duplicate`, `rejected`, `refused`. No page-level synonyms, no colour-only distinction.

Bounded logs: keep the newest entries per list (the existing bound of 60 is the baseline); dropping is silent and never reorders.

## 5. Page inventory

| Page | Purpose | Required content |
| --- | --- | --- |
| Session | operator main surface | connection banner; session facts; input composer with source selector and ledger; Stop/Resume with request ledger; recovery acknowledgement, request and status |
| Playback | output observation | mounted player, active output, subtitle, reaction, local receipts, faults, idle state |
| Selection and delivery | pipeline audit | waiting stage, plan facts, turn reply intent, server-confirmed delivery, accepted inputs |
| Diagnostics | protocol 1 | health fields, socket state, ping reply, explicit protocol notice |
| Profile / configuration | open decision, see §9 | not implemented today; do not invent it inside another page |

Ordering rule inside a page: identity and connection facts first, then the operator action, then the ledger for that action, then reference detail. A page must remain readable at 320 px without horizontal scrolling.

## 6. Visual and accessibility rules

- Contrast: normal text >= 4.5:1, large text >= 3:1, non-text indicators and focus outlines >= 3:1. This is the `#175` C01–C06 baseline and applies to every new token.
- Status is never conveyed by colour alone: every tag carries text, and every badge has an accessible name.
- Focus: a visible outline of at least 2 px with offset on every interactive element; no outline removal without a replacement.
- Live regions: connection status uses `role="status"` with `aria-atomic`; errors are announced once, not on every re-render.
- Responsive breakpoints: 320, 375, 480, 768, 1280. Acceptance requires `document.documentElement.scrollWidth <= window.innerWidth` at 320 and 375 after fonts have loaded (`#181` C09).
- Typography and spacing come from `design/` tokens; page CSS contains no raw colour, raw font size or one-off spacing value.
- Long identifiers wrap or truncate with the full value available to assistive technology; no field may force horizontal scroll.
- Raw protocol values are formatted for humans (`localTimeMs` becomes a duration), but the underlying value stays reachable.
- Respect `prefers-reduced-motion`; no animation is required to understand a state change.

## 7. Testing and evidence

- Baseline per slice: `pnpm test:m2`. Before handoff: `pnpm typecheck`, `pnpm lint`, `pnpm gate:ai-use-log`, `pnpm verify`.
- Unit tests cover `connection/`, `commands/` and `projections/` as pure modules. The existing browser mounts (`test/browser/console.tsx`, `test/browser/console-startup.tsx`) remain the integration surface.
- Every acceptance row keeps a named test. Fixture controls and ContractRunner stay under `test/`; production code must not import them.
- Mandatory failure cases: Stop during playback, disconnect during playback, reconnect without replay, stale acknowledgement, acknowledgement for another request, protocol violation, diagnostics socket failure.
- Assertions are never weakened to make a refactor pass. If a behaviour is intentionally changed, the change and its reason appear in the PR body and the affected reviewer is named.
- Browser verification records the viewport, the build, and the observed `scrollWidth`/`innerWidth` values. A screenshot without those numbers is not acceptance evidence.

## 8. Delivery process

| Slice | Content | Closes |
| --- | --- | --- |
| S1 | `commands/` and `connection/` extraction; draft ownership, generation fencing, bootstrap error reset | `#181` C08, C10 |
| S2 | `design/` tokens and responsive layout; ribbon and decoration overflow | `#175` C09 |
| S3 | `projections/` and page split; visual and typographic pass | `#182` main body |

Rules:

- One slice per branch and PR, based on current `main`. Target at most ~500 changed lines excluding tests; if a slice exceeds that, split it again.
- Branch names: `refactor/m2-console-<slice>`. Do not stack refactor commits on a review branch (`fix/m2-174-*`).
- The implementation is authored in a local OpenCode session; every session is recorded in `docs/ai-use-log.yaml`. The PR body names the slice, the requirement or case IDs, and the review owners.
- Requested reviewers: M1 for playback, subtitle and receipts; M5 for transport, bootstrap and operator token; M3/M4 for selection and delivery fields; M6 only if UI evidence changes.
- A `CHANGES_REQUESTED` review is resolved by its reviewer, not by a rewrite. Superseding a review requires an explicit comment mapping each requested item to the new commit.
- No agent merges, enables auto-merge or pushes to `main`.
- New case or requirement IDs are reserved in the coordination thread before use; the refactor does not renumber existing rows.

## 9. Open decisions before implementation

1. Profile and configuration surface: in scope for this rewrite, or a separate task with its own ID?
2. Navigation: keep two tabs, or split into routed pages? A router adds a dependency decision.
3. Legacy fallback: keep `playbackFactory` as a fixture-only path, or remove it once the performer machine covers all transports?
4. Diagnostics refresh policy: manual refresh only, or periodic health polling?
5. Font loading: how long the responsive acceptance waits before measuring `scrollWidth`.
6. Contrast verification: manual computation per token, or an automated assertion in the browser harness.

## 10. Definition of done for a slice

- Module boundaries from §3 hold; no forbidden import appears in the diff.
- The slice's acceptance rows in §8 have named passing tests.
- `pnpm test:m2`, `pnpm typecheck`, `pnpm lint`, `pnpm gate:ai-use-log` pass locally; `pnpm verify` passes before handoff.
- Browser check recorded at 320, 375, 768 and 1280 with the measured widths.
- Failure, disconnect and Stop cases observed, not only the happy path.
- No assertion weakened, no shared contract changed without producer and consumer review.
- PR body lists task IDs, changed interfaces, actual commands and results, gaps and the requested reviewers.
