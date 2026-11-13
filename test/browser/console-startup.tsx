/// <reference lib="dom" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'animal-island-ui/style'
import type { ConsoleTransportPort } from '../../src/contracts'
import { ConsoleApp } from '../../src/console/ConsoleApp'
import type { PerformerFactory, TransportStatusReporter } from '../../src/console/ConsoleApp'
import { createAppTransport } from '../../src/console/app-transport'
import type { PerformerMachine, PerformerState } from '../../src/console/performer-machine'

/**
 * StrictMode startup probe for the M2 console.
 *
 * This page mounts the real `ConsoleApp` under `StrictMode` with the real
 * application transport and the platform WebSocket. The only substitute is the
 * performer machine, which is never exercised here; a real browser WebSocket
 * server supplies the bootstrap snapshot. The acceptance script observes the
 * transport factory and every browser WebSocket construction/close event.
 */

interface StartupProbe {
  readonly transportFactoryCalls: number[]
  readonly bootstrapCalls: number[]
  readonly bootstrapResolved: number[]
  unmountedAt: number | null
}

interface ConsoleStartupWindow extends Window {
  __islaConsoleStartup?: StartupProbe
  __islaStartupSocketUrl?: string
  __islaUnmountConsole?: () => void
}

const browserWindow = window as ConsoleStartupWindow
const startupSocketUrl = browserWindow.__islaStartupSocketUrl
if (startupSocketUrl === undefined) throw new Error('console startup probe: missing application socket URL')
const socketUrl: string = startupSocketUrl
const unmountBeforeBootstrap = new URLSearchParams(window.location.search).get('scenario') === 'unmount-before-bootstrap'

const probe: StartupProbe = {
  transportFactoryCalls: [],
  bootstrapCalls: [],
  bootstrapResolved: [],
  unmountedAt: null,
}
browserWindow.__islaConsoleStartup = probe

function createObservedTransport(reporter: TransportStatusReporter): ConsoleTransportPort {
  const callIndex = probe.transportFactoryCalls.length
  probe.transportFactoryCalls.push(performance.now())
  if (unmountBeforeBootstrap && callIndex === 0) {
    // The first StrictMode mount schedules its unmount before the retained
    // mount schedules its bootstrap timer, so this timer deterministically wins
    // and cleanup must clear the pending bootstrap.
    setTimeout(() => browserWindow.__islaUnmountConsole?.(), 0)
  }
  const transport = createAppTransport({
    url: socketUrl,
    onStatus: reporter.onStatus,
    onProtocolViolation: reporter.onProtocolViolation,
  })
  return {
    ...transport,
    bootstrap: () => {
      probe.bootstrapCalls.push(performance.now())
      return transport.bootstrap().then((snapshot) => {
        probe.bootstrapResolved.push(performance.now())
        return snapshot
      })
    },
  }
}

function createStartupPerformer(): PerformerMachine {
  const state: PerformerState = {
    sessionId: 'session-console-startup',
    epoch: 1,
    lifecycle: 'stopped',
    retiring: false,
    disposed: false,
    outputConfirmation: 'confirmed',
    performer: false,
    operator: false,
    lastStage: null,
    display: { subtitle: null, reaction: null },
    error: null,
    recovery: {
      status: 'idle',
      retiredSessionId: null,
      successorSessionId: null,
      recoveries: 0,
      remainingRecoveries: null,
    },
    playerStatus: { idle: true, activeOutputId: null, lastStage: null },
  }
  return {
    handleMessage() {},
    attach() {},
    bootstrapOperator() {},
    input() {
      return null
    },
    resume() {
      return null
    },
    stop() {
      return null
    },
    recover() {
      return null
    },
    state: () => state,
    dispose() {},
  }
}

const performerFactory: PerformerFactory = () => createStartupPerformer()

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('console startup probe: missing #root')

const root = createRoot(rootElement)
browserWindow.__islaUnmountConsole = () => {
  probe.unmountedAt = performance.now()
  root.unmount()
}
root.render(
  <StrictMode>
    <ConsoleApp transportFactory={createObservedTransport} performerFactory={performerFactory} />
  </StrictMode>,
)
