#!/usr/bin/env node
/*
 * M2 console StrictMode startup regression.
 *
 * This harness mounts the real `ConsoleApp` under React `StrictMode` in a real
 * browser. It uses the real application transport and the platform WebSocket;
 * only the performer machine is replaced, because this check is about startup
 * lifecycle rather than session behaviour. A local WebSocket server supplies
 * the bootstrap snapshot.
 *
 * The regression is the React StrictMode development cycle: an immediate
 * bootstrap opens a WebSocket on the discarded first mount and closes it before
 * the connection can settle through a Vite proxy. The fixed console defers only
 * the bootstrap call by one task, so the discarded transport factory instance
 * makes no bootstrap or socket attempt; the retained mount bootstraps once,
 * opens one WebSocket, and closes it only when the page unmounts.
 *
 * Playwright is supplied externally, following the convention of the other
 * browser acceptance scripts in this directory. It is not part of `pnpm test`.
 *
 * Usage:
 *   node test/browser/console-startup-acceptance.mjs \
 *     --playwright /path/to/playwright \
 *     --output /tmp/isla-m2-console-startup
 *
 * Options:
 *   --playwright <path>  Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
 *   --chromium <path>    Chromium executable (env ISLA_CHROMIUM_EXECUTABLE)
 *   --url <url>          Existing console-startup page URL; skips the local Vite start
 *   --output <dir>       Artifact directory (env ISLA_CONSOLE_STARTUP_OUTPUT)
 *   --timeout <ms>       Per-observation timeout (env ISLA_CONSOLE_STARTUP_TIMEOUT_MS)
 *   --headed             Run headed (env ISLA_CONSOLE_STARTUP_HEADED=1)
 *   --sandbox            Keep Chromium's sandbox (default off)
 *   --help               Show this help
 */

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)

