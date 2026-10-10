import type {
  AppendAck,
  AtomicCommitAck,
  BootstrapSnapshot,
  CommitDelivery,
  ConfirmedDelivery,
  ConsoleTransportPort,
  ControlAck,
  DeliveryCommitAck,
  DialogueEnd,
  DialoguePort,
  DialogueSink,
  EventStorePort,
  HistoryQueryPort,
  InputAck,
  MemoryCommitPort,
  MemoryProjectionPort,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerPort,
  PlayerStatus,
  ReactionPort,
  ReplayReaderPort,
  RendererPort,
  RuntimeEndpointPort,
  RuntimeEvent,
  SelectionPort,
  ServerMessage,
  SynthesisPort,
  TrustedControlContext,
} from '../../src/contracts'
import {
  bootstrapSnapshotSchema,
  controlAckSchema,
  decisionResultSchema,
  deliveryCommitAckSchema,
  dialogueEndSchema,
  dialogueSegmentSchema,
  inputAckSchema,
  performanceReceiptSchema,
  preparedAudioSchema,
  selectionResultSchema,
} from '../../src/contracts'
import {
  FIXTURE_SESSION_ID,
  createFixtureIds,
  fixtureCapabilitySnapshot,
  fixtureOperatorContext,
  fixtureUsage,
} from './fixture-data'

export interface FixtureSelectionPort extends SelectionPort {
  callCount(): number
}

export function createFixtureSelectionPort(): FixtureSelectionPort {
  let calls = 0
  return {
    callCount: () => calls,
    async select(request) {
      calls += 1
      const first = request.candidates[0]
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: [first.eventId],
        replyIntent: 'answer',
        reasonCode: 'fixture-selected',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createDeferringSelectionPort(): SelectionPort {
  return {
    async select(request) {
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'defer',
        selectedEventIds: [],
        replyIntent: null,
        reasonCode: 'fixture-deferred',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createFixtureReactionPort(): ReactionPort {
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
        actionId: request.eligibleActionIds[0],
        provider: 'fixture-rule',
        modelVersion: 'fixture-v1',
        reasonCode: 'fixture-rule-selected',
        confidence: null,
        usage: fixtureUsage({ requestId: request.requestId, provider: 'fixture-rule' }),
      })
    },
  }
}

export interface FixtureDialogueOptions {
  segmentCount?: number
  /** Awaited before each segment; lets tests cancel before completion. */
  beforeSegment?: (index: number) => Promise<void>
}

export function createFixtureDialoguePort(options: FixtureDialogueOptions = {}): DialoguePort {
  const requestedCount = options.segmentCount ?? 1
  return {
    async generate(request, context, sink: DialogueSink): Promise<DialogueEnd> {
      const ids = createFixtureIds('dialogue')
      for (let index = 0; index < requestedCount; index += 1) {
        if (context.signal.aborted) {
          return dialogueEndSchema.parse({
            requestId: request.requestId,
            sessionId: request.sessionId,
            epoch: request.epoch,
            turnId: request.turnId,
            status: 'cancelled',
            segmentCount: index,
            usage: fixtureUsage({ requestId: request.requestId }),
          })
        }
        if (options.beforeSegment !== undefined) await options.beforeSegment(index)
        await sink.segment(
          dialogueSegmentSchema.parse({
            requestId: request.requestId,
            sessionId: request.sessionId,
            epoch: request.epoch,
            turnId: request.turnId,
            segmentId: `${request.turnId}-seg-${index}-${ids()}`,
            index,
            text: index === 0 ? 'We talked about the concert.' : 'It was loud and fun.',
            model: 'fixture',
            modelVersion: 'fixture-v1',
          }),
        )
      }
      return dialogueEndSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        status: 'completed',
        segmentCount: requestedCount,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createFixtureSynthesisPort(): SynthesisPort {
  return {
    async prepare(request) {
      return preparedAudioSchema.parse({
        ok: true,
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        audioRef: `audio://fixture/${request.turnId}/${request.segmentId}`,
        format: 'audio/wav',
        durationMs: 1200,
        timing: { startMs: 0, endMs: 1200 },
      })
    },
  }
}

export function createFixtureRendererPort(): RendererPort {
  return {
    capabilities: () => fixtureCapabilitySnapshot(),
    async execute(command) {
      return performanceReceiptSchema.parse({
        receiptId: `receipt-avatar-${command.outputId}`,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'avatar',
        stage: 'accepted',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: 'fixture-renderer',
        source: 'fixture-renderer',
      })
    },
  }
}

export interface CountingRenderer extends RendererPort {
  calls(): number
}

export function createCountingRenderer(delegate: RendererPort): CountingRenderer {
  let calls = 0
  return {
    calls: () => calls,
    capabilities: () => delegate.capabilities(),
    async execute(command, context) {
      calls += 1
      return delegate.execute(command, context)
    },
  }
}

/** A second valid selection policy: selects the second offered candidate with a distinct allowed intent. */
export function createAlternateSelectionPort(): SelectionPort {
  return {
    async select(request) {
      const chosen = request.candidates[Math.min(1, request.candidates.length - 1)]
      const intent = request.allowedIntents.includes('clarify') ? 'clarify' : request.allowedIntents[0]
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: [chosen.eventId],
        replyIntent: intent,
        reasonCode: 'fixture-second',
        provider: 'fixture-alt',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

/** A second valid decision policy: selects the last eligible action. */
export function createAlternateReactionPort(): ReactionPort {
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
        actionId: request.eligibleActionIds[request.eligibleActionIds.length - 1],
        provider: 'fixture-alt-rule',
        modelVersion: 'fixture-v1',
        reasonCode: 'fixture-alt-selected',
        confidence: null,
        usage: fixtureUsage({ requestId: request.requestId, provider: 'fixture-alt-rule' }),
      })
    },
  }
}

/** A second valid synthesis provider with a distinct opaque reference scheme. */
export function createAlternateSynthesisPort(): SynthesisPort {
  return {
    async prepare(request) {
      return preparedAudioSchema.parse({
        ok: true,
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        audioRef: `synth://alt/${request.segmentId}`,
        format: 'audio/ogg',
        durationMs: null,
        timing: null,
      })
    },
  }
}

/** A second valid renderer with a different identity and capability set. */
export function createAlternateRendererPort(): RendererPort {
  return {
    capabilities: () => ({
      rendererId: 'renderer-alt',
      characterId: 'character-alt',
      capabilityRevision: 3,
      actions: [
        { actionId: 'neutral', description: 'neutral', observability: 'observable', parameterBounds: [] },
        { actionId: 'listening', description: 'listening', observability: 'acceptance-only', parameterBounds: [] },
      ],
    }),
    async execute(command) {
      return performanceReceiptSchema.parse({
        receiptId: `receipt-alt-${command.outputId}`,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'avatar',
        stage: 'accepted',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: null,
        source: 'alternate-renderer',
      })
    },
  }
}

export function createAbstainingReactionPort(): ReactionPort {
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
        status: 'abstained',
        actionId: null,
        provider: 'fixture-rule',
        modelVersion: 'fixture-v1',
        reasonCode: 'fixture-abstained',
        confidence: null,
        usage: fixtureUsage({ requestId: request.requestId, provider: 'fixture-rule' }),
      })
    },
  }
}

