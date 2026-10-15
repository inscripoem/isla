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
  ReplayReaderPort,
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
  storedDeliveries(): FaultyStoredDelivery[]
  failNextCommit: boolean
  store: EventStorePort
}

export function createFaultyEventStore(): FaultyEventStore {
  const events: RuntimeEvent[] = []
  const deliveries: ConfirmedDelivery[] = []
  const record = {
    events,
    deliveries,
    // Insertion-order metadata is adequate for a deliberately faulty adapter.
    storedDeliveries: () => deliveries.map((delivery, index) => ({ record: delivery, eventSeq: index })),
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
        segmentIndex: delivery.segmentIndex,
        personaProfileId: delivery.personaProfileId,
        personaProfileVersion: delivery.personaProfileVersion,
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

/** A stored delivery with the sequence of its supporting event. */
export interface FaultyStoredDelivery {
  record: ConfirmedDelivery
  eventSeq: number
}

export interface FaultyHistorySource {
  readonly deliveries: ConfirmedDelivery[]
  storedDeliveries?(): readonly FaultyStoredDelivery[]
}

/**
 * Faults: returns every record for every session in insertion order, including
 * not-delivered and partial records, and returns shared references. Detects the
 * ordering, dedup, classification, session-scope and detachment assertions.
 */
export function createFaultyHistoryQuery(source: FaultyHistorySource): HistoryQueryPort {
  return {
    async confirmedHistory() {
      const records = source.storedDeliveries?.() ?? source.deliveries.map((record, index) => ({ record, eventSeq: index }))
      return records.map(({ record }) => record)
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

/** Fault: returns shared references, so mutating a replay changes live state. */
export function createFaultyReplayReader(store: {
  readSession(sessionId: string): Promise<RuntimeEvent[]>
}): ReplayReaderPort {
  return {
    async load(sessionId) {
      return { sessionId, events: await store.readSession(sessionId) }
    },
  }
}

/** Fault: a replay archive that omits every committed event. */
export function createEmptyReplayReader(): ReplayReaderPort {
  return {
    async load(sessionId) {
      return { sessionId, events: [] }
    },
  }
}

export interface FaultyPartialEventStore {
  store: EventStorePort
  events: RuntimeEvent[]
  deliveries: ConfirmedDelivery[]
  storedDeliveries(): FaultyStoredDelivery[]
}

/**
 * Fault: a non-atomic store that publishes the delivery record before it copies
 * the supporting event, mirroring the partial-batch failure found in PR #9. When
 * the event cannot be copied the copy throws after the delivery is already
 * visible, leaving partial state instead of a clean failed acknowledgement. A
 * focused probe must report the partial delivery, not merely let the exception
 * escape.
 */
export function createThrowAfterDeliveryEventStore(): FaultyPartialEventStore {
  const events: RuntimeEvent[] = []
  const deliveries: ConfirmedDelivery[] = []
  const record: FaultyPartialEventStore = {
    events,
    deliveries,
    storedDeliveries: () => deliveries.map((delivery, index) => ({ record: delivery, eventSeq: index })),
    store: undefined as unknown as EventStorePort,
  }
  const store: EventStorePort = {
    async append(event): Promise<AppendAck> {
      const sameId = events.find(
        (stored) => stored.sessionId === event.sessionId && stored.eventId === event.eventId,
      )
      if (sameId !== undefined) {
        return JSON.stringify(sameId) === JSON.stringify(event)
          ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq }
          : { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'event id conflict' }
      }
      if (events.some((stored) => stored.sessionId === event.sessionId && stored.seq === event.seq)) {
        return { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'sequence conflict' }
      }
      events.push(structuredClone(event))
      return { outcome: 'stored', eventId: event.eventId, seq: event.seq }
    },
    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      // Fault: publish the delivery before the fallible event copy.
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
        segmentIndex: delivery.segmentIndex,
        personaProfileId: delivery.personaProfileId,
        personaProfileVersion: delivery.personaProfileVersion,
      })
      const copy = structuredClone(event)
      events.push(copy)
      return {
        delivery: { status: 'applied', effectiveClassification: delivery.classification, recordId: `${delivery.turnId}:${delivery.segmentId}` },
        event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
      }
    },
    async readSession(sessionId): Promise<RuntimeEvent[]> {
      return events.filter((stored) => stored.sessionId === sessionId)
    },
    async exportJsonl(sessionId): Promise<string> {
      return events
        .filter((stored) => stored.sessionId === sessionId)
        .map((stored) => JSON.stringify(stored))
        .join('\n')
    },
  }
  record.store = store
  return record
}

/** Fault: exports a different session's events regardless of the request. */
export function createWrongExportEventStore(
  delegate: EventStorePort,
  wrongSessionId: string,
): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    commitDeliveryWithEvent: (delivery, event) => delegate.commitDeliveryWithEvent(delivery, event),
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: () => delegate.exportJsonl(wrongSessionId),
  }
}

