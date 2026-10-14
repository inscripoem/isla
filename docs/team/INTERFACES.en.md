# Interface and handoff baseline v0.2

Revision: 2026-10-15.1. Status: under review. Shared schemas, the M5 coordinator, M1 fixed synthesis/mapped rendering/browser playback and M6 in-memory storage exist. This revision adds delivery attribution and ordering metadata; affected-owner review and full application integration remain pending. This is an evolvable baseline coordinated by M5 with affected producers and consumers.

## Executable contract map

Import public types and schemas from `src/contracts/app/`. These files define exact fields, nullable values, result variants and validation. Use `test/support/fixture-data.ts` and the [role kits](READINESS-KITS.en.md) for working examples; do not reconstruct types from prose.

| Boundary | Schema source | Ownership |
| --- | --- | --- |
| C1: input/response plan | `pipeline.ts`: InputEvent, SelectionRequest, SelectionResult | M3 implements SelectionPort; M5 supplies eligible inputs and validates proposals. |
| C2: dialogue | `pipeline.ts`: DialogueRequest, DialogueSegment, DialogueEnd | M4 implements DialoguePort; M5 supplies selected input text and responsePlan. |
| C3: reaction | `pipeline.ts`: DecisionRequest, DecisionResult | M3 implements ReactionPort; M5 validates before dispatch. |
| C4: capabilities | `pipeline.ts`: CapabilitySnapshot | M1 implements RendererPort and semantic-action mappings. |
| C5: performance | `pipeline.ts`: PreparePerformance, PreparedAudio, PerformanceCommand, PerformanceCancel, PerformanceReceipt, PlayerStatus | M1 implements SynthesisPort, PlayerPort and RendererPort. |
| C6: delivered history | `storage.ts`: CommitDelivery, DeliveryCommitAck, ConfirmedDelivery | M4 implements MemoryCommitPort and owns memory semantics; it consumes M6's HistoryQueryPort. |
| C7: persistence/replay | `storage.ts`: RuntimeEvent, AppendAck, AtomicCommitAck | M6 implements EventStorePort, MemoryProjectionPort, HistoryQueryPort and ReplayReaderPort. M5 assigns seq. |
| Console/runtime | `wire.ts`: bootstrap, inputs, controls, acknowledgements and envelopes | M2 integrates ConsoleTransportPort; M5 implements RuntimeEndpointPort. |
| Common values/calls | `primitives.ts`, `ports.ts`, `validate.ts` | Versions, enums, usage, AbortSignal/deadline context, callable interfaces and parsing. |

The coordinator in `test/support/contract-runner.ts` illustrates fixture composition, not production M5. Production code must not import `test/`.

## Authority, identity and timing

M5 owns lifecycle, epoch, active turn, output registration, deadlines and sequencing. M3 proposes decisions; M4 generates dialogue and interprets delivery; M1 observes output; M6 persists evidence. Provider success or schema validity does not grant execution permission.

- `sessionId` is an identity, not a credential. `messageId` deduplicates messages; `requestId` correlates asynchronous requests and retries.
- M5 creates turnId and registers outputId; M4 creates immutable segmentId values within a turn.
- Epoch advances on Stop and successful Resume. Relevant decision-state changes advance snapshotRevision; M1 capability changes advance capabilityRevision.
- M5 allocates increasing per-session seq values; M6 acknowledges those exact events.
- Deadlines use a server-owned monotonic clock. Wall-clock timestamps are diagnostic, not authoritative.

Check correlation, session, captured epoch, applicable turn/segment/revisions and expiry after asynchronous work and before dispatch. Old results stay stale even if a later Resume makes the session running again.

## C1–C3: selection and dialogue

C1 offers at most five eligible inputs and selects exactly one or defers. Intents are answer, clarify, acknowledge, support, playful and check-correction. Selection and intent share one provider attempt per opportunity. Unchanged deferred input causes no polling. M5 validates the oldest-eligible/answer fallback after failure; Stop, expiry or stale state cannot be bypassed. Interrupted inputs are not automatically marked answered or retried.

C2 includes selectedInput text, profile references, confirmed-history references, context limits and a validated responsePlan. M4 assembles context through M6 storage APIs and its own persona/memory policy. Intent templates cannot override standing constraints; check-correction requests verification rather than automatic agreement.

