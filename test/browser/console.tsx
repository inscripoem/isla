/// <reference lib="dom" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'animal-island-ui/style'
import { APPLICATION_CONTRACT_VERSION } from '../../src/contracts'
import type {
  BootstrapSnapshot,
  ConsoleTransportPort,
  ControlAck,
  InputAck,
  PerformanceCancel,
  PerformanceCommand,
  ServerMessage,
} from '../../src/contracts'
import { ConsoleApp } from '../../src/console/ConsoleApp'
import type { TransportStatusReporter } from '../../src/console/ConsoleApp'
import { createPlaybackBinding } from '../../src/console/player-binding'
import type { PlaybackBinding, PlaybackCallbacks } from '../../src/console/player-binding'
import { createDomMediaDriver } from '../../src/performance/browser'
import type { AudioLease, AudioResolver } from '../../src/performance/browser'

/**
 * Manual console demo for M2-01, driven by a clearly identified fixture
 * transport.
 *
 * The fixture is the only substitute in this composition: it answers with the
 * agreed v0.2 messages (input acknowledgement, control acknowledgement, session
 * snapshot, session events) instead of a runtime. The console UI, the
 * application transport logic, the M1 playback controller and the real
 * `createDomMediaDriver()` are the actual implementations. No runtime, provider
 * or Node code is involved here, and this page is never part of the production
 * entry.
 */

const SESSION_ID = 'session-console-demo'
const REPLY_DELAY_MS = 300
const HEARTBEAT_INTERVAL_MS = 4000

const SEGMENTS: readonly { readonly ref: string; readonly text: string }[] = [
  { ref: 'audio://fixture/segment-0', text: 'We talked about the concert.' },
  { ref: 'audio://fixture/segment-1', text: 'It was loud and fun.' },
]

/** Registered ref-to-asset map. A reference is never used as a URL. */
const ASSETS: ReadonlyMap<string, string> = new Map<string, string>([
  ['audio://fixture/segment-0', './assets/segment-0.wav'],
  ['audio://fixture/segment-1', './assets/segment-1.wav'],
])

