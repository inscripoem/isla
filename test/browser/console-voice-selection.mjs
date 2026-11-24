#!/usr/bin/env node
/*
 * Console voice selection — true-browser acceptance (TA-004).
 * Real ConsoleApp, application transport and browser player, with the test-only
 * deployment keeping reference synthesis/audio/storage wiring. Kokoro is local;
 * SQLite and `<db>.voices.json` are real. Run phase 1 against a fresh database,
 * restart the runtime with the same ISLA_STORAGE_DB_PATH, then run
 * `--phase after-restart --state <phase1>/voice-selection-state.json`.
 *
 * The JSON artifact contains status, active id, first-segment SHA, preview SHA
 * and checks. Bootstrap tokens and base64 audio are never retained.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const HEART = 'Heart'
const EMMA = 'Emma'
const STATE_FILE = 'voice-selection-state.json'
const INPUTS = {
  baseline: 'Voice selection baseline turn.',
  selected: 'Voice selection adopted-voice turn.',
  restart: 'Voice selection post-restart turn.',
}

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
    const flag = argv[index]
    const next = () => {
      if (++index >= argv.length) throw new Error(`missing value for ${flag}`)
      return argv[index]
    }
    if (flag === '--url') options.url = next()
    else if (flag === '--output') options.output = next()
    else if (flag === '--state') options.state = next()
    else if (flag === '--phase') options.phase = next()
    else if (flag === '--playwright') options.playwright = next()
    else if (flag === '--chromium') options.chromium = next()
    else if (flag === '--timeout') options.timeoutMs = Number(next())
    else if (flag === '--headed') options.headless = false
    else if (flag === '--sandbox') options.sandbox = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Error(`unknown argument: ${flag}`)
  }
  return options
}

const HELP = `Console voice selection browser acceptance
Usage: node test/browser/console-voice-selection.mjs --playwright <path> [options]
  --url --output --state --phase --playwright --chromium --timeout --headed --sandbox --help
Defaults: http://127.0.0.1:5173/, temp output, before-restart, 60000 ms.
`

function loadPlaywright(modulePath) {
  if (modulePath !== null) return require(modulePath)
  try {
    return require('playwright')
  } catch (error) {
    throw new Error('playwright was not found; set ISLA_PLAYWRIGHT_MODULE', { cause: error })
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(HELP)
  process.exit(0)
}
if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('invalid timeout')
if (options.phase !== 'before-restart' && options.phase !== 'after-restart') throw new Error('invalid phase')

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const outDir = options.output === null
  ? path.join(tmpdir(), 'isla-console-voice-selection', stamp)
  : path.resolve(options.output)
const statePath = options.state === null
  ? path.join(outDir, STATE_FILE)
  : path.resolve(options.state)
await mkdir(outDir, { recursive: true })

const report = {
  phase: options.phase,
  status: 'failed',
  url: options.url,
  activeVoiceId: null,
  firstSegmentSha256: null,
  previewWavSha256: null,
  checks: [],
  errors: [],
}
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) })
  if (!ok) throw new Error(detail ? `${name}: ${detail}` : name)
}
async function waitFor(read, label, timeout = options.timeoutMs) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const isWav = (bytes) =>
  bytes.length >= 12 &&
  bytes.toString('ascii', 0, 4) === 'RIFF' &&
  bytes.toString('ascii', 8, 12) === 'WAVE'

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
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    report.errors.push(`console.error: ${message.text()}`)
  }
})

const sent = []
const received = []
const audio = new Map()
const baseOrigin = new URL(options.url).origin
const frameText = (frame) =>
  typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
const SAFE = new Set([
  'voice.state',
  'voice.list',
  'voice.select',
  'voice.preview',
  'performance.offer',
  'performance.grant',
  'performance.ready',
  'performance.receipt',
  'session.event',
  'session.attach.ack',
  'session.snapshot',
  'operator.ack',
  'control.ack',
  'control.resume',
  'input.ack',
  'input.submit',
  'request.error',
])

page.on('websocket', (socket) => {
  if (!socket.url().includes('/app')) return
  socket.on('framesent', (frame) => observe(frameText(frame), true))
  socket.on('framereceived', (frame) => observe(frameText(frame), false))
})
page.on('response', (response) => {
  if (response.request().method() !== 'POST') return
  let url
  try {
    url = new URL(response.url())
  } catch {
    return
  }
  if (url.origin !== baseOrigin || url.pathname !== '/audio' || response.status() !== 200) return
  const ref = url.searchParams.get('ref')
  if (ref === null) return
  response.body().then(
    (buffer) => audio.set(ref, { ref, sha256: sha256(buffer), bytes: buffer.length }),
    () => {},
  )
})
await page.addInitScript(() => {
  window.__voiceMedia = { events: [], playing: false }
  const originalPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...args) {
    const element = this
    if (!element.__voiceObserved) {
      element.__voiceObserved = true
      for (const type of ['playing', 'pause', 'ended', 'emptied']) {
        element.addEventListener(type, () => {
          window.__voiceMedia.events.push({ type, at: performance.now() })
          window.__voiceMedia.playing = type === 'playing'
        })
      }
    }
    return originalPlay.apply(this, args)
  }
})

function observe(raw, outbound) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  const kind = message?.kind
  if (!kind) return
  if (outbound && kind === 'operator.bootstrap') {
    sent.push({ kind, messageId: message.messageId })
    return
  }
  if (kind === 'voice.sample') {
    const bytes = Buffer.from(message.payload?.wavBase64 ?? '', 'base64')
    received.push({
      kind,
      messageId: message.messageId,
      payload: {
        requestMessageId: message.payload?.requestMessageId,
        voiceId: message.payload?.voiceId,
      },
      bytes: bytes.length,
      wav: isWav(bytes),
      sha256: sha256(bytes),
    })
    return
  }
  if (!SAFE.has(kind)) return
  ;(outbound ? sent : received).push({
    kind,
    messageId: message.messageId,
    epoch: message.epoch,
    payload: message.payload ?? {},
  })
}

const of = (kind) => received.filter((entry) => entry.kind === kind)
const sentOf = (kind) => sent.filter((entry) => entry.kind === kind)
const latest = (kind) => of(kind).at(-1)
const deliveries = () => of('session.event').filter((entry) => entry.payload.type === 'delivery.committed')
const chatCount = () =>
  [
    sentOf('input.submit').length,
    of('performance.offer').length,
    sentOf('performance.receipt').length,
    deliveries().length,
    sentOf('voice.select').length,
  ].join(':')
const currentLabel = async () =>
  (await page.locator('.console__voice-current').innerText()).replace(/\s+/g, ' ').trim()
const waitForCurrent = (name) =>
  page.waitForFunction(
    (wanted) =>
      (document.querySelector('.console__voice-current')?.textContent ?? '').includes(`Current voice: ${wanted}`),
    name,
  )
const selectVoice = (voiceId) => page.locator('#console-voice').selectOption(voiceId)

async function initialVoiceState() {
  const state = await waitFor(() => {
    const current = latest('voice.state')
    return current?.payload?.voices?.length ? current : null
  }, 'initial voice.state')
  await page.locator('#console-voice').waitFor()
  return state
}

async function attachAndResume(expectedVoiceId, expectedName) {
  const attaches = of('session.attach.ack').length
  await page.getByRole('button', { name: 'Attach performer', exact: true }).click()
  await waitFor(() => of('session.attach.ack').slice(attaches).find((entry) => entry.payload.performer), 'attach ack')
  const bootstraps = sentOf('operator.bootstrap').length
  // The Voice card may expose a secondary auth shortcut; use the existing
  // Performer and authority control, which is the last matching button.
  await page.getByRole('button', { name: 'Bootstrap operator', exact: true }).last().click()
  const bootstrap = await waitFor(() => sentOf('operator.bootstrap').slice(bootstraps)[0], 'bootstrap frame')
  const operator = await waitFor(() => of('operator.ack').find((entry) => entry.payload.requestMessageId === bootstrap.messageId), 'operator ack')
  check('operator authority confirmed', operator.payload.role === 'operator')
  const resumes = sentOf('control.resume').length
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  const resume = await waitFor(() => sentOf('control.resume').slice(resumes)[0], 'resume frame')
  const control = await waitFor(() => of('control.ack').find((entry) => entry.payload.requestMessageId === resume.messageId), 'resume ack')
  check(
    'session is running after Resume',
    control.payload.action === 'resume' && control.payload.status === 'applied' && control.payload.lifecycle === 'running',
  )
  const refreshed = await waitFor(() => of('voice.state').find((entry) => entry.epoch === control.payload.epoch), 'voice refresh')
  check('Resume refresh keeps the expected active voice', refreshed.payload.selectedVoiceId === expectedVoiceId)
  await waitForCurrent(expectedName)
}

async function runTurn(label, text) {
  const inputs = sentOf('input.submit').length
  const offersBefore = of('performance.offer').length
  const deliveriesBefore = deliveries().length
  await page.locator('#console-text').fill(text)
  await page.getByRole('button', { name: 'Submit input', exact: true }).click()
  const submit = await waitFor(() => sentOf('input.submit').slice(inputs)[0], `${label} input`)
  const ack = await waitFor(() => of('input.ack').find((entry) => entry.payload.requestMessageId === submit.messageId), `${label} ack`)
  check(`${label} input accepted`, ack.payload.status === 'accepted')
  const offers = await waitFor(() => {
    const current = of('performance.offer').slice(offersBefore)
    return current.length >= 2 ? current : null
  }, `${label} offers`)
  const pair = offers.filter((offer) => offer.payload.turnId === offers[0].payload.turnId)
  check(`${label} has two segments`, pair.length === 2, `offers=${pair.length}`)
  const evidence = await Promise.all(pair.map(async (offer) => ({
    offer,
    grant: await waitFor(() => of('performance.grant').find((entry) => entry.payload.outputId === offer.payload.outputId), `${label} grant`),
    ready: await waitFor(() => sentOf('performance.ready').find((entry) => entry.payload.outputId === offer.payload.outputId), `${label} ready`),
    receipt: await waitFor(
      () => sentOf('performance.receipt').find((entry) => entry.payload.outputId === offer.payload.outputId && entry.payload.stage === 'completed'),
      `${label} receipt`,
    ),
    bytes: await waitFor(() => audio.get(offer.payload.audioRef), `${label} audio`),
  })))
  const newDeliveries = await waitFor(() => {
    const current = deliveries().slice(deliveriesBefore)
    return current.length >= 2 ? current : null
  }, `${label} deliveries`)
  const fullyDelivered = newDeliveries.filter((entry) => entry.payload.data?.classification === 'fully-delivered')
  check(`${label} committed two fully-delivered notifications`, fullyDelivered.length === 2, JSON.stringify(newDeliveries.map((entry) => entry.payload)))
  check(`${label} delivery seqs are distinct`, fullyDelivered[0].payload.seq !== fullyDelivered[1].payload.seq)
  return {
    evidence,
    first: evidence[0],
    deliveries: fullyDelivered,
    deliverySeqs: fullyDelivered.map((entry) => entry.payload.seq),
  }
}

async function previewAndStop(emmaId) {
  await page.evaluate(() => {
    window.__voiceMedia = { events: [], playing: false }
  })
  const activeBefore = latest('voice.state')?.payload.selectedVoiceId
  const before = chatCount()
  const previews = sentOf('voice.preview').length
  await page.getByRole('button', { name: 'Preview voice', exact: true }).click()
  const preview = await waitFor(
    () => sentOf('voice.preview').slice(previews).find((entry) => entry.payload.voiceId === emmaId),
    'voice.preview frame',
  )
  const sample = await waitFor(() => of('voice.sample').find((entry) => entry.payload.requestMessageId === preview.messageId), 'voice.sample frame')
  check('preview is an Emma WAV', sample.payload.voiceId === emmaId && sample.bytes > 0 && sample.wav)
  let retried = false
  try {
    await page.waitForFunction(() => window.__voiceMedia?.playing === true, undefined, { timeout: 5000 })
  } catch {
    // A browser autoplay refusal keeps the prepared sample; a second explicit
    // Preview voice click is the user gesture that replays it.
    retried = true
    await page.getByRole('button', { name: 'Preview voice', exact: true }).click()
    await page.waitForFunction(() => window.__voiceMedia?.playing === true)
  }
  const stopAt = await page.evaluate(() => {
    window.__voiceMedia.stopAt = performance.now()
    return window.__voiceMedia.stopAt
  })
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click()
  await page.waitForFunction(
    (at) => !window.__voiceMedia.playing && window.__voiceMedia.events.some((event) => (event.type === 'pause' || event.type === 'emptied') && event.at >= at),
    stopAt,
  )
  check('preview and Stop emitted no chat or preference frames', before === chatCount(), `${before} | ${chatCount()}`)
  check(
    'preview did not change the official preference',
    latest('voice.state')?.payload.selectedVoiceId === activeBefore && (await currentLabel()).includes(`Current voice: ${HEART}`),
  )
  return { sample, retried }
}

async function adopt(emmaId) {
  const selects = sentOf('voice.select').length
  await page.getByRole('button', { name: 'Use this voice', exact: true }).click()
  const select = await waitFor(() => sentOf('voice.select').slice(selects).find((entry) => entry.payload.voiceId === emmaId), 'voice.select frame')
  await waitFor(
    () => of('voice.state').find((entry) => entry.payload.requestMessageId === select.messageId && entry.payload.selectedVoiceId === emmaId),
    'adopted voice.state',
  )
  await waitForCurrent(EMMA)
  check('adoption had no refusal', !of('request.error').some((entry) => entry.payload.requestId === select.messageId))
}

async function beforeRestart() {
  await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  const initial = await initialVoiceState()
  const heart = initial.payload.voices.find((voice) => voice.name === HEART)
  const emma = initial.payload.voices.find((voice) => voice.name === EMMA)
  check('installed voices include Heart and Emma', heart && emma)
  check('default active voice is Heart', initial.payload.selectedVoiceId === heart.id)
  await waitForCurrent(HEART)
  const optionCount = await page.locator('#console-voice option').count()
  check('combobox renders the genuine server voice list', optionCount === initial.payload.voices.length + 1, `options=${optionCount}`)
  check('initial draft is Heart', (await page.locator('#console-voice').inputValue()) === heart.id)
  const use = page.getByRole('button', { name: 'Use this voice', exact: true })
  await selectVoice(emma.id)
  check(
    'viewer draft is Emma while the current label stays Heart',
    (await page.locator('#console-voice').inputValue()) === emma.id && (await currentLabel()).includes(`Current voice: ${HEART}`),
  )
  check('viewer cannot apply', await use.isDisabled())
  check('viewer sent no voice.select', sentOf('voice.select').length === 0)

  await attachAndResume(heart.id, HEART)
  const baseline = await runTurn('baseline Heart', INPUTS.baseline)
  await selectVoice(emma.id)
  check(
    'operator draft is Emma while the current label stays Heart',
    (await page.locator('#console-voice').inputValue()) === emma.id && (await currentLabel()).includes(`Current voice: ${HEART}`),
  )
  const preview = await previewAndStop(emma.id)
  await adopt(emma.id)
  const selected = await runTurn('adopted Emma', INPUTS.selected)

  check(
    'baseline and adopted turns use identical first-segment text',
    baseline.first.offer.payload.subtitleText === selected.first.offer.payload.subtitleText,
  )
  check(
    'adopted Emma uses different actual first-segment bytes than Heart',
    baseline.first.bytes.sha256 !== selected.first.bytes.sha256,
    `${baseline.first.bytes.sha256} | ${selected.first.bytes.sha256}`,
  )
  check(
    'adopted turn completed both segments and committed two fully-delivered notifications',
    selected.evidence.length === 2 &&
      selected.evidence.every((entry) => entry.receipt.payload.stage === 'completed') &&
      selected.deliveries.length === 2 &&
      selected.deliveries.every((entry) => entry.payload.data?.classification === 'fully-delivered'),
    JSON.stringify(selected.evidence.map((entry) => ({ outputId: entry.offer.payload.outputId, stage: entry.receipt.payload.stage }))),
  )
  check('active voice remains Emma after the turn', latest('voice.state')?.payload.selectedVoiceId === emma.id)
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        selectedVoiceId: emma.id,
        firstSubtitle: selected.first.offer.payload.subtitleText,
        firstSegmentSha256: selected.first.bytes.sha256,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  report.activeVoiceId = emma.id
  report.firstSegmentSha256 = selected.first.bytes.sha256
  report.previewWavSha256 = preview.sample.sha256
  report.previewRetried = preview.retried
  report.baselineFirstSegmentSha256 = baseline.first.bytes.sha256
  report.deliverySeqs = selected.deliverySeqs
  report.correlations = selected.evidence.map((entry) => ({
    turnId: entry.offer.payload.turnId,
    segmentId: entry.offer.payload.segmentId,
    outputId: entry.offer.payload.outputId,
    audioRef: entry.offer.payload.audioRef,
    receiptStage: entry.receipt.payload.stage,
    audioSha256: entry.bytes.sha256,
  }))
}

async function afterRestart() {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  check('phase 1 state has the selected voice and first-segment SHA', typeof state.selectedVoiceId === 'string' && typeof state.firstSegmentSha256 === 'string')
  await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  const initial = await initialVoiceState()
  check('restarted server selected the persisted voice', initial.payload.selectedVoiceId === state.selectedVoiceId)
  check('restarted server still lists Emma', initial.payload.voices.some((voice) => voice.name === EMMA))
  await waitForCurrent(EMMA)
  await attachAndResume(state.selectedVoiceId, EMMA)
  const turn = await runTurn('post-restart Emma', INPUTS.restart)
  check('post-restart turn uses the same first-segment text', turn.first.offer.payload.subtitleText === state.firstSubtitle)
  check(
    'post-restart official Emma bytes match the pre-restart Emma bytes',
    turn.first.bytes.sha256 === state.firstSegmentSha256,
    `${state.firstSegmentSha256} | ${turn.first.bytes.sha256}`,
  )
  check(
    'post-restart turn completed both segments and committed two fully-delivered notifications',
    turn.evidence.length === 2 &&
      turn.evidence.every((entry) => entry.receipt.payload.stage === 'completed') &&
      turn.deliveries.length === 2 &&
      turn.deliveries.every((entry) => entry.payload.data?.classification === 'fully-delivered'),
  )
  check('restarted server still selects Emma after the turn', latest('voice.state')?.payload.selectedVoiceId === state.selectedVoiceId)
  report.activeVoiceId = state.selectedVoiceId
  report.firstSegmentSha256 = turn.first.bytes.sha256
  report.deliverySeqs = turn.deliverySeqs
  report.correlations = turn.evidence.map((entry) => ({
    turnId: entry.offer.payload.turnId,
    segmentId: entry.offer.payload.segmentId,
    outputId: entry.offer.payload.outputId,
    audioRef: entry.offer.payload.audioRef,
    receiptStage: entry.receipt.payload.stage,
    audioSha256: entry.bytes.sha256,
  }))
}

try {
  if (options.phase === 'before-restart') await beforeRestart()
  else await afterRestart()
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
} finally {
  report.checks = checks
  if (report.errors.length > 0) {
    report.status = 'failed'
    report.failure = report.failure ?? `browser errors: ${report.errors[0]}`
  } else if (report.failure === undefined) {
    report.status = 'passed'
  }
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await browser.close()
}

if (report.status === 'passed') {
  console.log(`Console voice selection acceptance passed; report: ${path.join(outDir, 'report.json')}`)
} else {
  console.error(report.failure ?? 'console voice selection acceptance failed')
  console.error(`report: ${path.join(outDir, 'report.json')}`)
  process.exitCode = 1
}
