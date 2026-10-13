import type { StoredDelivery } from '../../src/storage'
import type {
  AppendAck,
  AtomicCommitAck,
  BootstrapSnapshot,
  ConfirmedDelivery,
  ConsoleTransportPort,
  ControlAck,
  DialogueEnd,
  DialoguePort,
  EventStorePort,
  HistoryQueryPort,
  InputAck,
  MemoryProjectionPort,
  PlayerPort,
  PlayerStatus,
  ReactionPort,
  RendererPort,
  RuntimeEvent,
  SelectionPort,
  ServerMessage,
  SynthesisPort,
} from '../../src/contracts'
import {
  bootstrapSnapshotSchema,
  controlAckSchema,
  decisionResultSchema,
  dialogueEndSchema,
  dialogueSegmentSchema,
  inputAckSchema,
  performanceReceiptSchema,
  preparedAudioSchema,
  selectionResultSchema,
  sessionEventMessageSchema,
} from '../../src/contracts'
import { FIXTURE_SESSION_ID, fixtureUsage } from './fixture-data'

/**
 * Deliberately faulty adapters used to prove the reusable conformance
 * assertions reject incorrect behavior. They return wrong but well-typed data;
 * they do not throw to satisfy a test.
 */

export function createFaultySelectionPort(): SelectionPort {
  return {
    async select(request) {
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: ['not-an-offered-candidate'],
        replyIntent: 'answer',
        reasonCode: 'faulty-selected',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createFaultyReactionPort(): ReactionPort {
  return {
    async decide(request) {
      return decisionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        snapshotRevision: request.snapshotRevision,
        capabilityRevision: request.capabilityRevision,
        status: 'selected',
        actionId: 'unadvertised-action',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        reasonCode: 'faulty-reaction',
        confidence: null,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createFaultyDialoguePort(): DialoguePort {
  let textCounter = 0
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      textCounter += 1
      await sink.segment(
        dialogueSegmentSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          segmentId: `${request.turnId}-seg-0`,
          index: 0,
          text: `first draft ${textCounter}`,
          model: 'fixture',
          modelVersion: 'fixture-v1',
        }),
      )
      await sink.segment(
        dialogueSegmentSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          segmentId: `${request.turnId}-seg-1`,
          index: 1,
          text: 'second segment',
          model: 'fixture',
          modelVersion: 'fixture-v1',
        }),
      )
      return dialogueEndSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        status: 'completed',
        segmentCount: 1,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createFaultyPunctuationDialoguePort(): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      await sink.segment(
        dialogueSegmentSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          segmentId: `${request.turnId}-seg-0`,
          index: 0,
          text: '...',
          model: 'fixture',
          modelVersion: 'fixture-v1',
        }),
      )
      return dialogueEndSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        status: 'completed',
        segmentCount: 1,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createFaultySynthesisPort(): SynthesisPort {
  return {
    async prepare(request) {
      return preparedAudioSchema.parse({
        ok: true,
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        audioRef: '/Users/local/secret/audio.wav',
        format: 'audio/wav',
        durationMs: 1200,
        timing: null,
      })
    },
  }
}

export function createFaultyRendererPort(): RendererPort {
  return {
    capabilities: () => ({
      rendererId: 'renderer-faulty',
      characterId: 'character-fixture',
      capabilityRevision: 1,
      actions: [
        { actionId: 'smile', description: 'smile', observability: 'observable', parameterBounds: [] },
        { actionId: 'smile', description: 'duplicate', observability: 'observable', parameterBounds: [] },
      ],
    }),
    async execute(command) {
      return performanceReceiptSchema.parse({
        receiptId: `receipt-avatar-${command.outputId}`,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'avatar',
        stage: 'completed',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: 'faulty-renderer',
        source: 'faulty-renderer',
      })
    },
  }
}

export interface FaultyPlayer extends PlayerPort {
  cancelCalls(): number
}

export function createFaultyPlayer(options: { hold?: boolean } = {}): FaultyPlayer {
  let cancelCalls = 0
  let status: PlayerStatus = { idle: true, activeOutputId: null, lastStage: null }
  let pending: (() => void) | null = null
  return {
    cancelCalls: () => cancelCalls,
    async execute(command) {
      status = { idle: false, activeOutputId: command.outputId, lastStage: 'started' }
      const mismatched = performanceReceiptSchema.parse({
        receiptId: `receipt-audio-${command.outputId}`,
        outputId: 'mismatched-output-id',
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'completed',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: null,
        source: 'faulty-player',
      })
      if (!(options.hold ?? false)) return mismatched
      return new Promise<typeof mismatched>((resolve) => {
        pending = () => resolve(mismatched)
      })
    },
    async cancel() {
      cancelCalls += 1
      // Fault: cancels without returning terminal evidence, even when active.
      status = { idle: true, activeOutputId: null, lastStage: null }
      pending?.()
      return null
    },
    status: () => status,
  }
}

export interface FaultyEventStore {
  events: RuntimeEvent[]
  deliveries: ConfirmedDelivery[]
  failNextCommit: boolean
  store: EventStorePort
}

export function createFaultyEventStore(): FaultyEventStore {
  const events: RuntimeEvent[] = []
  const deliveries: ConfirmedDelivery[] = []
  const record = {
    events,
    deliveries,
    failNextCommit: false,
    store: undefined as unknown as EventStorePort,
  }
  const store: EventStorePort = {
    async append(event: RuntimeEvent): Promise<AppendAck> {
      // Fault: accepts any sequence, including duplicates in the same session.
      events.push(event)
      return { outcome: 'stored', eventId: event.eventId, seq: event.seq }
    },
    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      // Fault: mutates storage even when the write is meant to fail (non-atomic),
      // and always overwrites the delivery record.
      events.push(event)
      deliveries.push({
        sessionId: delivery.sessionId,
        turnId: delivery.turnId,
        segmentId: delivery.segmentId,
        textHash: delivery.textHash,
        text: delivery.text,
        outputId: delivery.outputId,
        receiptId: delivery.receiptId,
        classification: delivery.classification,
        modality: delivery.modality,
      })
      if (record.failNextCommit) {
        record.failNextCommit = false
        return {
          delivery: { status: 'failed', reasonCode: 'storage_unavailable', message: 'faulty non-atomic failure' },
          event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
        }
      }
      return {
        delivery: { status: 'applied', effectiveClassification: delivery.classification, recordId: 'faulty' },
        event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
      }
    },
    async readSession(sessionId: string): Promise<RuntimeEvent[]> {
      return events.filter((event) => event.sessionId === sessionId)
    },
    async exportJsonl(sessionId: string): Promise<string> {
      return events.filter((event) => event.sessionId === sessionId).map((event) => JSON.stringify(event)).join('\n')
    },
  }
  record.store = store
  return record
}

