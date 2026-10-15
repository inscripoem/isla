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
  commitDeliverySchema,
  controlAckSchema,
  decisionResultSchema,
  deliveryCommitAckSchema,
  deliveryEventCorrelationIssue,
  dialogueEndSchema,
  dialogueSegmentSchema,
  inputAckSchema,
  performanceReceiptSchema,
  preparedAudioSchema,
  runtimeEventSchema,
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

/** A committed delivery with the sequence of its supporting event. */
export interface FixtureStoredDelivery {
  record: ConfirmedDelivery
  eventSeq: number
}

export interface FixtureEventStore extends EventStorePort {
  /** Detached inspection view of the committed events. */
  readonly events: RuntimeEvent[]
  /** Detached inspection view of the committed delivery records. */
  readonly deliveries: ConfirmedDelivery[]
  /** Detached committed deliveries with their supporting-event sequence. */
  storedDeliveries(): FixtureStoredDelivery[]
  failNextAppend: boolean
  failNextCommit: boolean
  /** Test hooks to hold an acknowledgement for responsiveness checks. */
  beforeAppend?: () => Promise<void>
  beforeCommit?: () => Promise<void>
  /** Test hooks to forge, throw or mismatch the next acknowledgement. */
  throwNextAppend?: boolean
  throwNextCommit?: boolean
  mutateAppendAck?: (ack: AppendAck) => AppendAck
  mutateCommitAck?: (ack: AtomicCommitAck) => AtomicCommitAck
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Structural copy so committed records never share state with callers. */
function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}