export interface FixturePlayer extends PlayerPort {
  /** Resolve an in-flight held execute as completed. */
  complete(): void
}

interface ActivePlayback {
  command: PerformanceCommand
  resolve: (receipt: PerformanceReceipt) => void
}

function completedReceipt(command: PerformanceCommand): PerformanceReceipt {
  return performanceReceiptSchema.parse({
    receiptId: `receipt-audio-${command.outputId}`,
    outputId: command.outputId,
    sessionId: command.sessionId,
    epoch: command.epoch,
    turnId: command.turnId,
    segmentId: command.segmentId,
    modality: 'audio',
    stage: 'completed',
    localTimeMs: 1200,
    chunkIds: null,
    reasonCode: null,
    source: 'fixture-player',
  })
}

export function createFixturePlayer(options: { hold?: boolean; holdAfter?: number } = {}): FixturePlayer {
  let active: ActivePlayback | null = null
  let immediateRemaining = options.holdAfter ?? 0
  let status: PlayerStatus = { idle: true, activeOutputId: null, lastStage: null }
  return {
    complete() {
      if (active === null) return
      const { command, resolve } = active
      active = null
      status = { idle: true, activeOutputId: null, lastStage: 'completed' }
      resolve(completedReceipt(command))
    },
    async execute(command) {
      const shouldHold = (options.hold ?? false) && immediateRemaining <= 0
      if (!shouldHold) {
        if (options.hold ?? false) immediateRemaining -= 1
        status = { idle: false, activeOutputId: command.outputId, lastStage: 'started' }
        status = { idle: true, activeOutputId: null, lastStage: 'completed' }
        return completedReceipt(command)
      }
      status = { idle: false, activeOutputId: command.outputId, lastStage: 'started' }
      return new Promise<PerformanceReceipt>((resolve) => {
        active = { command, resolve }
      })
    },
    async cancel(request) {
      if (active === null) {
        status = { ...status, idle: true }
        return null
      }
      const { command, resolve } = active
      active = null
      status = { idle: true, activeOutputId: null, lastStage: 'cancelled' }
      const receipt = performanceReceiptSchema.parse({
        receiptId: `receipt-cancel-${request.requestId}`,
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: request.revokedEpoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        modality: 'audio',
        stage: 'cancelled',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: 'fixture-cancel',
        source: 'fixture-player',
      })
      resolve(receipt)
      return receipt
    },
    status: () => status,
  }
}

