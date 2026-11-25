#!/usr/bin/env node
/*
 * M2 console wiring acceptance.
 *
 * Six browser-only behaviours that were previously checked by hand are codified
 * here. This harness mounts the real `ConsoleApp` through Vite and the real
 * application transport, injects only a test-only WebSocket observation wrapper,
 * and serves application frames from a local WebSocket server. The performer is
 * a test-only machine that relays the console's requests as valid protocol-0.2
 * frames, following `console-startup-acceptance.mjs`.
 *
 * Checks:
 *   1. A rejected input ack keeps the exact raw composer text, and a later ack
 *      never clobbers text typed after submitting.
 *   2. A second duplicate ack for the same requestMessageId does not clear the
 *      draft again.
 *   3. After the application socket closes, Reconnect bootstraps exactly once
 *      and the console does not auto-resume or replay.
 *   4. After performer disposal, Submit input, Attach performer and Bootstrap
 *      operator are disabled (or absent). The shipped Reconnect action remains
 *      the operator's recovery affordance and is recorded, not silenced.
 *   5. The diagnostics socket renders `not started`, then `open`, then `closed`
 *      after the server closes it.
 *   6. Below 1100px the Local Receipts floating overlay is not applied, the
 *      document does not scroll horizontally, and it does not occlude the
 *      Control Deck.
 *
 * Playwright and Chromium are supplied externally, following the convention of
 * the other browser acceptance scripts in this directory. Nothing here is part
 * of `pnpm test`, no production module is changed, and no runtime/provider is
 * contacted.
 *
 * Usage:
 *   node test/browser/console-wiring-acceptance.mjs \
 *     --playwright /path/to/playwright \
 *     --chromium "/path/to/Chromium" \
 *     --output /tmp/isla-m2-console-wiring
 *
 * Options:
 *   --playwright <path>  Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
 *   --chromium <path>    Chromium executable (env ISLA_CHROMIUM_EXECUTABLE)
 *   --url <url>          Existing console-wiring page URL; skips the local Vite start
 *   --output <dir>       Artifact directory (env ISLA_CONSOLE_WIRING_OUTPUT)
 *   --timeout <ms>       Per-observation timeout (env ISLA_CONSOLE_WIRING_TIMEOUT_MS)
 *   --headed             Run headed (env ISLA_CONSOLE_WIRING_HEADED=1)
 *   --sandbox            Keep Chromium's sandbox (default off)
 *   --help               Show this help
 */

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createServer as createViteServer } from 'vite'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)

const SESSION_ID = 'session-console-wiring'
const SNAPSHOT = {
  protocolVersion: '0.2',
  messageId: 'wiring-snapshot',
  sessionId: SESSION_ID,
  epoch: 1,
  kind: 'session.snapshot',
  payload: {
    lifecycle: 'stopped',
    activeTurnId: null,
    performerStatus: 'idle',
    outputConfirmation: 'confirmed',
    capabilityRevision: 1,
    lastSeq: 0,
  },
}

const HELP = `M2 console wiring browser acceptance

Usage:
  node test/browser/console-wiring-acceptance.mjs --playwright <path> [options]

Options:
  --playwright <path>  Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
  --chromium <path>    Chromium executable (env ISLA_CHROMIUM_EXECUTABLE)
  --url <url>          Existing console-wiring page URL; skips the local Vite start
  --output <dir>       Artifact directory (env ISLA_CONSOLE_WIRING_OUTPUT)
  --timeout <ms>       Per-observation timeout (env ISLA_CONSOLE_WIRING_TIMEOUT_MS)
  --headed             Run headed
  --sandbox            Keep Chromium's sandbox
  --help               Show this help
`