`DialoguePort.generate(request, context, sink)` emits up to two ordered finalized segments via `sink.segment`, then returns DialogueEnd. Reusing a segment identity cannot change its text. Punctuation-only output is a no-speech outcome. Generation completion is not audio completion; generated text does not enter confirmed spoken history.

C3 chooses a current eligible action or no-op. A no-op makes no renderer call. Initial reactions use rules; model reactions remain later work. Timeout/abstention/invalid reaction must not delay Stop; the intended fallback is no-op while otherwise-valid speech continues. Full timeout scenario C-05 remains pending.

Record actual attempts and returned usage, including failures. Missing usage is unknown, not zero. Live resource/quality thresholds remain open in the requirements register.

## C4–C6: performance and delivered history

M1 separates synthesis, browser playback and rendering. Provider SDKs, private voice identifiers, credentials and VTS commands remain inside adapters. Advertise only verified semantic-action mappings. Switch adapters while stopped after old resources are settled, then refresh capabilities.

Preparing audio never starts playback. Audio uses an opaque reference, not a caller-selected filesystem path or arbitrary URL. Commands use finalized subtitle text and matching turn/segment identity. Play one speech output at a time, in order.

Receipts identify output, session, epoch, turn, segment, modality and observed stage. Subtitle appearance does not prove audio completion; renderer acceptance does not prove animation completion. Cancellation and player status provide local evidence. Control acknowledgement alone does not prove physical silence.

Deduplicate identical evidence; reject unregistered/mismatched receipts. Record contradictory terminal claims without overwriting confirmed facts. Unknown means missing knowledge and may be resolved by concrete evidence; it cannot authorize more playback.

Only confirmed completed audio enters fully-delivered spoken history. A stopped/failed segment that had started remains partial-unknown: do not quote its entire text as spoken. Earlier completed segments remain valid. Word-level delivery is outside v0.2. C6 updates are idempotent and tied to immutable text, captured attribution and supporting output/receipt evidence.

Storage-contract revision `2026-10-14.1` adds three required fields to both `CommitDelivery` and `ConfirmedDelivery`:

| Field | Source | Legacy unknown |
| --- | --- | --- |
| `segmentIndex` | Original `DialogueSegment.index`; never parse `segmentId` | `null` |
| `personaProfileId` | Original `DialogueRequest.characterProfileId` | `null` |
| `personaProfileVersion` | Original `DialogueRequest.characterProfileVersion` | `null` |

M5 captures profile values before passing the request to M4 and retains index/attribution with registered output. Normal completion, cancellation and late receipts use those original values. The supporting delivery event stores separate `versions.personaProfileId` and `versions.personaProfileVersion` keys. Identity and version are not concatenated into a value that consumers must parse.

New M5 deliveries carry known values. Missing fields fail strict schema validation; a future M6 migration/read boundary must explicitly normalize genuinely unknown legacy values to null. It must never infer an index from an identifier or assign the current persona to old output. Reusing `(sessionId, turnId, segmentId, modality)` with a changed index, profile identity or version returns a delivery conflict and preserves the original history record. Existing classification and event acknowledgement rules remain unchanged.

## C7: persistence, projection and replay

M6 owns SQLite infrastructure, migrations and storage/history APIs; M4 owns memory semantics; M5 retains live authority. M5 constructs the supporting event and calls M6 `commitDeliveryWithEvent(delivery, event)` directly; only after a successful atomic acknowledgement does it call M4 memory admission. Commit delivery and its supporting event atomically before acknowledging persistence. Do not publish a different event with the same seq or commit spoken memory before persistence succeeds.

Event/delivery/sequence uniqueness is session-scoped. Identity reuse with changed content conflicts. Projections track applied seq and cannot claim current history across a gap. JSONL exports derive from committed records and must agree with them.

`confirmedHistory(sessionId)` returns one session in supporting-event `seq` ascending order, independent of insertion order. Reconstructing a turn uses its explicit `segmentIndex` values; identifier spelling and receipt arrival order do not establish emission order. Preserve `(sessionId, turnId)` when grouping records, and do not compare session-local sequence values globally. Unknown indices remain unknown. Multi-session selection and production reconstruction remain later #22 work.