function createConsoleResolver(): AudioResolver {
  return {
    async resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease> {
      const assetUrl = ASSETS.get(audioRef)
      if (assetUrl === undefined) throw new Error(`unregistered audio ref: ${audioRef}`)
      const response = await fetch(assetUrl, { signal })
      if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`)
      const blob = await response.blob()
      return {
        blob,
        release() {
          // The DOM driver owns its object URL; the lease owns only the Blob.
        },
      }
    },
  }
}

interface FixtureState {
  epoch: number
  seq: number
  lifecycle: 'running' | 'stopped'
  segmentIndex: number
  sequence: number
}

function createFixtureTransport(reporter: TransportStatusReporter): ConsoleTransportPort {
  const listeners = new Set<(message: ServerMessage) => void>()
  const accepted = new Map<string, { readonly eventId: string; readonly seq: number }>()
  const state: FixtureState = { epoch: 1, seq: 0, lifecycle: 'running', segmentIndex: 0, sequence: 0 }
  let heartbeat: number | null = null

  const push = (message: ServerMessage): void => {
    for (const listener of [...listeners]) listener(message)
  }
  const envelope = (messageId: string): { protocolVersion: '0.2'; messageId: string; sessionId: string; epoch: number } => ({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId,
    sessionId: SESSION_ID,
    epoch: state.epoch,
  })
  const snapshotPayload = () => ({
    lifecycle: state.lifecycle,
    activeTurnId: null,
    performerStatus: 'idle' as const,
    outputConfirmation: 'confirmed' as const,
    capabilityRevision: 1,
    lastSeq: state.seq,
  })
  const eventMessage = (): ServerMessage => {
    state.seq += 1
    return {
      ...envelope(`fixture-event-${state.seq}`),
      kind: 'session.event',
      payload: { seq: state.seq, type: 'fixture.heartbeat', data: { at: new Date().toISOString() } },
    }
  }
  const inputAckMessage = (ack: InputAck, requestMessageId: string): ServerMessage => ({
    ...envelope(`fixture-input-ack-${requestMessageId}`),
    kind: 'input.ack',
    payload: ack,
  })
  const controlAckMessage = (ack: ControlAck, requestMessageId: string): ServerMessage => ({
    ...envelope(`fixture-control-ack-${requestMessageId}`),
    kind: 'control.ack',
    payload: ack,
  })
  const snapshotMessage = (requestMessageId: string): ServerMessage => ({
    ...envelope(`fixture-snapshot-${requestMessageId}`),
    kind: 'session.snapshot',
    payload: snapshotPayload(),
  })
  const cancelMessage = (cancel: PerformanceCancel, requestMessageId: string): ServerMessage => ({
    ...envelope(`fixture-cancel-${requestMessageId}`),
    kind: 'performance.cancel',
    payload: cancel,
  })
  const executeMessage = (command: PerformanceCommand): ServerMessage => ({
    ...envelope(`fixture-execute-${command.outputId}`),
    kind: 'performance.execute',
    payload: command,
  })

  return {
    bootstrap(): Promise<BootstrapSnapshot> {
      reporter.onStatus('open', null)
      heartbeat = window.setInterval(() => {
        push(eventMessage())
      }, HEARTBEAT_INTERVAL_MS)
      return Promise.resolve({
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: 'fixture-bootstrap',
        sessionId: SESSION_ID,
        epoch: state.epoch,
        seq: state.seq,
        lifecycle: state.lifecycle,
        activeTurnId: null,
        performerStatus: 'idle',
        outputConfirmation: 'confirmed',
        capabilityRevision: 1,
      })
    },

    sendInput(message) {
      return new Promise<InputAck>((resolve) => {
        window.setTimeout(() => {
          const key = `${message.payload.source}\u0000${message.payload.text}`
          const previous = accepted.get(key)
          let ack: InputAck
          if (message.payload.text.startsWith('reject')) {
            ack = {
              status: 'rejected',
              requestMessageId: message.messageId,
              sessionId: SESSION_ID,
              epoch: state.epoch,
              code: 'invalid_field',
              message: 'the fixture rejects text that starts with "reject"',
              retryable: true,
            }
          } else if (previous !== undefined) {
            ack = {
              status: 'duplicate',
              requestMessageId: message.messageId,
              eventId: previous.eventId,
              sessionId: SESSION_ID,
              epoch: state.epoch,
              seq: previous.seq,
            }
          } else {
            const event = eventMessage()
            if (event.kind !== 'session.event') throw new Error('fixture: expected a session event')
            const acceptedEvent = { eventId: `fixture-input-${state.seq}`, seq: event.payload.seq }
            accepted.set(key, acceptedEvent)
            ack = {
              status: 'accepted',
              requestMessageId: message.messageId,
              eventId: acceptedEvent.eventId,
              sessionId: SESSION_ID,
              epoch: state.epoch,
              seq: acceptedEvent.seq,
            }
          }
          push(inputAckMessage(ack, message.messageId))
          resolve(ack)
        }, REPLY_DELAY_MS)
      })
    },

    sendControl(message) {
      const isStop = message.kind === 'control.stop'
      return new Promise<ControlAck>((resolve) => {
        window.setTimeout(() => {
          const previousEpoch = state.epoch
          if (isStop) {
            state.epoch += 1
            state.lifecycle = 'stopped'
          } else {
            state.lifecycle = 'running'
          }
          const ack: ControlAck = {
            sessionId: SESSION_ID,
            requestId: message.payload.requestId,
            requestMessageId: message.messageId,
            action: isStop ? 'stop' : 'resume',
            status: 'applied',
            previousEpoch,
            epoch: state.epoch,
            lifecycle: state.lifecycle,
            outputConfirmation: 'confirmed',
            reasonCode: null,
            message: 'the fixture applied the control request',
          }
          push(controlAckMessage(ack, message.messageId))
          push(snapshotMessage(message.messageId))
          if (isStop) {
            push(
              cancelMessage(
                { requestId: message.payload.requestId, revokedEpoch: previousEpoch, newEpoch: state.epoch },
                message.messageId,
              ),
            )
            resolve(ack)
            return
          }
          const segment = SEGMENTS[state.segmentIndex % SEGMENTS.length]
          state.segmentIndex += 1
          state.sequence += 1
          if (segment !== undefined) {
            push(
              executeMessage({
                outputId: `fixture-output-${state.sequence}`,
                sessionId: SESSION_ID,
                epoch: state.epoch,
                turnId: `fixture-turn-${state.sequence}`,
                segmentId: `fixture-segment-${state.sequence}`,
                audioRef: segment.ref,
                subtitleText: segment.text,
                actionId: 'smile',
                capabilityRevision: 1,
              }),
            )
          }
          resolve(ack)
        }, REPLY_DELAY_MS)
      })
    },

    onServerMessage(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    close() {
      if (heartbeat !== null) {
        window.clearInterval(heartbeat)
        heartbeat = null
      }
      listeners.clear()
      reporter.onStatus('closed', 'the fixture transport was closed')
    },
  }
}

let receiptCount = 0

function createConsolePlayback(bootstrap: BootstrapSnapshot, callbacks: PlaybackCallbacks): PlaybackBinding {
  return createPlaybackBinding({
    bootstrap,
    resolver: createConsoleResolver(),
    media: createDomMediaDriver(),
    newReceiptId: () => {
      receiptCount += 1
      return `fixture-console-receipt-${receiptCount}`
    },
    localNowMs: () => Math.round(performance.now()),
    ...callbacks,
  })
}

const root = document.getElementById('root')
if (root === null) throw new Error('console demo: missing #root')

createRoot(root).render(
  <StrictMode>
    <ConsoleApp transportFactory={createFixtureTransport} playbackFactory={createConsolePlayback} />
  </StrictMode>,
)
