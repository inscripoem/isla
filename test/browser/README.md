# M1-01 fixed-audio browser player demo (T14)

This directory holds an isolated, manual browser demonstration of the increment
B browser player. It is **not** part of the automated suite and it does not run
under `pnpm test`.

## What it demonstrates

- The real `createPlaybackController` with the real `createDomMediaDriver()`
  (`HTMLAudioElement`), not a fixture media driver.
- Two pre-generated fixed WAV Blobs (`assets/segment-0.wav`,
  `assets/segment-1.wav`) resolved from an explicit, registered ref map. The
  resolver never treats an `audio://` reference as a filename, URL or `src`.
- A local `AbortController` per execution and a single observer sender that
  records each receipt fact exactly once.
- Natural completion and Stop, with observable receipt events, player status
  (`idle`, `activeOutputId`, `lastStage`) and cleanup.

The "test renderer display" panel is intentionally separate from playback; the
player never invokes a renderer.

## Asset provenance

The WAV files are copies of the prepared fixed material recorded for M1-01
(Windows System.Speech.Synthesis, `Microsoft David Desktop`, en-US, rate 0,
volume 100). They are fixed assets, not a runtime TTS integration.

| File | Subtitles | SHA-256 |
| --- | --- | --- |
| `assets/segment-0.wav` | We talked about the concert. | `c758ea8bce12e75c670bada318d1a372984b5298fc706a8e275e5c7101c0b8b6` |
| `assets/segment-1.wav` | It was loud and fun. | `92a7f9e0ef8b47ad34cbe0ab7721d88cf5d313a99b1483a7f0a67ac72f5606e0` |

## Run it

From the repository root:

```sh
pnpm exec vite --config test/browser/vite.config.ts
```

The demo-local config binds `127.0.0.1` only, serves this directory as the root
and allows Vite to read the repository's browser-safe source imports. It leaves
the root Vite configuration unchanged. Open the printed local URL, then:

1. Select **Play segment 0** or **Play segment 1** to hear the fixed asset and
   observe `accepted` -> `started` -> `completed` receipts.
2. Select **Stop** during playback to observe a `cancelled` receipt after the
   local abort.
3. Select **Dispose** to prevent new admissions and attempt local cleanup.

## Observation limits

`playing`, `ended` and player status are **API observations**, not acoustic
measurements. This demo does not prove acoustic output or acoustic silence;
those require a separate physical observation. Start is evidenced only by an
actual media `playing` event, never by a fulfilled `play()` promise.

## M2-01 console demo (second entry point)

`console.html` is a separate manual entry for the M2-01 control console. Open
`http://127.0.0.1:<port>/console.html` after starting the same demo-local Vite
server. It mounts the real `ConsoleApp`, the real application transport logic
and the real browser playback controller; the only substitute is an explicit
in-page **fixture transport** that answers with the agreed v0.2 messages
(`input.ack`, `control.ack`, `session.snapshot`, `session.event`,
`performance.execute`, `performance.cancel`) instead of a runtime. No runtime,
provider or Node code takes part, and this page is never part of the production
entry.

What it demonstrates:

- Input dispatch with visible per-request outcomes: `accepted`, `duplicate`
  (submitting the same source/text twice) and `rejected` (any text starting with
  `reject`).
- Stop and Resume controls answered with `control.ack`, an epoch change and a
  `session.snapshot`.
- Playback receipts observed locally in the browser after Resume. The console
  has no player-to-runtime channel yet, so the receipts panel is labelled
  **local evidence only**; it never claims the runtime confirmed delivery.
- An honest non-dispatching state: the console only dispatches once a trusted
  bootstrap has arrived.

The fixture is an approved substitute for an unfinished runtime boundary. Passing
this demo is not evidence of live runtime integration.

## M2 formal product-console acceptance

`formal-console-acceptance.mjs` is a separate manual harness for the real root
entry, not the fixture demo. It drives `ConsoleApp` through the actual
application WebSocket and the actual M1 browser controller, and requires a
runtime deployment that serves the registered fixed audio resources through
`POST /audio`. Without that deployment a turn can be accepted but cannot reach
playback; the harness fails visibly instead of substituting playback.

Use a fresh runtime session database so the script can assert the initial
stopped, epoch-0, non-retiring snapshot. Start the runtime and root Vite entry,
then supply the Playwright module:

```sh
node test/browser/formal-console-acceptance.mjs \
  --playwright /path/to/playwright \
  --session <expected-session-id> \
  --output /tmp/isla-m2-formal-console
```

The harness covers two complete turns, Stop before and during playback, manual
Resume, duplicate and late frame replay, transport loss, reload without replay,
the first acknowledged recovery before retirement, successor adoption and a
final complete turn. It records screenshots plus `report.json` and
`summary.txt`. The observations are local browser/media and server-reported
facts; they are not acoustic, live-provider or Windows evidence, and they do not
replace a reviewer's acceptance decision.