function parseArgs(argv) {
  const options = {
    url: process.env.ISLA_CONSOLE_WIRING_URL ?? null,
    output: process.env.ISLA_CONSOLE_WIRING_OUTPUT ?? null,
    playwright: process.env.ISLA_PLAYWRIGHT_MODULE ?? null,
    chromium: process.env.ISLA_CHROMIUM_EXECUTABLE ?? null,
    headless: process.env.ISLA_CONSOLE_WIRING_HEADED !== '1',
    sandbox: process.env.ISLA_CONSOLE_WIRING_SANDBOX === '1',
    timeoutMs: Number(process.env.ISLA_CONSOLE_WIRING_TIMEOUT_MS ?? 20000),
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(HELP)
  process.exit(0)
}
if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
  throw new Error(`invalid timeout: ${options.timeoutMs}`)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const outDir = options.output === null
  ? `/tmp/isla-m2-console-wiring/${stamp}`
  : path.resolve(options.output)
await mkdir(outDir, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  pageUrl: options.url,
  checks: [],
  observations: {},
  errors: [],
  consoleErrors: [],
  verdict: 'failed',
}

async function waitUntil(read, label, timeout = options.timeoutMs) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const { chromium } = loadPlaywright(options.playwright)

// ---------------------------------------------------------------------------
// Application socket: the real console transport connects here. The server
// sends one snapshot per connection and records every client frame so checks
// can correlate acknowledgements and prove that nothing was replayed.
// ---------------------------------------------------------------------------
const applicationServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise((resolve, reject) => {
  applicationServer.once('listening', resolve)
  applicationServer.once('error', reject)
})
const applicationAddress = applicationServer.address()
assert(
  typeof applicationAddress === 'object' && applicationAddress !== null,
  'the application WebSocket server has no TCP address',
)

const application = {
  connections: 0,
  closes: 0,
  inbound: [],
  sockets: new Set(),
  connection: 0,
}
let currentApplicationSocket = null
let ackSequence = 0

function sendToApplication(message) {
  const socket = currentApplicationSocket
  assert(socket !== null, 'the application socket is not open')
  socket.send(JSON.stringify(message))
}

function sendVoiceState(socket, request) {
  if (socket.readyState !== 1) return
  socket.send(
    JSON.stringify({
      protocolVersion: '0.2',
      messageId: `wiring-voice-state-${request.messageId}`,
      sessionId: request.sessionId,
      epoch: request.epoch,
      kind: 'voice.state',
      payload: { requestMessageId: request.messageId, selectedVoiceId: null, voices: [] },
    }),
  )
}

function sendOperatorAck(socket, request) {
  if (socket.readyState !== 1) return
  socket.send(
    JSON.stringify({
      protocolVersion: '0.2',
      messageId: `wiring-operator-ack-${request.messageId}`,
      sessionId: request.sessionId,
      epoch: request.epoch,
      kind: 'operator.ack',
      payload: { role: 'operator', requestMessageId: request.messageId },
    }),
  )
}

applicationServer.on('connection', (socket) => {
  application.connections += 1
  application.connection += 1
  const connection = application.connection
  application.sockets.add(socket)
  currentApplicationSocket = socket
  socket.on('close', () => {
    application.closes += 1
    application.sockets.delete(socket)
    if (currentApplicationSocket === socket) currentApplicationSocket = null
  })
  socket.on('message', (data) => {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      application.inbound.push({ connection, at: Date.now(), parseError: true, text: String(data) })
      return
    }
    application.inbound.push({ connection, at: Date.now(), message, text: String(data) })
    if (message?.kind === 'voice.list') sendVoiceState(socket, message)
    if (message?.kind === 'operator.bootstrap') sendOperatorAck(socket, message)
  })
  socket.send(JSON.stringify(SNAPSHOT))
})

const inboundOf = (kind) =>
  application.inbound.filter((entry) => entry.message?.kind === kind)

function sendInputAck(payload) {
  ackSequence += 1
  sendToApplication({
    protocolVersion: '0.2',
    messageId: `wiring-input-ack-${ackSequence}`,
    sessionId: SESSION_ID,
    epoch: 1,
    kind: 'input.ack',
    payload,
  })
}

function sendAccepted(requestMessageId, seq) {
  sendInputAck({
    status: 'accepted',
    requestMessageId,
    eventId: `wiring-event-${seq}`,
    sessionId: SESSION_ID,
    epoch: 1,
    seq,
  })
}

function sendDuplicate(requestMessageId, seq) {
  sendInputAck({
    status: 'duplicate',
    requestMessageId,
    eventId: `wiring-event-${seq}`,
    sessionId: SESSION_ID,
    epoch: 1,
    seq,
  })
}

function sendRejected(requestMessageId) {
  sendInputAck({
    status: 'rejected',
    requestMessageId,
    sessionId: SESSION_ID,
    epoch: 1,
    code: 'invalid_field',
    message: 'the wiring harness rejects this input',
    retryable: true,
  })
}

