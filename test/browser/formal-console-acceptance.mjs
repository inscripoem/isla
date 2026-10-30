#!/usr/bin/env node
/*
 * M2 formal product-console acceptance — browser and SQLite observation script.
 *
 * This is a manual acceptance harness, not part of `pnpm test`. It drives the
 * real root Vite entry (`http://127.0.0.1:4173/` by default), the real
 * `ConsoleApp`, the real application WebSocket and the real M1 browser
 * controller behind the runtime. It does not replace media events, receipts or
 * runtime replies with fixtures.
 *
 * The deployment must serve the registered fixed audio resources through the
 * same-origin `POST /audio` route. The controlled test deployment that supplies
 * `createSynthesis` and `audioResources` is a separate M5 deliverable; without
 * it a turn can be accepted but cannot reach playback. The runtime must also
 * use a fresh session database so this script can assert an initial stopped,
 * epoch-0, non-retiring snapshot.
 *
 * The only test-only injection is a thin wrapper around the page's real
 * `WebSocket` constructor, installed before page scripts run. It keeps a handle
 * on the actual application socket so the harness can:
 *   - close it at an exact moment (transport-loss check);
 *   - re-send an old `input.submit` frame (duplicate check);
 *   - re-send an old `performance.receipt` frame (late-frame check).
 * It never records, prints or stores operator bootstrap tokens, response
 * bodies, credentials or browser profiles.
 *
 * ---------------------------------------------------------------------------
 * Prerequisites (paths are supplied at run time, never committed):
 *   - A Playwright module:       --playwright <path> | ISLA_PLAYWRIGHT_MODULE
 *   - A Chromium executable:     --chromium <path>   | ISLA_CHROMIUM_EXECUTABLE
 *                                (optional: defaults to Playwright's own build)
 *
 * Start the runtime and root Vite entry, then run:
 *   node test/browser/formal-console-acceptance.mjs \
 *     --playwright /path/to/playwright \
 *     --output /tmp/isla-m2-formal-console
 *
 * The script covers:
 *   1. a complete two-segment turn with server delivery;
 *   2. Stop clicked in the same browser task as Submit, before playback;
 *   3. Stop during playback and the cancelled stage;
 *   4. manual Resume and another complete two-segment turn;
 *   5. duplicate input and late receipt replay;
 *   6. transport loss during playback;
 *   7. reload without replay, manual attach/bootstrap/Resume;
 *   8. first acknowledged recovery before any retirement, successor adoption,
 *      successor reload and a final complete turn.
 *
 * Exit status is non-zero if any assertion fails. Screenshots plus a JSON and
 * text report are written to the output directory. Browser and console errors
 * also fail the run. The observations are local browser/media and
 * server-reported facts; they are not acoustic, live-provider or Windows
 * evidence, and they do not close a reviewer's acceptance.
 * ---------------------------------------------------------------------------
 */

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

const SEGMENT_TEXTS = ['We talked about the concert.', 'It was loud and fun.']

