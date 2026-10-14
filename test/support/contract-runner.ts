import type {
  BootstrapSnapshot,
  CallContext,
  CommitDelivery,
  ControlAck,
  ControlAuthorizerPort,
  ControlResumeMessage,
  ControlStopMessage,
  DialogueEnd,
  DialoguePort,
  DialogueSegment,
  EventStorePort,
  HistoryQueryPort,
  InputAck,
  InputEvent,
  InputSubmitMessage,
  MemoryCommitPort,
  MemoryProjectionPort,
  PerformanceReceipt,
  PlayerPort,
  ReactionPort,
  ReplayReaderPort,
  RendererPort,
  RuntimeEndpointPort,
  RuntimeEvent,
  SelectionPort,
  SelectionResult,
  ServerMessage,
  SynthesisPort,
  TrustedControlContext,
} from '../../src/contracts'
import {
  NO_OP_ACTION,
  bootstrapSnapshotSchema,
  controlAckSchema,
  decisionRequestSchema,
  decisionResultSchema,
  dialogueRequestSchema,
  inputAckSchema,
  performanceCommandSchema,
  runtimeEventSchema,
  selectionRequestSchema,
  selectionResultSchema,
} from '../../src/contracts'
import {
  classifyAudioDelivery,
  isDeadlineExpired,
  isTerminalReceiptStage,
  nextEpoch,
  reconcileReceipt,
  selectFallback,
} from './policy'
import type { ReceiptFact } from './policy'
import type { VirtualClock } from './virtual-clock'

/**
 * Offline contract runner. It drives the public ports to demonstrate contract
 * semantics (normal flow, prompt Stop/stale, receipt reconciliation, atomic
 * persistence acknowledgement). It is deliberately not the production M5
 * coordinator and reimplements no product provider logic.
 */

export interface RunnerHooks {
  beforeSelect?: () => Promise<void>
  /** Invoked after playback starts but before it settles, so a test can Stop mid-playback. */
  onPlaybackStart?: (index: number, outputId: string) => Promise<void>
  afterSegmentDispatch?: (index: number) => Promise<void>
}

export interface RunnerDeps {
  selection: SelectionPort
  reaction: ReactionPort
  dialogue: DialoguePort
  synthesis: SynthesisPort
  renderer: RendererPort
  player: PlayerPort
  commit: MemoryCommitPort
  store: EventStorePort
  history: HistoryQueryPort
  projection: MemoryProjectionPort
  replay: ReplayReaderPort
  authorizer: ControlAuthorizerPort
  cancelDelayMs?: number
  inputTtlMs?: number
}

export type TurnStatus =
  | 'completed'
  | 'cancelled'
  | 'deferred'
  | 'stale'
  | 'inactive'
  | 'no-input'
  | 'degraded'
  | 'busy'
  | 'blocked'

export interface TurnOutcome {
  status: TurnStatus
  turnId: string | null
  plan: SelectionResult | null
  deliveries: CommitDelivery[]
}

export interface ContractRunner {
  readonly endpoint: RuntimeEndpointPort
  readonly hooks: RunnerHooks
  readonly clock: VirtualClock
  lifecycle(): string
  epoch(): number
  events(): RuntimeEvent[]
  deliveries(): CommitDelivery[]
  selectionCalls(): number
  rejectedLate(): number
  rejectedReceipts(): number
  storageFailureObserved(): boolean
  runTurn(): Promise<TurnOutcome>
  resume(): Promise<ControlAck>
  stop(): Promise<ControlAck>
  controlWith(message: ControlStopMessage | ControlResumeMessage, context: TrustedControlContext): Promise<ControlAck>
  accept(text: string, messageId?: string): Promise<InputAck>
  replay(sessionId: string): Promise<number>
}

interface OutputRegistration {
  sessionId: string
  epoch: number
  turnId: string
  segmentId: string
  modality: string
}