export function createFaultyHistoryQuery(source: {
  storedDeliveries(): readonly StoredDelivery[]
}): HistoryQueryPort {
  return {
    async confirmedHistory(sessionId) {
      // Fault: returns every record for the session in insertion order, including partial/not-delivered.
      return source
        .storedDeliveries()
        .map(({ record }) => record)
        .filter((record) => record.sessionId === sessionId)
    },
  }
}

export function createFaultyMemoryProjection(): MemoryProjectionPort & { appliedCount: () => number } {
  let applied = 0
  let count = 0
  return {
    appliedCount: () => count,
    appliedSeq: () => applied,
    async apply(event) {
      // Fault: reapplies without idempotence and claims current even past a gap.
      applied = event.seq
      count += 1
      return { appliedSeq: applied }
    },
  }
}

export function createFaultyControlAuthorizer() {
  return {
    isOperator: () => true,
  }
}

export function createFaultyConsoleTransport(): ConsoleTransportPort {
  const bootstrap: BootstrapSnapshot = bootstrapSnapshotSchema.parse({
    protocolVersion: '0.2',
    messageId: 'bootstrap-faulty',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    seq: 5,
    lifecycle: 'running',
    activeTurnId: null,
    performerStatus: 'idle',
    outputConfirmation: 'confirmed',
    capabilityRevision: 1,
  })
  const listeners = new Set<(message: ServerMessage) => void>()
  return {
    async bootstrap() {
      return bootstrap
    },
    async sendInput(message): Promise<InputAck> {
      return inputAckSchema.parse({
        status: 'accepted',
        requestMessageId: message.messageId,
        eventId: 'event-faulty',
        sessionId: message.sessionId,
        epoch: message.epoch,
        seq: 6,
      })
    },
    async sendControl(message): Promise<ControlAck> {
      return controlAckSchema.parse({
        sessionId: message.sessionId,
        requestId: message.payload.requestId,
        requestMessageId: message.messageId,
        action: message.kind === 'control.stop' ? 'stop' : 'resume',
        status: 'applied',
        previousEpoch: message.epoch,
        epoch: message.epoch + 1,
        lifecycle: message.kind === 'control.stop' ? 'stopped' : 'running',
        outputConfirmation: 'unknown',
        reasonCode: null,
        message: 'faulty',
      })
    },
    onServerMessage(listener) {
      listeners.add(listener)
      listener(
        sessionEventMessageSchema.parse({
          protocolVersion: '0.2',
          messageId: 'stale-event',
          sessionId: FIXTURE_SESSION_ID,
          epoch: 1,
          kind: 'session.event',
          payload: { seq: 3, type: 'input.accepted', data: {} },
        }),
      )
      return () => {
        listeners.delete(listener)
      }
    },
    close() {
      listeners.clear()
    },
  }
}
