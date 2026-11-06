import type { BootstrapSnapshot } from './contracts'
import { createDomMediaDriver } from './performance/browser'
import { ConsoleApp } from './console/ConsoleApp'
import type { PerformerFactory, TransportStatusReporter } from './console/ConsoleApp'
import { createAppTransport, type ConsoleApplicationTransport } from './console/app-transport'
import { createMachineTransport } from './console/performer-adapter'
import { createPerformerMachine, type PerformerMachineHooks } from './console/performer-machine'
import { requestOperatorBootstrap } from './console/operator-bootstrap'
import { createRuntimeAudioResolver } from './console/runtime-audio-resolver'

/**
 * Console composition root.
 *
 * The console itself is pure view state; transport and the performer machine
 * reach it only through injected factories. They are module-level constants so
 * the console's setup effect keeps a stable dependency list and never
 * reconnects per render.
 *
 * The runtime serves the application socket at `/app`, the one-time operator
 * bootstrap at `/operator/bootstrap` and dynamic audio at `/audio`. Browser
 * delivery still requires a runtime-reported `performance.grant`; the console
 * never treats a local receipt as confirmation.
 */

const APPLICATION_PATH = '/app'

function createConsoleTransport(reporter: TransportStatusReporter): ConsoleApplicationTransport {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return createAppTransport({
    url: `${scheme}://${window.location.host}${APPLICATION_PATH}`,
    onStatus: reporter.onStatus,
    onProtocolViolation: reporter.onProtocolViolation,
  })
}

const createConsolePerformer: PerformerFactory = (
  _bootstrap: BootstrapSnapshot,
  transport: ConsoleApplicationTransport,
  hooks: PerformerMachineHooks,
) =>
  createPerformerMachine({
    transport: createMachineTransport(transport),
    media: createDomMediaDriver(),
    resolver: createRuntimeAudioResolver(),
    hooks,
  })

async function requestOperatorToken(): Promise<string> {
  const result = await requestOperatorBootstrap()
  return result.token
}

function App() {
  return (
    <ConsoleApp
      transportFactory={createConsoleTransport}
      performerFactory={createConsolePerformer}
      requestOperatorToken={requestOperatorToken}
    />
  )
}

export default App