function sendTurnStarted(seq) {
  sendToApplication({
    protocolVersion: '0.2',
    messageId: `wiring-turn-${seq}`,
    sessionId: SESSION_ID,
    epoch: 1,
    kind: 'session.event',
    payload: {
      seq,
      type: 'turn.started',
      data: { turnId: 'wiring-turn-1', replyIntent: 'answer' },
    },
  })
}

// ---------------------------------------------------------------------------
// Diagnostics socket: served from the same Vite origin at /diag. The page's
// real DiagnosticsPage opens it from window.location.host, so a local plugin
// handles the upgrade instead of changing production code.
// ---------------------------------------------------------------------------
const diagnosticsServer = new WebSocketServer({ noServer: true })
const diagnostics = { connections: 0, closes: 0, sockets: new Set() }
let currentDiagnosticsSocket = null
diagnosticsServer.on('connection', (socket) => {
  diagnostics.connections += 1
  diagnostics.sockets.add(socket)
  currentDiagnosticsSocket = socket
  socket.on('close', () => {
    diagnostics.closes += 1
    diagnostics.sockets.delete(socket)
    if (currentDiagnosticsSocket === socket) currentDiagnosticsSocket = null
  })
})

const HEALTH = {
  ok: true,
  service: 'isla-console-wiring-harness',
  version: '0.0.0-test',
  role: 'harness',
  loopbackOnly: true,
  protocol: { diagnostics: 1, application: null },
  capabilities: ['diagnostics'],
  uptimeSec: 1,
}

function diagnosticsPlugin() {
  return {
    name: 'isla-console-wiring-diagnostics',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/health') {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(HEALTH))
      })
      server.httpServer?.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/diag') return
        diagnosticsServer.handleUpgrade(request, socket, head, (upgrade) => {
          diagnosticsServer.emit('connection', upgrade, request)
        })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Browser setup.
// ---------------------------------------------------------------------------
const testBrowserDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const applicationSocketUrl = `ws://127.0.0.1:${applicationAddress.port}/app`

let viteServer = null
let browser = null
let page = null

async function screenshot(name) {
  if (page === null) return
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
}

async function openConsole() {
  await page.goto(report.pageUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'open',
    undefined,
    { timeout: options.timeoutMs },
  )
  await page.waitForFunction(
    (sessionId) => document.querySelector('main')?.innerText?.includes(sessionId) === true,
    SESSION_ID,
    { timeout: options.timeoutMs },
  )
  // Let the deferred StrictMode pass and the first render settle.
  await page.waitForTimeout(150)
}

async function probeCounts() {
  return page.evaluate(() => {
    const probe = window.__islaConsoleWiring ?? {
      transportFactoryCalls: [],
      bootstrapCalls: [],
      bootstrapResolved: [],
    }
    return {
      transportFactoryCalls: probe.transportFactoryCalls.length,
      bootstrapCalls: probe.bootstrapCalls.length,
      bootstrapResolved: probe.bootstrapResolved.length,
    }
  })
}

async function composerValue() {
  return page.locator('#console-text').inputValue()
}

async function buttonStates() {
  return page.evaluate(() => {
    const button = (label) =>
      [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label) ?? null
    const state = (label) => {
      const element = button(label)
      return element === null
        ? { present: false, disabled: false }
        : { present: true, disabled: element.disabled }
    }
    return {
      submit: state('Submit input'),
      attach: state('Attach performer'),
      bootstrap: state('Bootstrap operator'),
      reconnect: state('Reconnect'),
      connection: document.querySelector('.console__connection-label')?.textContent?.trim() ?? null,
    }
  })
}

async function diagnosticsLabel() {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.isla-card')]
    const card = cards.find((entry) =>
      entry.querySelector(':scope > .isla-card__head .isla-card__title')?.textContent?.includes('Diagnostics socket'),
    )
    if (card === undefined) return null
    return card.querySelector(':scope > .isla-card__head .isla-tag')?.textContent?.trim() ?? null
  })
}

