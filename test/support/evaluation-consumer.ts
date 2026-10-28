import type {
  PerformanceCommand,
  PerformanceReadyMessage,
  PerformanceReceipt,
  PerformanceStatusMessage,
  PlayerMessage,
} from '../../src/contracts'
import type { AudioResolver, MediaDriver } from '../../src/performance/browser/types'
import type { RuntimeComposition } from '../../src/runtime/composition'
import type { PerformerBridgeMessage } from '../../src/runtime/performance-bridge'
import { createPerformerMachine } from '../browser/performer-machine'
import type { PerformerMachine } from '../browser/performer-machine'
import { createTestReceiptTools } from './m1-kit'

/**
 * Explicit audio consumer for the M5 evaluation adapter: the real browser-side
 * performer machine driven against the composition's performance bridge, with
 * controlled M1 media. It is the only source of delivery receipts — the adapter
 * never fabricates one, so what this consumer publishes (or withholds) is what
 * the bench observes.
 *
 * `attach` bootstraps the machine from the authoritative snapshot and binds the
 * bridge transport with the application's routing: ready -> `handleReady`,
 * physical status -> `handlePhysicalStatus`, receipt -> `bridge.deliver`, and
 * only evidence the bridge did not consume is forwarded to the endpoint.
 *
 * `silent` binds the transport but never delivers a server message to a
 * performer and never publishes a receipt: it models a consumer that confirms
 * nothing, so the runtime never receives terminal delivery evidence.
 */

export interface ControlledConsumerOptions {
  readonly media: MediaDriver
  readonly resolver: AudioResolver
  /** Awaited before `ready` is sent, to model delayed readiness. */
  readonly beforeReady?: (command: PerformanceCommand) => Promise<void> | void
  readonly receiptPrefix?: string
  /** Called with the composition at attach, so a test can drive the control path. */
  readonly onAttach?: (composition: RuntimeComposition) => void
  /** Bind the transport without a performer: no message is handled, no receipt published. */
  readonly silent?: boolean
}

export interface ControlledConsumer {
  attach(composition: RuntimeComposition): Promise<void>
  detach(): void
  machine(): PerformerMachine | null
  /** Terminal receipts published by the machine: the delivery facts it claimed. */
  receipts(): PerformanceReceipt[]
}

export function createControlledConsumer(options: ControlledConsumerOptions): ControlledConsumer {
  const published: PerformanceReceipt[] = []
  const prefix = options.receiptPrefix ?? 'eval'
  let machine: PerformerMachine | null = null
  let messageCounter = 0

  const route = (composition: RuntimeComposition, raw: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const kind = (parsed as { kind?: unknown }).kind
    if (kind === 'performance.ready') {
      composition.bridge.handleReady(parsed as PerformanceReadyMessage)
      return
    }
    if (kind === 'performance.status') {
      composition.bridge.handlePhysicalStatus(parsed as PerformanceStatusMessage)
      return
    }
    if (kind === 'performance.receipt') {
      const message = parsed as PlayerMessage
      void (async () => {
        const outcome = await composition.bridge.deliver(message)
        // A delayed receipt from a retired composition must never be forwarded.
        if (outcome === 'forward') {
          await composition.coordinator.endpoint.handlePlayerMessage(message)
        }
      })().catch(() => {
        // Routing faults are the machine's evidence path, not the bench's.
      })
    }
  }

  return {
    async attach(composition) {
      options.onAttach?.(composition)
      if (options.silent === true) {
        composition.bridge.bindTransport({
          send: () => 'sent',
          handleEvidence: async () => {},
          makeMessageId: () => `${prefix}-msg-${(messageCounter += 1)}`,
          generation: () => 1,
        })
        return
      }
      const snapshot = await composition.coordinator.endpoint.snapshot()
      const current = createPerformerMachine({
        transport: {
          send: (raw) => route(composition, raw),
        },
        media: options.media,
        resolver: options.resolver,
        receipts: createTestReceiptTools(prefix),
        ...(options.beforeReady !== undefined ? { beforeReady: options.beforeReady } : {}),
        hooks: {
          onReceipt: (receipt) => {
            published.push(receipt)
          },
        },
      })
      current.handleMessage({
        protocolVersion: '0.2',
        messageId: `${prefix}-snapshot`,
        sessionId: snapshot.sessionId,
        epoch: snapshot.epoch,
        kind: 'session.snapshot',
        payload: {
          lifecycle: snapshot.lifecycle,
          activeTurnId: snapshot.activeTurnId,
          performerStatus: snapshot.performerStatus,
          outputConfirmation: snapshot.outputConfirmation,
          capabilityRevision: snapshot.capabilityRevision,
          lastSeq: snapshot.seq,
        },
      })
      composition.bridge.bindTransport({
        send: (message: PerformerBridgeMessage) => {
          current.handleMessage(message)
          return 'sent'
        },
        handleEvidence: async (message) => {
          await composition.coordinator.endpoint.handlePlayerMessage(message)
        },
        makeMessageId: () => `${prefix}-msg-${(messageCounter += 1)}`,
        generation: () => 1,
      })
      machine = current
    },
    detach() {
      machine?.dispose('evaluation consumer detached')
      machine = null
    },
    machine: () => machine,
    receipts: () => published.slice(),
  }
}
