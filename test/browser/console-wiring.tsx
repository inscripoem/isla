/// <reference lib="dom" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'animal-island-ui/style'
import {
  APPLICATION_CONTRACT_VERSION,
  parseApplicationServerMessage,
  type ApplicationClientMessage,
  type BootstrapSnapshot,
  type ConsoleTransportPort,
  type ControlResumeMessage,
  type ControlStopMessage,
  type InputSource,
  type InputSubmitMessage,
  type OperatorBootstrapMessage,
  type SessionAttachMessage,
  type SessionRecoverMessage,
} from '../../src/contracts'
import { ConsoleApp } from '../../src/console/ConsoleApp'
import type { PerformerFactory, TransportStatusReporter } from '../../src/console/ConsoleApp'
import { createAppTransport, type ConsoleApplicationTransport } from '../../src/console/app-transport'
import type { PerformerMachine, PerformerMachineHooks, PerformerState } from '../../src/console/performer-machine'

/**
 * M2 console wiring probe.
 *
 * This entry mounts the real `ConsoleApp` through the real application transport
 * and the platform WebSocket. The only substitute is the performer machine: this
 * page's fake performer relays the console's requests as valid protocol-0.2
 * frames so a Node WebSocket server can acknowledge them at the exact time each
 * acceptance check needs. Nothing here starts a runtime, provider or Node code.
 *
 * The probe records transport factory and bootstrap calls so the acceptance
 * script can prove that Reconnect creates exactly one fresh bootstrap.
 */

interface WiringProbe {
  readonly transportFactoryCalls: number[]
  readonly bootstrapCalls: number[]
  readonly bootstrapResolved: number[]
}

interface ConsoleWiringWindow extends Window {
  __islaConsoleWiring?: WiringProbe
  __islaWiringSocketUrl?: string
}

const browserWindow = window as ConsoleWiringWindow
const socketUrl: string = (() => {
  const injected = browserWindow.__islaWiringSocketUrl
  if (injected === undefined) throw new Error('console wiring probe: missing application socket URL')
  return injected
})()

const probe: WiringProbe = {
  transportFactoryCalls: [],
  bootstrapCalls: [],
  bootstrapResolved: [],
}
browserWindow.__islaConsoleWiring = probe

function createObservedTransport(reporter: TransportStatusReporter): ConsoleTransportPort {
  probe.transportFactoryCalls.push(performance.now())
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

/**
 * Test-only performer. It owns no media and no playback: it only relays the
 * console's intentional requests to the real application transport, and keeps
 * enough state for the Control Deck to render the same guards the product uses.
 */
function createWiringPerformer(
  bootstrap: BootstrapSnapshot,
  transport: ConsoleApplicationTransport,
  hooks: PerformerMachineHooks,
): PerformerMachine {
  let sequence = 0
  const nextId = (prefix: string): string => `wiring-${prefix}-${(sequence += 1)}`
  const notify = (): void => hooks.onStateChanged?.()

  let state: PerformerState = {
    sessionId: bootstrap.sessionId,
    epoch: bootstrap.epoch,
    lifecycle: bootstrap.lifecycle,
    retiring: false,
    disposed: false,
    outputConfirmation: bootstrap.outputConfirmation,
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

  const send = (message: ApplicationClientMessage): void => {
    transport.sendApplication(message)
  }

  return {
    handleMessage(raw: unknown): void {
      const parsed = parseApplicationServerMessage(raw)
      if (!parsed.ok) {
        notify()
        return
      }
      const message = parsed.message
      switch (message.kind) {
        case 'session.snapshot':
          state = {
            ...state,
            sessionId: message.sessionId,
            epoch: message.epoch,
            lifecycle: message.payload.lifecycle,
            outputConfirmation: message.payload.outputConfirmation,
          }
          break
        case 'session.recovery.state':
          state = { ...state, retiring: message.payload.retiring }
          break
        case 'control.ack':
          state = {
            ...state,
            epoch: message.payload.epoch,
            lifecycle: message.payload.lifecycle,
            outputConfirmation: message.payload.outputConfirmation,
          }
          break
        case 'session.attach.ack':
          state = { ...state, performer: true }
          break
        case 'operator.ack':
          state = { ...state, operator: true }
          break
        default:
          break
      }
      notify()
    },
    attach(): void {
      if (state.disposed) return
      const message: SessionAttachMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: nextId('attach'),
        sessionId: state.sessionId,
        epoch: state.epoch,
        kind: 'session.attach',
        payload: {},
      }
      send(message)
    },
    bootstrapOperator(token: string): void {
      if (state.disposed) return
      const message: OperatorBootstrapMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: nextId('bootstrap'),
        sessionId: state.sessionId,
        epoch: state.epoch,
        kind: 'operator.bootstrap',
        payload: { token },
      }
      send(message)
    },
    input(text: string, messageId?: string, source: InputSource = 'local-audience'): string | null {
      if (state.disposed) return null
      const id = messageId ?? nextId('input')
      const message: InputSubmitMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: id,
        sessionId: state.sessionId,
        epoch: state.epoch,
        kind: 'input.submit',
        payload: { source, text },
      }
      send(message)
      return id
    },
    resume(requestId?: string, messageId?: string): string | null {
      if (state.disposed) return null
      const id = messageId ?? nextId('resume-message')
      const message: ControlResumeMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: id,
        sessionId: state.sessionId,
        epoch: state.epoch,
        kind: 'control.resume',
        payload: { requestId: requestId ?? nextId('resume') },
      }
      send(message)
      return id
    },
    stop(requestId?: string, messageId?: string): string | null {
      if (state.disposed) return null
      const id = messageId ?? nextId('stop-message')
      const message: ControlStopMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: id,
        sessionId: state.sessionId,
        epoch: state.epoch,
        kind: 'control.stop',
        payload: { requestId: requestId ?? nextId('stop') },
      }
      send(message)
      return id
    },
    recover(): string | null {
      if (state.disposed) return null
      const id = nextId('recover')
      const message: SessionRecoverMessage = {
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: id,
        sessionId: state.sessionId,
        epoch: state.epoch,
        kind: 'session.recover',
        payload: { acknowledgePlaybackEnded: true },
      }
      send(message)
      return id
    },
    state(): PerformerState {
      return state
    },
    dispose(reason: string): void {
      if (state.disposed) return
      state = { ...state, disposed: true, error: reason }
      notify()
    },
  }
}

const performerFactory: PerformerFactory = createWiringPerformer

const requestOperatorToken = (): Promise<string> => Promise.resolve('wiring-operator-token')

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('console wiring probe: missing #root')

createRoot(rootElement).render(
  <StrictMode>
    <ConsoleApp
      transportFactory={createObservedTransport}
      performerFactory={performerFactory}
      requestOperatorToken={requestOperatorToken}
    />
  </StrictMode>,
)