async function stageHud() {
  return page.evaluate(() => {
    const pills = [...document.querySelectorAll('.isla-stage__hud .isla-tag')]
    const pill = pills.find((entry) => entry.textContent?.trim().startsWith('Pipeline:')) ?? pills[1] ?? null
    const waveform = document.querySelector('.isla-stage__viz .isla-eq')
    return {
      text: pill?.textContent?.trim() ?? null,
      pulsing: pill !== null && pill.querySelector('.isla-tag__dot--pulse') !== null,
      waveformPresent: waveform !== null,
      waveformSpeaking: waveform?.classList.contains('is-speaking') ?? null,
    }
  })
}

async function layoutObservation() {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.isla-card')]
    const titleOf = (card) =>
      card.querySelector(':scope > .isla-card__head .isla-card__title')?.textContent ?? ''
    const localReceipts = cards.find((card) => titleOf(card).includes('Local Receipts')) ?? null
    const controlDeck = cards.find((card) => titleOf(card).includes('Control Deck')) ?? null
    const rectOf = (element) => {
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const intersects = (a, b) =>
      a !== null &&
      b !== null &&
      a.left < b.right &&
      b.left < a.right &&
      a.top < b.bottom &&
      b.top < a.bottom
    const localRect = rectOf(localReceipts)
    const controlRect = rectOf(controlDeck)
    const style = localReceipts === null ? null : getComputedStyle(localReceipts)
    return {
      localReceiptsPresent: localReceipts !== null,
      controlDeckPresent: controlDeck !== null,
      position: style?.position ?? null,
      inlinePosition: localReceipts?.style.position ?? null,
      zIndex: style?.zIndex ?? null,
      localRect,
      controlRect,
      occludesControlDeck: intersects(localRect, controlRect),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      narrow: window.matchMedia('(max-width: 1100px)').matches,
    }
  })
}

const checks = []
let failed = false

async function runCheck(id, name, fn) {
  try {
    const observed = await fn()
    report.observations[id] = observed
    checks.push({ id, name, status: 'pass', observed })
    console.log(`PASS ${id}: ${name}`)
    try {
      await screenshot(`${id}-pass`)
    } catch {
      // A screenshot failure must not mask the check result.
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ id, name, status: 'fail', detail: message })
    failed = true
    report.failure = report.failure ?? `${id}: ${message}`
    console.log(`FAIL ${id}: ${name} — ${message}`)
    try {
      await screenshot(`${id}-failure`)
    } catch {
      // A screenshot failure must not mask the original failure.
    }
  }
}