/**
 * Fault: drops the delivery attribution on write. The three required nullable
 * fields are replaced with explicit nulls, so a known segment index or persona
 * is lost while the commit still reports success. Proves the shared attribution
 * checks detect lost fields.
 */
export function createAttributionDroppingEventStore(delegate: EventStorePort): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    commitDeliveryWithEvent: (delivery, event) =>
      delegate.commitDeliveryWithEvent(
        { ...delivery, segmentIndex: null, personaProfileId: null, personaProfileVersion: null },
        event,
      ),
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: (sessionId) => delegate.exportJsonl(sessionId),
  }
}

/**
 * Fault: fabricates a fixed attribution on write, substituting an invented
 * index and persona for the originating segment/request. Proves the shared
 * checks detect fabricated fields.
 */
export function createAttributionFabricatingEventStore(delegate: EventStorePort): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    commitDeliveryWithEvent: (delivery, event) =>
      delegate.commitDeliveryWithEvent(
        {
          ...delivery,
          segmentIndex: 0,
          personaProfileId: 'persona-fabricated',
          personaProfileVersion: '0',
        },
        event,
      ),
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: (sessionId) => delegate.exportJsonl(sessionId),
  }
}

/**
 * Fault: silently normalizes an inconsistent classification/terminalOutcome
 * pair to a consistent one before delegating, so the boundary accepts a pair it
 * must reject. Proves the shared combination checks detect a bypassed boundary.
 */
export function createCombinationNormalizingEventStore(delegate: EventStorePort): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    commitDeliveryWithEvent: (delivery, event) =>
      delegate.commitDeliveryWithEvent(
        {
          ...delivery,
          terminalOutcome:
            delivery.classification === 'fully-delivered'
              ? 'completed'
              : delivery.terminalOutcome === 'completed'
                ? 'cancelled'
                : delivery.terminalOutcome,
        },
        event,
      ),
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: (sessionId) => delegate.exportJsonl(sessionId),
  }
}

/**
 * Fault: silently rewrites a contradicting supporting event to agree with the
 * delivery before delegating, so a known provenance/correlation mismatch is
 * accepted instead of rejected. Proves the shared correlation checks detect a
 * bypassed boundary; unrelated version entries are still preserved.
 */
export function createProvenanceIgnoringEventStore(delegate: EventStorePort): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    commitDeliveryWithEvent: (delivery, event) =>
      delegate.commitDeliveryWithEvent(delivery, {
        ...event,
        sessionId: delivery.sessionId,
        turnId: event.turnId === null ? null : delivery.turnId,
        segmentId: event.segmentId === null ? null : delivery.segmentId,
        outputId: event.outputId === null ? null : delivery.outputId,
        versions:
          event.versions === null
            ? null
            : {
                ...event.versions,
                ...(event.versions['personaProfileId'] !== undefined &&
                delivery.personaProfileId !== null
                  ? { personaProfileId: delivery.personaProfileId }
                  : {}),
                ...(event.versions['personaProfileVersion'] !== undefined &&
                delivery.personaProfileVersion !== null
                  ? { personaProfileVersion: delivery.personaProfileVersion }
                  : {}),
              },
      }),
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: (sessionId) => delegate.exportJsonl(sessionId),
  }
}

/**
 * Fault: a rejected delivery is persisted anyway. When the first commit is
 * rejected (for example because a required field was omitted), the wrapper
 * repairs the omitted field to an explicit null and commits again through the
 * delegate, which stores **both** the delivery record and its supporting event
 * behind the failed acknowledgement. This is not a record-only orphan: the
 * whole batch is published despite the failure. Proves the shared snapshot
 * check detects state published behind a failed acknowledgement, and the retry
 * check detects that the consumed identity can no longer be applied.
 */
export function createPersistDespiteRejectionEventStore(delegate: EventStorePort): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    async commitDeliveryWithEvent(delivery, event) {
      const ack = await delegate.commitDeliveryWithEvent(delivery, event)
      if (ack.delivery.status === 'failed') {
        await delegate.commitDeliveryWithEvent(
          {
            ...delivery,
            segmentIndex: delivery.segmentIndex ?? null,
            personaProfileId: delivery.personaProfileId ?? null,
            personaProfileVersion: delivery.personaProfileVersion ?? null,
          },
          event,
        )
      }
      return ack
    },
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: (sessionId) => delegate.exportJsonl(sessionId),
  }
}

/**
 * Fault: when a delivery is rejected, the wrapper still publishes its
 * supporting event without the delivery. This leaves a partial event behind a
 * failed acknowledgement. Proves the shared snapshot checks detect partial
 * events, not only partial delivery records.
 */