export function createFixtureMemoryCommit(): MemoryCommitPort {
  const records = new Map<string, CommitDelivery>()
  return {
    async commit(delivery): Promise<DeliveryCommitAck> {
      const key = `${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
      const existing = records.get(key)
      if (existing === undefined) {
        records.set(key, delivery)
        return deliveryCommitAckSchema.parse({
          status: 'applied',
          effectiveClassification: delivery.classification,
          recordId: key,
        })
      }
      if (existing.classification === delivery.classification) {
        return deliveryCommitAckSchema.parse({
          status: 'duplicate',
          effectiveClassification: existing.classification,
          recordId: key,
        })
      }
      return deliveryCommitAckSchema.parse({
        status: 'conflict',
        recordedClassification: existing.classification,
        incomingClassification: delivery.classification,
        conflictRecordId: `${key}:conflict`,
      })
    },
  }
}

export interface FixtureEventStore extends EventStorePort {
  readonly events: RuntimeEvent[]
  readonly deliveries: ConfirmedDelivery[]
  failNextAppend: boolean
  failNextCommit: boolean
  /** Test hooks to hold an acknowledgement for responsiveness checks. */
  beforeAppend?: () => Promise<void>
  beforeCommit?: () => Promise<void>
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function deliveryKey(delivery: Pick<ConfirmedDelivery, 'sessionId' | 'turnId' | 'segmentId' | 'modality'>): string {
  return `${delivery.sessionId}:${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
}

export function createFixtureEventStore(): FixtureEventStore {
  const events: RuntimeEvent[] = []
  const deliveries: ConfirmedDelivery[] = []
  const store: FixtureEventStore = {
    events,
    deliveries,
    failNextAppend: false,
    failNextCommit: false,
    async append(event): Promise<AppendAck> {
      if (store.beforeAppend !== undefined) await store.beforeAppend()
      if (store.failNextAppend) {
        store.failNextAppend = false
        return { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'storage_unavailable', message: 'fixture append failure' }
      }
      const sameId = events.find((stored) => stored.eventId === event.eventId)
      if (sameId !== undefined) {
        return sameContent(sameId, event)
          ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq }
          : { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'reused event id with different content' }
      }
      if (events.some((stored) => stored.sessionId === event.sessionId && stored.seq === event.seq)) {
        return { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'duplicate sequence number in session' }
      }
      events.push(event)
      return { outcome: 'stored', eventId: event.eventId, seq: event.seq }
    },
    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      if (store.beforeCommit !== undefined) await store.beforeCommit()
      const failure: AtomicCommitAck = {
        delivery: { status: 'failed', reasonCode: 'storage_unavailable', message: 'fixture atomic failure' },
        event: { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'storage_unavailable', message: 'fixture atomic failure' },
      }
      if (store.failNextCommit) {
        store.failNextCommit = false
        return failure
      }
      const sameId = events.find((stored) => stored.eventId === event.eventId)
      if (sameId !== undefined && !sameContent(sameId, event)) {
        return failure
      }
      if (events.some((stored) => stored.sessionId === event.sessionId && stored.seq === event.seq && stored.eventId !== event.eventId)) {
        return { ...failure, event: { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'duplicate sequence number in session' } }
      }
      const key = deliveryKey(delivery)
      const existing = deliveries.find((record) => deliveryKey(record) === key)
      let deliveryAck: DeliveryCommitAck
      if (existing === undefined) {
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
        deliveryAck = deliveryCommitAckSchema.parse({ status: 'applied', effectiveClassification: delivery.classification, recordId: key })
      } else if (existing.textHash !== delivery.textHash) {
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'conflict',
          recordedClassification: existing.classification,
          incomingClassification: delivery.classification,
          conflictRecordId: `${key}:conflict`,
        })
      } else if (existing.classification === delivery.classification) {
        deliveryAck = deliveryCommitAckSchema.parse({ status: 'duplicate', effectiveClassification: existing.classification, recordId: key })
      } else {
        deliveryAck = deliveryCommitAckSchema.parse({
          status: 'conflict',
          recordedClassification: existing.classification,
          incomingClassification: delivery.classification,
          conflictRecordId: `${key}:conflict`,
        })
      }
      if (sameId === undefined) events.push(event)
      return { delivery: deliveryAck, event: sameId !== undefined ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq } : { outcome: 'stored', eventId: event.eventId, seq: event.seq } }
    },
    async readSession(sessionId): Promise<RuntimeEvent[]> {
      return events.filter((event) => event.sessionId === sessionId).sort((a, b) => a.seq - b.seq)
    },
    async exportJsonl(sessionId): Promise<string> {
      return events
        .filter((event) => event.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq)
        .map((event) => JSON.stringify(event))
        .join('\n')
    },
  }
  return store
}

