/// <reference lib="dom" />
import { createDomMediaDriver, type AudioLease, type AudioResolver } from '../../src/performance/browser/index'
import type { PerformanceReceipt } from '../../src/contracts'
import { createPerformerMachine } from './performer-machine'
import type { PerformerMachine, PerformerState } from './performer-machine'
import { wireSocket } from './loop-wiring'
import type { SocketLike } from './loop-wiring'

/**
 * Minimal browser performer client for the I1 interactive loop demo. It uses the
 * shared browser-safe performer state machine (the same logic the automated
 * Node tests exercise) with the real DOM media driver and the registered fixed
 * WAV assets. It is a small test/demo, not the M2 product console. Media events
 * are API observations, not acoustic measurements.
 */

const ASSETS: ReadonlyMap<string, string> = new Map([
  ['audio://fixture/segment-0', './assets/segment-0.wav'],
  ['audio://fixture/segment-1', './assets/segment-1.wav'],
])

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`loop demo: missing #${id}`)
  return found as T
}

const statusEl = element<HTMLPreElement>('status')
const subtitleEl = element<HTMLPreElement>('subtitle')
const reactionEl = element<HTMLPreElement>('reaction')
const eventsEl = element<HTMLPreElement>('events')
const startButton = element<HTMLButtonElement>('start')
const resumeButton = element<HTMLButtonElement>('resume')
const stopButton = element<HTMLButtonElement>('stop')
const sendButton = element<HTMLButtonElement>('send')
const inputText = element<HTMLInputElement>('input-text')

const events: string[] = []
function log(message: string): void {
  events.push(`${new Date().toISOString()} ${message}`)
  eventsEl.textContent = events.slice(-40).join('\n')
}

function createResolver(): AudioResolver {
  return {
    async resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease> {
      const assetUrl = ASSETS.get(audioRef)
      if (assetUrl === undefined) throw new Error(`unregistered audio ref: ${audioRef}`)
      const response = await fetch(assetUrl, { signal })
      if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`)
      const blob = await response.blob()
      return { blob, release() {} }
    },
  }
}

const socket = new WebSocket(
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/app`,
)

// Identities come from the shared machine's realm-unique default so a page
// reload never reuses message/receipt ids the retained server session knows.
const machine: PerformerMachine = createPerformerMachine({
  transport: {
    send: (raw) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(raw)
    },
  },
  media: createDomMediaDriver(),
  resolver: createResolver(),
  hooks: {
    onEvent: (message) => {
      const payload = (message as { payload?: Record<string, unknown> }).payload
      if (payload !== undefined) log(`event ${String(payload.type)}`)
    },
    onReceipt: (receipt: PerformanceReceipt) => {
      log(`receipt ${receipt.stage} ${receipt.outputId}`)
    },
    onServiceError: (_raw, reason) => log(`message rejected: ${reason}`),
    onStateChanged: () => render(),
  },
})

function render(): void {
  const state: PerformerState = machine.state()
  statusEl.textContent = [
    `socket: ${socket.readyState}`,
    `session: ${state.sessionId || '(none)'}`,
    `epoch: ${state.epoch}`,
    `lifecycle: ${state.lifecycle}`,
    `last observed server confirmation: ${state.outputConfirmation}`,
    `local media stage (not proof): ${state.lastStage ?? '(none)'}`,
    `operator: ${state.operator}`,
    `performer: ${state.performer}`,
    state.error !== null ? `error: ${state.error}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
  subtitleEl.textContent = state.display.subtitle ?? '(none)'
  reactionEl.textContent =
    state.display.reaction === null
      ? '(none)'
      : `${state.display.reaction} (display only; not completion evidence)`

  const hasSession = state.sessionId.length > 0
  const connected = socket.readyState === WebSocket.OPEN
  startButton.disabled = !connected || !hasSession || (state.operator && state.performer)
  resumeButton.disabled = !(connected && hasSession && state.operator && state.performer) || state.lifecycle === 'running'
  stopButton.disabled = !(connected && hasSession && state.operator && state.performer) || state.lifecycle !== 'running'
  sendButton.disabled = !(connected && hasSession && state.performer) || state.lifecycle !== 'running'
}

wireSocket(socket as unknown as SocketLike, machine, {
  onOpen: () => {
    log('socket open')
    render()
  },
  onClose: () => {
    log('socket closed; local playback is detached and the session is not auto-resumed')
    machine.dispose('socket_closed')
    render()
  },
  onError: () => {
    machine.dispose('socket_error')
    render()
  },
  onMalformed: () => log('ignored a malformed server message'),
})
window.addEventListener('beforeunload', () => machine.dispose('unload'))

startButton.addEventListener('click', () => {
  void start()
})

async function start(): Promise<void> {
  if (machine.state().sessionId.length === 0) {
    log('cannot bootstrap before the first session snapshot arrives')
    return
  }
  startButton.disabled = true
  try {
    // Same-origin, explicit operator bootstrap. The one-time token is held only
    // in memory and is never logged or written to storage.
    const response = await fetch('/operator/bootstrap', {
      method: 'POST',
      headers: { 'x-isla-operator-bootstrap': '1' },
    })
    if (!response.ok) {
      log(`operator bootstrap failed with status ${response.status}`)
      return
    }
    const body = (await response.json()) as { token?: string }
    if (typeof body.token !== 'string' || body.token.length === 0) {
      log('operator bootstrap returned no usable token')
      return
    }
    machine.bootstrapOperator(body.token)
    machine.attach()
  } catch (error) {
    log(`operator bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    render()
  }
}

resumeButton.addEventListener('click', () => {
  machine.resume()
})
stopButton.addEventListener('click', () => {
  machine.stop()
})
element<HTMLFormElement>('input-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const text = inputText.value.trim()
  if (text.length === 0) return
  machine.input(text)
  log(`input submitted: ${text}`)
})

log('demo ready; media events are the only start/end evidence')
render()
