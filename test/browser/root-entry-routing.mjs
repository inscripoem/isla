#!/usr/bin/env node
/*
 * Root Vite entry routing — real traffic acceptance.
 *
 * The root Vite entry (`pnpm dev`, config `vite.config.ts`) serves the
 * diagnostics console and forwards the runtime routes on the same origin:
 * `/health`, `/diag` (WebSocket), `/app` (WebSocket), `/operator` (HTTP) and
 * `/audio` (HTTP POST). This script drives the real running servers with real
 * HTTP requests and real WebSocket connections through the root entry. It does
 * not inspect the config shape and does not mock the runtime: the runtime's own
 * origin/host checks decide whether a request is allowed, exactly as a browser
 * would experience it.
 *
 * Prerequisites (started separately, real processes):
 *   pnpm dev:loop   # runtime on 127.0.0.1:4317 (test/browser/loop-server.ts)
 *   pnpm dev        # root Vite entry on 127.0.0.1:5173
 *
 * Run:
 *   node test/browser/root-entry-routing.mjs
 *
 * What it proves: the root entry serves the console page and forwards
 * `/health`, `/operator/bootstrap` (including the origin and header refusals)
 * and the `/app` and `/diag` WebSocket upgrades to the runtime. What it does not
 * prove: product console behavior, live providers, acoustic output or product
 * deployment wiring. It never prints the operator bootstrap token.
 *
 * Exit status is non-zero if any assertion fails.
 */
import { WebSocket } from 'ws'

const ENTRY_ORIGIN = process.env.ISLA_ROOT_ENTRY_ORIGIN ?? 'http://127.0.0.1:5173'
const ALLOWED_ORIGIN = process.env.ISLA_ALLOWED_ORIGIN ?? 'http://127.0.0.1:5173'
const DISALLOWED_ORIGIN = 'http://not-allowed.example'