export interface FixtureMemoryProjection extends MemoryProjectionPort {
  readonly appliedSeqs: number[]
}

export function createFixtureMemoryProjection(): FixtureMemoryProjection {
  const appliedSeqs: number[] = []
  let highest = 0
  return {
    appliedSeqs,
    appliedSeq: () => highest,
    async apply(event) {
      if (event.seq <= highest) return { appliedSeq: highest }
      if (event.seq > highest + 1) return { appliedSeq: highest }
      highest = event.seq
      appliedSeqs.push(event.seq)
      return { appliedSeq: highest }
    },
  }
}

export function createFixtureReplayReader(store: {
  readSession(sessionId: string): Promise<RuntimeEvent[]>
}): ReplayReaderPort {
  return {
    async load(sessionId) {
      return { sessionId, events: await store.readSession(sessionId) }
    },
  }
}

export function createFixtureHistoryQuery(store: {
  readonly deliveries: ConfirmedDelivery[]
}): HistoryQueryPort {
  return {
    async confirmedHistory(sessionId): Promise<ConfirmedDelivery[]> {
      // Only confirmed spoken records are returned as fully-delivered history.
      return store.deliveries.filter(
        (delivery) =>
          delivery.sessionId === sessionId && delivery.classification === 'fully-delivered',
      )
    },
  }
}

export function createFixtureControlAuthorizer() {
  return {
    isOperator: (context: TrustedControlContext): boolean =>
      context.role === 'operator' && context.authenticated,
  }
}

export function createBootstrapOnlyRuntime(): RuntimeEndpointPort {
  const listeners = new Set<(message: ServerMessage) => void>()
  return {
    async snapshot() {
      return bootstrapSnapshotSchema.parse({
        protocolVersion: '0.2',
        messageId: 'bootstrap-fixture',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        seq: 0,
        lifecycle: 'stopped',
        activeTurnId: null,
        performerStatus: 'idle',
        outputConfirmation: 'confirmed',
        capabilityRevision: 1,
      })
    },
    async submitInput(message) {
      return inputAckSchema.parse({
        status: 'accepted',
        requestMessageId: message.messageId,
        eventId: 'event-console',
        sessionId: message.sessionId,
        epoch: message.epoch,
        seq: 1,
      })
    },
    async control(message) {
      return controlAckSchema.parse({
        sessionId: message.sessionId,
        requestId: message.payload.requestId,
        requestMessageId: message.messageId,
        action: message.kind === 'control.stop' ? 'stop' : 'resume',
        status: 'applied',
        previousEpoch: message.epoch,
        epoch: message.epoch + 1,
        lifecycle: 'stopped',
        outputConfirmation: 'pending',
        reasonCode: null,
        message: 'fixture',
      })
    },
    async handlePlayerMessage() {},
    onServerMessage(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function createFixtureConsoleTransport(
  endpoint: RuntimeEndpointPort,
  context: TrustedControlContext = fixtureOperatorContext(),
): ConsoleTransportPort {
  return {
    bootstrap: (): Promise<BootstrapSnapshot> => endpoint.snapshot(),
    sendInput: (message): Promise<InputAck> => endpoint.submitInput(message, context),
    sendControl: (message): Promise<ControlAck> => endpoint.control(message, context),
    onServerMessage: (listener) => endpoint.onServerMessage(listener),
    close: () => {},
  }
}
