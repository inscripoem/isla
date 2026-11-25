# Speaking-mouth demo on Windows

Run this demo to make Hiyori open and close her mouth with Isla's speech. The companion reads the sound level for the dedicated browser process and watches playback receipts from the current runtime. A playing segment moves the mouth. Silence, natural completion and **Stop** close it. It works with the stock Hiyori artwork and the installed Kokoro English voices. Cubism Editor is optional.

## Set up the demo machine

Use the Node and pnpm versions supported by this checkout, 64-bit Windows, a Chromium-based browser, Python 3.10 or later and Steam's VTube Studio with the bundled Hiyori model. Open VTube Studio and enable its local plugin API on port 8001. Run the following from the repository root in PowerShell.

```powershell
pnpm install --frozen-lockfile
pnpm exec tsx test/live/kokoro-setup.ts

py -3 -m venv .cache/m1-speaking-windows
$python = (Resolve-Path .cache/m1-speaking-windows/Scripts/python.exe).Path
& $python -m pip install -r src/performance/lipsync/windows/requirements.txt
```

Kokoro setup downloads the pinned model on the first run. An existing compatible cache can be passed to the launcher with `--cache`. Python 3.13 was used for the Windows device checks.

In Steam, open **VTube Studio → Manage → Browse local files**. Paste that installation directory at the first prompt. The preparation command creates a separate model in the same library and generates local model and hotkey IDs. It keeps the original body animations and removes their mouth curves from the copy so they cannot hold the mouth shut during speech.

```powershell
$vts = Read-Host 'VTube Studio installation directory'
$models = Join-Path $vts 'VTube Studio_Data/StreamingAssets/Live2DModels'
$speaking = Join-Path $models 'isla_hiyori_speaking'
& $python src/performance/lipsync/prepare_speaking_model.py --source (Join-Path $models 'hiyori_vts') --dest $speaking
$manifest = Join-Path $speaking 'isla-speaking-model.json'
$token = Join-Path $env:LOCALAPPDATA 'isla-vts/isla-runtime-cs5351.token'
```

If the project is already paired with VTube Studio on this computer, point `$token` at the reference deployment's `ISLA_VTS_TOKEN_PATH`. On a new machine, create a private directory and run the following once. Select **Allow** in VTube Studio for **Isla Runtime / CS5351 Isla**. The command verifies the new token and saves it exclusively at the path you supplied. Keep that file on the demo machine.

```powershell
New-Item -ItemType Directory -Force (Split-Path -Parent $token) | Out-Null
node src/performance/lipsync/windows/pair-speaking-demo.mjs --pair-only --token-file $token
```

## Speak and stop

```powershell
node src/performance/lipsync/windows/start-speaking-demo.mjs --model-manifest $manifest --token-file $token --python $python
```

Use the Chromium window opened by the launcher. In **Session**, select **Attach performer**, **Bootstrap operator**, then **Resume**. Enter an English line and select **Submit input**. Let one sentence finish, then try **Stop** while a second sentence is playing. For example:

> Mama made five blue paper boats. Our friendly avatar is speaking now, and we can stop this second sentence halfway.

By default a local text service repeats the operator's input for the demonstration. Kokoro synthesizes it locally, the real browser plays it, and VTube Studio animates the model. Use `--live-text` with the reference deployment's configured text-service environment to use that provider. The speaker must use the Windows default playback endpoint and remain unmuted. The companion follows the dedicated browser, so another browser tab or a microphone is unnecessary.

Close the dedicated console window or press **Ctrl+C** in the launcher to stop the demo. Use `--help` for browser, model-cache and runtime options.

## What was checked

A Windows run exercised two segments through the formal console, real Kokoro playback, SQLite and the VTube Studio window. The first segment played to completion. The second received a cancelled receipt after Stop. In the recorded sample the mouth was visibly open immediately before the click and remained closed from roughly 81 ms afterwards. This is a single measured run. This mode follows the level of the voice; individual phoneme and teeth shapes are a separate feature.

The demo prepares assets from the operator's own copy of **Hiyori Momose**, a Live2D original character. This content uses sample data owned and copyrighted by Live2D Inc. [Hiyori sample](https://www.live2d.com/en/learn/sample/momose-hiyori/) · [Live2D sample terms and attribution](https://www.live2d.com/en/learn/sample/model-terms/)