Storage failure makes evidence incomplete and blocks new turns. Stop and local cancellation remain independent of pending storage calls. Replay is an isolated read view and cannot invoke live providers/rendering.

Production restart uses a new stopped session, restores confirmed history and keeps unresolved output unknown without replay. Fixtures do not prove durable SQLite recovery, migrations or crash consistency. Database/audio remain outside OneDrive; retention/deletion metrics remain pending.

## Browser transport and lifecycle

Application contracts use version 0.2. Existing `/diag` still serves diagnostic version 1 and rejects product commands; health application readiness remains null. Diagnostic success does not establish product transport support.

Use JSON control messages and shared receiving schemas. Bootstrap supplies sessionId, epoch, seq, lifecycle and output confirmation before the first console command. `wire.ts` defines acknowledgement envelopes; `validate.ts` converts between wire messages and port values and checks acknowledgement correlation. Duplicated envelope/payload identities must agree. Audio stays outside control JSON.

Trusted operator context comes from the transport boundary, never audience/model text or a self-reported payload role. Fixture attribution is not deployed authentication.

| Trigger | Required behavior |
| --- | --- |
| Startup | Stopped; no replay or implicit speech. |
| Authorized Resume | Require healthy storage and confirmed idle output; advance epoch; start only new work. |
| Authorized Stop | Revoke dispatch and advance epoch immediately; request cancellation; acknowledge without waiting for providers/player/database. Report confirmation separately. |
| Duplicate control | Recheck authority and identity; return stored acknowledgement without double epoch advancement. Different action with the same ID conflicts. |
| Late result | Reject new dispatch; release resources and retain relevant historical evidence. |
| Disconnect/uncertainty | Cancel local playback, show uncertainty and remain non-dispatching. |
| Reconnect | Receive a current snapshot first; no automatic replay/Resume. Full C-08 verification remains pending. |

Initial deployment is loopback-only; remote deployment requires a separate transport/control-security review.

## Acceptance and handoff

The [case registry](../req/case-registry.yaml) records current tests and pending cases. “Implemented” means its registered fixture assertions exist, not that the entire production scenario passed.

| Case | Purpose |
| --- | --- |
| C-01 | Normal ordered response and confirmed delivery |
| C-02 | Duplicate input/control |
| C-03 | Stop with genuinely late selection/dialogue/preparation/reaction |
| C-04 | Stop between segments and during second playback |
| C-05 | Decision timeout and speech continuation — full scenario pending |
| C-06 | Invalid/stale capability and no-op |
| C-07 | Untrusted content cannot grant control |
| C-08 | Snapshot-first reconnect — full scenario pending |
| C-09 | Synthesis failure/recovery — full scenario pending |
| C-10 | Duplicate/conflicting/unknown receipts |
| C-11 | Replaceable selection, synthesis and renderer fixtures |
| C-12 | Replay isolation |
| C-13 | Selected text and intent reach dialogue |
| C-14 | Invalid/expired plans and authoritative fallback |
| C-15 | Defer without polling; bounded attempts |
| C-16 | Intent quality and late fallback — full semantic evaluation pending |
| C-17 | Registered persistence/projection/recovery-boundary checks; durable SQLite remains future work |

Handoff includes task/requirement IDs, exact imports/variants, actual commands, positive/negative results, cancellation/failure behavior and remaining gaps. The consuming owner verifies the same contract revision; [role kits](READINESS-KITS.en.md) link replacement examples.

Before changing an interface, trace consumers and update implementations, examples and tests together. Application protocol `0.2` and diagnostic protocol `1` are unchanged; the internal storage revision above must be coordinated across producers, consumers and strict decoders, including draft SQLite adapters. Strict decoders need coordinated rollout even for optional fields. Breaking changes need a version/migration decision; this baseline is not permanently frozen.

## M5-01 implementation handoff

The [M5-01 handoff](HANDOFF-M5-01.en.md) documents the implemented coordinator, local configuration, event records and requested I1-01 reviews. The M5-01 increment originally kept C1–C7 unchanged. This Step A revision extends the C6/C7 storage record shapes as documented above; port call signatures remain unchanged. Application protocol 0.2 remains separate from diagnostic protocol 1. M1/M2/M3/M4/M6 retain their existing ownership; integrating their real modules is the next team checkpoint.
