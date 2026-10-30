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
  InputEvent,
  PerformanceCancel,
  PerformanceCommand,
  ReplyIntent,
  SelectionResult,
  ServerMessage,
} from '../../src/contracts'
import {
  createBatchInputScenario,
  deliveryCommittedMessage,
  inputAcceptedMessage,
  selectionPlanMessage,
  turnStartedMessage,
} from '../support/m2-batch-input'
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
 * snapshot, session events) instead of a runtime, and it acts as the server by
 * publishing `input.accepted`, `selection.plan`, `turn.started` and
 * `delivery.committed` session events. These are fixture-authored server
 * substitute events; they are never browser-observed evidence. The console UI,
 * the application transport logic, the M1 playback controller and the real
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

/**
 * The fixture's standing batch. The plan selects the second text by default, so
 * a reviewer sees the batch projection without typing three messages by hand.
 */
const BATCH = createBatchInputScenario({ sessionId: SESSION_ID, epoch: 1, startSeq: 0 })
const BATCH_TEXTS: readonly string[] = BATCH.inputs.map((input) => input.text)

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

  /**
   * Publish one accepted input as the fixture server: the accepted event, the
   * selection plan that selects it, the turn it starts, and finally the
   * committed delivery once a segment has been dispatched.
   */
  const projectAcceptedInput = (input: InputEvent): void => {
    state.seq += 1
    const acceptedSeq = state.seq
    push(
      inputAcceptedMessage({
        sessionId: SESSION_ID,
        epoch: state.epoch,
        seq: acceptedSeq,
        input,
      }),
    )

    const plan: SelectionResult = {
      requestId: `fixture-plan-${input.eventId}`,
      sessionId: SESSION_ID,
      epoch: state.epoch,
      snapshotRevision: 1,
      disposition: 'respond',
      selectedEventIds: [input.eventId],
      replyIntent: 'answer',
      reasonCode: 'fixture-batch',
      provider: 'fixture-provider',
      modelVersion: 'fixture-model-v1',
      usage: {
        provider: 'fixture-provider',
        requestedModel: 'fixture-model-v1',
        resolvedModel: 'fixture-model-v1',
        requestId: `fixture-plan-${input.eventId}`,
        inputTokens: 1,
        outputTokens: 1,
        usageMissing: false,
        elapsedMs: 1,
        status: 'ok',
        pricingRef: null,
      },
    }
    state.seq += 1
    push(selectionPlanMessage({ sessionId: SESSION_ID, epoch: state.epoch, seq: state.seq, plan, synthetic: false }))

    state.seq += 1
    const turnId = `fixture-turn-${input.eventId}`
    const replyIntent: ReplyIntent = 'answer'
    push(turnStartedMessage({ sessionId: SESSION_ID, epoch: state.epoch, seq: state.seq, replyIntent }))

    const segment = SEGMENTS[state.segmentIndex % SEGMENTS.length]
    state.segmentIndex += 1
    state.sequence += 1
    if (segment === undefined) return
    const outputId = `fixture-output-${state.sequence}`
    const segmentId = `fixture-segment-${state.sequence}`
    push(
      executeMessage({
        outputId,
        sessionId: SESSION_ID,
        epoch: state.epoch,
        turnId,
        segmentId,
        audioRef: segment.ref,
        subtitleText: segment.text,
        actionId: 'smile',
        capabilityRevision: 1,
      }),
    )
    // The delivery is the fixture server's committed classification, not local
    // playback evidence observed in this browser.
    state.seq += 1
    push(
      deliveryCommittedMessage({
        sessionId: SESSION_ID,
        epoch: state.epoch,
        seq: state.seq,
        classification: 'fully-delivered',
      }),
    )
  }

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
            state.seq += 1
            const acceptedSeq = state.seq
            const input: InputEvent = {
              eventId: `fixture-input-${acceptedSeq}`,
              sessionId: SESSION_ID,
              epoch: state.epoch,
              source: message.payload.source,
              actorId: 'fixture-audience',
              text: message.payload.text,
              receivedAtMs: REPLY_DELAY_MS,
              expiresAtMs: REPLY_DELAY_MS + 30_000,
              trust: 'untrusted-content',
            }
            const acceptedEvent = { eventId: input.eventId, seq: acceptedSeq }
            accepted.set(key, acceptedEvent)
            ack = {
              status: 'accepted',
              requestMessageId: message.messageId,
              eventId: acceptedEvent.eventId,
              sessionId: SESSION_ID,
              epoch: state.epoch,
              seq: acceptedEvent.seq,
            }
            push(inputAckMessage(ack, message.messageId))
            projectAcceptedInput(input)
            resolve(ack)
            return
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

/**
 * Demo-only batch helper. It renders no production behaviour: it submits the
 * default batch texts through the console's existing form path so a reviewer can
 * see the batch projection without typing three messages. Each submission types
 * the text into the message field and activates the form's submit button, so the
 * console's own dispatch remains the only path to the fixture transport.
 */
function submitDefaultBatch(): void {
  const field = document.getElementById('console-text')
  if (!(field instanceof HTMLInputElement)) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  let delay = 0
  for (const text of BATCH_TEXTS) {
    window.setTimeout(() => {
      setter?.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      // Let React commit the controlled value before activating the form.
      window.setTimeout(() => {
        field.form?.requestSubmit()
      }, 0)
    }, delay)
    delay += REPLY_DELAY_MS + 200
  }
}

const batchHelper = (
  <div className="console__stack" style={{ padding: '0.75rem 1rem 0' }}>
    <p className="console__hint" style={{ margin: 0 }}>
      Demo fixture: the batch helper submits {BATCH_TEXTS.length} default texts through the message form. The
      fixture server then publishes accepted inputs, a selection, a turn and a delivery. These are fixture
      substitute events, not browser-observed evidence.
    </p>
    <div className="console__actions">
      <button type="button" className="console__batch-helper" onClick={submitDefaultBatch}>
        Submit the default batch
      </button>
    </div>
  </div>
)

createRoot(root).render(
  <StrictMode>
    {batchHelper}
    <ConsoleApp transportFactory={createFixtureTransport} playbackFactory={createConsolePlayback} />
  </StrictMode>,
)