function deliveryKey(delivery: Pick<ConfirmedDelivery, 'sessionId' | 'turnId' | 'segmentId' | 'modality'>): string {
  return `${delivery.sessionId}:${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
}

export function createFixtureEventStore(): FixtureEventStore {
  const committedEvents: RuntimeEvent[] = []
  // One explicit representation: each committed delivery keeps its supporting
  // event sequence, so history never has to invent ordering metadata.
  const stored: FixtureStoredDelivery[] = []
  const store: FixtureEventStore = {
    get events() {
      return committedEvents.map(cloneRecord)
    },
    get deliveries() {
      return stored.map(({ record }) => cloneRecord(record))
    },
    storedDeliveries: () =>
      stored.map(({ record, eventSeq }) => ({ record: cloneRecord(record), eventSeq })),
    failNextAppend: false,
    failNextCommit: false,
    async append(event): Promise<AppendAck> {
      if (store.beforeAppend !== undefined) await store.beforeAppend()
      if (store.throwNextAppend) {
        store.throwNextAppend = false
        throw new Error('fixture append throw')
      }
      let ack: AppendAck
      if (store.failNextAppend) {
        store.failNextAppend = false
        ack = { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'storage_unavailable', message: 'fixture append failure' }
      } else {
        const sameId = committedEvents.find(
          (committed) => committed.sessionId === event.sessionId && committed.eventId === event.eventId,
        )
        if (sameId !== undefined) {
          ack = sameContent(sameId, event)
            ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq }
            : { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'reused event id with different content' }
        } else if (committedEvents.some((committed) => committed.sessionId === event.sessionId && committed.seq === event.seq)) {
          ack = { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'duplicate sequence number in session' }
        } else {
          // Fallible preparation precedes publication: copy the event before it
          // is appended, so a copy failure is an ordinary preparation failure
          // reported as a failed acknowledgement with no partial state.
          let prepared: RuntimeEvent | undefined
          try {
            prepared = cloneRecord(event)
          } catch {
            prepared = undefined
          }
          if (prepared === undefined) {
            ack = { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'storage_unavailable', message: 'fixture append preparation failure' }
          } else {
            committedEvents.push(prepared)
            ack = { outcome: 'stored', eventId: event.eventId, seq: event.seq }
          }
        }
      }
      if (store.mutateAppendAck !== undefined) {
        const mutate = store.mutateAppendAck
        store.mutateAppendAck = undefined
        ack = mutate(ack)
      }
      return ack
    },
    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      if (store.beforeCommit !== undefined) await store.beforeCommit()
      // Mirror the production store: an omitted or malformed required delivery
      // field is rejected before any mutation, while explicit nulls stay valid.
      if (!commitDeliverySchema.safeParse(delivery).success) {
        return {
          delivery: { status: 'failed', reasonCode: 'invalid_delivery', message: 'fixture invalid delivery' },
          event: {
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'invalid_delivery',
            message: 'fixture atomic commit rejected an invalid delivery',
          },
        }
      }
      // Mirror the production store: validate the supporting event before its
      // fields are read, so an omitted `versions` or a non-string/null version
      // member is rejected rather than stored or thrown on.
      if (!runtimeEventSchema.safeParse(event).success) {
        const message = 'supporting event failed schema validation'
        return {
          delivery: { status: 'failed', reasonCode: 'invalid_event', message },
          event: {
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'invalid_event',
            message,
          },
        }
      }
      // Mirror the production store: contradictory known provenance or
      // correlation between the delivery and its supporting event is one paired
      // failure before any mutation.
      const correlationIssue = deliveryEventCorrelationIssue(delivery, event)
      if (correlationIssue !== null) {
        const message = `delivery and supporting event disagree on ${correlationIssue}`
        return {
          delivery: { status: 'failed', reasonCode: 'inconsistent_delivery', message },
          event: {
            outcome: 'failed',
            eventId: event.eventId,
            seq: event.seq,
            reasonCode: 'inconsistent_delivery',
            message,
          },
        }
      }
      if (store.throwNextCommit) {
        store.throwNextCommit = false
        throw new Error('fixture commit throw')
      }
      const failure: AtomicCommitAck = {
        delivery: { status: 'failed', reasonCode: 'storage_unavailable', message: 'fixture atomic failure' },
        event: { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'storage_unavailable', message: 'fixture atomic failure' },
      }
      let atomic: AtomicCommitAck
      if (store.failNextCommit) {
        store.failNextCommit = false
        atomic = failure
      } else {
        const sameId = committedEvents.find(
          (committed) => committed.sessionId === event.sessionId && committed.eventId === event.eventId,
        )
        if (sameId !== undefined && !sameContent(sameId, event)) {
          atomic = failure
        } else if (committedEvents.some((committed) => committed.sessionId === event.sessionId && committed.seq === event.seq && committed.eventId !== event.eventId)) {
          atomic = { ...failure, event: { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'duplicate sequence number in session' } }
        } else {
          const key = deliveryKey(delivery)
          const existing = stored.find((entry) => deliveryKey(entry.record) === key)?.record
          let deliveryAck: DeliveryCommitAck
          let nextRecord: ConfirmedDelivery | undefined
          if (existing === undefined) {
            nextRecord = {
              sessionId: delivery.sessionId,
              turnId: delivery.turnId,
              segmentId: delivery.segmentId,
              textHash: delivery.textHash,
              text: delivery.text,
              outputId: delivery.outputId,
              receiptId: delivery.receiptId,
              classification: delivery.classification,
              modality: delivery.modality,
              segmentIndex: delivery.segmentIndex,
              personaProfileId: delivery.personaProfileId,
              personaProfileVersion: delivery.personaProfileVersion,
            }
            deliveryAck = deliveryCommitAckSchema.parse({ status: 'applied', effectiveClassification: delivery.classification, recordId: key })
          } else if (
            existing.textHash !== delivery.textHash ||
            // Attribution is immutable identity: a changed index or persona
            // conflicts rather than silently duplicating or overwriting.
            existing.segmentIndex !== delivery.segmentIndex ||
            existing.personaProfileId !== delivery.personaProfileId ||
            existing.personaProfileVersion !== delivery.personaProfileVersion
          ) {
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
          // Prepare every fallible copy (the supporting event and any new
          // delivery record) before publishing either. A copy failure is an
          // ordinary preparation failure: a failed acknowledgement with no
          // partial event, delivery or history state.
          let preparedEvent: RuntimeEvent | undefined
          let preparedRecord: ConfirmedDelivery | undefined
          let publishable = true
          try {
            if (sameId === undefined) preparedEvent = cloneRecord(event)
            if (nextRecord !== undefined) preparedRecord = cloneRecord(nextRecord)
          } catch {
            publishable = false
          }
          if (!publishable) {
            atomic = failure
          } else {
            if (preparedRecord !== undefined) stored.push({ record: preparedRecord, eventSeq: event.seq })
            if (preparedEvent !== undefined) committedEvents.push(preparedEvent)
            atomic = { delivery: deliveryAck, event: sameId !== undefined ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq } : { outcome: 'stored', eventId: event.eventId, seq: event.seq } }
          }
        }
      }
      if (store.mutateCommitAck !== undefined) {
        const mutate = store.mutateCommitAck
        store.mutateCommitAck = undefined
        atomic = mutate(atomic)
      }
      return atomic
    },
    async readSession(sessionId): Promise<RuntimeEvent[]> {
      return committedEvents
        .filter((event) => event.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq)
        .map(cloneRecord)
    },
    async exportJsonl(sessionId): Promise<string> {
      return committedEvents
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
      // Detached from live state: replay may be inspected or mutated freely.
      return { sessionId, events: (await store.readSession(sessionId)).map(cloneRecord) }
    },
  }
}

export interface FixtureHistorySource {
  storedDeliveries(): readonly FixtureStoredDelivery[]
}

export function createFixtureHistoryQuery(store: FixtureHistorySource): HistoryQueryPort {
  return {
    async confirmedHistory(sessionId): Promise<ConfirmedDelivery[]> {
      // Read live each call, keep only confirmed spoken records, order by the
      // supporting-event sequence and detach the returned records.
      return store
        .storedDeliveries()
        .filter(
          ({ record }) =>
            record.sessionId === sessionId && record.classification === 'fully-delivered',
        )
        .sort((a, b) => a.eventSeq - b.eventSeq)
        .map(({ record }) => cloneRecord(record))
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
