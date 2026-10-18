#!/usr/bin/env node
/*
 * I1 explicit session recovery — browser acceptance script (Playwright).
 *
 * This is an independent acceptance harness for the real running loop demo. It
 * drives the actual page (`test/browser/loop.html`) against the actual M5 runtime
 * (`test/browser/loop-server.ts`) and the real DOM media driver. It does NOT mock
 * media events, playback, receipts or runtime responses: it only observes the
 * page's own status/subtitle/event text and the real WebSocket.
 *
 * The one test-only injection is a thin wrapper around the page's `WebSocket`
 * constructor, installed before any page script runs, so the harness can hold a
 * handle to the real application socket and close it at an exact moment (to
 * reproduce an application-socket closure during playback). It returns the real
 * socket unchanged and adds no behaviour.
 *
 * It never logs or stores operator bootstrap credentials, raw private frames or
 * browser profiles: it uses a fresh ephemeral browser context, records only DOM
 * text and protocol-level observations, and never records HTTP response bodies.
 *
 * ---------------------------------------------------------------------------
 * Prerequisites (paths are supplied at run time, never committed):
 *   - A Playwright module:        --playwright <path> | ISLA_PLAYWRIGHT_MODULE
 *   - A Chromium executable:      --chromium <path>   | ISLA_CHROMIUM_EXECUTABLE
 *                                 (optional: defaults to Playwright's own build)
 *
 * Start the runtime and the page, then run this script against the page URL:
 *   pnpm dev:loop                                   # runtime on 127.0.0.1:4317
 *   pnpm exec vite --config test/browser/vite.config.ts   # page on 127.0.0.1:5173
 *   node test/browser/recovery-acceptance.mjs \
 *     --playwright /path/to/playwright \
 *     --chromium /path/to/chromium \
 *     --url http://127.0.0.1:5173/loop.html \
 *     --output /tmp/isla-recovery-acceptance
 *
 * Exit status is non-zero if any step's assertion fails. The browser is always
 * closed, and screenshots plus a JSON/text report are written to the output dir.
 * ---------------------------------------------------------------------------
 */

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'

const require = createRequire(import.meta.url)

const SEGMENT_TEXTS = ['We talked about the concert.', 'It was loud and fun.']