const SNAPSHOT = {
  protocolVersion: '0.2',
  messageId: 'startup-snapshot',
  sessionId: 'session-console-startup',
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

const HELP = `M2 console StrictMode startup regression

Usage:
  node test/browser/console-startup-acceptance.mjs --playwright <path> [options]

Options:
  --playwright <path>  Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
  --chromium <path>    Chromium executable (env ISLA_CHROMIUM_EXECUTABLE)
  --url <url>          Existing console-startup page URL; skips the local Vite start
  --output <dir>       Artifact directory (env ISLA_CONSOLE_STARTUP_OUTPUT)
  --timeout <ms>       Per-observation timeout (env ISLA_CONSOLE_STARTUP_TIMEOUT_MS)
  --headed             Run headed
  --sandbox            Keep Chromium's sandbox
  --help               Show this help
`

function parseArgs(argv) {
  const options = {
    url: process.env.ISLA_CONSOLE_STARTUP_URL ?? null,
    output: process.env.ISLA_CONSOLE_STARTUP_OUTPUT ?? null,
    playwright: process.env.ISLA_PLAYWRIGHT_MODULE ?? null,
    chromium: process.env.ISLA_CHROMIUM_EXECUTABLE ?? null,
    headless: process.env.ISLA_CONSOLE_STARTUP_HEADED !== '1',
    sandbox: process.env.ISLA_CONSOLE_STARTUP_SANDBOX === '1',
    timeoutMs: Number(process.env.ISLA_CONSOLE_STARTUP_TIMEOUT_MS ?? 20000),
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
  ? `/tmp/isla-m2-console-startup/${stamp}`
  : path.resolve(options.output)
await mkdir(outDir, { recursive: true })

const report = {
  startedAt: new Date().toISOString(),
  pageUrl: options.url,
  steps: [],
  observations: {},
  errors: [],
  consoleErrors: [],
  verdict: 'failed',
}

const websocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await new Promise((resolve, reject) => {
  websocketServer.once('listening', resolve)
  websocketServer.once('error', reject)
})
const address = websocketServer.address()
assert(typeof address === 'object' && address !== null, 'the WebSocket server has no TCP address')

const serverObservation = { connections: 0, closes: 0 }
let connectedSocket = null
websocketServer.on('connection', (socket) => {
  serverObservation.connections += 1
  connectedSocket = socket
  socket.on('close', () => {
    serverObservation.closes += 1
    if (connectedSocket === socket) connectedSocket = null
  })
  socket.send(JSON.stringify(SNAPSHOT))
})

let webSocketServerClosed = false

async function closeWebSocketServer() {
  if (webSocketServerClosed) return
  webSocketServerClosed = true
  await new Promise((resolve) => websocketServer.close(resolve))
}

let viteServer = null
let browser = null
let phase = 'startup'
try {
  let pageUrl = options.url
  if (pageUrl === null) {
    viteServer = await createViteServer({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('.', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    })
    await viteServer.listen()
    const localUrl = viteServer.resolvedUrls?.local?.[0]
    assert(localUrl !== undefined, 'the local Vite server did not report a URL')
    pageUrl = new URL('console-startup.html', localUrl).toString()
  }
  report.pageUrl = pageUrl

  const socketUrl = `ws://127.0.0.1:${address.port}/app`
  const { chromium } = loadPlaywright(options.playwright)
  browser = await chromium.launch({
    headless: options.headless,
    sandbox: options.sandbox,
    executablePath: options.chromium ?? undefined,
    args: ['--disable-gpu', '--disable-gpu-compositing', '--disable-accelerated-2d-canvas', '--mute-audio'],
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } })
  page.setDefaultTimeout(options.timeoutMs)
  page.on('pageerror', (error) => report.errors.push(`pageerror: ${String(error)}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    report.consoleErrors.push({ phase, text: message.text() })
  })

  await page.addInitScript((applicationSocketUrl) => {
    window.__islaStartupSocketUrl = applicationSocketUrl
    const OriginalWebSocket = window.WebSocket
    const observation = { created: [], opened: [], closed: [] }
    window.__islaSocketObservation = observation
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const socket = new target(...args)
        const url = String(args[0] ?? '')
        // Only the application socket belongs to this regression. Vite's HMR
        // client also opens a WebSocket, and it must not be counted.
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
  }, socketUrl)

  phase = 'startup'
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'open',
    undefined,
    { timeout: options.timeoutMs },
  )
  // Let the discarded StrictMode pass and any deferred task settle before the
  // lifecycle counts are read.
  await page.waitForTimeout(250)

  const observation = await page.evaluate(() => {
    const probe = window.__islaConsoleStartup ?? { transportFactoryCalls: [], bootstrapCalls: [], bootstrapResolved: [] }
    const socket = window.__islaSocketObservation ?? { created: [], opened: [], closed: [] }
    return {
      transportFactoryCalls: probe.transportFactoryCalls.length,
      bootstrapCalls: probe.bootstrapCalls.length,
      bootstrapResolved: probe.bootstrapResolved.length,
      socketCreated: socket.created.length,
      socketOpened: socket.opened.length,
      socketClosed: socket.closed.length,
      connection: document.querySelector('.console__connection-label')?.textContent?.trim() ?? null,
      text: document.querySelector('main')?.innerText ?? '',
    }
  })
  report.observations.startup = { ...observation, server: { ...serverObservation } }

  assert(observation.transportFactoryCalls >= 1, 'the console did not create a transport')
  assert(observation.bootstrapCalls === 1, `expected one bootstrap attempt, got ${observation.bootstrapCalls}`)
  assert(observation.bootstrapResolved === 1, `expected one resolved bootstrap, got ${observation.bootstrapResolved}`)
  assert(observation.socketCreated === 1, `expected one WebSocket, got ${observation.socketCreated}`)
  assert(observation.socketOpened === 1, `expected one opened WebSocket, got ${observation.socketOpened}`)
  assert(observation.socketClosed === 0, `expected no WebSocket close during startup, got ${observation.socketClosed}`)
  assert(serverObservation.connections === 1, `expected one server connection, got ${serverObservation.connections}`)
  assert(serverObservation.closes === 0, `expected no server close during startup, got ${serverObservation.closes}`)
  assert(observation.connection === 'open', `expected an open console connection, got ${observation.connection}`)
  assert(observation.text.includes('session-console-startup'), 'the bootstrap session identity was not rendered')

  phase = 'disconnect'
  assert(connectedSocket !== null, 'the server no longer holds the startup socket')
  // Drop the established connection without a close handshake: the browser
  // observes an unclean runtime close (code 1006), so the console must render
  // the unexpected-close detail instead of hiding it.
  connectedSocket.terminate()
  await page.waitForFunction(
    () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'closed',
    undefined,
    { timeout: options.timeoutMs },
  )
  const disconnect = await page.evaluate(() => ({
    connection: document.querySelector('.console__connection-label')?.textContent?.trim() ?? null,
    // The header renders the transport's connectionDetail in its hint; the
    // connection-detail span carries only the session summary.
    detail: document.querySelector('.console__header .console__hint')?.textContent?.trim() ?? null,
    text: document.querySelector('main')?.innerText ?? '',
  }))
  const disconnectDeadline = Date.now() + options.timeoutMs
  while (serverObservation.closes < 1 && Date.now() < disconnectDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  report.observations.disconnect = { ...disconnect, server: { ...serverObservation } }
  assert(disconnect.connection === 'closed', `expected a closed console connection, got ${disconnect.connection}`)
  assert(
    disconnect.detail !== null &&
      /application transport closed unexpectedly \(code \d+\)/.test(disconnect.detail),
    `expected the visible unexpected-close detail, got ${String(disconnect.detail)}`,
  )
  assert(
    disconnect.text.includes('application transport closed unexpectedly'),
    'the unexpected-close detail was not visible in the console body',
  )
  assert(serverObservation.closes === 1, `expected one server close after disconnect, got ${serverObservation.closes}`)

  // Reload against the still-running local WebSocket server. The new document
  // must create and open exactly one fresh application socket and must not
  // record a startup close.
  phase = 'reload'
  const beforeReload = { ...serverObservation }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'open',
    undefined,
    { timeout: options.timeoutMs },
  )
  await page.waitForTimeout(250)
  const reload = await page.evaluate(() => {
    const probe = window.__islaConsoleStartup ?? { transportFactoryCalls: [], bootstrapCalls: [], bootstrapResolved: [] }
    const socket = window.__islaSocketObservation ?? { created: [], opened: [], closed: [] }
    return {
      transportFactoryCalls: probe.transportFactoryCalls.length,
      bootstrapCalls: probe.bootstrapCalls.length,
      bootstrapResolved: probe.bootstrapResolved.length,
      socketCreated: socket.created.length,
      socketOpened: socket.opened.length,
      socketClosed: socket.closed.length,
      connection: document.querySelector('.console__connection-label')?.textContent?.trim() ?? null,
      text: document.querySelector('main')?.innerText ?? '',
    }
  })
  const reloadServerConnectionsAdded = serverObservation.connections - beforeReload.connections
  const reloadServerClosesAdded = serverObservation.closes - beforeReload.closes
  report.observations.reload = {
    ...reload,
    server: { ...serverObservation },
    serverConnectionsAdded: reloadServerConnectionsAdded,
    serverClosesAdded: reloadServerClosesAdded,
  }
  assert(reload.transportFactoryCalls >= 1, 'the reloaded console did not create a transport')
  assert(reload.bootstrapCalls === 1, `expected one bootstrap attempt after reload, got ${reload.bootstrapCalls}`)
  assert(reload.bootstrapResolved === 1, `expected one resolved bootstrap after reload, got ${reload.bootstrapResolved}`)
  assert(reload.socketCreated === 1, `expected one new WebSocket after reload, got ${reload.socketCreated}`)
  assert(reload.socketOpened === 1, `expected one opened WebSocket after reload, got ${reload.socketOpened}`)
  assert(reload.socketClosed === 0, `expected no WebSocket close after reload, got ${reload.socketClosed}`)
  assert(reload.connection === 'open', `expected an open console connection after reload, got ${reload.connection}`)
  assert(reload.text.includes('session-console-startup'), 'the reloaded bootstrap session identity was not rendered')
  assert(
    reloadServerConnectionsAdded === 1,
    `expected one new server connection after reload, got ${reloadServerConnectionsAdded}`,
  )
  assert(
    reloadServerClosesAdded === 0,
    `expected no server close after reload, got ${reloadServerClosesAdded}`,
  )

  // Unmount the reloaded document and wait for its socket and server close.
  const beforeReloadUnmount = { ...serverObservation }
  await page.evaluate(() => window.__islaUnmountConsole?.())
  await page.waitForFunction(
    () => (window.__islaSocketObservation?.closed.length ?? 0) === 1,
    undefined,
    { timeout: options.timeoutMs },
  )
  const reloadUnmountDeadline = Date.now() + options.timeoutMs
  while (
    serverObservation.closes < beforeReloadUnmount.closes + 1 &&
    Date.now() < reloadUnmountDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const reloadUnmount = await page.evaluate(() => ({
    socketClosed: window.__islaSocketObservation?.closed.length ?? -1,
  }))
  const reloadUnmountServerClosesAdded = serverObservation.closes - beforeReloadUnmount.closes
  report.observations.reloadUnmount = {
    ...reloadUnmount,
    server: { ...serverObservation },
    serverClosesAdded: reloadUnmountServerClosesAdded,
  }
  assert(
    reloadUnmount.socketClosed === 1,
    `expected one WebSocket close on reload unmount, got ${reloadUnmount.socketClosed}`,
  )
  assert(
    reloadUnmountServerClosesAdded === 1,
    `expected one server close on reload unmount, got ${reloadUnmountServerClosesAdded}`,
  )

  // Explicit unmount before the deferred bootstrap timer fires. The first
  // StrictMode mount schedules this unmount before the retained mount schedules
  // bootstrap, so the pending timer must be cleared and no socket may open.
  phase = 'early-unmount'
  const beforeUnmountBeforeBootstrap = { ...serverObservation }
  const unmountUrl = new URL(pageUrl)
  unmountUrl.searchParams.set('scenario', 'unmount-before-bootstrap')
  await page.goto(unmountUrl.toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const probe = window.__islaConsoleStartup
      return probe !== undefined && probe.unmountedAt !== null
    },
    undefined,
    { timeout: options.timeoutMs },
  )
  await page.waitForTimeout(250)
  const unmountBeforeBootstrap = await page.evaluate(() => {
    const probe = window.__islaConsoleStartup ?? { transportFactoryCalls: [], bootstrapCalls: [], bootstrapResolved: [] }
    const socket = window.__islaSocketObservation ?? { created: [], opened: [], closed: [] }
    return {
      transportFactoryCalls: probe.transportFactoryCalls.length,
      bootstrapCalls: probe.bootstrapCalls.length,
      bootstrapResolved: probe.bootstrapResolved.length,
      socketCreated: socket.created.length,
      socketOpened: socket.opened.length,
      socketClosed: socket.closed.length,
      unmounted: probe.unmountedAt !== null,
    }
  })
  const unmountBeforeBootstrapServerConnections =
    serverObservation.connections - beforeUnmountBeforeBootstrap.connections
  const unmountBeforeBootstrapServerCloses = serverObservation.closes - beforeUnmountBeforeBootstrap.closes
  report.observations.unmountBeforeBootstrap = {
    ...unmountBeforeBootstrap,
    server: { ...serverObservation },
    serverConnectionsAdded: unmountBeforeBootstrapServerConnections,
    serverClosesAdded: unmountBeforeBootstrapServerCloses,
  }
  assert(unmountBeforeBootstrap.unmounted, 'the console was not unmounted before bootstrap')
  assert(unmountBeforeBootstrap.transportFactoryCalls >= 1, 'the console did not create a transport')
  assert(
    unmountBeforeBootstrap.bootstrapCalls === 0,
    `expected no bootstrap attempt, got ${unmountBeforeBootstrap.bootstrapCalls}`,
  )
  assert(
    unmountBeforeBootstrap.bootstrapResolved === 0,
    `expected no resolved bootstrap, got ${unmountBeforeBootstrap.bootstrapResolved}`,
  )
  assert(
    unmountBeforeBootstrap.socketCreated === 0,
    `expected no WebSocket, got ${unmountBeforeBootstrap.socketCreated}`,
  )
  assert(
    unmountBeforeBootstrap.socketOpened === 0,
    `expected no opened WebSocket, got ${unmountBeforeBootstrap.socketOpened}`,
  )
  assert(
    unmountBeforeBootstrapServerConnections === 0,
    `expected no server connection, got ${unmountBeforeBootstrapServerConnections}`,
  )
  assert(
    unmountBeforeBootstrapServerCloses === 0,
    `expected no server close, got ${unmountBeforeBootstrapServerCloses}`,
  )

  // Stop this script's own WebSocket server exactly once, then load the same
  // console page against the unavailable endpoint. The real ConsoleApp must
  // render an error with a visible detail instead of hiding it.
  phase = 'unavailable-server'
  await closeWebSocketServer()
  const unavailableUrl = new URL(pageUrl)
  unavailableUrl.searchParams.delete('scenario')
  await page.goto(unavailableUrl.toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelector('.console__connection-label')?.textContent?.trim() === 'error',
    undefined,
    { timeout: options.timeoutMs },
  )
  // Let the browser's error/close events and the bootstrap rejection settle on
  // the final connection state before reading the rendered detail.
  await page.waitForTimeout(100)
  const unavailable = await page.evaluate(() => ({
    connection: document.querySelector('.console__connection-label')?.textContent?.trim() ?? null,
    detail: document.querySelector('.console__header .console__hint')?.textContent?.trim() ?? null,
    connectionSummary: document.querySelector('.console__header .console__connection-detail')?.textContent?.trim() ?? null,
  }))
  report.observations.unavailableServer = {
    ...unavailable,
    server: { ...serverObservation },
    serverClosed: webSocketServerClosed,
  }
  assert(unavailable.connection === 'error', `expected an error console connection, got ${unavailable.connection}`)
  assert(
    unavailable.detail !== null && unavailable.detail.length > 0,
    `expected a visible connection detail, got ${String(unavailable.detail)}`,
  )
  assert(report.errors.length === 0, `unexpected browser errors: ${report.errors[0]}`)

  // Every console error is preserved in the report. The only one this
  // deliberately unavailable phase may produce is the browser's refused
  // WebSocket connection to the known application endpoint; anything else is a
  // real regression and must fail the run.
  const unexpectedConsoleErrors = report.consoleErrors.filter(
    (entry) =>
      !(
        entry.phase === 'unavailable-server' &&
        entry.text.includes(socketUrl) &&
        entry.text.includes('ERR_CONNECTION_REFUSED')
      ),
  )
  report.unexpectedConsoleErrors = unexpectedConsoleErrors
  assert(
    unexpectedConsoleErrors.length === 0,
    `unexpected browser console errors: ${unexpectedConsoleErrors
      .map((entry) => `[${entry.phase}] ${entry.text}`)
      .join(' | ')}`,
  )

  report.verdict = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const summary = [
    `M2 console StrictMode startup regression: ${report.verdict}`,
    `page: ${report.pageUrl ?? 'not started'}`,
    `failure: ${report.failure ?? 'none'}`,
    `browser errors: ${report.errors.length}`,
    `console errors: ${report.consoleErrors.length}`,
    '',
    ...report.errors.map((entry) => `error: ${entry}`),
    ...report.consoleErrors.map((entry) => `console.error [${entry.phase}]: ${entry.text}`),
  ].join('\n')
  await writeFile(path.join(outDir, 'summary.txt'), `${summary}\n`, 'utf8')
  if (browser !== null) await browser.close()
  if (viteServer !== null) await viteServer.close()
  await closeWebSocketServer()
}

if (report.verdict === 'passed') {
  console.log(`M2 console StrictMode startup regression passed; report: ${path.join(outDir, 'report.json')}`)
} else {
  console.error(report.failure ?? 'startup regression failed')
  console.error(`report: ${path.join(outDir, 'report.json')}`)
}
