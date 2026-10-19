#!/usr/bin/env node
/*
 * Root Vite entry dynamic-audio fetch — real browser acceptance.
 *
 * The root Vite entry (`pnpm dev`, config `vite.config.ts`) forwards `/audio`
 * to the runtime on the same origin, alongside `/health`, `/diag`, `/app` and
 * `/operator`. This script drives the real demo page served by that entry in
 * Chromium: the genuine operator bootstrap and Resume through the page
 * controls, then a same-origin `POST /audio` fetch from the page context. A
 * same-origin browser POST carries the `Origin` header, so the runtime's strict
 * exact-origin policy admits it; the request also carries the explicit
 * audio-fetch header. The response bytes are compared with the prepared WAV
 * asset that the demo's fixture source registers in the real M1 registry.
 *
 * Prerequisites (started separately, real processes):
 *   pnpm dev:loop   # runtime on 127.0.0.1:4317 (test/browser/loop-server.ts)
 *   pnpm dev        # root Vite entry on 127.0.0.1:5173
 *
 * Run:
 *   node test/browser/root-entry-audio-browser.mjs
 *
 * Playwright and Chromium are discovered from the normal tool environment:
 * Playwright resolves from the project's installed packages (or any Node
 * resolution path), and Chromium is the browser Playwright itself selects.
 * Both can be pointed at a prepared local toolchain instead:
 *
 * Env overrides:
 *   ISLA_ROOT_ENTRY_ORIGIN  default http://127.0.0.1:5173
 *   ISLA_AUDIO_CHECK_REF    default audio://demo/audio-route-check
 *   ISLA_PLAYWRIGHT_PATH    optional Playwright package directory or specifier;
 *                           unset resolves `playwright` normally
 *   ISLA_CHROMIUM_PATH      optional Chromium executable; unset lets Playwright
 *                           choose its own browser
 *
 * The acceptance run recorded in the M5 handoff supplied both variables, since
 * this machine keeps Playwright and Chromium in a prepared tools directory
 * rather than in the project.
 *
 * What it proves: a real browser, on the root entry origin, reaches the
 * runtime's dynamic audio route through the Vite proxy and receives the
 * registered bytes, while the header, method, lifecycle and scope refusals
 * hold. What it does not prove: M2's product resolver, a live provider,
 * acoustic output or a product deployment.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ENTRY_ORIGIN = process.env.ISLA_ROOT_ENTRY_ORIGIN ?? 'http://127.0.0.1:5173'
const CHECK_REF = process.env.ISLA_AUDIO_CHECK_REF ?? 'audio://demo/audio-route-check'
const AUDIO_FETCH_HEADER = 'x-isla-audio-fetch'
const PLAYWRIGHT_PATH = process.env.ISLA_PLAYWRIGHT_PATH ?? null
const CHROMIUM_PATH = process.env.ISLA_CHROMIUM_PATH ?? null
const ASSET_PATH = fileURLToPath(new URL('./assets/segment-0.wav', import.meta.url))

const require = createRequire(import.meta.url)

function loadPlaywright() {
  if (PLAYWRIGHT_PATH !== null) return require(PLAYWRIGHT_PATH)
  try {
    return require('playwright')
  } catch (error) {
    throw new Error(
      'playwright was not found; install it in this project or set ISLA_PLAYWRIGHT_PATH to the Playwright package directory',
      { cause: error },
    )
  }
}

const { chromium } = loadPlaywright()

const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed = true
  const suffix = detail.length > 0 ? ` — ${detail}` : ''
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`)
}

const expectedBytes = readFileSync(ASSET_PATH)
const browser = await chromium.launch({
  headless: true,
  ...(CHROMIUM_PATH !== null ? { executablePath: CHROMIUM_PATH } : {}),
})

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.goto(new URL('/test/browser/loop.html', ENTRY_ORIGIN).toString(), {
    waitUntil: 'domcontentloaded',
  })

  await page.waitForFunction(
    () => {
      const text = document.getElementById('status')?.textContent ?? ''
      return text.includes('session: ') && !text.includes('session: (none)')
    },
    undefined,
    { timeout: 15000 },
  )
  check('the root entry serves the loop demo page to a real browser', true)

  // The genuine operator flow: bootstrap and attach, then Resume, through the
  // page controls. Both fetches below run from the page origin (the root entry).
  await page.click('#start')
  await page.waitForFunction(
    () => {
      const text = document.getElementById('status')?.textContent ?? ''
      return text.includes('operator: true') && text.includes('performer: true')
    },
    undefined,
    { timeout: 15000 },
  )
  check('the page controls complete the real operator bootstrap and performer attach', true)

  const fetchFromPage = (ref, init) =>
    page.evaluate(
      async ({ ref: target, init: requestInit }) => {
        const response = await fetch(`/audio?ref=${encodeURIComponent(target)}`, requestInit)
        const body = await response.arrayBuffer()
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bytes: Array.from(new Uint8Array(body)),
        }
      },
      { ref, init },
    )

  const stopped = await fetchFromPage(CHECK_REF, {
    method: 'POST',
    headers: { [AUDIO_FETCH_HEADER]: '1' },
  })
  check(
    'the browser audio fetch is refused while the session is stopped',
    stopped.status === 409,
    `status ${stopped.status}`,
  )

  await page.click('#resume')
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent ?? '').includes('lifecycle: running'),
    undefined,
    { timeout: 15000 },
  )
  check('the page Resume reaches the runtime and the session runs', true)

  const served = await fetchFromPage(CHECK_REF, {
    method: 'POST',
    headers: { [AUDIO_FETCH_HEADER]: '1' },
  })
  const servedOk =
    served.status === 200 &&
    served.contentType === 'audio/wav' &&
    Buffer.from(served.bytes).equals(expectedBytes)
  check(
    'a real browser same-origin POST reaches the runtime audio route through the root entry and receives the registered bytes',
    servedOk,
    `status ${served.status}, ${served.bytes.length} bytes, content-type ${String(served.contentType)}`,
  )

  const noHeader = await fetchFromPage(CHECK_REF, { method: 'POST' })
  check(
    'the browser audio fetch without the explicit header is refused',
    noHeader.status === 403,
    `status ${noHeader.status}`,
  )

  const getRefused = await fetchFromPage(CHECK_REF, { method: 'GET' })
  check('the browser GET audio fetch is refused', getRefused.status === 405, `status ${getRefused.status}`)

  const unknown = await fetchFromPage('audio://demo/unknown-reference', {
    method: 'POST',
    headers: { [AUDIO_FETCH_HEADER]: '1' },
  })
  check(
    'the running runtime refuses an unknown reference to the browser',
    unknown.status === 404,
    `status ${unknown.status}`,
  )

  if (pageErrors.length > 0) {
    check('the demo page reported no page errors during the audio checks', false, pageErrors.join(' | '))
  }
} finally {
  await browser.close()
}

if (failed) {
  const failedCount = results.filter((result) => !result.ok).length
  console.error(
    `root Vite entry dynamic audio browser acceptance: FAILED (${failedCount}/${results.length} checks failed)`,
  )
  process.exitCode = 1
} else {
  console.log(
    `root Vite entry dynamic audio browser acceptance: PASSED (${results.length}/${results.length} checks)`,
  )
}