function parseArgs(argv) {
  const options = {
    url: process.env.ISLA_CONSOLE_ACCEPTANCE_URL ?? 'http://127.0.0.1:4173/',
    output: process.env.ISLA_CONSOLE_ACCEPTANCE_OUTPUT ?? null,
    session: process.env.ISLA_CONSOLE_ACCEPTANCE_SESSION ?? null,
    playwright: process.env.ISLA_PLAYWRIGHT_MODULE ?? null,
    chromium: process.env.ISLA_CHROMIUM_EXECUTABLE ?? null,
    headless: process.env.ISLA_CONSOLE_ACCEPTANCE_HEADED !== '1',
    sandbox: process.env.ISLA_CONSOLE_ACCEPTANCE_SANDBOX === '1',
    timeoutMs: Number(process.env.ISLA_CONSOLE_ACCEPTANCE_TIMEOUT_MS ?? 30000),
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
    else if (argument === '--session') options.session = next()
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

const HELP = `M2 formal product-console acceptance script

Usage:
  node test/browser/formal-console-acceptance.mjs --playwright <path> [--chromium <path>] [options]

Options:
  --url <url>          Console URL (env ISLA_CONSOLE_ACCEPTANCE_URL; default http://127.0.0.1:4173/)
  --output <dir>       Artifact directory (env ISLA_CONSOLE_ACCEPTANCE_OUTPUT; default /tmp/isla-m2-formal-console/<timestamp>)
  --session <id>       Expected initial session (env ISLA_CONSOLE_ACCEPTANCE_SESSION; default adopt the observed session)
  --playwright <path>  Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
  --chromium <path>    Chromium executable (env ISLA_CHROMIUM_EXECUTABLE; default Playwright bundled)
  --timeout <ms>       Per-observation timeout (env ISLA_CONSOLE_ACCEPTANCE_TIMEOUT_MS; default 30000)
  --headed             Run headed (env ISLA_CONSOLE_ACCEPTANCE_HEADED=1 for headed)
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
  ? `/tmp/isla-m2-formal-console/${stamp}`
  : path.resolve(options.output)

const report = {
  startedAt: new Date().toISOString(),
  base: options.url,
  expectedSession: options.session,
  steps: [],
  snapshots: [],
  errors: [],
  verdict: 'failed',
}

await mkdir(outDir, { recursive: true })

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

await page.addInitScript(() => {
  const OriginalWebSocket = window.WebSocket
  const store = { appSockets: [], inputs: [], receipts: [], closes: [] }
  window.__islaM2Acceptance = store

  window.WebSocket = function IslaM2AcceptanceWebSocket(...args) {
    const socket = new OriginalWebSocket(...args)
    const url = String(args[0] ?? '')
    if (url.includes('/app')) {
      store.appSockets.push(socket)
      socket.addEventListener('close', (event) => {
        store.closes.push({ code: event.code, reason: String(event.reason ?? '') })
      })
      const originalSend = socket.send.bind(socket)
      socket.send = function islaM2Send(data) {
        try {
          const parsed = JSON.parse(data)
          if (parsed.kind === 'input.submit') {
            store.inputs.push({
              raw: data,
              messageId: parsed.messageId,
              text: parsed.payload?.text ?? null,
            })
          }
          if (parsed.kind === 'performance.receipt') {
            store.receipts.push({
              raw: data,
              receiptId: parsed.payload?.receiptId ?? null,
              outputId: parsed.payload?.outputId ?? null,
              stage: parsed.payload?.stage ?? null,
            })
          }
        } catch {
          // A non-JSON frame is not one of the observed application messages.
        }
        return originalSend(data)
      }
    }
    return socket
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    window.WebSocket[key] = OriginalWebSocket[key]
  }
  window.WebSocket.prototype = OriginalWebSocket.prototype

  store.openAppSocket = () => {
    const socket = store.appSockets.filter((entry) => entry.readyState === OriginalWebSocket.OPEN).at(-1)
    return socket ?? null
  }
  store.closeAppSocket = () => {
    const socket = store.openAppSocket()
    if (socket === null) return null
    socket.close(4001, 'acceptance-disconnect')
    return socket.readyState
  }
  store.replayInput = (index) => {
    const entry = store.inputs[index]
    const socket = store.openAppSocket()
    if (entry === undefined || socket === null) return false
    socket.send(entry.raw)
    return true
  }
  store.replayReceipt = (index) => {
    const entry = store.receipts[index]
    const socket = store.openAppSocket()
    if (entry === undefined || socket === null) return false
    socket.send(entry.raw)
    return true
  }
})

async function waitForText(needle, timeout = options.timeoutMs) {
  await page.waitForFunction(
    (value) => document.querySelector('main')?.innerText.includes(value) === true,
    needle,
    { timeout },
  )
}

async function fact(label) {
  return page.evaluate((wanted) => {
    for (const element of Array.from(document.querySelectorAll('dl.facts dt'))) {
      if (element.textContent?.trim() === wanted) {
        const value = element.nextElementSibling
        return value?.textContent?.trim() ?? null
      }
    }
    return null
  }, label)
}

async function facts() {
  return {
    session: await fact('Session'),
    lifecycle: await fact('Lifecycle'),
    epoch: await fact('Epoch'),
    outputConfirmation: await fact('Output confirmation'),
    performerAttached: await fact('Performer attached'),
    operatorAuthority: await fact('Operator authority'),
    retiring: await fact('Session retiring'),
    idle: await fact('Idle'),
    activeOutput: await fact('Active output'),
    lastStage: await fact('Last stage'),
    lastSubtitle: await fact('Last subtitle'),
    waitingStage: await fact('Waiting stage'),
    deliveryClassification: await fact('Delivery classification'),
    recoveryStatus: await fact('Recovery status'),
    retiredSession: await fact('Retired session'),
    successorSession: await fact('Successor session'),
    recoveries: await fact('Recoveries'),
    connection: (await page.locator('.console__connection-label').innerText()).trim(),
  }
}

async function settle(label) {
  await page.waitForTimeout(120)
  const current = await facts()
  report.snapshots.push({ label, at: new Date().toISOString(), ...current })
  return current
}

async function note(label, detail = null) {
  const entry = { label, at: new Date().toISOString() }
  if (detail !== null) entry.detail = detail
  report.steps.push(entry)
}

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

async function waitForSessionSnapshot(timeout = options.timeoutMs) {
  await waitUntil(
    () => fact('Session'),
    (value) => value !== null && value !== 'unknown',
    timeout,
    'a session snapshot',
  )
}

async function attachAndBootstrap() {
  await page.getByRole('button', { name: 'Attach performer', exact: true }).click()
  await waitUntil(() => fact('Performer attached'), (value) => value === 'yes', options.timeoutMs, 'performer attached')
  await page.getByRole('button', { name: 'Bootstrap operator', exact: true }).click()
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

async function stopSession() {
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await waitUntil(
    () => fact('Lifecycle'),
    (value) => value === 'stopped',
    options.timeoutMs,
    'stopped lifecycle',
  )
}

async function submit(text) {
  await page.locator('#console-text').fill(text)
  await page.getByRole('button', { name: 'Submit input', exact: true }).click()
}

async function submitAndStopImmediately(text) {
  await page.evaluate((value) => {
    const input = document.querySelector('#console-text')
    if (input === null) throw new Error('console text input is missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('native input setter is unavailable')
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const submitButton = buttons.find((button) => button.textContent?.trim() === 'Submit input')
    return submitButton !== undefined && !submitButton.disabled
  })
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const submitButton = buttons.find((button) => button.textContent?.trim() === 'Submit input')
    const stopButton = buttons.find((button) => button.textContent?.trim() === 'Stop')
    if (submitButton === undefined || stopButton === undefined) {
      throw new Error('submit or Stop button is missing')
    }
    submitButton.click()
    stopButton.click()
  })
}

async function deliveryEventCount() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('main button')).filter((button) =>
      (button.textContent ?? '').includes('delivery.committed'),
    ).length,
  )
}

async function newReceiptStages(before) {
  return page.evaluate(
    (index) => window.__islaM2Acceptance.receipts.slice(index).map((receipt) => receipt.stage),
    before,
  )
}

async function waitForSubtitle(text, timeout = options.timeoutMs) {
  await waitUntil(() => fact('Last subtitle'), (value) => value === text, timeout, `subtitle ${text}`)
}

async function waitForStage(stage, timeout = options.timeoutMs) {
  await waitUntil(() => fact('Last stage'), (value) => value === stage, timeout, `last stage ${stage}`)
}

async function completeTurn(label, text) {
  const beforeReceipts = await page.evaluate(() => window.__islaM2Acceptance.receipts.length)
  const beforeDeliveries = await deliveryEventCount()
  await submit(text)
  await waitForSubtitle(SEGMENT_TEXTS[0])
  await waitForSubtitle(SEGMENT_TEXTS[1])
  await waitUntil(
    () => deliveryEventCount(),
    (count) => count >= beforeDeliveries + 1,
    options.timeoutMs,
    'a new server delivery.committed event for this turn',
  )
  await waitUntil(
    async () => {
      const current = await facts()
      return current.lastStage === 'completed' && current.idle === 'true'
    },
    (value) => value === true,
    options.timeoutMs,
    'completed local playback for this turn',
  )
  const afterReceipts = await page.evaluate(() => window.__islaM2Acceptance.receipts.length)
  const delivered = await waitUntil(
    () => fact('Delivery classification'),
    (value) => value === 'fully-delivered',
    options.timeoutMs,
    'runtime-confirmed fully-delivered delivery',
  )
  const snapshot = await settle(label)
  assert(
    afterReceipts >= beforeReceipts + 4,
    `expected at least four local receipts for two segments, got ${afterReceipts - beforeReceipts}`,
  )
  assert(delivered === 'fully-delivered', `expected fully-delivered, got ${delivered}`)
  return {
    ...snapshot,
    localReceipts: afterReceipts - beforeReceipts,
    newDeliveryEvents: (await deliveryEventCount()) - beforeDeliveries,
  }
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
}

try {
  await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  await waitForSessionSnapshot()
  const initial = await settle('initial snapshot before attach')
  assert(initial.session !== null && initial.session !== 'unknown', 'no initial session identity was observed')
  if (options.session !== null) {
    assert(initial.session === options.session, `expected ${options.session}, got ${initial.session}`)
  } else {
    report.expectedSession = initial.session
  }
  assert(
    initial.lifecycle === 'stopped',
    `initial lifecycle is ${initial.lifecycle}; start the runtime against a fresh session database`,
  )
  assert(initial.epoch === '0', `initial epoch is ${initial.epoch}; start the runtime against a fresh session database`)
  assert(initial.retiring === 'no', `initial retiring is ${initial.retiring}`)
  assert(initial.performerAttached === 'no', `initial performer attached is ${initial.performerAttached}`)
  assert(initial.operatorAuthority === 'no', `initial operator authority is ${initial.operatorAuthority}`)
  await screenshot('01-initial')

  await attachAndBootstrap()
  await resumeSession()
  const running = await settle('attached, operator authorized and manually resumed')
  assert(running.performerAttached === 'yes', 'performer is not attached')
  assert(running.operatorAuthority === 'yes', 'operator authority is not established')
  assert(running.retiring === 'no', `retiring is ${running.retiring} after Resume`)
  await screenshot('02-running')

  const turnOne = await completeTurn('turn 1 complete two-segment playback', 'Formal turn one: complete playback.')
  await note('turn 1 completed', turnOne)
  await screenshot('03-turn-one-completed')

  // Turn 2: submit and Stop in one browser task, before the fixed-audio output
  // is granted. A first attempt that still reaches playback is recorded and
  // retried so the matrix contains a genuine before-playback Stop.
  let beforePlaybackStop = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if ((await fact('Lifecycle')) !== 'running') await resumeSession()
    const beforeReceipts = await page.evaluate(() => window.__islaM2Acceptance.receipts.length)
    await submitAndStopImmediately(`Formal turn two attempt ${attempt}: Stop before playback.`)
    await waitUntil(
      () => fact('Lifecycle'),
      (value) => value === 'stopped',
      options.timeoutMs,
      'stopped lifecycle before playback',
    )
    await page.waitForTimeout(300)
    const stages = await newReceiptStages(beforeReceipts)
    const stoppedBefore = await settle(`stop before playback attempt ${attempt}`)
    beforePlaybackStop = { attempt, stages, ...stoppedBefore }
    await note(`turn 2 stop before playback attempt ${attempt}`, beforePlaybackStop)
    assert(stoppedBefore.idle === 'true', `local playback is not idle after Stop (${stoppedBefore.idle})`)
    if (!stages.includes('started') && !stages.includes('completed')) break
    if (attempt === 2) {
      throw new Error(`Stop before playback reached playback on both attempts: ${JSON.stringify(stages)}`)
    }
  }
  assert(
    beforePlaybackStop !== null &&
      !beforePlaybackStop.stages.includes('started') &&
      !beforePlaybackStop.stages.includes('completed'),
    `Stop before playback observed playback stages ${JSON.stringify(beforePlaybackStop?.stages)}`,
  )
  await screenshot('04-stop-before-playback')

  await resumeSession()
  const beforeCancelReceipts = await page.evaluate(() => window.__islaM2Acceptance.receipts.length)
  await submit('Formal turn three: Stop during playback.')
  await waitForStage('started')
  await stopSession()
  await waitForStage('cancelled')
  const stoppedDuring = await settle('stop during playback')
  const afterCancelReceipts = await page.evaluate(() => window.__islaM2Acceptance.receipts.length)
  assert(stoppedDuring.idle === 'true', `local playback is not idle after Stop (${stoppedDuring.idle})`)
  assert(stoppedDuring.activeOutput === 'none', `active output remains ${stoppedDuring.activeOutput}`)
  assert(afterCancelReceipts > beforeCancelReceipts, 'no new local receipt was recorded for cancellation')
  await note('turn 3 stopped during playback', {
    receiptDelta: afterCancelReceipts - beforeCancelReceipts,
    ...stoppedDuring,
  })
  await screenshot('05-stop-during-playback')

  await resumeSession()
  const turnFour = await completeTurn(
    'turn 4 complete after Stop and Resume',
    'Formal turn four: complete after Resume.',
  )
  await note('turn 4 completed', turnFour)
  await screenshot('06-turn-four-completed')

  // Duplicate and late replay: the real socket re-sends an old input frame and an
  // old completed receipt. The console must not render a second turn or delivery.
  const replayInput = await page.evaluate(() => window.__islaM2Acceptance.replayInput(0))
  const replayReceipt = await page.evaluate(() => window.__islaM2Acceptance.replayReceipt(0))
  assert(replayInput === true, 'the real application socket was unavailable for duplicate input replay')
  assert(replayReceipt === true, 'the real application socket was unavailable for late receipt replay')
  await waitForText('duplicate')
  await page.waitForTimeout(1000)
  const replayState = await settle('duplicate input and late receipt replayed')
  await note('duplicate/late replay', { replayInput, replayReceipt, ...replayState })
  assert(
    replayState.lastStage === 'completed' || replayState.lastStage === 'cancelled',
    `duplicate replay changed playback stage to ${replayState.lastStage}`,
  )
  await screenshot('07-duplicate-late')

  // Transport loss during a new playing turn.
  await submit('Formal turn five: transport loss during playback.')
  await waitForStage('started')
  const closeState = await page.evaluate(() => window.__islaM2Acceptance.closeAppSocket())
  assert(closeState === 2 || closeState === 3, `unexpected socket state after close: ${closeState}`)
  await waitUntil(
    async () => (await page.locator('.console__connection-label').innerText()).trim().toLowerCase(),
    (value) => value === 'closed' || value === 'error',
    options.timeoutMs,
    'closed connection after transport loss',
  )
  const lost = await settle('transport loss during playback')
  assert(lost.idle === 'true', `local playback is not idle after transport loss (${lost.idle})`)
  assert(lost.outputConfirmation === 'unknown', `output confirmation is ${lost.outputConfirmation} after transport loss`)
  await note('transport loss', lost)
  await screenshot('08-transport-loss')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForSessionSnapshot()
  const reloaded = await settle('reloaded after transport loss')
  assert(reloaded.session === report.expectedSession, `reload adopted ${reloaded.session}`)
  assert(reloaded.performerAttached === 'no', 'performer was reattached automatically')
  assert(reloaded.operatorAuthority === 'no', 'operator authority was restored automatically')
  assert(reloaded.lastSubtitle === 'none', `reload replayed subtitle ${reloaded.lastSubtitle}`)
  assert(reloaded.lastStage === 'none', `reload replayed stage ${reloaded.lastStage}`)
  await note('reload reattached to the same interrupted session', reloaded)
  await screenshot('09-reloaded')

  await attachAndBootstrap()
  const beforeRecovery = await settle('connected current session before recovery')
  assert(
    beforeRecovery.retiring === 'no',
    `retiring is ${beforeRecovery.retiring} before the first recovery request`,
  )
  const checkbox = page.getByRole('checkbox')
  const request = page.getByRole('button', { name: 'Request recovery', exact: true })
  const checkboxBefore = await checkbox.isEnabled()
  const requestBefore = await request.isEnabled()
  assert(checkboxBefore, 'recovery acknowledgement is disabled before retirement is reported')
  assert(!requestBefore, 'recovery request is enabled before explicit acknowledgement')
  await note('recovery eligibility before acknowledgement', { checkboxBefore, requestBefore })
  await checkbox.click()
  await waitUntil(
    () => request.isEnabled(),
    (value) => value === true,
    options.timeoutMs,
    'recovery request enabled after acknowledgement',
  )
  const requestAfter = await request.isEnabled()
  assert(requestAfter, 'recovery request is disabled after explicit acknowledgement')
  await note('recovery eligibility after acknowledgement', { requestAfter })
  await screenshot('10-recovery-eligible')

  await request.click()
  await waitUntil(() => fact('Recovery status'), (value) => value === 'applied', options.timeoutMs, 'recovery applied')
  const recovered = await settle('recovery applied')
  assert(recovered.successorSession !== 'none', 'recovery applied without a successor session')
  assert(recovered.retiredSession === report.expectedSession, `retired session is ${recovered.retiredSession}`)
  assert(recovered.successorSession !== report.expectedSession, 'successor identity equals the retired session')
  await note('recovery applied', recovered)
  await screenshot('11-recovery-applied')

  const successor = recovered.successorSession
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForSessionSnapshot()
  const successorLoaded = await settle('successor session loaded')
  assert(successorLoaded.session === successor, `successor bootstrap adopted ${successorLoaded.session}`)
  assert(successorLoaded.lastSubtitle === 'none', `successor replayed subtitle ${successorLoaded.lastSubtitle}`)
  assert(successorLoaded.lastStage === 'none', `successor replayed stage ${successorLoaded.lastStage}`)
  await attachAndBootstrap()
  await resumeSession()
  const successorResumed = await settle('successor manually resumed')
  await note('successor resumed', successorResumed)
  await screenshot('12-successor-resumed')

  const finalTurn = await completeTurn(
    'successor turn complete two-segment playback',
    'Formal turn six: successor playback.',
  )
  const finalState = await settle('final state after successor playback')
  await note('successor turn completed', { ...finalTurn, ...finalState })
  await screenshot('13-successor-complete')

  report.verdict = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error)
  report.verdict = 'failed'
  try {
    await screenshot('failure')
  } catch {
    // Screenshot failure must not mask the original error.
  }
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  if (report.errors.length > 0 && report.verdict !== 'failed') {
    report.verdict = 'failed'
    report.failure = report.failure ?? `unexpected browser errors: ${report.errors[0]}`
    process.exitCode = 1
  }
  await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const summary = [
    `M2 formal console acceptance: ${report.verdict}`,
    `base: ${report.base}`,
    `expected session: ${report.expectedSession ?? 'not observed'}`,
    `failure: ${report.failure ?? 'none'}`,
    `page errors: ${report.errors.length}`,
    '',
    ...report.steps.map((entry) => `- ${entry.label}`),
    '',
    ...report.errors.map((entry) => `error: ${entry}`),
  ].join('\n')
  await writeFile(path.join(outDir, 'summary.txt'), `${summary}\n`, 'utf8')
  await browser.close()
}

if (report.verdict === 'passed') {
  console.log(`M2 formal console acceptance passed; report: ${path.join(outDir, 'report.json')}`)
} else {
  console.error(report.failure)
  console.error(`report: ${path.join(outDir, 'report.json')}`)
}