try {
  let pageUrl = options.url
  if (pageUrl === null) {
    viteServer = await createViteServer({
      configFile: false,
      root: testBrowserDir,
      plugins: [react(), diagnosticsPlugin()],
      server: {
        host: '127.0.0.1',
        port: 0,
        fs: { allow: [repoRoot] },
      },
      logLevel: 'error',
    })
    await viteServer.listen()
    const localUrl = viteServer.resolvedUrls?.local?.[0]
    assert(localUrl !== undefined, 'the local Vite server did not report a URL')
    pageUrl = new URL('console-wiring.html', localUrl).toString()
  }
  report.pageUrl = pageUrl

  browser = await chromium.launch({
    headless: options.headless,
    sandbox: options.sandbox,
    executablePath: options.chromium ?? undefined,
    args: ['--disable-gpu', '--disable-gpu-compositing', '--disable-accelerated-2d-canvas', '--mute-audio'],
  })
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  page.setDefaultTimeout(options.timeoutMs)
  page.on('pageerror', (error) => report.errors.push(`pageerror: ${String(error)}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (message.text().includes('favicon')) return
    report.consoleErrors.push({ text: message.text() })
  })

  await page.addInitScript((socketUrl) => {
    window.__islaWiringSocketUrl = socketUrl
    const OriginalWebSocket = window.WebSocket
    const observation = { created: [], opened: [], closed: [] }
    window.__islaWiringSocketObservation = observation
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const socket = new target(...args)
        const url = String(args[0] ?? '')
        if (!url.includes('/app')) return socket
        observation.created.push({ url, at: performance.now() })
        socket.addEventListener('open', () => {
          observation.opened.push({ at: performance.now() })
        })
        socket.addEventListener('close', (event) => {
          observation.closed.push({ code: event.code, wasClean: event.wasClean, at: performance.now() })
        })
        return socket
      },
    })
  }, applicationSocketUrl)

  // -------------------------------------------------------------------------
  // Check 1: rejected composer restoration and later ack isolation.
  // -------------------------------------------------------------------------
  await runCheck('1', 'rejected ack restores the composer; later ack keeps new text', async () => {
    await openConsole()
    const raw = '  rejected composer text  '
    await page.locator('#console-text').fill(raw)
    const beforeSubmit = inboundOf('input.submit').length
    await page.getByRole('button', { name: 'Submit input', exact: true }).click()
    const firstSubmit = await waitUntil(
      () => inboundOf('input.submit')[beforeSubmit],
      'the first input.submit frame',
    )
    assert(
      firstSubmit.message.payload.text === raw.trim(),
      `expected the trimmed payload ${JSON.stringify(raw.trim())}, got ${JSON.stringify(firstSubmit.message.payload.text)}`,
    )
    sendRejected(firstSubmit.message.messageId)
    await waitUntil(
      async () => (await composerValue()) === raw,
      'the exact rejected composer text to remain',
    )
    const rejectedValue = await composerValue()

    // A second submission is acknowledged only after the operator types a new
    // draft; that acknowledgement must settle its own request without clobbering
    // the newer text.
    const secondRaw = 'second submission'
    await page.locator('#console-text').fill(secondRaw)
    const beforeSecond = inboundOf('input.submit').length
    await page.getByRole('button', { name: 'Submit input', exact: true }).click()
    const secondSubmit = await waitUntil(
      () => inboundOf('input.submit')[beforeSecond],
      'the second input.submit frame',
    )
    const typedAfterSubmit = 'typed after submitting'
    await page.locator('#console-text').fill(typedAfterSubmit)
    sendAccepted(secondSubmit.message.messageId, 1)
    await page.waitForTimeout(200)
    const afterLaterAck = await composerValue()
    await screenshot('01-input-ack-draft')
    assert(
      rejectedValue === raw,
      `a rejected ack changed the composer from ${JSON.stringify(raw)} to ${JSON.stringify(rejectedValue)}`,
    )
    assert(
      afterLaterAck === typedAfterSubmit,
      `a later ack clobbered the new composer text: ${JSON.stringify(afterLaterAck)}`,
    )
    return {
      rawRejectedDraft: raw,
      afterRejectedAck: rejectedValue,
      typedAfterSubmit,
      afterLaterAck,
      rejectedPayload: firstSubmit.message.payload.text,
    }
  })

  // -------------------------------------------------------------------------
  // Check 2: a second duplicate ack must not clear the draft again.
  // -------------------------------------------------------------------------
  await runCheck('2', 'a second duplicate ack does not clear the draft again', async () => {
    await openConsole()
    const draft = 'duplicate draft'
    await page.locator('#console-text').fill(draft)
    const beforeSubmit = inboundOf('input.submit').length
    await page.getByRole('button', { name: 'Submit input', exact: true }).click()
    const submit = await waitUntil(
      () => inboundOf('input.submit')[beforeSubmit],
      'the duplicate-test input.submit frame',
    )
    sendDuplicate(submit.message.messageId, 1)
    await waitUntil(async () => (await composerValue()) === '', 'the first duplicate ack to clear the draft')
    const afterFirstDuplicate = await composerValue()
    const secondDraft = 'typed after the first duplicate'
    await page.locator('#console-text').fill(secondDraft)
    sendDuplicate(submit.message.messageId, 1)
    await page.waitForTimeout(200)
    const afterSecondDuplicate = await composerValue()
    await screenshot('02-duplicate-draft')
    assert(
      afterFirstDuplicate === '',
      `the first duplicate ack did not clear the draft: ${JSON.stringify(afterFirstDuplicate)}`,
    )
    assert(
      afterSecondDuplicate === secondDraft,
      `the second duplicate ack cleared newer text: ${JSON.stringify(afterSecondDuplicate)}`,
    )
    return { requestMessageId: submit.message.messageId, afterFirstDuplicate, secondDraft, afterSecondDuplicate }
  })

  // -------------------------------------------------------------------------
  // Check 5: diagnostics socket honest lifecycle.
  // -------------------------------------------------------------------------
  await runCheck('5', 'diagnostics socket reports not started, open, then closed', async () => {
    await openConsole()
    const initial = await diagnosticsLabel()
    assert(initial === 'not started', `expected the initial diagnostics label "not started", got ${String(initial)}`)
    await page.getByRole('button', { name: 'Diagnostics socket', exact: true }).click()
    const beforeConnect = diagnostics.connections
    await page.getByRole('button', { name: 'Connect diagnostics socket' }).click()
    await waitUntil(() => diagnostics.connections > beforeConnect, 'the diagnostics WebSocket connection')
    await waitUntil(async () => (await diagnosticsLabel()) === 'open', 'the open diagnostics label')
    const connected = await diagnosticsLabel()
    assert(currentDiagnosticsSocket !== null, 'the diagnostics server has no open socket to close')
    currentDiagnosticsSocket.close(1000, 'wiring harness closes the diagnostics socket')
    await waitUntil(async () => (await diagnosticsLabel()) === 'closed', 'the closed diagnostics label')
    const closed = await diagnosticsLabel()
    await screenshot('05-diagnostics-socket')
    return {
      initial,
      connected,
      closed,
      server: { connections: diagnostics.connections, closes: diagnostics.closes },
    }
  })

  // -------------------------------------------------------------------------
  // Check 3: explicit Reconnect after transport loss bootstraps exactly once.
  // -------------------------------------------------------------------------
  await runCheck('3', 'Reconnect after socket close bootstraps exactly once without replay', async () => {
    await openConsole()
    // The runtime pipeline may report `speaking` before any local media starts.
    // The HUD pill must label that pipeline stage without pulsing as if audio
    // were live.
    sendTurnStarted(1)
    await page.waitForFunction(
      () => {
        const pills = [...document.querySelectorAll('.isla-stage__hud .isla-tag')]
        return pills.some((entry) => entry.textContent?.trim().startsWith('Pipeline: speaking'))
      },
      undefined,
      { timeout: options.timeoutMs },
    )
    const hudBeforeClose = await stageHud()
    assert(
      hudBeforeClose.pulsing === false,
      'the stage HUD pill pulsed on the pipeline speaking stage before any local playback',
    )
    const beforeClose = await probeCounts()
    const beforeConnections = application.connections
    const beforeInbound = application.inbound.length
    assert(currentApplicationSocket !== null, 'the application server has no socket to close')
    currentApplicationSocket.close(1000, 'wiring harness closes the application socket')
    await page.waitForFunction(
      () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'closed',
      undefined,
      { timeout: options.timeoutMs },
    )
    // No auto reconnect, retry, resume or replay may happen on its own.
    await page.waitForTimeout(500)
    const idle = await probeCounts()
    const idleState = await buttonStates()
    const hudAfterClose = await stageHud()
    const idleFrames = application.inbound.slice(beforeInbound)
    const idleKinds = idleFrames.map((entry) => entry.message?.kind).filter((kind) => kind !== undefined)
    await screenshot('03a-transport-closed')
    assert(idleState.connection === 'closed', `expected the console to stay closed, got ${String(idleState.connection)}`)
    assert(idleState.reconnect.present, 'the visible Reconnect action was not rendered after transport loss')
    assert(
      hudBeforeClose.text !== null && hudBeforeClose.text.startsWith('Pipeline:'),
      `the stage HUD pill did not label the pipeline, got ${String(hudBeforeClose.text)}`,
    )
    assert(
      hudAfterClose.text !== null && hudAfterClose.text.startsWith('Pipeline:'),
      `the stage HUD pill lost its pipeline label after transport loss, got ${String(hudAfterClose.text)}`,
    )
    assert(
      hudAfterClose.pulsing === false,
      'the stage HUD pill kept its pulsing class after the socket closed',
    )
    assert(
      hudAfterClose.waveformPresent && hudAfterClose.waveformSpeaking === false,
      `the waveform was not idle after the socket closed: ${JSON.stringify(hudAfterClose)}`,
    )
    assert(
      application.connections === beforeConnections,
      `the console reconnected on its own: ${application.connections - beforeConnections} new connection(s)`,
    )
    assert(
      idle.transportFactoryCalls === beforeClose.transportFactoryCalls,
      `the console created a transport on its own: ${idle.transportFactoryCalls - beforeClose.transportFactoryCalls} new factory call(s)`,
    )
    assert(
      idle.bootstrapCalls === beforeClose.bootstrapCalls,
      `the console bootstrapped on its own: ${idle.bootstrapCalls - beforeClose.bootstrapCalls} new bootstrap(s)`,
    )
    assert(
      idleKinds.every((kind) => kind === 'voice.list'),
      `the console sent ${JSON.stringify(idleKinds)} after the close without an operator action`,
    )
    assert(
      !idleKinds.includes('control.resume') && !idleKinds.includes('control.stop'),
      'the console sent a control frame after transport loss without an operator action',
    )

    const beforeReconnect = application.connections
    const beforeReconnectProbe = await probeCounts()
    const beforeReconnectInbound = application.inbound.length
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'open',
      undefined,
      { timeout: options.timeoutMs },
    )
    await page.waitForFunction(
      (sessionId) => document.querySelector('main')?.innerText?.includes(sessionId) === true,
      SESSION_ID,
      { timeout: options.timeoutMs },
    )
    await page.waitForTimeout(400)
    const afterReconnect = await probeCounts()
    const newConnections = application.connections - beforeReconnect
    const replayKinds = application.inbound
      .slice(beforeReconnectInbound)
      .map((entry) => entry.message?.kind)
      .filter((kind) => kind !== undefined)
    await screenshot('03b-reconnected')
    assert(newConnections === 1, `expected exactly one new application connection, got ${newConnections}`)
    assert(
      afterReconnect.bootstrapCalls === beforeReconnectProbe.bootstrapCalls + 1,
      `expected exactly one new bootstrap, got ${afterReconnect.bootstrapCalls - beforeReconnectProbe.bootstrapCalls}`,
    )
    assert(
      afterReconnect.transportFactoryCalls >= beforeReconnectProbe.transportFactoryCalls + 1,
      'Reconnect did not create a fresh transport',
    )
    assert(
      !replayKinds.includes('control.resume') &&
        !replayKinds.includes('control.stop') &&
        !replayKinds.includes('input.submit'),
      `the reconnect replayed ${JSON.stringify(replayKinds)}`,
    )
    assert(
      replayKinds.every((kind) => kind === 'voice.list' || kind === 'operator.bootstrap'),
      `the reconnect emitted unexpected frames ${JSON.stringify(replayKinds)}`,
    )
    return {
      beforeClose,
      hudBeforeClose,
      hudAfterClose,
      idle,
      idleKinds,
      beforeReconnectProbe,
      afterReconnect,
      newConnections,
      replayKinds,
      connection: (await buttonStates()).connection,
    }
  })

  // -------------------------------------------------------------------------
  // Check 4: after performer disposal no performer action remains available.
  // -------------------------------------------------------------------------
  await runCheck('4', 'performer disposal disables the performer actions', async () => {
    await openConsole()
    await page.locator('#console-text').fill('disposal guard draft')
    assert(currentApplicationSocket !== null, 'the application server has no socket to close for disposal')
    currentApplicationSocket.close(1000, 'wiring harness disposes the performer')
    await page.waitForFunction(
      () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'closed',
      undefined,
      { timeout: options.timeoutMs },
    )
    await waitUntil(async () => {
      const state = await buttonStates()
      return state.attach.disabled && state.bootstrap.disabled
    }, 'the disposed performer to disable Attach and Bootstrap')
    const observed = await buttonStates()
    await screenshot('04-performer-disposed')
    assert(observed.connection === 'closed', `expected a closed connection after disposal, got ${String(observed.connection)}`)
    assert(observed.submit.present && observed.submit.disabled, 'Submit input stayed enabled after performer disposal')
    assert(observed.attach.present && observed.attach.disabled, 'Attach performer stayed enabled after performer disposal')
    assert(observed.bootstrap.present && observed.bootstrap.disabled, 'Bootstrap operator stayed enabled after performer disposal')
    // The shipped Reconnect action is not a performer request: it starts a fresh
    // bootstrap and is the only recovery affordance after transport loss. The
    // behaviour that was verified manually is that it restores the session
    // (check 3), so the harness records the button as enabled instead of
    // asserting a disabled state that no production path implements.
    assert(
      observed.reconnect.present && observed.reconnect.disabled === false,
      'the Reconnect recovery action was not the enabled action after performer disposal',
    )
    return {
      ...observed,
      reconnectDisabled: observed.reconnect.disabled,
      note: 'Reconnect remains enabled because it starts a new bootstrap; check 3 verifies it does so exactly once.',
    }
  })

  // -------------------------------------------------------------------------
  // Check 6: narrow viewport removes the floating Local Receipts overlay.
  // -------------------------------------------------------------------------
  await runCheck('6', 'narrow viewport does not float Local Receipts or occlude the Control Deck', async () => {
    await page.setViewportSize({ width: 1280, height: 1000 })
    await openConsole()
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('.isla-card')]
        const card = cards.find((entry) =>
          entry.querySelector(':scope > .isla-card__head .isla-card__title')?.textContent?.includes('Local Receipts'),
        )
        return card !== undefined && getComputedStyle(card).position === 'absolute'
      },
      undefined,
      { timeout: options.timeoutMs },
    )
    const wide = await layoutObservation()
    assert(wide.localReceiptsPresent, 'the Local Receipts panel was not rendered at the wide viewport')
    assert(wide.position === 'absolute', `expected the wide Local Receipts overlay to float, got ${String(wide.position)}`)

    await page.setViewportSize({ width: 900, height: 1000 })
    await page.waitForFunction(() => window.matchMedia('(max-width: 1100px)').matches, undefined, {
      timeout: options.timeoutMs,
    })
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('.isla-card')]
        const card = cards.find((entry) =>
          entry.querySelector(':scope > .isla-card__head .isla-card__title')?.textContent?.includes('Local Receipts'),
        )
        if (card === undefined) return false
        const position = getComputedStyle(card).position
        return position !== 'absolute' && position !== 'fixed'
      },
      undefined,
      { timeout: options.timeoutMs },
    )
    await page.waitForTimeout(300)
    const narrow = await layoutObservation()
    await screenshot('06-narrow-viewport')
    assert(narrow.localReceiptsPresent && narrow.controlDeckPresent, 'Local Receipts or the Control Deck was not rendered narrow')
    assert(
      narrow.position !== 'absolute' && narrow.position !== 'fixed',
      `the Local Receipts overlay still floats at ${narrow.innerWidth}px as ${String(narrow.position)}`,
    )
    assert(narrow.inlinePosition === '', `floating geometry was still applied inline: ${String(narrow.inlinePosition)}`)
    assert(
      narrow.scrollWidth === narrow.innerWidth,
      `document scrollWidth ${narrow.scrollWidth} !== innerWidth ${narrow.innerWidth}`,
    )
    assert(narrow.occludesControlDeck === false, 'the Local Receipts panel occludes the Control Deck at the narrow viewport')
    return { wide, narrow }
  })
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  failed = true
} finally {
  report.finishedAt = new Date().toISOString()
  report.checks = checks
  if (report.errors.length > 0) {
    failed = true
    report.failure = report.failure ?? `unexpected browser page errors: ${report.errors[0]}`
  }
  if (report.consoleErrors.length > 0) {
    failed = true
    report.failure = report.failure ?? `unexpected browser console errors: ${report.consoleErrors[0].text}`
  }
  report.verdict = failed ? 'failed' : 'passed'
  if (failed) process.exitCode = 1
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const summary = [
    `M2 console wiring acceptance: ${report.verdict}`,
    `page: ${report.pageUrl ?? 'not started'}`,
    `failure: ${report.failure ?? 'none'}`,
    `checks: ${checks.filter((entry) => entry.status === 'pass').length}/${checks.length} passed`,
    `browser errors: ${report.errors.length}`,
    `console errors: ${report.consoleErrors.length}`,
    '',
    ...checks.map((entry) => `${entry.status === 'pass' ? 'PASS' : 'FAIL'} ${entry.id}: ${entry.name}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`),
    '',
    ...report.errors.map((entry) => `error: ${entry}`),
    ...report.consoleErrors.map((entry) => `console.error: ${entry.text}`),
  ].join('\n')
  await writeFile(path.join(outDir, 'summary.txt'), `${summary}\n`, 'utf8')
  if (browser !== null) await browser.close()
  if (viteServer !== null) await viteServer.close()
  for (const socket of [...application.sockets]) socket.terminate()
  await new Promise((resolve) => applicationServer.close(resolve))
  for (const socket of [...diagnostics.sockets]) socket.terminate()
  diagnosticsServer.close(() => {})
}

if (report.verdict === 'passed') {
  console.log(`M2 console wiring acceptance passed; report: ${path.join(outDir, 'report.json')}`)
} else {
  console.error(report.failure ?? 'console wiring acceptance failed')
  console.error(`report: ${path.join(outDir, 'report.json')}`)
}