export function createPartialEventOnRejectedDeliveryEventStore(
  delegate: EventStorePort,
): EventStorePort {
  return {
    append: (event) => delegate.append(event),
    async commitDeliveryWithEvent(delivery, event) {
      const ack = await delegate.commitDeliveryWithEvent(delivery, event)
      if (ack.delivery.status === 'failed') {
        await delegate.append(event)
      }
      return ack
    },
    readSession: (sessionId) => delegate.readSession(sessionId),
    exportJsonl: (sessionId) => delegate.exportJsonl(sessionId),
  }
}

/** Fault: returns confirmed history in insertion order instead of event-seq order. */
export function createInsertionOrderedHistoryQuery(source: {
  readonly deliveries: ConfirmedDelivery[]
}): HistoryQueryPort {
  return {
    async confirmedHistory(sessionId) {
      return source.deliveries
        .filter(
          (record) =>
            record.sessionId === sessionId && record.classification === 'fully-delivered',
        )
        .map((record) => structuredClone(record))
    },
  }
}

export interface FaultySharedStorageKit {
  store: EventStorePort
  projection: MemoryProjectionPort
  history: HistoryQueryPort
  replay: ReplayReaderPort
  setFailNextCommit: () => void
}

/**
 * A deliberately session-blind, reference-sharing storage kit. Event identity is
 * global rather than session-scoped, reads and JSONL exports ignore the session,
 * records are shared with the caller, and confirmed history is unfiltered and
 * unordered. It exercises every strengthened storage assertion at once.
 */
export function createFaultySharedStorageKit(
  options: { snapshotHistory?: boolean } = {},
): FaultySharedStorageKit {
  const events: RuntimeEvent[] = []
  const deliveries: ConfirmedDelivery[] = []
  let failNextCommit = false
  const globalKey = (delivery: Pick<ConfirmedDelivery, 'turnId' | 'segmentId' | 'modality'>): string =>
    `${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
  const captured = deliveries.map((record, index) => ({ record, eventSeq: index }))
  const store: EventStorePort = {
    async append(event): Promise<AppendAck> {
      const sameId = events.find((stored) => stored.eventId === event.eventId)
      if (sameId !== undefined) {
        return JSON.stringify(sameId) === JSON.stringify(event)
          ? { outcome: 'duplicate', eventId: event.eventId, seq: event.seq }
          : { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'global event id conflict' }
      }
      events.push(event)
      return { outcome: 'stored', eventId: event.eventId, seq: event.seq }
    },
    async commitDeliveryWithEvent(delivery, event): Promise<AtomicCommitAck> {
      const sameId = events.find((stored) => stored.eventId === event.eventId)
      events.push(event)
      if (sameId !== undefined && JSON.stringify(sameId) !== JSON.stringify(event)) {
        return {
          delivery: { status: 'failed', reasonCode: 'conflict', message: 'global event id conflict' },
          event: { outcome: 'failed', eventId: event.eventId, seq: event.seq, reasonCode: 'conflict', message: 'global event id conflict' },
        }
      }
      const existing = deliveries.find((stored) => globalKey(stored) === globalKey(delivery))
      deliveries.push(delivery)
      if (failNextCommit) {
        failNextCommit = false
        return {
          delivery: { status: 'failed', reasonCode: 'storage_unavailable', message: 'faulty shared failure' },
          event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
        }
      }
      if (existing === undefined) {
        return {
          delivery: { status: 'applied', effectiveClassification: delivery.classification, recordId: globalKey(delivery) },
          event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
        }
      }
      if (existing.textHash === delivery.textHash && existing.classification === delivery.classification) {
        return {
          delivery: { status: 'duplicate', effectiveClassification: existing.classification, recordId: globalKey(delivery) },
          event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
        }
      }
      return {
        delivery: {
          status: 'conflict',
          recordedClassification: existing.classification,
          incomingClassification: delivery.classification,
          conflictRecordId: `${globalKey(delivery)}:conflict`,
        },
        event: { outcome: 'stored', eventId: event.eventId, seq: event.seq },
      }
    },
    async readSession(): Promise<RuntimeEvent[]> {
      return [...events].sort((a, b) => a.seq - b.seq)
    },
    async exportJsonl(): Promise<string> {
      return [...events].sort((a, b) => a.seq - b.seq).map((event) => JSON.stringify(event)).join('\n')
    },
  }
  return {
    store,
    projection: createFaultyMemoryProjection(),
    history: {
      async confirmedHistory() {
        const records =
          options.snapshotHistory === true
            ? captured
            : deliveries.map((record, index) => ({ record, eventSeq: index }))
        return records.map(({ record }) => record)
      },
    },
    replay: {
      async load(sessionId) {
        return { sessionId, events: await store.readSession(sessionId) }
      },
    },
    setFailNextCommit: () => {
      failNextCommit = true
    },
  }
}
