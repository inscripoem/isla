# Supported platform and frozen functional scope

Status: **proposed record for [#108](https://github.com/inscripoem/isla/issues/108)** (checkpoint
[#76](https://github.com/inscripoem/isla/issues/76)). Owner: M5. The target machine and services are
expected to be confirmed by M1/M2; M6 accepts the platform/scope decision. This record does not claim
acceptance for any platform it does not name.

## 1. Regression baseline

`pnpm verify` on Linux (the CI `verify` job) is the regression baseline: typecheck, lint, every offline
suite and the production build. It requires no live provider, VTube Studio, Kokoro model or audio
device. The Node and pnpm versions are the ones pinned by the CI workflow and the lockfile. The
`test/live` entrypoints are a separate live suite: they are excluded from the root typecheck and from
`pnpm verify`, and need a standalone `tsc --noEmit` check and the pinned model (`src/performance/README.md`).

## 2. Live product target

The live target is the configuration observed in M1's Windows run at
[`9577069`](https://github.com/inscripoem/isla/commit/95770691cc927bb82d747024b6be193420648b21)
(squash of #167):

- Windows 11 build 26300 (AMD Ryzen 9 9950X3D target), headed Chromium 151.0.7922.34.
- LP-UNF output device; the run used the system default sink at 20% volume with mute off.
- VTube Studio 1.35.10 with the bundled `Hiyori_A` model
  (`00f9750080014d43bb398cd98e4f55ad`), the product plugin identity `Isla Runtime` / `CS5351 Isla`,
  and the three pinned `animation-1/2/3` hotkeys.
- Kokoro voice `af_heart`; the OpenAI-compatible `deepseek-flash` text source configured for the
  deployment. This is the deployment's configured provider; this record makes no quality claim about
  it.
- Stock `src/runtime/production-cli.ts` with
  `ISLA_DEPLOYMENT_MODULE=src/runtime/deployments/reference-live.ts`, a fresh SQLite database, and
  the real audio resource route.

Evidence: [M1 Windows live run](https://github.com/inscripoem/isla/issues/94#issuecomment-6918492119),
[M5 deployment confirmation](https://github.com/inscripoem/isla/issues/94#issuecomment-6919015872),
[M1 Windows deployment evidence](https://github.com/inscripoem/isla/issues/96#issuecomment-6920647994),
[six browser receipts](https://github.com/inscripoem/isla/issues/97#issuecomment-6918501769).

The CP04 checkpoint (#74) remains open; the dated deployment record is the `9577069` run.

**Merged after CP04.** Two changes postdate the run in this section and are not part of its evidence.
#189 (merged `3a54e6b`, 2026-11-24) sends three VTube Studio requests per hotkey and reports the
`play_not_allowed` / `play_failed` failure reasons. #190 (merged `2889136`, 2026-11-25) adds console
`voice.list`, `voice.preview` and `voice.select` for installed Kokoro voices and persists the selection
in `<databasePath>.voices.json`. Both are merged; #190's offline tests are
`test/offline/console-voice-selection.test.ts` and `test/offline/voice-settings.test.ts`. This record
contains no live run or named acceptance for either change.

## 3. Supported and not supported

Supported: the regression baseline in §1 and the live product target in §2. Since #190, installed
Kokoro voices can be listed, previewed and selected from the console; only `af_heart` was exercised in
the recorded run, so this record makes no quality or acoustic claim for another voice.

Not supported or claimed by this record: macOS live VTS/Kokoro; Windows builds other than build
26300; VTube Studio models other than `Hiyori_A`; browser output device enumeration beyond the sink used
in the recorded run; multi-host or multi-user deployment; any provider, model, platform or voice
without its own recorded live run.

## 4. Known limits

- Windows Git checkouts skip nine POSIX-only signal tests; the signal behaviour is exercised on Linux
  (#135).
- The run used the system default output sink; it does not establish `setSinkId` enumeration or a
  different device.
- VTS pairing requires the host operator to approve the plugin identity once; the authentication
  token is stored outside the repository through the local credential provider.
- The live observation is one controlled acceptance run. It is not a latency, throughput, scale or
  long-soak measurement.

## 5. Frozen functional scope

The CP04 live feature set is the merged reference deployment at `9577069`: live text
dialogue, deterministic rule selection/reaction, Kokoro synthesis, the audio resource route, the
VTS-backed renderer with the three pinned actions, operator Stop/cancellation, durable SQLite
persistence and recovery.

X01, X02, X03, X06, X07 and X08 are implemented and merged (#159, #163, #161, #157) but are not wired
into the reference deployment, so they add no live behavior to the CP04 scope. X06 is the default-off,
opt-in offline expression policy merged as `2a3f9d3`; the reference deployment continues to use its
existing renderer path. X04's `session_state` storage shipped in #157 (`d86dbc1`); its audience-level
seed remains deferred. X05 and X09 are deferred and outside the submission scope unless separately
approved. No new user-visible feature was planned at the CP04 freeze; the later #190 console
voice-selection change is recorded in §2 and is not covered by the `9577069` acceptance. After the
freeze, changes are limited to demonstrated defect fixes and evidence/documentation corrections.

## 6. Reproduction and acceptance

- Regression: `pnpm verify` on Linux.
- Live: the reference startup command in the repository README, with the target services and
  credentials supplied outside the repository.
- Acceptance: M1 confirms the target machine, VTS model and bindings; M2 confirms the
  console/browser half; M6 accepts this platform/scope record. This document does not claim those
  named confirmations.

## 7. Open items

- M1/M2 named confirmation of the declared target for #108.
- Any future platform or device must produce its own recorded live run; it is not covered by
  inheritance from this record.