export function createContractRunner(
  clock: VirtualClock,
  deps: RunnerDeps,
  options: { sessionId?: string } = {},
): ContractRunner {
  const sessionId = options.sessionId ?? 'session-fixture'
  const hooks: RunnerHooks = {}
  let epoch = 0
  let lifecycle = 'stopped'
  let running = false
  let activeTurnId: string | null = null
  let performerStatus: 'unknown' | 'idle' | 'busy' = 'idle'
  let outputConfirmation: 'pending' | 'confirmed' | 'unknown' = 'confirmed'
  const capabilityRevision = 1
  let snapshotRevision = 1
  let seq = 0
  let selectionCalls = 0
  let rejectedLate = 0
  let rejectedReceipts = 0
  let storageFailure = false
  let turnCounter = 0
  let idCounter = 0
  let turnActive = false
  let deferredKey: string | null = null
  let pending: InputEvent[] = []
  const seenMessages = new Set<string>()
  const controlAcks = new Map<string, ControlAck>()
  const events: RuntimeEvent[] = []
  const deliveries: CommitDelivery[] = []
  const outputRegistry = new Map<string, OutputRegistration>()
  const receiptFacts = new Map<string, ReceiptFact>()
  const serverListeners = new Set<(message: ServerMessage) => void>()
  let activeAbort: AbortController | null = null

  function nextId(prefix: string): string {
    idCounter += 1
    return `${prefix}-${idCounter}`
  }

  function allocateSeq(): number {
    seq += 1
    return seq
  }

  function makeEvent(
    type: string,
    extra: Partial<RuntimeEvent> & { seq?: number; sourceModule?: RuntimeEvent['sourceModule'] } = {},
  ): RuntimeEvent {
    return runtimeEventSchema.parse({
      protocolVersion: '0.2',
      eventId: nextId('evt'),
      seq: extra.seq ?? allocateSeq(),
      timestampMs: clock.nowMs(),
      sessionId,
      epoch,
      turnId: extra.turnId ?? null,
      segmentId: extra.segmentId ?? null,
      outputId: extra.outputId ?? null,
      type,
      sourceModule: extra.sourceModule ?? 'M5',
      versions: extra.versions ?? null,
      payload: extra.payload ?? {},
    })
  }

  function emit(message: ServerMessage): void {
    for (const listener of serverListeners) listener(message)
  }

  async function commitEvent(event: RuntimeEvent): Promise<void> {
    events.push(event)
    const ack = await deps.store.append(event)
    if (ack.outcome === 'failed') {
      lifecycle = 'degraded'
      storageFailure = true
    }
    emit({
      protocolVersion: '0.2',
      messageId: nextId('srv'),
      sessionId,
      epoch,
      kind: 'session.event',
      payload: { seq: event.seq, type: event.type, data: event.payload },
    })
  }

  async function persist(type: string, extra: Partial<RuntimeEvent> = {}): Promise<void> {
    await commitEvent(makeEvent(type, extra))
  }

  function snapshot(): BootstrapSnapshot {
    return bootstrapSnapshotSchema.parse({
      protocolVersion: '0.2',
      messageId: nextId('snap'),
      sessionId,
      epoch,
      seq,
      lifecycle,
      activeTurnId,
      performerStatus,
      outputConfirmation,
      capabilityRevision,
    })
  }

  function contextForTurn(): CallContext {
    const controller = activeAbort ?? new AbortController()
    return { signal: controller.signal, deadline: { atMs: clock.nowMs() + 60_000 } }
  }

  function submitInput(message: InputSubmitMessage, context: TrustedControlContext): Promise<InputAck> {
    if (lifecycle === 'degraded') {
      return Promise.resolve(
        inputAckSchema.parse({
          status: 'rejected',
          requestMessageId: message.messageId,
          sessionId,
          epoch,
          code: 'storage_unavailable',
          message: 'input rejected while the session is degraded',
          retryable: true,
        }),
      )
    }
    if (seenMessages.has(message.messageId)) {
      return Promise.resolve(
        inputAckSchema.parse({
          status: 'duplicate',
          requestMessageId: message.messageId,
          eventId: `event-${message.messageId}`,
          sessionId,
          epoch,
          seq,
        }),
      )
    }
    seenMessages.add(message.messageId)
    deferredKey = null
    const eventId = `event-${message.messageId}`
    pending.push({
      eventId,
      sessionId,
      epoch,
      source: message.payload.source,
      actorId: context.actorId,
      text: message.payload.text,
      receivedAtMs: clock.nowMs(),
      expiresAtMs: clock.nowMs() + (deps.inputTtlMs ?? 60_000),
      trust: 'untrusted-content',
    })
    const event = makeEvent('input.accepted', { payload: { eventId } })
    events.push(event)
    void deps.store.append(event).then((ack) => {
      if (ack.outcome === 'failed') {
        lifecycle = 'degraded'
        storageFailure = true
      }
    })
    return Promise.resolve(
      inputAckSchema.parse({
        status: 'accepted',
        requestMessageId: message.messageId,
        eventId,
        sessionId,
        epoch,
        seq: event.seq,
      }),
    )
  }

  async function control(
    message: ControlStopMessage | ControlResumeMessage,
    context: TrustedControlContext,
  ): Promise<ControlAck> {
    const action = message.kind === 'control.stop' ? 'stop' : 'resume'
    const refused = (reasonCode: string, text: string, previousEpoch = epoch): ControlAck =>
      controlAckSchema.parse({
        sessionId,
        requestId: message.payload.requestId,
        requestMessageId: message.messageId,
        action,
        status: 'refused',
        previousEpoch,
        epoch,
        lifecycle,
        outputConfirmation,
        reasonCode,
        message: text,
      })
    // Trusted permission is checked before any duplicate lookup.
    if (!deps.authorizer.isOperator(context)) {
      return refused('unauthorized', 'control requires an authenticated operator context')
    }
    const existing = controlAcks.get(message.payload.requestId)
    if (existing !== undefined) {
      if (existing.action !== action) {
        return refused('conflict', 'request id reused with a different control action')
      }
      return { ...existing, requestMessageId: message.messageId, status: 'duplicate' }
    }
    if (action === 'resume') {
      if (lifecycle === 'degraded' || storageFailure) {
        return refused('storage_unavailable', 'resume refused while storage recovery is unconfirmed')
      }
      if (outputConfirmation !== 'confirmed') {
        return refused('evidence_pending', 'resume refused while output evidence is unconfirmed')
      }
      if (!deps.player.status().idle) {
        return refused('performer_busy', 'resume refused while the performer is not confirmed idle')
      }
    }
    const previousEpoch = epoch
    epoch = nextEpoch(epoch)
    if (action === 'stop') {
      // Revocation is immediate; Stop never waits for cancellation or storage.
      running = false
      lifecycle = 'stopped'
      activeTurnId = null
      performerStatus = 'idle'
      outputConfirmation = 'pending'
      activeAbort?.abort()
      activeAbort = null
      const cancelRequest = {
        requestId: message.payload.requestId,
        revokedEpoch: previousEpoch,
        newEpoch: epoch,
      }
      void (async () => {
        try {
          if (deps.cancelDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, deps.cancelDelayMs))
          }
          const evidence = await deps.player.cancel(cancelRequest, contextForTurn())
          outputConfirmation =
            evidence === null || isTerminalReceiptStage(evidence.stage) ? 'confirmed' : 'pending'
        } catch {
          // Cancellation failure keeps the evidence unconfirmed (pending).
        }
      })()
      void persist('session.stopped', { payload: { requestId: message.payload.requestId } })
    } else {
      running = true
      lifecycle = 'running'
      activeAbort = new AbortController()
      performerStatus = 'idle'
      deferredKey = null
      void persist('session.resumed', { payload: { requestId: message.payload.requestId } })
    }
    const ack = controlAckSchema.parse({
      sessionId,
      requestId: message.payload.requestId,
      requestMessageId: message.messageId,
      action,
      status: 'applied',
      previousEpoch,
      epoch,
      lifecycle,
      outputConfirmation,
      reasonCode: null,
      message: `${action} applied`,
    })
    controlAcks.set(message.payload.requestId, ack)
    return ack
  }

  async function handleReceipt(receipt: PerformanceReceipt): Promise<void> {
    const registration = outputRegistry.get(receipt.outputId)
    const reject = (reason: string): void => {
      rejectedReceipts += 1
      // An unregistered or mismatched receipt leaves the output unconfirmed.
      outputConfirmation = 'unknown'
      void persist('receipt.rejected', { outputId: receipt.outputId, payload: { reason } })
    }
    if (registration === undefined) {
      reject('unregistered-output')
      return
    }
    if (
      registration.sessionId !== receipt.sessionId ||
      registration.epoch !== receipt.epoch ||
      registration.turnId !== receipt.turnId ||
      registration.segmentId !== receipt.segmentId
    ) {
      reject('identity-mismatch')
      return
    }
    if (registration.modality !== receipt.modality) {
      reject('modality-mismatch')
      return
    }
    const key = `${receipt.outputId}:${receipt.modality}`
    const fact: ReceiptFact = {
      receiptId: receipt.receiptId,
      outputId: receipt.outputId,
      modality: receipt.modality,
      stage: receipt.stage,
    }
    const reconciliation = reconcileReceipt(receiptFacts.get(key) ?? null, fact)
    if (reconciliation.action === 'record' || reconciliation.action === 'resolve-unknown') {
      receiptFacts.set(key, reconciliation.effective)
    }
    const effectiveStage = reconciliation.effective.stage
    if (isTerminalReceiptStage(effectiveStage)) outputConfirmation = 'confirmed'
    else if (effectiveStage === 'unknown') outputConfirmation = 'unknown'
    else outputConfirmation = 'pending'
    await persist('output.receipt', {
      outputId: receipt.outputId,
      payload: { stage: receipt.stage, reconciliation: reconciliation.action },
    })
  }

  function fresh(startedEpoch: number, deadline: { atMs: number }, context: CallContext): boolean {
    return running && epoch === startedEpoch && !context.signal.aborted && !isDeadlineExpired(clock, deadline)
  }

  async function dispatchSegment(
    segment: DialogueSegment,
    turnId: string,
    segmentIndex: number,
    startedEpoch: number,
    deadline: { atMs: number },
    context: CallContext,
    personaIdentity: { profileId: string; profileVersion: string },
  ): Promise<void> {
    if (!fresh(startedEpoch, deadline, context)) return
    // A prior segment that left the output unknown or pending must not allow a
    // further segment to play until the outcome is resolved to confirmed.
    if (outputConfirmation !== 'confirmed') return
    const prepareRequest = {
      requestId: nextId('prepare'),
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      text: segment.text,
      voiceProfileId: 'voice-fixture',
      voiceProfileVersion: '1',
      deadline,
    }
    const prepared = await deps.synthesis.prepare(prepareRequest, context)
    if (!fresh(startedEpoch, deadline, context)) return
    if (!prepared.ok) {
      await persist('dependency.failed', { turnId, segmentId: segment.segmentId, payload: { reason: prepared.reasonCode } })
      return
    }
    if (
      prepared.requestId !== prepareRequest.requestId ||
      prepared.sessionId !== sessionId ||
      prepared.epoch !== startedEpoch ||
      prepared.turnId !== turnId ||
      prepared.segmentId !== segment.segmentId
    ) {
      await persist('result.stale', { turnId, segmentId: segment.segmentId, payload: { stage: 'synthesis' } })
      return
    }
    // Capabilities are captured for the request and refreshed after the await,
    // because a held reaction may outlive a capability change.
    const capturedCapabilities = deps.renderer.capabilities()
    const eligibleForRequest = [...new Set([...capturedCapabilities.actions.map((action) => action.actionId), NO_OP_ACTION])]
    const decisionRequestId = nextId('decision')
    const decision = await deps.reaction.decide(
      decisionRequestSchema.parse({
        requestId: decisionRequestId,
        sessionId,
        epoch: startedEpoch,
        turnId,
        segmentId: segment.segmentId,
        snapshotRevision,
        capabilityRevision: capturedCapabilities.capabilityRevision,
        task: 'segment-reaction',
        segmentText: segment.text,
        personaSummary: 'fixture',
        interactionState: 'calm',
        eligibleActionIds: eligibleForRequest,
        deadline,
        policyVersion: 'policy-v1',
        providerVersion: 'provider-v1',
      }),
      context,
    )
    if (!fresh(startedEpoch, deadline, context)) return
    const currentCapabilities = deps.renderer.capabilities()
    const eligibleNow = [...new Set([...currentCapabilities.actions.map((action) => action.actionId), NO_OP_ACTION])]
    const parsedDecision = decisionResultSchema.safeParse(decision)
    let actionId: string = NO_OP_ACTION
    if (
      parsedDecision.success &&
      parsedDecision.data.status === 'selected' &&
      parsedDecision.data.actionId !== null &&
      parsedDecision.data.requestId === decisionRequestId &&
      parsedDecision.data.sessionId === sessionId &&
      parsedDecision.data.epoch === startedEpoch &&
      parsedDecision.data.turnId === turnId &&
      parsedDecision.data.segmentId === segment.segmentId &&
      parsedDecision.data.snapshotRevision === snapshotRevision &&
      parsedDecision.data.capabilityRevision === currentCapabilities.capabilityRevision &&
      (parsedDecision.data.actionId === NO_OP_ACTION || eligibleNow.includes(parsedDecision.data.actionId))
    ) {
      actionId = parsedDecision.data.actionId
    }
    const command = performanceCommandSchema.parse({
      outputId: nextId('output'),
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      audioRef: prepared.audioRef,
      subtitleText: segment.text,
      actionId,
      capabilityRevision: currentCapabilities.capabilityRevision,
    })
    outputRegistry.set(command.outputId, {
      sessionId,
      epoch: startedEpoch,
      turnId,
      segmentId: segment.segmentId,
      modality: 'audio',
    })
    // A no-op reaction makes zero renderer calls; speech still plays.
    if (actionId !== NO_OP_ACTION) {
      await deps.renderer.execute(command, context)
    }
    if (!fresh(startedEpoch, deadline, context)) return
    const playback = deps.player.execute(command, context)
    if (hooks.onPlaybackStart !== undefined) {
      await hooks.onPlaybackStart(segmentIndex, command.outputId)
    }
    const receipt = await playback
    await handleReceipt(receipt)
    const fact = receiptFacts.get(`${command.outputId}:audio`)
    if (fact === undefined) {
      // The returned receipt was rejected (unregistered or mismatched): no
      // accepted registered audio fact exists, so no delivery may be committed.
      return
    }
    if (!isTerminalReceiptStage(fact.stage)) {
      outputConfirmation = fact.stage === 'unknown' ? 'unknown' : 'pending'
      return
    }
    const finalStage = fact.stage
    const classification = classifyAudioDelivery(finalStage, true)
    const delivery: CommitDelivery = {
      sessionId,
      turnId,
      segmentId: segment.segmentId,
      textHash: `hash-${segment.segmentId}`,
      text: segment.text,
      outputId: command.outputId,
      receiptId: fact.receiptId,
      classification,
      terminalOutcome:
        finalStage === 'completed' ? 'completed' : finalStage === 'cancelled' ? 'cancelled' : 'failed',
      modality: 'audio',
      segmentIndex: segment.index,
      personaProfileId: personaIdentity.profileId,
      personaProfileVersion: personaIdentity.profileVersion,
    }
    // Persist the delivery and its supporting event once, atomically, before
    // committing spoken memory.
    const deliveryEvent = makeEvent('delivery.committed', {
      turnId,
      segmentId: segment.segmentId,
      outputId: command.outputId,
      sourceModule: 'M6',
      versions: {
        personaProfileId: personaIdentity.profileId,
        personaProfileVersion: personaIdentity.profileVersion,
      },
      payload: { classification },
    })
    const atomic = await deps.store.commitDeliveryWithEvent(delivery, deliveryEvent)
    if (atomic.event.outcome === 'failed' || atomic.delivery.status === 'failed') {
      lifecycle = 'degraded'
      storageFailure = true
      running = false
      return
    }
    events.push(deliveryEvent)
    emit({
      protocolVersion: '0.2',
      messageId: nextId('srv'),
      sessionId,
      epoch,
      kind: 'session.event',
      payload: { seq: deliveryEvent.seq, type: deliveryEvent.type, data: deliveryEvent.payload },
    })
    const ack = await deps.commit.commit(delivery)
    if (ack.status === 'applied' || ack.status === 'duplicate') {
      deliveries.push(delivery)
    }
    outputConfirmation = 'confirmed'
  }

  async function runTurn(): Promise<TurnOutcome> {
    if (turnActive) return { status: 'busy', turnId: null, plan: null, deliveries: [] }
    if (lifecycle === 'degraded') return { status: 'degraded', turnId: null, plan: null, deliveries: [] }
    if (!running) return { status: 'inactive', turnId: null, plan: null, deliveries: [] }
    if (outputConfirmation !== 'confirmed') {
      return { status: 'blocked', turnId: null, plan: null, deliveries: [] }
    }
    const now = clock.nowMs()
    const eligiblePending = pending.filter((candidate) => candidate.expiresAtMs > now)
    const droppedExpired = eligiblePending.length !== pending.length
    pending = eligiblePending
    if (eligiblePending.length === 0) {
      return { status: droppedExpired ? 'deferred' : 'no-input', turnId: null, plan: null, deliveries: [] }
    }
    const candidates = eligiblePending.slice(0, 5)
    const candidateKey = `${epoch}:${candidates.map((candidate) => candidate.eventId).join(',')}`
    if (deferredKey === candidateKey) return { status: 'deferred', turnId: null, plan: null, deliveries: [] }
    const startedEpoch = epoch
    turnActive = true
    try {
      const deadline = { atMs: clock.nowMs() + 5_000 }
      if (hooks.beforeSelect !== undefined) await hooks.beforeSelect()
      const preSelectContext = contextForTurn()
      if (!fresh(startedEpoch, deadline, preSelectContext)) {
        rejectedLate += 1
        await persist('result.stale', { payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      const selectionRequest = selectionRequestSchema.parse({
        requestId: nextId('selection'),
        task: 'response-plan',
        sessionId,
        epoch: startedEpoch,
        snapshotRevision,
        candidates,
        personaSummary: 'fixture persona',
        currentTopic: 'concert',
        recentHistory: [],
        allowedIntents: ['answer', 'clarify', 'acknowledge', 'support', 'playful', 'check-correction'],
        deadline,
        policyVersion: 'policy-v1',
        providerVersion: 'provider-v1',
      })
      selectionCalls += 1
      const context = contextForTurn()
      let result: unknown
      try {
        result = await deps.selection.select(selectionRequest, context)
      } catch {
        // A thrown provider error is treated like an invalid result so the
        // currently-valid M5 fallback still applies.
        result = undefined
      }
      if (!fresh(startedEpoch, deadline, context)) {
        rejectedLate += 1
        await persist('result.stale', { payload: { stage: 'selection' } })
        return { status: 'stale', turnId: null, plan: null, deliveries: [] }
      }
      const parsed = selectionResultSchema.safeParse(result)
      const offered =
        parsed.success && parsed.data.disposition === 'respond'
          ? candidates.some((candidate) => candidate.eventId === parsed.data.selectedEventIds[0])
          : false
      const consistent =
        parsed.success &&
        parsed.data.requestId === selectionRequest.requestId &&
        parsed.data.sessionId === sessionId &&
        parsed.data.epoch === startedEpoch &&
        parsed.data.snapshotRevision === snapshotRevision
      let plan: SelectionResult
      if (parsed.success && consistent && parsed.data.disposition === 'defer') {
        deferredKey = candidateKey
        return { status: 'deferred', turnId: null, plan: parsed.data, deliveries: [] }
      }
      if (!parsed.success || !consistent || !offered) {
        // Only a currently valid M5 fallback may replace an invalid result.
        const fallback = selectFallback(candidates, clock)
        if (fallback === null) {
          deferredKey = candidateKey
          return { status: 'deferred', turnId: null, plan: parsed.success ? parsed.data : null, deliveries: [] }
        }
        const chosen = candidates.find((candidate) => candidate.eventId === fallback.eventId)
        if (chosen === undefined) {
          deferredKey = candidateKey
          return { status: 'deferred', turnId: null, plan: null, deliveries: [] }
        }
        plan = {
          requestId: selectionRequest.requestId,
          sessionId,
          epoch: startedEpoch,
          snapshotRevision,
          disposition: 'respond',
          selectedEventIds: [chosen.eventId],
          replyIntent: fallback.replyIntent,
          reasonCode: 'm5-fallback',
          provider: 'm5-fallback',
          modelVersion: 'm5-fallback',
          usage: { provider: 'm5-fallback', requestedModel: 'none', resolvedModel: null, requestId: selectionRequest.requestId, inputTokens: null, outputTokens: null, usageMissing: true, elapsedMs: 0, status: 'ok', pricingRef: null },
        }
      } else {
        plan = parsed.data
      }
      const chosen = candidates.find((candidate) => candidate.eventId === (plan.selectedEventIds[0] ?? ''))
      if (chosen === undefined || plan.replyIntent === null || chosen.expiresAtMs <= clock.nowMs()) {
        deferredKey = candidateKey
        return { status: 'deferred', turnId: null, plan, deliveries: [] }
      }
      deferredKey = null
      turnCounter += 1
      const turnId = `turn-${turnCounter}`
      activeTurnId = turnId
      performerStatus = 'busy'
      snapshotRevision += 1
      await persist('turn.started', { turnId, payload: { replyIntent: plan.replyIntent } })
      const turnDeliveries: CommitDelivery[] = []
      const personaIdentity = { profileId: 'character-fixture', profileVersion: '1' }
      const dialogueRequest = dialogueRequestSchema.parse({
        requestId: nextId('dialogue'),
        sessionId,
        epoch: startedEpoch,
        turnId,
        selectedInput: { eventId: chosen.eventId, text: chosen.text },
        characterProfileId: personaIdentity.profileId,
        characterProfileVersion: personaIdentity.profileVersion,
        responsePlan: {
          selectionRequestId: selectionRequest.requestId,
          selectedEventId: chosen.eventId,
          replyIntent: plan.replyIntent,
          policyVersion: 'policy-v1',
        },
        confirmedEventRefs: [],
        contextLimits: { maxTurns: 8, maxCharacters: 2000 },
      })
      let index = 0
      const end: DialogueEnd = await deps.dialogue.generate(dialogueRequest, context, {
        segment: async (segment) => {
          if (!fresh(startedEpoch, deadline, context)) return
          const before = deliveries.length
          await dispatchSegment(segment, turnId, index, startedEpoch, deadline, context, personaIdentity)
          turnDeliveries.push(...deliveries.slice(before))
          if (hooks.afterSegmentDispatch !== undefined) await hooks.afterSegmentDispatch(index)
          index += 1
        },
      })
      pending = pending.filter((candidate) => candidate.eventId !== chosen.eventId)
      activeTurnId = null
      performerStatus = 'idle'
      if (lifecycle !== 'degraded') {
        await persist('turn.ended', { turnId, payload: { status: end.status } })
      }
      if (lifecycle === 'degraded') {
        return { status: 'degraded', turnId, plan, deliveries: turnDeliveries }
      }
      return { status: end.status === 'cancelled' ? 'cancelled' : 'completed', turnId, plan, deliveries: turnDeliveries }
    } finally {
      turnActive = false
    }
  }

  const endpoint: RuntimeEndpointPort = {
    snapshot: () => Promise.resolve(snapshot()),
    submitInput,
    control,
    async handlePlayerMessage(message) {
      await handleReceipt(message.payload)
    },
    onServerMessage(listener) {
      serverListeners.add(listener)
      return () => {
        serverListeners.delete(listener)
      }
    },
  }

  const operator: TrustedControlContext = {
    connectionId: 'operator',
    role: 'operator',
    actorId: 'operator',
    authenticated: true,
  }

  return {
    endpoint,
    hooks,
    clock,
    lifecycle: () => lifecycle,
    epoch: () => epoch,
    events: () => [...events],
    deliveries: () => [...deliveries],
    selectionCalls: () => selectionCalls,
    rejectedLate: () => rejectedLate,
    rejectedReceipts: () => rejectedReceipts,
    storageFailureObserved: () => storageFailure,
    runTurn,
    resume: () =>
      control(
        {
          protocolVersion: '0.2',
          kind: 'control.resume',
          messageId: nextId('msg'),
          sessionId,
          epoch,
          payload: { requestId: nextId('resume') },
        },
        operator,
      ),
    stop: () =>
      control(
        {
          protocolVersion: '0.2',
          kind: 'control.stop',
          messageId: nextId('msg'),
          sessionId,
          epoch,
          payload: { requestId: nextId('stop') },
        },
        operator,
      ),
    controlWith: control,
    accept: (text, messageId) =>
      submitInput(
        {
          protocolVersion: '0.2',
          messageId: messageId ?? nextId('msg'),
          sessionId,
          epoch,
          kind: 'input.submit',
          payload: { source: 'local-audience', text },
        },
        { connectionId: 'audience', role: 'viewer', actorId: 'actor-local-audience', authenticated: true },
      ),
    async replay(targetSessionId) {
      const archive = await deps.replay.load(targetSessionId)
      return archive.events.length
    },
  }
}