const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed = true
  const suffix = detail.length > 0 ? ` — ${detail}` : ''
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`)
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, ENTRY_ORIGIN), init)
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/** Opens one WebSocket through the root entry and resolves on its first message. */
function firstMessage(path, origin, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const url = new URL(path, ENTRY_ORIGIN)
    url.protocol = 'ws:'
    const socket = new WebSocket(url.toString(), { origin })
    const timer = setTimeout(() => {
      socket.terminate()
      resolve({ opened: false, message: null, error: 'timeout' })
    }, timeoutMs)
    socket.on('message', (data) => {
      clearTimeout(timer)
      let message = null
      try {
        message = JSON.parse(data.toString('utf8'))
      } catch {
        message = null
      }
      socket.close()
      resolve({ opened: true, message, error: null })
    })
    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      socket.terminate()
      resolve({ opened: false, message: null, error: `http-${response.statusCode}` })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      resolve({ opened: false, message: null, error: error.message })
    })
  })
}

/**
 * One real application round-trip through the root entry: receives the
 * snapshot, answers `session.attach` on the same connection and waits for the
 * correlated `session.attach.ack`.
 */
function appRoundTrip(origin, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const url = new URL('/app', ENTRY_ORIGIN)
    url.protocol = 'ws:'
    const socket = new WebSocket(url.toString(), { origin })
    let sent = false
    const timer = setTimeout(() => {
      socket.terminate()
      resolve({ ok: false, detail: 'timeout' })
    }, timeoutMs)
    socket.on('message', (data) => {
      let message = null
      try {
        message = JSON.parse(data.toString('utf8'))
      } catch {
        message = null
      }
      if (!sent && message?.kind === 'session.snapshot') {
        sent = true
        socket.send(
          JSON.stringify({
            protocolVersion: '0.2',
            messageId: 'root-entry-attach',
            sessionId: message.sessionId,
            epoch: message.epoch,
            kind: 'session.attach',
            payload: {},
          }),
        )
        return
      }
      if (!sent) return
      if (message?.kind === 'session.attach.ack') {
        clearTimeout(timer)
        socket.close()
        resolve({ ok: message.payload?.performer === true, detail: `ack performer ${String(message.payload?.performer)}` })
        return
      }
      if (message?.kind === 'request.error') {
        clearTimeout(timer)
        socket.terminate()
        resolve({ ok: false, detail: `request.error ${String(message.payload?.code)}` })
        return
      }
      // Other server pushes (for example session.recovery.state) are not part
      // of this routing check; the correlated ack is.
    })
    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      socket.terminate()
      resolve({ ok: false, detail: `http-${response.statusCode}` })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: error.message })
    })
  })
}

const consolePage = await fetch(new URL('/', ENTRY_ORIGIN))
const consoleHtml = await consolePage.text()
check(
  'root entry serves the console page',
  consolePage.status === 200 && consoleHtml.includes('/src/main.tsx'),
  `status ${consolePage.status}`,
)

const health = await request('/health')
check(
  'GET /health reaches the runtime through the root entry',
  health.status === 200 && health.body?.ok === true && typeof health.body?.service === 'string',
  `status ${health.status}`,
)

const bootstrap = await request('/operator/bootstrap', {
  method: 'POST',
  headers: {
    origin: ALLOWED_ORIGIN,
    'x-isla-operator-bootstrap': '1',
  },
})
check(
  'POST /operator/bootstrap reaches the runtime with an allowed origin',
  bootstrap.status === 200 &&
    bootstrap.body?.ok === true &&
    typeof bootstrap.body?.token === 'string' &&
    bootstrap.body.token.length > 0,
  `status ${bootstrap.status}`,
)

const bootstrapBadOrigin = await request('/operator/bootstrap', {
  method: 'POST',
  headers: {
    origin: DISALLOWED_ORIGIN,
    'x-isla-operator-bootstrap': '1',
  },
})
check(
  'the runtime refuses the bootstrap for a disallowed origin through the root entry',
  bootstrapBadOrigin.status === 403 && bootstrapBadOrigin.body?.error?.code === 'forbidden',
  `status ${bootstrapBadOrigin.status}`,
)

const bootstrapNoHeader = await request('/operator/bootstrap', {
  method: 'POST',
  headers: { origin: ALLOWED_ORIGIN },
})
check(
  'the runtime refuses the bootstrap without the explicit header through the root entry',
  bootstrapNoHeader.status === 403 && bootstrapNoHeader.body?.error?.code === 'forbidden',
  `status ${bootstrapNoHeader.status}`,
)

// Dynamic audio route: these refusals are decided before the session lifecycle,
// so they hold regardless of whether the demo session is currently running. The
// served-bytes check lives in root-entry-audio-browser.mjs, which resumes the
// session through the real demo page first.
const audioRef = encodeURIComponent('audio://demo/audio-route-check')

const audioNoHeader = await request(`/audio?ref=${audioRef}`, {
  method: 'POST',
  headers: { origin: ALLOWED_ORIGIN },
})
check(
  'the runtime refuses an audio fetch without the explicit header through the root entry',
  audioNoHeader.status === 403 && audioNoHeader.body?.error?.code === 'forbidden',
  `status ${audioNoHeader.status}`,
)

const audioGet = await request(`/audio?ref=${audioRef}`, {
  method: 'GET',
  headers: { origin: ALLOWED_ORIGIN, 'x-isla-audio-fetch': '1' },
})
check(
  'the runtime refuses a GET audio fetch through the root entry',
  audioGet.status === 405 && audioGet.body?.error?.code === 'method_not_allowed',
  `status ${audioGet.status}`,
)

const audioBadOrigin = await request(`/audio?ref=${audioRef}`, {
  method: 'POST',
  headers: { origin: DISALLOWED_ORIGIN, 'x-isla-audio-fetch': '1' },
})
check(
  'the runtime refuses an audio fetch for a disallowed origin through the root entry',
  audioBadOrigin.status === 403 && audioBadOrigin.body?.error?.code === 'forbidden',
  `status ${audioBadOrigin.status}`,
)

const appSocket = await appRoundTrip(ALLOWED_ORIGIN)
check(
  'WebSocket /app reaches the runtime and completes a real attach round-trip',
  appSocket.ok,
  appSocket.detail,
)

const appSocketBadOrigin = await firstMessage('/app', DISALLOWED_ORIGIN)
check(
  'the runtime refuses the /app upgrade for a disallowed origin through the root entry',
  !appSocketBadOrigin.opened && String(appSocketBadOrigin.error).startsWith('http-403'),
  String(appSocketBadOrigin.error),
)

const diagnostics = await new Promise((resolve) => {
  const url = new URL('/diag', ENTRY_ORIGIN)
  url.protocol = 'ws:'
  const socket = new WebSocket(url.toString(), { origin: ALLOWED_ORIGIN })
  const timer = setTimeout(() => {
    socket.terminate()
    resolve({ ok: false, detail: 'timeout' })
  }, 5000)
  socket.on('open', () => {
    socket.send(JSON.stringify({ v: 1, id: 'root-entry-routing', kind: 'ping' }))
  })
  socket.on('message', (data) => {
    clearTimeout(timer)
    let message = null
    try {
      message = JSON.parse(data.toString('utf8'))
    } catch {
      message = null
    }
    socket.close()
    resolve({ ok: message?.v === 1, detail: `v ${String(message?.v)}` })
  })
  socket.on('error', (error) => {
    clearTimeout(timer)
    resolve({ ok: false, detail: error.message })
  })
})
check('WebSocket /diag still reaches the diagnostics runtime through the root entry', diagnostics.ok, diagnostics.detail)

if (failed) {
  const failedCount = results.filter((result) => !result.ok).length
  console.error(
    `root Vite entry routing acceptance: FAILED (${failedCount}/${results.length} checks failed)`,
  )
  process.exitCode = 1
} else {
  console.log(`root Vite entry routing acceptance: PASSED (${results.length}/${results.length} checks)`)
}
