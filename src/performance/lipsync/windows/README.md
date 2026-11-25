# Speaking-mouth demo on Windows

Watch Hiyori speak in VTube Studio while you operate Isla from the dedicated browser. During synthesis, Isla measures Kokoro's audio in 20 ms windows. The mouth follows the RMS level at the player's current position. A pause in the audio, the end of a sentence or **Stop** closes the mouth. The demo uses the bundled Hiyori artwork and locally installed Kokoro English voices.

## Set up the demo machine

Use the Node and pnpm versions supported by this checkout, a Chromium-based browser and VTube Studio with the bundled Hiyori model. The one-time model preparation script uses Python 3.10 or later and its standard library. If the speaking model and manifest are already installed, reuse them. The following commands are for PowerShell on Windows.

```powershell
pnpm install --frozen-lockfile
pnpm exec tsx test/live/kokoro-setup.ts
```

Kokoro setup downloads the pinned model on the first run. Pass an existing compatible cache with `--cache`. Start VTube Studio and enable its local plugin API on port 8001.

In Steam, open **VTube Studio → Manage → Browse local files**. Paste that installation directory at the first prompt. The preparation command creates a separate model in the same library and generates local model and hotkey IDs. It keeps the original body animations and removes their mouth curves from the copy so they cannot hold the mouth shut during speech.

```powershell
$vts = Read-Host 'VTube Studio installation directory'
$models = Join-Path $vts 'VTube Studio_Data/StreamingAssets/Live2DModels'
$speaking = Join-Path $models 'isla_hiyori_speaking'
py -3 src/performance/lipsync/prepare_speaking_model.py --source (Join-Path $models 'hiyori_vts') --dest $speaking
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
node src/performance/lipsync/windows/start-speaking-demo.mjs --model-manifest $manifest --token-file $token
```

Use the Chromium window opened by the launcher. In the control deck, select **Attach performer**, **Bootstrap operator**, then **Resume**. Enter an English line and select **Submit input**. To try **Stop** during the second sentence, enter both sentences together.

> Mama made five blue paper boats. Our friendly avatar is speaking now, and we can stop this second sentence halfway.

By default a local text service repeats the operator's input. Kokoro synthesizes it locally, the browser plays it, and VTube Studio animates the model. Use `--live-text` with the reference deployment's configured text-service environment to use that provider.

Close the dedicated console window or press **Ctrl+C** in the launcher to stop the demo. Use `--help` for browser, model-cache and runtime options.

### Optional Windows render-session meter

The default `--mouth-source envelope` runs in Node and the browser. To reproduce the earlier Windows meter demo, install its audio packages in a virtual environment and select `--mouth-source windows`.

```powershell
py -3 -m venv .cache/m1-speaking-windows
$python = (Resolve-Path .cache/m1-speaking-windows/Scripts/python.exe).Path
& $python -m pip install -r src/performance/lipsync/windows/requirements.txt
node src/performance/lipsync/windows/start-speaking-demo.mjs --mouth-source windows --model-manifest $manifest --token-file $token --python $python
```

## What was checked

The synthesis-envelope demo played two English sentences through the formal console, real Kokoro and VTube Studio on Windows. In the recorded run Hiyori visibly closed her mouth about 72 ms after a media pause and 123 ms after the operator clicked **Stop**. Both sentences showed visible movement. All six playback receipts matched SQLite.

The earlier Windows render-session meter was tested with two segments through the formal console, real Kokoro playback, SQLite and VTube Studio. In that recording the first segment completed and the mouth remained closed from about 81 ms after Stop in the second.

The demo prepares assets from the operator's own copy of **Hiyori Momose**, a Live2D original character. This content uses sample data owned and copyrighted by Live2D Inc. [Hiyori sample](https://www.live2d.com/en/learn/sample/momose-hiyori/) · [Live2D sample terms and attribution](https://www.live2d.com/en/learn/sample/model-terms/)
