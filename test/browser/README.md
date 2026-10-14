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
