#!/usr/bin/env node
/*
 * Console voice selection — real browser acceptance for TA-004.
 *
 * This manual harness drives the real root Vite entry, the real product
 * `ConsoleApp`, the real application transport and the real browser player. It
 * never substitutes a console, transport or player. A separate test-only
 * deployment (`test/support/console-voice-selection-deployment.ts`) keeps the
 * default reference wiring for synthesis, audio resources, storage and session
 * identity, and replaces only the live text provider and the VTube Studio
 * renderer with deterministic local peers. Kokoro runs from local-only weights;
 * SQLite is the real runtime database.
 *
 * The script covers the normal operator path:
 *   1. list the installed English voices (at least Heart and Emma) and show the
 *      default active voice Heart;
 *   2. choose an uncommitted Emma as a viewer and confirm the active voice text
 *      and the server-selected voice both remain Heart;
 *   3. opt in with Bootstrap operator, preview Emma, observe real media
 *      playback, then click Stop preview during playback and observe the stop;
 *   4. confirm preview and Stop produce no official input, performance or
 *      delivery event;
 *   5. use Emma, require a matching server voice.state before accepting the
 *      active voice, and run a new formal turn;
 *   6. compare the formal turn's actual first-segment WAV with the baseline
 *      Heart turn. Both turns use the same deterministic reply text, so a
 *      different WAV hash is evidence that the selected voice reached synthesis.
 *
 * A second phase verifies restart persistence without faking a restart:
 *   phase 1 (before-restart) writes voice-selection-state.json after selecting
 *   Emma; the caller restarts the real runtime with the same SQLite database;
 *   phase 2 (after-restart) reads the state, requires the restarted server to
 *   report Emma, and requires a new formal turn's first-segment WAV hash to
 *   match the phase 1 Emma turn.
 *
 * ---------------------------------------------------------------------------
 * Prerequisites (started separately; real processes)
 *
 * 1. A runtime process using the test-only deployment and a real local Kokoro
 *    model directory. The text-provider and VTS values below are parse-only:
 *    the deployment substitutes those peers and never calls them. Use the same
 *    ISLA_STORAGE_DB_PATH after the restart.
 *
 *      ISLA_DEPLOYMENT_MODULE=test/support/console-voice-selection-deployment.ts \
 *      ISLA_STORAGE_DB_PATH=/path/to/voice-selection.sqlite \
 *      ISLA_KOKORO_MODEL_DIR=/path/to/Kokoro-82M-v1.0-ONNX \
 *      ISLA_ALLOWED_ORIGINS=http://127.0.0.1:5173 \
 *      ISLA_LIVE_TEXT_BASE_URL=http://127.0.0.1:9 \
 *      ISLA_LIVE_TEXT_MODEL=local-substitute \
 *      ISLA_LIVE_TEXT_API_KEY=parse-only \
 *      ISLA_VTS_WS_URL=ws://127.0.0.1:9 \
 *      ISLA_VTS_PLUGIN_NAME=parse-only \
 *      ISLA_VTS_PLUGIN_DEVELOPER=parse-only \
 *      ISLA_VTS_TOKEN_PATH=/path/to/unused-vts-token \
 *      ISLA_VTS_HOTKEY_MAP='{"animation-1":"hotkey-1","animation-2":"hotkey-2","animation-3":"hotkey-3"}' \
 *      pnpm exec tsx src/runtime/production-cli.ts
 *
 *    The runtime listens on 127.0.0.1:4317 by default. Its "listening" log line
 *    includes the session id.
 *
 * 2. The root Vite entry on 127.0.0.1:5173:
 *
 *      pnpm dev
 *
 * 3. A Playwright module and Chromium, supplied externally:
 *
 *      --playwright <path> | ISLA_PLAYWRIGHT_MODULE
 *      --chromium <path>   | ISLA_CHROMIUM_EXECUTABLE
 *
 * Run phase 1 (fresh database):
 *
 *   node test/browser/console-voice-selection.mjs \
 *     --playwright /path/to/playwright \
 *     --output /tmp/isla-console-voice-selection
 *
 * The adopted voice is persisted beside the database as
 * `<ISLA_STORAGE_DB_PATH>.voices.json`; keep both files for phase 2.
 *
 * Restart the runtime with the same ISLA_STORAGE_DB_PATH, keep Vite running,
 * then run phase 2:
 *
 *   node test/browser/console-voice-selection.mjs \
 *     --phase after-restart \
 *     --state /tmp/isla-console-voice-selection/voice-selection-state.json \
 *     --playwright /path/to/playwright \
 *     --output /tmp/isla-console-voice-selection/after-restart
 *
 * The examples use POSIX environment syntax; on PowerShell set the same names
 * with `$env:NAME = 'value'`. The default output directory is already under the
 * OS temp directory.
 *
 * Expectations:
 *   - the Voice combobox lists Heart and Emma and the active voice text starts
 *     at "Current voice: Heart";
 *   - a viewer draft of Emma leaves the active voice at Heart and the Use
 *     control disabled;
 *   - Bootstrap operator is required before Preview voice and Use this voice;
 *   - Preview voice plays a nonempty RIFF/WAVE sample for Emma; Stop preview
 *     during playback produces a media terminal event and no official input,
 *     performance.execute or delivery.committed event;
 *   - Use this voice is confirmed by a voice.state whose requestMessageId
 *     matches the request and whose selectedVoiceId is Emma;
 *   - a new formal turn completes with two segments, commits one delivery, and
 *     its first-segment WAV hash differs from the baseline Heart turn while its
 *     subtitle text is identical;
 *   - after a real runtime restart with the same database, the server still
 *     reports Emma and a new formal turn's first-segment WAV hash equals the
 *     phase 1 Emma turn.
 *
 * What this does not prove: acoustic identity, a live text provider, a VTube
 * Studio avatar, physical silence, or a production deployment. The renderer and
 * text source are explicit local substitutes; playback observations are browser
 * media events, not acoustic measurements. The harness never records the
 * one-time operator token or a complete audio blob; reports contain only voice
 * ids, WAV metadata and SHA-256 hashes.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

const HEART_NAME = 'Heart'
const EMMA_NAME = 'Emma'
const STATE_FILE_NAME = 'voice-selection-state.json'
const BASELINE_INPUT = 'Voice selection baseline turn.'
const SELECTED_INPUT = 'Voice selection selected-voice turn.'
const RESTART_INPUT = 'Voice selection post-restart turn.'

function parseArgs(argv) {
  const options = {
    url: process.env.ISLA_VOICE_SELECTION_URL ?? 'http://127.0.0.1:5173/',
    output: process.env.ISLA_VOICE_SELECTION_OUTPUT ?? null,
    state: process.env.ISLA_VOICE_SELECTION_STATE ?? null,
    phase: process.env.ISLA_VOICE_SELECTION_PHASE ?? 'before-restart',
    playwright:
      process.env.ISLA_VOICE_SELECTION_PLAYWRIGHT ??
      process.env.ISLA_PLAYWRIGHT_MODULE ??
      process.env.ISLA_PLAYWRIGHT_PATH ??
      null,
    chromium:
      process.env.ISLA_VOICE_SELECTION_CHROMIUM ??
      process.env.ISLA_CHROMIUM_EXECUTABLE ??
      process.env.ISLA_CHROMIUM_PATH ??
      null,
    headless: process.env.ISLA_VOICE_SELECTION_HEADED !== '1',
    sandbox: process.env.ISLA_VOICE_SELECTION_SANDBOX === '1',
    timeoutMs: Number(process.env.ISLA_VOICE_SELECTION_TIMEOUT_MS ?? 60000),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${argument}`)
      return argv[index]
    }
    if (argument === '--url') options.url = next()
    else if (argument === '--output') options.output = next()
    else if (argument === '--state') options.state = next()
    else if (argument === '--phase') options.phase = next()
    else if (argument === '--playwright') options.playwright = next()
    else if (argument === '--chromium') options.chromium = next()
    else if (argument === '--timeout') options.timeoutMs = Number(next())
    else if (argument === '--headed') options.headless = false
    else if (argument === '--sandbox') options.sandbox = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

const HELP = `Console voice selection browser acceptance

Usage:
  node test/browser/console-voice-selection.mjs --playwright <path> [options]

Options:
  --url <url>          Console URL (env ISLA_VOICE_SELECTION_URL; default http://127.0.0.1:5173/)
  --output <dir>       Artifact directory (env ISLA_VOICE_SELECTION_OUTPUT; default a temp directory)
  --state <file>       Two-phase state file (env ISLA_VOICE_SELECTION_STATE; default <output>/${STATE_FILE_NAME})
  --phase <name>       before-restart (default) or after-restart
  --playwright <path>  Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
  --chromium <path>    Chromium executable (env ISLA_CHROMIUM_EXECUTABLE)
  --timeout <ms>       Per-observation timeout (env ISLA_VOICE_SELECTION_TIMEOUT_MS; default 60000)
  --headed             Run headed (env ISLA_VOICE_SELECTION_HEADED=1)
  --sandbox            Keep Chromium's sandbox (default off)
  --help               Show this help
`

function loadPlaywright(modulePath) {
  if (modulePath !== null) return require(modulePath)
  try {
    return require('playwright')
  } catch (error) {
    throw new Error(
      'playwright was not found; install it in this project or set ISLA_PLAYWRIGHT_MODULE to the Playwright package directory',
      { cause: error },
    )
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function activeVoicePattern(name) {
  return new RegExp(`Current voice\\s*:?\\s*${escapeRegExp(name)}\\b`, 'i')
}

function summarizeWavBuffer(buffer) {
  const bytes = buffer
  const result = {
    bytes: bytes.byteLength,
    riff: false,
    wav: false,
    format: null,
    dataBytes: null,
    durationMs: null,
  }
  if (bytes.byteLength < 12) return result
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
  result.riff = tag(0) === 'RIFF'
  result.wav = result.riff && tag(8) === 'WAVE'
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const chunk = tag(offset)
    const size = view.getUint32(offset + 4, true)
    if (chunk === 'fmt ' && offset + 24 <= bytes.byteLength) {
      result.format = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        byteRate: view.getUint32(offset + 16, true),
        blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      }
    }
    if (chunk === 'data') {
      result.dataBytes = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (
    result.format !== null &&
    result.format.sampleRate > 0 &&
    result.format.channels > 0 &&
    result.format.bitsPerSample > 0 &&
    typeof result.dataBytes === 'number'
  ) {
    const frameBytes = (result.format.bitsPerSample / 8) * result.format.channels
    result.durationMs = Math.round((result.dataBytes / frameBytes / result.format.sampleRate) * 1000)
  }
  return result
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(HELP)
  process.exit(0)
}
if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
  throw new Error(`invalid timeout: ${options.timeoutMs}`)
}
if (options.phase !== 'before-restart' && options.phase !== 'after-restart') {
  throw new Error(`invalid phase: ${options.phase}; expected before-restart or after-restart`)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const outDir = options.output === null
  ? path.join(tmpdir(), 'isla-console-voice-selection', stamp)
  : path.resolve(options.output)
const statePath = options.state === null
  ? path.join(outDir, STATE_FILE_NAME)
  : path.resolve(options.state)
await mkdir(outDir, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  phase: options.phase,
  base: options.url,
  statePath,
  steps: [],
  checks: [],
  errors: [],
  verdict: 'failed',
}

const checks = []
function check(name, condition, detail = '') {
  const ok = Boolean(condition)
  checks.push({ name, ok, detail })
  if (!ok) throw new Error(detail.length > 0 ? `${name}: ${detail}` : name)
}

function note(label, detail = null) {
  const entry = { label, at: new Date().toISOString() }
  if (detail !== null) entry.detail = detail
  report.steps.push(entry)
}

function countDeliveries(events) {
  return events.filter(
    (entry) => entry.kind === 'session.event' && entry.type === 'delivery.committed',
  ).length
}

function voiceByName(state, name) {
  const voices = state?.payload?.voices
  if (!Array.isArray(voices)) return undefined
  return voices.find(
    (entry) => typeof entry.name === 'string' && entry.name.toLowerCase() === name.toLowerCase(),
  )
}

function uniqueServedRefs(audio) {
  return new Set(
    audio
      .filter((entry) => entry.status === 200 && typeof entry.sha256 === 'string')
      .map((entry) => entry.ref),
  )
}

const { chromium } = loadPlaywright(options.playwright)
const browser = await chromium.launch({
  headless: options.headless,
  sandbox: options.sandbox,
  executablePath: options.chromium ?? undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 2200 } })
page.setDefaultTimeout(options.timeoutMs)
page.on('pageerror', (error) => report.errors.push(`pageerror: ${String(error)}`))
page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = message.text()
  if (text.includes('favicon')) return
  report.errors.push(`console.error: ${text}`)
})

const audioCaptures = []
const audioCapturePromises = []
page.on('response', (response) => {
  const request = response.request()
  if (request.method() !== 'POST') return
  let url
  try {
    url = new URL(response.url())
  } catch {
    return
  }
  if (url.pathname !== '/audio') return
  const ref = url.searchParams.get('ref')
  if (ref === null) return
  const status = response.status()
  const contentType = response.headers()['content-type'] ?? null
  const promise = response.body().then(
    (buffer) => {
      const entry = {
        ref,
        status,
        contentType,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        ...summarizeWavBuffer(buffer),
      }
      audioCaptures.push(entry)
      return entry
    },
    (error) => {
      const entry = {
        ref,
        status,
        contentType,
        error: error instanceof Error ? error.message : String(error),
      }
      audioCaptures.push(entry)
      return entry
    },
  )
  audioCapturePromises.push(promise)
})

await page.addInitScript(() => {
  const store = {
    sends: [],
    inbound: [],
    samples: [],
    media: [],
    activeMedia: [],
    stop: {
      armed: false,
      clicked: false,
      clickedAt: null,
      playingObserved: false,
      endedBeforeStop: false,
      timedOut: false,
    },
  }
  window.__islaVoiceSelection = store

  const observedElements = new WeakSet()
  const clickStopPreview = () => {
    const state = store.stop
    if (!state.armed || state.clicked) return
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Stop preview',
    )
    if (button !== undefined && !button.disabled) {
      state.armed = false
      state.clicked = true
      state.clickedAt = performance.now()
      button.click()
      return
    }
    requestAnimationFrame(clickStopPreview)
  }

  const observeElement = (element) => {
    if (observedElements.has(element)) return
    observedElements.add(element)
    const record = (type) => {
      store.media.push({ type, at: performance.now() })
      if (type === 'playing') {
        if (!store.activeMedia.includes(element)) store.activeMedia.push(element)
        store.stop.playingObserved = true
        clickStopPreview()
      } else if (['pause', 'ended', 'emptied', 'abort', 'error'].includes(type)) {
        store.activeMedia = store.activeMedia.filter((entry) => entry !== element)
        if (type === 'ended' && !store.stop.clicked) {
          store.stop.endedBeforeStop = true
          store.stop.armed = false
        }
      }
    }
    for (const type of ['playing', 'pause', 'ended', 'emptied', 'abort', 'error']) {
      element.addEventListener(type, () => record(type))
    }
  }

  const originalPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...args) {
    observeElement(this)
    return originalPlay.apply(this, args)
  }

  const OriginalWebSocket = window.WebSocket
  window.WebSocket = function IslaVoiceSelectionWebSocket(...args) {
    const socket = new OriginalWebSocket(...args)
    if (!String(args[0] ?? '').includes('/app')) return socket
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message?.kind === 'voice.sample') {
        const payload = message.payload ?? {}
        void summarizeSample(payload.wavBase64 ?? '').then((summary) => {
          store.samples.push({
            messageId: typeof message.messageId === 'string' ? message.messageId : null,
            requestMessageId:
              typeof payload.requestMessageId === 'string' ? payload.requestMessageId : null,
            voiceId: typeof payload.voiceId === 'string' ? payload.voiceId : null,
            ...summary,
          })
        })
        return
      }
      store.inbound.push(safeInbound(message))
    })
    const originalSend = socket.send.bind(socket)
    socket.send = function islaVoiceSelectionSend(data) {
      try {
        store.sends.push(safeOutbound(JSON.parse(String(data))))
      } catch {
        store.sends.push({ kind: null, at: performance.now() })
      }
      return originalSend(data)
    }
    return socket
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    window.WebSocket[key] = OriginalWebSocket[key]
  }
  window.WebSocket.prototype = OriginalWebSocket.prototype

  function envelope(message) {
    return {
      kind: typeof message?.kind === 'string' ? message.kind : null,
      messageId: typeof message?.messageId === 'string' ? message.messageId : null,
      sessionId: typeof message?.sessionId === 'string' ? message.sessionId : null,
      epoch: typeof message?.epoch === 'number' ? message.epoch : null,
      at: performance.now(),
    }
  }

  function safeOutbound(message) {
    const entry = envelope(message)
    if (entry.kind === 'operator.bootstrap') {
      // The one-time token is deliberately never retained.
      return entry
    }
    const payload = message.payload
    if (typeof payload === 'object' && payload !== null) entry.payload = { ...payload }
    return entry
  }

  function safeInbound(message) {
    const entry = envelope(message)
    const payload = message.payload
    if (entry.kind === 'session.event') {
      entry.seq = typeof payload?.seq === 'number' ? payload.seq : null
      entry.type = typeof payload?.type === 'string' ? payload.type : null
      return entry
    }
    if (entry.kind === 'session.snapshot') {
      entry.lifecycle = typeof payload?.lifecycle === 'string' ? payload.lifecycle : null
      return entry
    }
    // voice.sample is handled before this function so its base64 never lands
    // here. Every other v0.2 server payload is small metadata; a shallow copy
    // keeps correlations and voice objects without retaining audio bytes.
    if (typeof payload === 'object' && payload !== null) entry.payload = { ...payload }
    return entry
  }

  async function summarizeSample(base64) {
    if (typeof base64 !== 'string' || base64.length === 0) {
      return { bytes: 0, wav: false, sha256: null }
    }
    let bytes
    try {
      const binary = atob(base64)
      bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
    } catch {
      return { bytes: 0, wav: false, sha256: null }
    }
    const tag = (offset) =>
      String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const wav = bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE'
    let sha256 = null
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      sha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')
    } catch {
      // The hash is optional evidence; the sample bytes and playback still count.
    }
    return { bytes: bytes.length, wav, sha256 }
  }

  store.armStopOnPlaying = () => {
    store.stop = {
      armed: true,
      clicked: false,
      clickedAt: null,
      playingObserved: false,
      endedBeforeStop: false,
      timedOut: false,
    }
    setTimeout(() => {
      if (store.stop.armed) {
        store.stop.armed = false
        store.stop.timedOut = true
      }
    }, 5000)
  }

  store.mediaPlaying = () =>
    store.activeMedia.filter((element) => !element.paused && !element.ended).length
})

async function waitUntil(read, predicate, timeout, label) {
  const deadline = Date.now() + timeout
  let last = null
  for (;;) {
    try {
      last = await read()
      if (predicate(last)) return last
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last observation: ${JSON.stringify(last)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

async function pageText() {
  return page.evaluate(() => document.body?.innerText ?? '')
}

async function waitForBodyText(pattern, label, timeout = options.timeoutMs) {
  await waitUntil(() => pageText(), (text) => pattern.test(text), timeout, label)
}

async function fact(label) {
  return page.evaluate((wanted) => {
    for (const element of Array.from(document.querySelectorAll('dl.facts dt'))) {
      if (element.textContent?.trim() === wanted) {
        return element.nextElementSibling?.textContent?.trim() ?? null
      }
    }
    return null
  }, label)
}

async function facts() {
  return {
    session: await fact('Session'),
    lifecycle: await fact('Lifecycle'),
    idle: await fact('Idle'),
    lastStage: await fact('Last stage'),
  }
}

async function readSends(kind) {
  return page.evaluate((wanted) => {
    const entries = window.__islaVoiceSelection?.sends ?? []
    return entries.filter((entry) => wanted === null || entry.kind === wanted)
  }, kind)
}

async function readInbound(kind) {
  return page.evaluate((wanted) => {
    const entries = window.__islaVoiceSelection?.inbound ?? []
    return entries.filter((entry) => wanted === null || entry.kind === wanted)
  }, kind)
}

async function readSamples() {
  return page.evaluate(() => window.__islaVoiceSelection?.samples ?? [])
}

async function readMedia() {
  return page.evaluate(() => window.__islaVoiceSelection?.media ?? [])
}

async function readStopState() {
  return page.evaluate(() => ({ ...(window.__islaVoiceSelection?.stop ?? {}) }))
}

async function readMediaPlaying() {
  return page.evaluate(() => window.__islaVoiceSelection?.mediaPlaying?.() ?? 0)
}

async function latestVoiceState() {
  const states = await readInbound('voice.state')
  return states.at(-1) ?? null
}

async function waitForInitialVoiceState() {
  const state = await waitUntil(
    () => latestVoiceState(),
    (value) => value !== null && Array.isArray(value.payload?.voices),
    options.timeoutMs,
    'the console voice list reply (voice.list/voice.state)',
  )
  const listSends = await readSends('voice.list')
  if (listSends.length === 0) {
    throw new Error('the console did not send voice.list; the voice picker may not be wired')
  }
  return state
}

async function waitForMatchingVoiceState(requestMessageId) {
  const states = await waitUntil(
    () => readInbound('voice.state'),
    (entries) => entries.some((entry) => entry.payload?.requestMessageId === requestMessageId),
    options.timeoutMs,
    `a voice.state for request ${requestMessageId}`,
  )
  return states.find((entry) => entry.payload?.requestMessageId === requestMessageId)
}

async function waitForNewSample(requestMessageId) {
  const samples = await waitUntil(
    () => readSamples(),
    (entries) => entries.some((entry) => entry.requestMessageId === requestMessageId),
    options.timeoutMs,
    `a voice.sample for request ${requestMessageId}`,
  )
  return samples.find((entry) => entry.requestMessageId === requestMessageId)
}

async function waitForConnectionOpen() {
  await page.waitForFunction(
    () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'open',
    undefined,
    { timeout: options.timeoutMs },
  )
  await waitUntil(
    () => fact('Session'),
    (value) => value !== null && value !== 'unknown',
    options.timeoutMs,
    'a session snapshot',
  )
}

async function attachAndBootstrap() {
  await page.getByRole('button', { name: 'Attach performer', exact: true }).click()
  await waitUntil(
    () => fact('Performer attached'),
    (value) => value === 'yes',
    options.timeoutMs,
    'performer attached',
  )
  // While the connection is a viewer, the product renders the same bootstrap
  // action in the Voice card and in the Performer and authority card.
  await page
    .getByRole('button', { name: 'Bootstrap operator', exact: true })
    .first()
    .click()
  await waitUntil(
    () => fact('Operator authority'),
    (value) => value === 'yes',
    options.timeoutMs,
    'operator authority',
  )
}

async function resumeSession() {
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await waitUntil(
    () => fact('Lifecycle'),
    (value) => value === 'running',
    options.timeoutMs,
    'running lifecycle',
  )
}

async function readVoiceOptions() {
  const combo = page.getByRole('combobox', { name: 'Voice', exact: true })
  await combo.waitFor({ state: 'visible' })
  const options = await combo.locator('option').evaluateAll((entries) =>
    entries.map((entry) => ({
      value: entry.value,
      label: entry.textContent?.trim() ?? '',
      disabled: entry.disabled,
    })),
  )
  return options
}

function optionIncludes(options, name) {
  return options.some((option) => option.label.toLowerCase().includes(name.toLowerCase()))
}

async function selectVoice(name) {
  const combo = page.getByRole('combobox', { name: 'Voice', exact: true })
  await combo.waitFor({ state: 'visible' })
  const options = await readVoiceOptions()
  const option = options.find(
    (entry) => !entry.disabled && entry.label.toLowerCase().includes(name.toLowerCase()),
  )
  if (option === undefined) throw new Error(`the Voice combobox has no enabled option containing ${name}`)
  await combo.selectOption(option.value)
}

function voiceUseButton() {
  return page.getByRole('button', { name: 'Use this voice', exact: true })
}

function voicePreviewButton() {
  return page.getByRole('button', { name: 'Preview voice', exact: true })
}

async function waitForEnabled(locator, label, timeout = options.timeoutMs) {
  await waitUntil(() => locator.isEnabled(), (enabled) => enabled === true, timeout, label)
}

async function runFormalTurn(label, text) {
  if ((await fact('Lifecycle')) !== 'running') await resumeSession()
  const beforeInputs = (await readSends('input.submit')).length
  const beforeExecutes = (await readInbound('performance.execute')).length
  const beforeDeliveries = countDeliveries(await readInbound('session.event'))
  const beforeAudio = audioCaptures.length
  const beforePending = audioCapturePromises.length

  await page.locator('#console-text').fill(text)
  await page.getByRole('button', { name: 'Submit input', exact: true }).click()
  const sends = await waitUntil(
    () => readSends('input.submit'),
    (entries) => entries.length > beforeInputs,
    options.timeoutMs,
    `an input.submit for ${label}`,
  )
  const input = sends.at(-1)
  check(`${label}: input was submitted`, input.payload?.text === text, JSON.stringify(input.payload))
  const acks = await waitUntil(
    () => readInbound('input.ack'),
    (entries) => entries.some((entry) => entry.payload?.requestMessageId === input.messageId),
    options.timeoutMs,
    `an input acknowledgement for ${label}`,
  )
  const ack = acks.find((entry) => entry.payload?.requestMessageId === input.messageId)
  check(`${label}: input was accepted`, ack.payload?.status === 'accepted', JSON.stringify(ack.payload))
  await waitUntil(
    () => readInbound('performance.execute'),
    (entries) => entries.length >= beforeExecutes + 2,
    options.timeoutMs,
    `two performance.execute frames for ${label}`,
  )
  await waitUntil(
    () => readInbound('session.event'),
    (entries) => countDeliveries(entries) >= beforeDeliveries + 1,
    options.timeoutMs,
    `a delivery.committed event for ${label}`,
  )
  await waitUntil(
    () => facts(),
    (current) => current.lastStage === 'completed' && current.idle === 'true',
    options.timeoutMs,
    `completed playback for ${label}`,
  )
  await waitUntil(
    () => audioCaptures.length,
    (count) => count >= beforeAudio + 2,
    options.timeoutMs,
    `two audio responses for ${label}`,
  )
  await Promise.allSettled(audioCapturePromises.slice(beforePending))

  const executes = (await readInbound('performance.execute')).slice(beforeExecutes)
  const audio = audioCaptures.slice(beforeAudio)
  const first = executes[0]
  const firstAudio = audio.find(
    (entry) => entry.ref === first.payload?.audioRef && entry.status === 200 && typeof entry.sha256 === 'string',
  )
  check(
    `${label}: first segment audio was served`,
    firstAudio !== undefined && firstAudio.wav === true && firstAudio.format?.sampleRate > 0,
    JSON.stringify(audio.map(({ ref, status, bytes }) => ({ ref, status, bytes }))),
  )
  const delivered = countDeliveries(await readInbound('session.event')) - beforeDeliveries
  check(`${label}: one delivery committed`, delivered === 1, `observed ${delivered}`)
  note(`${label} completed`, {
    firstSubtitle: first.payload?.subtitleText,
    firstWavSha256: firstAudio.sha256,
    firstWavBytes: firstAudio.bytes,
    executeCount: executes.length,
    audioResponseCount: audio.length,
    deliveryDelta: delivered,
  })
  return { input, ack, executes, audio, first, firstAudio, delivered }
}

async function screenshot(name) {
  try {
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
  } catch (error) {
    note(`screenshot ${name} unavailable`, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function beforeRestartFlow() {
  await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  await waitForConnectionOpen()
  const initial = await waitForInitialVoiceState()
  const heart = voiceByName(initial, HEART_NAME)
  const emma = voiceByName(initial, EMMA_NAME)
  check('the installed voice list includes Heart', heart !== undefined, JSON.stringify(initial.payload.voices))
  check('the installed voice list includes Emma', emma !== undefined, JSON.stringify(initial.payload.voices))
  check(
    'the initial server-selected voice is Heart',
    initial.payload.selectedVoiceId === heart.id,
    `selectedVoiceId=${String(initial.payload.selectedVoiceId)}`,
  )
  await waitForBodyText(activeVoicePattern(HEART_NAME), 'the initial active voice text Heart')
  const voiceOptions = await readVoiceOptions()
  check('the Voice combobox lists Heart', optionIncludes(voiceOptions, HEART_NAME), JSON.stringify(voiceOptions))
  check('the Voice combobox lists Emma', optionIncludes(voiceOptions, EMMA_NAME), JSON.stringify(voiceOptions))
  note('initial voice state', {
    sessionId: await fact('Session'),
    selectedVoiceId: initial.payload.selectedVoiceId,
    voices: initial.payload.voices,
  })
  await screenshot('01-initial')

  const viewerSelectsBefore = (await readSends('voice.select')).length
  await selectVoice(EMMA_NAME)
  await page.waitForTimeout(200)
  await waitForBodyText(activeVoicePattern(HEART_NAME), 'the active voice text Heart after the viewer draft')
  const viewerUse = voiceUseButton()
  const viewerUseVisible = (await viewerUse.count()) > 0
  const viewerUseDisabled = viewerUseVisible ? await viewerUse.isDisabled() : null
  const viewerStates = await readInbound('voice.state')
  const viewerState = viewerStates.at(-1) ?? initial
  check(
    'the viewer draft did not change the server-selected voice',
    viewerState.payload.selectedVoiceId === initial.payload.selectedVoiceId,
    `before=${String(initial.payload.selectedVoiceId)} after=${String(viewerState.payload.selectedVoiceId)}`,
  )
  check(
    'the viewer draft did not send voice.select',
    (await readSends('voice.select')).length === viewerSelectsBefore,
  )
  check('the viewer sees the Use this voice control', viewerUseVisible)
  check('the viewer cannot use this voice', viewerUseDisabled === true, `disabled=${String(viewerUseDisabled)}`)
  note('viewer draft', { draft: EMMA_NAME, active: HEART_NAME, useDisabled: viewerUseDisabled })
  await screenshot('02-viewer-draft')

  await attachAndBootstrap()
  // Resume changes the session epoch, so the console refreshes its voice list
  // and resets the local draft to the server-selected voice. Wait for that
  // refresh before choosing the operator's preview candidate again.
  const listSendsBeforeResume = (await readSends('voice.list')).length
  await resumeSession()
  const listSendsAfterResume = await waitUntil(
    () => readSends('voice.list'),
    (entries) => entries.length > listSendsBeforeResume,
    options.timeoutMs,
    'a voice.list refresh after Resume',
  )
  const refreshedList = listSendsAfterResume.at(-1)
  await waitForMatchingVoiceState(refreshedList.messageId)
  await waitForBodyText(activeVoicePattern(HEART_NAME), 'the active voice text Heart after Resume')
  const afterOperatorState = await latestVoiceState()
  check(
    'operator opt-in and Resume did not change the active voice',
    afterOperatorState.payload.selectedVoiceId === initial.payload.selectedVoiceId,
    `before=${String(initial.payload.selectedVoiceId)} after=${String(afterOperatorState.payload.selectedVoiceId)}`,
  )
  await selectVoice(EMMA_NAME)
  await page.waitForTimeout(150)
  await waitForBodyText(activeVoicePattern(HEART_NAME), 'the active voice text Heart after the operator draft')

  const baseline = await runFormalTurn('baseline Heart turn', BASELINE_INPUT)
  await screenshot('03-baseline-turn')

  const previewBefore = {
    inputs: (await readSends('input.submit')).length,
    executes: (await readInbound('performance.execute')).length,
    deliveries: countDeliveries(await readInbound('session.event')),
  }
  const activeBeforePreview = (await latestVoiceState()).payload.selectedVoiceId
  await page.evaluate(() => window.__islaVoiceSelection.armStopOnPlaying())
  await waitForEnabled(voicePreviewButton(), 'the Preview voice control')
  const previewSendsBefore = (await readSends('voice.preview')).length
  await voicePreviewButton().click()
  const previewSends = await waitUntil(
    () => readSends('voice.preview'),
    (entries) => entries.length > previewSendsBefore,
    options.timeoutMs,
    'a voice.preview request',
  )
  const previewRequest = previewSends.at(-1)
  check(
    'the preview request targets Emma',
    previewRequest.payload?.voiceId === emma.id,
    `voiceId=${String(previewRequest.payload?.voiceId)}`,
  )
  const sample = await waitForNewSample(previewRequest.messageId)
  check('the preview sample is for Emma', sample.voiceId === emma.id, `voiceId=${String(sample.voiceId)}`)
  check('the preview sample is a nonempty WAV', sample.bytes > 0 && sample.wav === true, JSON.stringify(sample))
  const stopState = await waitUntil(
    () => readStopState(),
    (value) => value.clicked === true || value.endedBeforeStop === true || value.timedOut === true,
    options.timeoutMs,
    'the preview playback outcome',
  )
  check('the preview started playing', stopState.playingObserved === true, JSON.stringify(stopState))
  check('Stop preview was clicked during playback', stopState.clicked === true, JSON.stringify(stopState))
  check('the preview did not end before Stop preview', stopState.endedBeforeStop !== true, JSON.stringify(stopState))
  await waitUntil(() => readMediaPlaying(), (count) => count === 0, options.timeoutMs, 'preview playback to stop')
  const media = await readMedia()
  check(
    'a media terminal event followed Stop preview',
    media.some(
      (entry) =>
        ['pause', 'ended', 'abort', 'emptied'].includes(entry.type) &&
        entry.at >= (stopState.clickedAt ?? 0) - 10,
    ),
    JSON.stringify(media.slice(-8)),
  )
  await voicePreviewButton().waitFor({ state: 'visible' })
  await page.waitForTimeout(300)
  const previewAfter = {
    inputs: (await readSends('input.submit')).length,
    executes: (await readInbound('performance.execute')).length,
    deliveries: countDeliveries(await readInbound('session.event')),
  }
  check('the preview produced no input.submit', previewAfter.inputs === previewBefore.inputs)
  check('the preview produced no performance.execute', previewAfter.executes === previewBefore.executes)
  check('the preview produced no delivery.committed', previewAfter.deliveries === previewBefore.deliveries)
  const afterPreviewState = await latestVoiceState()
  check(
    'the preview did not change the server-selected voice',
    afterPreviewState.payload.selectedVoiceId === activeBeforePreview,
    `before=${String(activeBeforePreview)} after=${String(afterPreviewState.payload.selectedVoiceId)}`,
  )
  await waitForBodyText(activeVoicePattern(HEART_NAME), 'the active voice text Heart after preview')
  note('preview and Stop preview', {
    requestMessageId: previewRequest.messageId,
    sample,
    stopState,
    officialEvents: {
      inputDelta: previewAfter.inputs - previewBefore.inputs,
      executeDelta: previewAfter.executes - previewBefore.executes,
      deliveryDelta: previewAfter.deliveries - previewBefore.deliveries,
    },
  })
  await screenshot('04-preview-stopped')

  const use = voiceUseButton()
  await waitForEnabled(use, 'the Use this voice control after operator opt-in')
  const selectSendsBefore = (await readSends('voice.select')).length
  await use.click()
  const selectSends = await waitUntil(
    () => readSends('voice.select'),
    (entries) => entries.length > selectSendsBefore,
    options.timeoutMs,
    'a voice.select request',
  )
  const selectRequest = selectSends.at(-1)
  check(
    'the selection request targets Emma',
    selectRequest.payload?.voiceId === emma.id,
    `voiceId=${String(selectRequest.payload?.voiceId)}`,
  )
  const confirmed = await waitForMatchingVoiceState(selectRequest.messageId)
  check(
    'the server confirmed Emma as the selected voice',
    confirmed.payload?.selectedVoiceId === emma.id,
    `selectedVoiceId=${String(confirmed.payload?.selectedVoiceId)}`,
  )
  await waitForBodyText(activeVoicePattern(EMMA_NAME), 'the active voice text Emma after server confirmation')
  note('server-confirmed selection', {
    requestMessageId: selectRequest.messageId,
    selectedVoiceId: confirmed.payload?.selectedVoiceId,
  })
  await screenshot('05-selected')

  const selectedTurn = await runFormalTurn('selected Emma turn', SELECTED_INPUT)
  check(
    'both formal turns use the same deterministic first-segment text',
    selectedTurn.first.payload?.subtitleText === baseline.first.payload?.subtitleText,
    `baseline=${JSON.stringify(baseline.first.payload?.subtitleText)} selected=${JSON.stringify(selectedTurn.first.payload?.subtitleText)}`,
  )
  check(
    'the selected voice changed the first-segment WAV bytes',
    selectedTurn.firstAudio.sha256 !== baseline.firstAudio.sha256,
    `baseline=${baseline.firstAudio.sha256} selected=${selectedTurn.firstAudio.sha256}`,
  )
  const selectedServedRefs = uniqueServedRefs(selectedTurn.audio)
  check(
    'the selected turn served both segments',
    selectedTurn.executes.length >= 2 && selectedServedRefs.size >= 2,
    `executes=${selectedTurn.executes.length} servedRefs=${selectedServedRefs.size}`,
  )
  await waitForBodyText(activeVoicePattern(EMMA_NAME), 'the active voice text Emma after the formal turn')
  const finalState = await latestVoiceState()
  check(
    'the server-selected voice remains Emma after the formal turn',
    finalState.payload?.selectedVoiceId === emma.id,
    `selectedVoiceId=${String(finalState.payload?.selectedVoiceId)}`,
  )
  note('selected-voice formal turn', {
    baselineWavSha256: baseline.firstAudio.sha256,
    selectedWavSha256: selectedTurn.firstAudio.sha256,
    selectedExecuteCount: selectedTurn.executes.length,
    selectedServedRefCount: selectedServedRefs.size,
  })
  await screenshot('06-selected-turn')

  const state = {
    createdAt: new Date().toISOString(),
    phase: 'before-restart',
    sessionId: await fact('Session'),
    selectedVoiceId: emma.id,
    selectedVoiceName: emma.name,
    voices: confirmed.payload?.voices ?? [],
    baseline: {
      firstSubtitle: baseline.first.payload?.subtitleText,
      firstSegmentWav: baseline.firstAudio,
    },
    preview: {
      requestMessageId: previewRequest.messageId,
      voiceId: sample.voiceId,
      wav: { bytes: sample.bytes, wav: sample.wav, sha256: sample.sha256 ?? null },
    },
    selectedTurn: {
      firstSubtitle: selectedTurn.first.payload?.subtitleText,
      firstSegmentWav: selectedTurn.firstAudio,
      executeCount: selectedTurn.executes.length,
      servedRefCount: selectedServedRefs.size,
    },
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  note('two-phase state written', { path: statePath, selectedVoiceId: emma.id })
}

async function afterRestartFlow() {
  let state
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `the before-restart state file could not be read at ${statePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  check(
    'the before-restart state names a selected voice',
    typeof state.selectedVoiceId === 'string' && state.selectedVoiceId.length > 0,
  )
  check(
    'the before-restart state contains selected-turn WAV evidence',
    typeof state.selectedTurn?.firstSegmentWav?.sha256 === 'string',
  )
  check(
    'the before-restart state contains the selected-turn subtitle',
    typeof state.selectedTurn?.firstSubtitle === 'string',
  )

  await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  await waitForConnectionOpen()
  const initial = await waitForInitialVoiceState()
  const emma = voiceByName(initial, EMMA_NAME)
  check('the restarted deployment still lists Emma', emma !== undefined, JSON.stringify(initial.payload?.voices))
  check(
    'the restarted server selected the persisted voice',
    initial.payload?.selectedVoiceId === state.selectedVoiceId,
    `stored=${state.selectedVoiceId} observed=${String(initial.payload?.selectedVoiceId)}`,
  )
  await waitForBodyText(activeVoicePattern(EMMA_NAME), 'the active voice text Emma after restart')
  note('restarted deployment read back the persisted voice', {
    storedSessionId: state.sessionId,
    restartSessionId: await fact('Session'),
    selectedVoiceId: initial.payload?.selectedVoiceId,
  })
  await screenshot('06-after-restart')

  await attachAndBootstrap()
  await resumeSession()
  const turn = await runFormalTurn('post-restart Emma turn', RESTART_INPUT)
  check(
    'the post-restart turn uses the same deterministic first-segment text',
    turn.first.payload?.subtitleText === state.selectedTurn.firstSubtitle,
    `stored=${JSON.stringify(state.selectedTurn.firstSubtitle)} observed=${JSON.stringify(turn.first.payload?.subtitleText)}`,
  )
  check(
    'the post-restart turn produced the same selected-voice WAV evidence',
    turn.firstAudio.sha256 === state.selectedTurn.firstSegmentWav.sha256,
    `stored=${state.selectedTurn.firstSegmentWav.sha256} observed=${turn.firstAudio.sha256}`,
  )
  const servedRefs = uniqueServedRefs(turn.audio)
  check(
    'the post-restart turn served both segments',
    turn.executes.length >= 2 && servedRefs.size >= 2,
    `executes=${turn.executes.length} servedRefs=${servedRefs.size}`,
  )
  await waitForBodyText(activeVoicePattern(EMMA_NAME), 'the active voice text Emma after the post-restart turn')
  const finalState = await latestVoiceState()
  check(
    'the restarted server still selects Emma after the formal turn',
    finalState.payload?.selectedVoiceId === state.selectedVoiceId,
    `selectedVoiceId=${String(finalState.payload?.selectedVoiceId)}`,
  )
  note('post-restart formal turn', {
    selectedVoiceId: finalState.payload?.selectedVoiceId,
    storedWavSha256: state.selectedTurn.firstSegmentWav.sha256,
    observedWavSha256: turn.firstAudio.sha256,
    executeCount: turn.executes.length,
    servedRefCount: servedRefs.size,
  })
  await screenshot('07-after-restart-turn')
}

try {
  if (options.phase === 'before-restart') {
    await beforeRestartFlow()
  } else {
    await afterRestartFlow()
  }
  report.verdict = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
  await screenshot('failure')
} finally {
  report.finishedAt = new Date().toISOString()
  report.checks = checks
  if (report.errors.length > 0 && report.verdict !== 'failed') {
    report.verdict = 'failed'
    report.failure = report.failure ?? `unexpected browser errors: ${report.errors[0]}`
    process.exitCode = 1
  }
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const summary = [
    `Console voice selection acceptance (${report.phase}): ${report.verdict}`,
    `base: ${report.base}`,
    `state: ${report.statePath}`,
    `failure: ${report.failure ?? 'none'}`,
    `page errors: ${report.errors.length}`,
    '',
    ...report.checks.map(
      (entry) => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail.length > 0 ? ` — ${entry.detail}` : ''}`,
    ),
    '',
    ...report.steps.map((entry) => `- ${entry.label}`),
    '',
    ...report.errors.map((entry) => `error: ${entry}`),
  ].join('\n')
  await writeFile(path.join(outDir, 'summary.txt'), `${summary}\n`, 'utf8')
  await browser.close()
}

if (report.verdict === 'passed') {
  console.log(`Console voice selection acceptance passed; report: ${path.join(outDir, 'report.json')}`)
} else {
  console.error(report.failure ?? 'console voice selection acceptance failed')
  console.error(`report: ${path.join(outDir, 'report.json')}`)
}