function parseArgs(argv) {
  const options = {
    url: process.env.ISLA_ACCEPTANCE_URL ?? 'http://127.0.0.1:5173/loop.html',
    output: process.env.ISLA_ACCEPTANCE_OUTPUT ?? null,
    playwright: process.env.ISLA_PLAYWRIGHT_MODULE ?? null,
    chromium: process.env.ISLA_CHROMIUM_EXECUTABLE ?? null,
    headless: process.env.ISLA_ACCEPTANCE_HEADED !== '1',
    sandbox: process.env.ISLA_ACCEPTANCE_SANDBOX === '1',
    timeoutMs: Number(process.env.ISLA_ACCEPTANCE_TIMEOUT_MS ?? 30000),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[index]
    }
    if (arg === '--url') options.url = next()
    else if (arg === '--output') options.output = next()
    else if (arg === '--playwright') options.playwright = next()
    else if (arg === '--chromium') options.chromium = next()
    else if (arg === '--timeout') options.timeoutMs = Number(next())
    else if (arg === '--headed') options.headless = false
    else if (arg === '--sandbox') options.sandbox = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const HELP = `I1 recovery browser acceptance script

Usage:
  node test/browser/recovery-acceptance.mjs --playwright <path> [--chromium <path>] [options]

Options:
  --url <url>         Page URL (env ISLA_ACCEPTANCE_URL; default http://127.0.0.1:5173/loop.html)
  --output <dir>      Artifact directory (env ISLA_ACCEPTANCE_OUTPUT; default /tmp/isla-recovery-acceptance/<timestamp>)
  --playwright <path> Playwright module or package directory (env ISLA_PLAYWRIGHT_MODULE)
  --chromium <path>   Chromium executable (env ISLA_CHROMIUM_EXECUTABLE; default Playwright bundled)
  --timeout <ms>      Per-observation timeout (env ISLA_ACCEPTANCE_TIMEOUT_MS; default 30000)
  --headed            Run headed (env ISLA_ACCEPTANCE_HEADED=1 for headed)
  --sandbox           Keep Chromium's sandbox (default off)
  --help              Show this help
`

/* ------------------------------------------------------------------ helpers */

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function countOf(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/* -------------------------------------------------------------- page driving */

async function acceptanceState(page) {
  return page.evaluate(() => {
    const state = window.__islaAcceptance ?? { events: [], subtitles: [], errors: [], media: [], protocol: [] }
    return {
      events: [...state.events],
      subtitles: [...state.subtitles],
      errors: [...state.errors],
      media: [...(state.media ?? [])],
      protocol: [...(state.protocol ?? [])],
    }
  })
}

/** The live state of the current native media element (never synthesized). */
async function mediaState(page) {
  return page.evaluate(() =>
    window.__islaAcceptance?.mediaState ? window.__islaAcceptance.mediaState() : { element: false },
  )
}

async function readText(page, selector) {
  return (await page.locator(selector).textContent()) ?? ''
}

function statusValue(statusText, key) {
  const line = statusText.split('\n').find((entry) => entry.startsWith(`${key}:`))
  return line === undefined ? null : line.slice(key.length + 1).trim()
}

async function waitFor(fn, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      last = await fn()
      if (predicate(last)) return last
    } catch (error) {
      // A navigation (reload) can destroy the execution context mid-poll.
      last = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last observation: ${JSON.stringify(last)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** Count trusted native media events of `type` (synthesized events never count). */
async function trustedMediaCount(page, type) {
  const state = await acceptanceState(page)
  return state.media.filter((entry) => entry.type === type && entry.isTrusted === true).length
}

/** Wait until this many trusted native media events of `type` have occurred. */
async function waitForMedia(page, type, minCount, timeoutMs) {
  return waitFor(
    () => trustedMediaCount(page, type),
    (count) => count >= minCount,
    timeoutMs,
    `>= ${minCount} trusted native ${type} media event(s)`,
  )
}

/**
 * Read one fresh authoritative snapshot through a separate, unprivileged viewer
 * socket that never attaches. Normal asynchronous cancellation does not push a
 * snapshot to the bound client, so the page's displayed confirmation can stay
 * stale; this reads the runtime's real state instead. `predicate` runs in Node.
 */
async function authoritativeSnapshot(page, predicate, timeoutMs, label) {
  return waitFor(
    () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const viewer = window.__islaAcceptance.originalWebSocket
            const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
            let socket
            try {
              socket = new viewer(`${scheme}://${window.location.host}/app`)
            } catch {
              resolve(null)
              return
            }
            const timer = setTimeout(() => {
              try {
                socket.close()
              } catch {
                // Already closed.
              }
              resolve(null)
            }, 1500)
            socket.addEventListener('message', (event) => {
              if (typeof event.data !== 'string') return
              let parsed
              try {
                parsed = JSON.parse(event.data)
              } catch {
                return
              }
              if (parsed.kind !== 'session.snapshot') return
              clearTimeout(timer)
              try {
                socket.close()
              } catch {
                // Already closed.
              }
              resolve({
                sessionId: parsed.sessionId ?? null,
                epoch: parsed.epoch ?? null,
                lifecycle: parsed.payload?.lifecycle ?? null,
                outputConfirmation: parsed.payload?.outputConfirmation ?? null,
              })
            })
            socket.addEventListener('error', () => {
              clearTimeout(timer)
              resolve(null)
            })
          }),
      ),
    predicate,
    timeoutMs,
    label,
  )
}

async function waitForStatus(page, key, predicate, timeoutMs, label) {
  return waitFor(
    async () => statusValue(await readText(page, '#status'), key),
    predicate,
    timeoutMs,
    label ?? `status ${key}`,
  )
}

async function waitForEvent(page, needle, minCount, timeoutMs) {
  return waitFor(
    async () => countOf((await acceptanceState(page)).events, needle),
    (count) => count >= minCount,
    timeoutMs,
    `>= ${minCount} event(s) containing ${JSON.stringify(needle)}`,
  )
}

async function waitForSession(page, timeoutMs) {
  return waitForStatus(page, 'session', (value) => value !== null && value !== '' && value !== '(none)', timeoutMs, 'a session snapshot')
}

/* ---------------------------------------------------------------------- main */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (options.playwright === null) {
    throw new Error('missing --playwright <path> (or ISLA_PLAYWRIGHT_MODULE)')
  }
  const outputDir =
    options.output ?? path.join(os.tmpdir(), 'isla-recovery-acceptance', new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(outputDir, { recursive: true })

  const report = {
    startedAt: new Date().toISOString(),
    url: options.url,
    output: outputDir,
    chromium: options.chromium ?? '(playwright bundled)',
    headless: options.headless,
    steps: [],
    pageErrors: [],
    verdict: 'failed',
  }

  const playwright = require(options.playwright)
  const chromium = playwright.chromium

  const launchArgs = [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--disable-dev-shm-usage',
  ]
  if (!options.sandbox) launchArgs.push('--no-sandbox')

  const browser = await chromium.launch({
    headless: options.headless,
    ...(options.chromium !== null ? { executablePath: options.chromium } : {}),
    args: launchArgs,
  })

  let context
  let stepCounter = 0
  const stepResults = report.steps

  async function step(name, body) {
    stepCounter += 1
    const record = {
      index: stepCounter,
      name,
      status: 'passed',
      assertions: [],
      observations: [],
      durationMs: 0,
    }
    stepResults.push(record)
    const started = Date.now()
    const shared = {
      note(message) {
        record.observations.push(message)
      },
      check(condition, message) {
        record.assertions.push(message)
        assert(condition, message)
      },
    }
    try {
      await body(shared)
    } catch (error) {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      try {
        await page.screenshot({ path: path.join(outputDir, `${String(stepCounter).padStart(2, '0')}-${slug(name)}-failure.png`) })
      } catch {
        // A screenshot failure must not mask the original error.
      }
      throw error
    } finally {
      record.durationMs = Date.now() - started
      if (record.status === 'passed') {
        try {
          await page.screenshot({ path: path.join(outputDir, `${String(stepCounter).padStart(2, '0')}-${slug(name)}.png`) })
        } catch {
          // Screenshots are diagnostic; a failure here is not a step failure.
        }
      }
    }
  }

  let page
  try {
    context = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
    page = await context.newPage()
    page.setDefaultTimeout(options.timeoutMs)

    page.on('pageerror', (error) => report.pageErrors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      // Ignore only the known harmless favicon request, by exact resource.
      const url = String(message.location?.()?.url ?? '')
      if (url.endsWith('/favicon.ico')) return
      report.pageErrors.push(`console.error: ${message.text()}`)
    })

    await page.addInitScript(() => {
      // Observation only: accumulate distinct event/subtitle text, native media
      // events, selected protocol fields and page errors across the session, and
      // retain the real WebSocket handles. The real /app socket stays untouched
      // except that a test may close it explicitly.
      const store = { events: [], subtitles: [], errors: [], sockets: [], media: [], protocol: [], mediaElements: [] }
      window.__islaAcceptance = store
      window.addEventListener('error', (event) => store.errors.push(String(event.message)))
      window.addEventListener('unhandledrejection', (event) => store.errors.push(String(event.reason)))

      // Native media instrumentation: record trusted play/pause/finish events on
      // the real audio elements the driver creates, plus their live state. No
      // media event is ever synthesized.
      const originalCreateElement = Document.prototype.createElement
      Document.prototype.createElement = function islaAcceptanceCreateElement(tag, elementOptions) {
        const created = originalCreateElement.call(this, tag, elementOptions)
        const name = String(tag).toLowerCase()
        if (name === 'audio' || name === 'video') {
          store.mediaElements.push(created)
          for (const type of ['playing', 'ended', 'pause', 'emptied', 'error']) {
            created.addEventListener(type, (event) => {
              store.media.push({
                type,
                currentTime: Number(created.currentTime) || 0,
                isTrusted: event.isTrusted === true,
              })
            })
          }
        }
        return created
      }
      // Live state of the CURRENT native media element. A released handle has an
      // empty `src` attribute/property, NETWORK_EMPTY and HAVE_NOTHING. The
      // element's `currentSrc` is deliberately NOT used: Chromium keeps the last
      // resource URL there after a real release, so it would report a stale
      // source for correctly released media.
      store.mediaState = () => {
        const element = store.mediaElements[store.mediaElements.length - 1] ?? null
        if (element === null) {
          return { element: false, paused: null, ended: null, currentTime: null, hasSrc: false, released: true }
        }
        const srcAttribute = element.getAttribute('src')
        const srcProperty = element.src
        const released =
          (srcAttribute === null || srcAttribute === '') &&
          (srcProperty === null || srcProperty === '') &&
          element.networkState === 0 &&
          element.readyState === 0
        return {
          element: true,
          paused: element.paused,
          ended: element.ended,
          currentTime: element.currentTime,
          hasSrc: !released,
          released,
        }
      }

      const OriginalWebSocket = window.WebSocket
      // An unrecorded constructor for read-only viewer sockets the verifier opens
      // to read a fresh authoritative snapshot without attaching.
      store.originalWebSocket = OriginalWebSocket
      window.WebSocket = function IslaAcceptanceWebSocket(...args) {
        const socket = new OriginalWebSocket(...args)
        store.sockets.push(socket)
        // Selected protocol/identity fields only: no tokens, text, or raw frames.
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return
          let parsed
          try {
            parsed = JSON.parse(event.data)
          } catch {
            return
          }
          const payload = parsed.payload ?? {}
          store.protocol.push({
            kind: parsed.kind ?? null,
            sessionId: parsed.sessionId ?? null,
            epoch: parsed.epoch ?? null,
            action: payload.action ?? null,
            status: payload.status ?? null,
            stage: payload.stage ?? null,
            code: payload.code ?? null,
            reasonCode: payload.reasonCode ?? null,
            outputId: payload.outputId ?? null,
          })
        })
        return socket
      }
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        window.WebSocket[key] = OriginalWebSocket[key]
      }
      window.WebSocket.prototype = OriginalWebSocket.prototype
      // Explicitly close the captured real /app socket (returns its readyState).
      store.closeSocket = (code, reason) => {
        const socket = store.sockets[store.sockets.length - 1]
        if (socket === undefined) return null
        if (socket.readyState === window.WebSocket.OPEN) socket.close(code, reason)
        return socket.readyState
      }

      const observe = () => {
        const eventsEl = document.getElementById('events')
        const subtitleEl = document.getElementById('subtitle')
        if (eventsEl === null || subtitleEl === null) {
          setTimeout(observe, 10)
          return
        }
        const seen = new Set()
        const pushEvents = (text) => {
          for (const line of text.split('\n')) {
            if (line.length > 0 && !seen.has(line)) {
              seen.add(line)
              store.events.push(line)
            }
          }
        }
        pushEvents(eventsEl.textContent ?? '')
        new MutationObserver(() => pushEvents(eventsEl.textContent ?? '')).observe(eventsEl, {
          childList: true,
          characterData: true,
          subtree: true,
        })

        let lastSubtitle = subtitleEl.textContent ?? ''
        if (lastSubtitle.length > 0 && lastSubtitle !== '(none)') store.subtitles.push(lastSubtitle)
        new MutationObserver(() => {
          const value = subtitleEl.textContent ?? ''
          if (value !== lastSubtitle) {
            lastSubtitle = value
            if (value.length > 0 && value !== '(none)') store.subtitles.push(value)
          }
        }).observe(subtitleEl, { childList: true, characterData: true, subtree: true })
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe)
      else observe()
    })

    // ---- Step 1: load and inspect the initial stopped session.
    let retainedSession = null
    await step('initial session is loaded and stopped', async ({ note, check }) => {
      await page.goto(options.url, { waitUntil: 'domcontentloaded' })
      retainedSession = await waitForSession(page, options.timeoutMs)
      const status = await readText(page, '#status')
      note(`status:\n${status}`)
      check(retainedSession === 'session-loop-demo', `initial session id is session-loop-demo (got ${retainedSession})`)
      check(statusValue(status, 'lifecycle') === 'stopped', 'initial lifecycle is stopped')
      check(statusValue(status, 'operator') === 'false', 'operator is not yet enabled')
      check(statusValue(status, 'performer') === 'false', 'performer is not yet attached')
      check((await readText(page, '#subtitle')) === '(none)', 'no subtitle is shown before any turn')
    })

    // ---- Step 2: initial manual Resume.
    await step('initial manual Resume starts the session', async ({ note, check }) => {
      await page.click('#start')
      await waitForStatus(page, 'operator', (value) => value === 'true', options.timeoutMs, 'operator enabled')
      await waitForStatus(page, 'performer', (value) => value === 'true', options.timeoutMs, 'performer attached')
      await page.waitForFunction(() => !document.getElementById('resume').disabled, null, { timeout: options.timeoutMs })
      await page.click('#resume')
      await waitForStatus(page, 'lifecycle', (value) => value === 'running', options.timeoutMs, 'running lifecycle')
      const status = await readText(page, '#status')
      note(`status after Resume:\n${status}`)
      check(statusValue(status, 'last observed server confirmation') === 'confirmed', 'a fresh session reports confirmed output')
    })

    // ---- Step 3: a complete two-segment turn.
    await step('a complete two-segment turn plays both catalog segments', async ({ note, check }) => {
      const before = await acceptanceState(page)
      const completedBefore = countOf(before.events, 'receipt completed ')
      await page.fill('#input-text', 'acceptance: first complete turn')
      await page.click('#send')
      await waitForEvent(page, 'receipt completed ', completedBefore + 2, options.timeoutMs)
      await waitForStatus(page, 'lifecycle', (value) => value === 'running', options.timeoutMs, 'idle running lifecycle')
      const after = await acceptanceState(page)
      const observed = after.subtitles.slice(before.subtitles.length)
      note(`subtitles this turn: ${JSON.stringify(observed)}`)
      note(`completed receipts: ${countOf(after.events, 'receipt completed ')}`)
      check(observed.includes(SEGMENT_TEXTS[0]), 'the first catalog segment subtitle was displayed')
      check(observed.includes(SEGMENT_TEXTS[1]), 'the second catalog segment subtitle was displayed')
      check(countOf(after.events, 'receipt completed ') >= completedBefore + 2, 'two segments completed')
    })

    // ---- Step 4: a real Stop during a new playing turn, then strict Resume.
    await step('ordinary Stop during a new playing turn, then manual Resume and a new complete turn', async ({ note, check }) => {
      const before = await acceptanceState(page)
      const playingBefore = await trustedMediaCount(page, 'playing')
      const cancelBefore = before.protocol.filter((frame) => frame.kind === 'performance.cancel').length
      const cancelReceiptBefore = countOf(before.events, 'receipt cancelled ')
      const resumeAckBefore = before.protocol.filter(
        (frame) => frame.kind === 'control.ack' && frame.action === 'resume',
      ).length
      const sessionBefore = await waitForSession(page, options.timeoutMs)

      await page.fill('#input-text', 'acceptance: stop during a new playing turn')
      await page.click('#send')

      // The NEW output must reach trusted native playing before Stop (never an
      // older one, and never a synthesized event).
      await waitForMedia(page, 'playing', playingBefore + 1, options.timeoutMs)
      const during = await mediaState(page)
      note(`native media state while playing: ${JSON.stringify(during)}`)
      check(
        during.element === true && during.paused === false && during.ended === false,
        'a native media element is currently playing before Stop',
      )

      await page.click('#stop')

      // New server cancellation frame for this Stop.
      const cancelled = await waitFor(
        async () =>
          (await acceptanceState(page)).protocol.filter((frame) => frame.kind === 'performance.cancel'),
        (frames) => frames.length >= cancelBefore + 1,
        options.timeoutMs,
        'a new server performance.cancel frame',
      )
      note(`new cancellation frames this Stop: ${cancelled.length - cancelBefore}`)

      // New cancellation receipt evidence, recorded by the page receipt log (a
      // browser-to-server receipt is not visible on the inbound socket).
      const cancelReceipts = await waitFor(
        async () => countOf((await acceptanceState(page)).events, 'receipt cancelled '),
        (count) => count >= cancelReceiptBefore + 1,
        options.timeoutMs,
        'a new performer cancellation receipt in the page log',
      )
      note(`new cancellation receipts this Stop: ${cancelReceipts - cancelReceiptBefore}`)

      // Local resource cleanup: paused AND no source (or no element at all).
      const cleaned = await waitFor(
        () => mediaState(page),
        (state) => state.element === false || (state.paused === true && state.hasSrc === false),
        options.timeoutMs,
        'local media cleanup after cancellation',
      )
      note(`native media state after cancellation: ${JSON.stringify(cleaned)}`)

      // A fresh authoritative snapshot, because the page's displayed
      // confirmation can stay stale after an asynchronous cancellation.
      const confirmed = await authoritativeSnapshot(
        page,
        (snapshot) =>
          snapshot !== null &&
          snapshot.sessionId === sessionBefore &&
          snapshot.lifecycle === 'stopped' &&
          snapshot.outputConfirmation === 'confirmed',
        options.timeoutMs,
        'the same session stopped with confirmed output',
      )
      note(`authoritative snapshot before Resume: ${JSON.stringify(confirmed)}`)

      // Strict manual Resume once, failing with its real evidence.
      await page.waitForFunction(() => !document.getElementById('resume').disabled, null, { timeout: options.timeoutMs })
      await page.click('#resume')
      const resumeFrames = await waitFor(
        async () =>
          (await acceptanceState(page)).protocol.filter(
            (frame) => frame.kind === 'control.ack' && frame.action === 'resume',
          ),
        (frames) => frames.length >= resumeAckBefore + 1,
        options.timeoutMs,
        'the Resume control acknowledgement',
      )
      const resumeAck = resumeFrames[resumeFrames.length - 1]
      check(
        resumeAck?.status === 'applied',
        `the SAME-session manual Resume was applied (status=${resumeAck?.status} reason=${resumeAck?.reasonCode ?? 'n/a'})`,
      )
      check((await waitForSession(page, options.timeoutMs)) === sessionBefore, 'Resume kept the SAME session identity')

      // A new complete two-segment output follows Resume.
      const completedBefore = countOf((await acceptanceState(page)).events, 'receipt completed ')
      await page.fill('#input-text', 'acceptance: a new turn after Resume')
      await page.click('#send')
      await waitForEvent(page, 'receipt completed ', completedBefore + 2, options.timeoutMs)
      const after = await acceptanceState(page)
      const observed = after.subtitles.slice(before.subtitles.length)
      note(`subtitles after Resume: ${JSON.stringify(observed)}`)
      check(
        observed.includes(SEGMENT_TEXTS[0]) && observed.includes(SEGMENT_TEXTS[1]),
        'a new complete two-segment output followed Resume',
      )
    })

    // ---- Step 5: a real socket close during a newly playing output.
    await step('a real application socket close during a newly playing output is observed', async ({ note, check }) => {
      const before = await acceptanceState(page)
      const playingBefore = await trustedMediaCount(page, 'playing')
      const closedBefore = countOf(before.events, 'socket closed')

      await page.fill('#input-text', 'acceptance: disconnect during a new playing output')
      await page.click('#send')

      // The NEW output must reach trusted native playing before the close.
      await waitForMedia(page, 'playing', playingBefore + 1, options.timeoutMs)

      // Atomically read the live media state and close the real /app socket in the
      // same evaluation, so the trigger is evidenced at the close itself.
      const trigger = await page.evaluate(() => {
        const media = window.__islaAcceptance.mediaState()
        const readyState = window.__islaAcceptance.closeSocket(4001, 'acceptance-disconnect')
        return { media, readyState }
      })
      note(`trigger at close: ${JSON.stringify(trigger)}`)
      check(
        trigger.media.element === true && trigger.media.paused === false && trigger.media.ended === false,
        'the new output is in a playing state at the instant of the close',
      )
      check(trigger.readyState === 2 || trigger.readyState === 3, 'the test closed the real /app socket')

      await waitForEvent(page, 'socket closed', closedBefore + 1, options.timeoutMs)
      const socketReady = await page.evaluate(() => window.__islaAcceptance.sockets.at(-1)?.readyState ?? null)
      note(`application socket readyState after close: ${socketReady}`)
      check(socketReady === 3, `the application socket is CLOSED (got ${socketReady})`)

      // Local media cleanup: paused AND no source (or no element at all).
      const cleaned = await waitFor(
        () => mediaState(page),
        (state) => state.element === false || (state.paused === true && state.hasSrc === false),
        options.timeoutMs,
        'local media cleanup after the disconnect',
      )
      note(`native media state after disconnect: ${JSON.stringify(cleaned)}`)
      check(
        cleaned.element === false || (cleaned.paused === true && cleaned.hasSrc === false),
        'local media was released on disconnect',
      )
    })

    // ---- Step 6: reload reattaches to the SAME interrupted session.
    await step('reload reattaches to the SAME interrupted session with unresolved confirmation', async ({ note, check }) => {
      await page.reload({ waitUntil: 'domcontentloaded' })
      const session = await waitForSession(page, options.timeoutMs)
      const status = await readText(page, '#status')
      note(`session after reload: ${session}`)
      note(`status after reload:\n${status}`)
      const confirmation = statusValue(status, 'last observed server confirmation')
      check(
        session === retainedSession,
        `the reloaded page reattaches to the SAME interrupted session (got ${session})`,
      )
      check(confirmation !== 'confirmed', `the interrupted output is NOT confirmed (got ${confirmation})`)
      check(statusValue(status, 'operator') === 'false', 'operator is re-established only on demand')
      check((await readText(page, '#subtitle')) === '(none)', 'no subtitle is replayed on reattach')
      check(countOf((await acceptanceState(page)).events, 'receipt ') === 0, 'no receipt is replayed on reattach')
    })

    // ---- Step 7: explicit acknowledgement and recovery to a stopped successor.
    await step('explicit acknowledgement and recovery retires the interrupted session', async ({ note, check }) => {
      const appliedBefore = countOf((await acceptanceState(page)).events, 'recovery applied')
      await waitForStatus(page, 'session', (value) => value === retainedSession, options.timeoutMs, 'the retained session')
      await page.click('#start')
      await waitForStatus(page, 'operator', (value) => value === 'true', options.timeoutMs, 'operator enabled')
      await waitForStatus(page, 'performer', (value) => value === 'true', options.timeoutMs, 'performer attached')
      await page.check('#recover-ack')
      await page.waitForFunction(() => !document.getElementById('recover').disabled, null, { timeout: options.timeoutMs })
      const retiredSession = retainedSession
      await page.click('#recover')
      await waitForEvent(page, 'recovery applied', appliedBefore + 1, options.timeoutMs)
      const recovery = await readText(page, '#recovery-status')
      note(`recovery status:\n${recovery}`)
      const retired = statusValue(recovery, 'retired session')
      const successor = statusValue(recovery, 'successor session')
      check(retired === retiredSession, `the retired session is the interrupted session (got ${retired})`)
      check(successor !== null && successor !== '' && successor !== '(none)', 'a successor session id is reported')
      check(successor !== retiredSession, 'the successor has a different identity')
      // A visible reconnect action/instruction is provided; recovery never auto-resumes.
      const instruction = await readText(page, '#recovery-instruction')
      note(`recovery instruction: ${instruction}`)
      check(instruction.includes(successor), 'the page names the successor in a reconnect instruction')
      check(await page.locator('#reconnect').isEnabled(), 'a visible reconnect action is available after recovery')
      retainedSession = successor
    })

    // ---- Step 8: the different successor starts stopped with no replay.
    await step('the successor session starts stopped with no replay', async ({ note, check }) => {
      // Exercise the visible reconnect action: it reloads without auto-Resume.
      await page
        .evaluate(() => {
          document.getElementById('reconnect')?.click()
        })
        .catch(() => {})
      const session = await waitForSession(page, options.timeoutMs)
      await waitForStatus(page, 'session', (value) => value === retainedSession, options.timeoutMs, 'the successor session')
      const status = await readText(page, '#status')
      note(`session: ${session}`)
      note(`status:\n${status}`)
      check(session === retainedSession, 'the reconnect action adopts the successor session')
      check(statusValue(status, 'lifecycle') === 'stopped', 'the successor starts stopped')
      check((await readText(page, '#subtitle')) === '(none)', 'the successor does not replay the retired history')
      check(countOf((await acceptanceState(page)).events, 'receipt ') === 0, 'the successor has produced no receipts yet')
    })

    // ---- Step 9: manual Resume and two fresh complete turns.
    await step('manual Resume then two fresh complete turns', async ({ note, check }) => {
      await page.click('#start')
      await waitForStatus(page, 'performer', (value) => value === 'true', options.timeoutMs, 'performer attached')
      await page.click('#resume')
      await waitForStatus(page, 'lifecycle', (value) => value === 'running', options.timeoutMs, 'running lifecycle')
      for (const index of [1, 2]) {
        const before = await acceptanceState(page)
        const completedBefore = countOf(before.events, 'receipt completed ')
        await page.fill('#input-text', `acceptance: fresh turn ${index}`)
        await page.click('#send')
        await waitForEvent(page, 'receipt completed ', completedBefore + 2, options.timeoutMs)
        await waitForStatus(page, 'lifecycle', (value) => value === 'running', options.timeoutMs, 'idle running lifecycle')
        const after = await acceptanceState(page)
        const observed = after.subtitles.slice(before.subtitles.length)
        check(observed.includes(SEGMENT_TEXTS[0]), `turn ${index} displayed the first segment`)
        check(observed.includes(SEGMENT_TEXTS[1]), `turn ${index} displayed the second segment`)
        note(`turn ${index} subtitles: ${JSON.stringify(observed)}`)
      }
      const status = await readText(page, '#status')
      check(statusValue(status, 'lifecycle') === 'running', 'the session is running after two turns')
      check((await waitForSession(page, options.timeoutMs)) === retainedSession, 'both fresh turns ran in the successor session')
      note(`status:\n${status}`)
    })

    // ---- Step 10: another recovery, retaining lineage.
    await step('another recovery retains the session lineage', async ({ note, check }) => {
      const before = await acceptanceState(page)
      const appliedBefore = countOf(before.events, 'recovery applied')
      const beforeSession = retainedSession
      await page.check('#recover-ack')
      await page.waitForFunction(() => !document.getElementById('recover').disabled, null, { timeout: options.timeoutMs })
      await page.click('#recover')
      // Count relative to the current observation store, not a global total.
      await waitForEvent(page, 'recovery applied', appliedBefore + 1, options.timeoutMs)
      const recovery = await readText(page, '#recovery-status')
      note(`recovery status:\n${recovery}`)
      const retired = statusValue(recovery, 'retired session')
      const successor = statusValue(recovery, 'successor session')
      const recoveries = Number(statusValue(recovery, 'recoveries'))
      check(retired === beforeSession, `the second recovery retires the first successor (got ${retired})`)
      check(successor !== beforeSession, 'the second successor has a new identity')
      check(recoveries >= 2, `the successor carries accumulated recovery lineage (recoveries=${recoveries})`)
    })

    report.verdict = 'passed'
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error)
    report.verdict = 'failed'
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    // Unexpected page errors fail the run even if every step passed.
    if (page !== undefined) {
      try {
        const finalState = await acceptanceState(page)
        for (const entry of finalState.errors) report.pageErrors.push(`window error: ${entry}`)
      } catch {
        // A destroyed context means the page is gone; nothing to collect.
      }
    }
    if (report.pageErrors.length > 0 && report.verdict !== 'failed') {
      report.verdict = 'failed'
      report.failure = report.failure ?? `unexpected browser errors: ${report.pageErrors[0]}`
      process.exitCode = 1
    }
    try {
      if (context !== undefined) await context.close()
    } catch {
      // Best-effort cleanup.
    }
    try {
      await browser.close()
    } catch {
      // Best-effort cleanup.
    }
    try {
      await writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      const lines = [
        `I1 recovery acceptance: ${report.verdict}`,
        `url: ${report.url}`,
        `chromium: ${report.chromium}`,
        `page errors: ${report.pageErrors.length}`,
        report.failure !== undefined ? `failure: ${report.failure}` : '',
        '',
        ...report.steps.map(
          (entry) =>
            `${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${String(entry.index).padStart(2, '0')} ${entry.name} (${entry.durationMs}ms)` +
            `${entry.error !== undefined ? ` -> ${entry.error}` : ''}`,
        ),
        '',
        ...report.pageErrors.map((entry) => `page-error: ${entry}`),
      ].filter((line) => line !== '')
      await writeFile(path.join(outputDir, 'summary.txt'), `${lines.join('\n')}\n`, 'utf8')
    } catch {
      // Report writing is best-effort; the exit status already reflects failure.
    }
    process.stdout.write(`${JSON.stringify({ verdict: report.verdict, output: outputDir, steps: report.steps.length, failure: report.failure ?? null })}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
