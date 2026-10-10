import type {
  DecisionResult,
  DialogueEnd,
  DialoguePort,
  DialogueRequest,
  DialogueSegment,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerPort,
  ReactionPort,
  ReceiptStage,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../../src/contracts'
import { FIXTURE_SESSION_ID } from './fixture-data'
import {
  decisionResultSchema,
  dialogueEndSchema,
  dialogueSegmentSchema,
  performanceReceiptSchema,
  preparedAudioSchema,
  selectionResultSchema,
} from '../../src/contracts'
import { fixtureUsage } from './fixture-data'

/** Deferred selection that only returns after the gate opens. */
export function createGatedSelectionPort(gate: Promise<void>, onEnter?: () => void): SelectionPort {
  return {
    async select(request) {
      onEnter?.()
      await gate
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

/** Schema-invalid selection: respond with the wrong number of selected events. */
export function createMalformedSelectionPort(): SelectionPort {
  return {
    async select(request) {
      return {
        ...selectionResultSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          snapshotRevision: request.snapshotRevision,
          disposition: 'respond',
          selectedEventIds: [request.candidates[0].eventId],
          replyIntent: 'answer',
          reasonCode: 'malformed',
          provider: 'fixture',
          modelVersion: 'fixture-v1',
          usage: fixtureUsage({ requestId: request.requestId }),
        }),
        selectedEventIds: ['a', 'b'],
      }
    },
  }
}

/** Valid shape but a decision-relevant revision that does not match. */
export function createWrongRevisionSelectionPort(): SelectionPort {
  return {
    async select(request) {
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision + 5,
        disposition: 'respond',
        selectedEventIds: [request.candidates[0].eventId],
        replyIntent: 'answer',
        reasonCode: 'stale-revision',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

/** Dialogue that waits for a gate before producing any segment. */
export function createGatedDialoguePort(
  gate: Promise<void>,
  segmentCount = 1,
  onEnter?: () => void,
): DialoguePort {
  return {
    async generate(request, context, sink): Promise<DialogueEnd> {
      onEnter?.()
      await gate
      if (context.signal.aborted) {
        return dialogueEndSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          status: 'cancelled',
          segmentCount: 0,
          usage: fixtureUsage({ requestId: request.requestId }),
        })
      }
      for (let index = 0; index < segmentCount; index += 1) {
        if (context.signal.aborted) break
        await sink.segment(
          dialogueSegmentSchema.parse({
            requestId: request.requestId,
            sessionId: request.sessionId,
            epoch: request.epoch,
            turnId: request.turnId,
            segmentId: `${request.turnId}-seg-${index}`,
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
        segmentCount,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

/**
 * Cancellation-ignoring dialogue: it returns a completed result even after its
 * AbortSignal fired, so the runtime must reject the stale output itself rather
 * than relying on producer cooperation.
 */
export function createLateDialoguePort(gate: Promise<void>, onEnter?: () => void): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      onEnter?.()
      await gate
      await sink.segment(
        dialogueSegmentSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          segmentId: `${request.turnId}-late-seg-0`,
          index: 0,
          text: 'A stale late reply.',
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

export function createGatedSynthesisPort(gate: Promise<void>, onEnter?: () => void): SynthesisPort {
  return {
    async prepare(request) {
      onEnter?.()
      await gate
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

export function createGatedReactionPort(gate: Promise<void>, onEnter?: () => void): ReactionPort {
  return {
    async decide(request): Promise<DecisionResult> {
      onEnter?.()
      await gate
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

export interface CountingPlayer extends PlayerPort {
  executeCalls(): number
  cancelCalls(): number
}

export function createCountingPlayer(delegate: PlayerPort): CountingPlayer {
  let execute = 0
  let cancel = 0
  return {
    executeCalls: () => execute,
    cancelCalls: () => cancel,
    async execute(command, context) {
      execute += 1
      return delegate.execute(command, context)
    },
    async cancel(request, context) {
      cancel += 1
      return delegate.cancel(request, context)
    },
    status: () => delegate.status(),
  }
}

export function createGatedCancelPlayer(delegate: PlayerPort, gate: Promise<void>): PlayerPort {
  return {
    execute: (command, context) => delegate.execute(command, context),
    async cancel(request, context) {
      await gate
      return delegate.cancel(request, context)
    },
    status: () => delegate.status(),
  }
}

export interface CapturingDialoguePort extends DialoguePort {
  requests(): DialogueRequest[]
}

export function createCapturingDialoguePort(delegate: DialoguePort): CapturingDialoguePort {
  const requests: DialogueRequest[] = []
  return {
    requests: () => [...requests],
    generate(request, context, sink) {
      requests.push(request)
      return delegate.generate(request, context, sink)
    },
  }
}

/** Valid-shaped selection whose requestId does not match the request. */
export function createCorrelationBreakingSelectionPort(): SelectionPort {
  return {
    async select(request) {
      return selectionResultSchema.parse({
        requestId: `${request.requestId}-stale`,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: [request.candidates[0].eventId],
        replyIntent: 'answer',
        reasonCode: 'stale-correlation',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export function createThrowingSelectionPort(): SelectionPort {
  return {
    async select() {
      throw new Error('fixture selection provider failure')
    },
  }
}

/** Valid-shaped prepared audio whose requestId does not match the request. */
export function createCorrelationBreakingSynthesisPort(): SynthesisPort {
  return {
    async prepare(request) {
      return preparedAudioSchema.parse({
        ok: true,
        requestId: `${request.requestId}-stale`,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        audioRef: `audio://fixture/${request.segmentId}`,
        format: 'audio/wav',
        durationMs: 1200,
        timing: null,
      })
    },
  }
}

/** Valid-shaped decision whose requestId does not match the request. */
export function createCorrelationBreakingReactionPort(): ReactionPort {
  return {
    async decide(request) {
      return decisionResultSchema.parse({
        requestId: `${request.requestId}-stale`,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        snapshotRevision: request.snapshotRevision,
        capabilityRevision: request.capabilityRevision,
        status: 'selected',
        actionId: request.eligibleActionIds[0],
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        reasonCode: 'stale-correlation',
        confidence: null,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

export interface RevisionSwitchingRenderer extends RendererPort {
  bump(): void
  calls(): number
}

export function createRevisionSwitchingRenderer(startRevision = 1): RevisionSwitchingRenderer {
  let revision = startRevision
  let calls = 0
  return {
    bump: () => {
      revision += 1
    },
    calls: () => calls,
    capabilities: () => ({
      rendererId: 'renderer-switch',
      characterId: 'character-fixture',
      capabilityRevision: revision,
      actions: [
        { actionId: 'smile', description: 'smile', observability: 'observable', parameterBounds: [] },
      ],
    }),
    async execute(command) {
      calls += 1
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
        reasonCode: null,
        source: 'renderer-switch',
      })
    },
  }
}

export function createEmptyCapabilityRenderer(): RendererPort {
  return {
    capabilities: () => ({
      rendererId: 'renderer-empty',
      characterId: 'character-fixture',
      capabilityRevision: 1,
      actions: [],
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
        stage: 'accepted',
        localTimeMs: null,
        chunkIds: null,
        reasonCode: null,
        source: 'renderer-empty',
      })
    },
  }
}

function receiptFrom(
  command: PerformanceCommand,
  overrides: Partial<PerformanceReceipt> = {},
): PerformanceReceipt {
  return performanceReceiptSchema.parse({
    receiptId: `receipt-${command.outputId}`,
    outputId: command.outputId,
    sessionId: command.sessionId,
    epoch: command.epoch,
    turnId: command.turnId,
    segmentId: command.segmentId,
    modality: 'audio',
    stage: 'completed',
    localTimeMs: null,
    chunkIds: null,
    reasonCode: null,
    source: 'fixture-player',
    ...overrides,
  })
}

function staticPlayer(factory: (command: PerformanceCommand) => PerformanceReceipt): PlayerPort {
  return {
    async execute(command) {
      return factory(command)
    },
    async cancel() {
      return null
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

/** Returns a completed receipt for an output id that was never registered. */
export function createMismatchedReceiptPlayer(): PlayerPort {
  return staticPlayer((command) => receiptFrom(command, { outputId: 'ghost-output' }))
}

/** Returns a receipt whose modality does not match the registered audio output. */
export function createWrongModalityReceiptPlayer(): PlayerPort {
  return staticPlayer((command) => receiptFrom(command, { modality: 'subtitle' }))
}

/** Returns a receipt that leaves the output unknown. */
export function createUnknownReceiptPlayer(): PlayerPort {
  return staticPlayer((command) => receiptFrom(command, { stage: 'unknown' }))
}

export interface CapturingPlayer extends PlayerPort {
  commands(): PerformanceCommand[]
}

export function createCapturingPlayer(delegate: PlayerPort): CapturingPlayer {
  const commands: PerformanceCommand[] = []
  return {
    commands: () => [...commands],
    async execute(command, context) {
      commands.push(command)
      return delegate.execute(command, context)
    },
    async cancel(request, context) {
      return delegate.cancel(request, context)
    },
    status: () => delegate.status(),
  }
}

/** A promise that never settles, used to prove a wait is really bounded. */
const NEVER_SETTLES: Promise<never> = new Promise(() => {})

/** Selection that never returns; only a real deadline can end the wait. */
export function createNeverSettlingSelectionPort(): SelectionPort {
  return {
    select: () => NEVER_SETTLES,
  }
}

/**
 * Selection that hangs on its first call and then behaves normally, so a
 * revoked first cycle can be followed by a valid one on the same coordinator.
 */
export function createHangOnceSelectionPort(): SelectionPort {
  let calls = 0
  return {
    async select(request) {
      calls += 1
      if (calls === 1) return await NEVER_SETTLES
      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: [request.candidates[0].eventId],
        replyIntent: 'answer',
        reasonCode: 'fixture-selected',
        provider: 'fixture',
        modelVersion: 'fixture-v1',
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

/** Dialogue that never returns; only a real deadline can end the wait. */
export function createNeverSettlingDialoguePort(onEnter?: () => void): DialoguePort {
  return {
    generate() {
      onEnter?.()
      return NEVER_SETTLES
    },
  }
}

/** Synthesis that never returns. */
export function createNeverSettlingSynthesisPort(onEnter?: () => void): SynthesisPort {
  return {
    prepare() {
      onEnter?.()
      return NEVER_SETTLES
    },
  }
}

/** Reaction that never returns. */
export function createNeverSettlingReactionPort(onEnter?: () => void): ReactionPort {
  return {
    decide() {
      onEnter?.()
      return NEVER_SETTLES
    },
  }
}

/** Renderer whose avatar dispatch never returns; speech must still proceed. */
export function createNeverSettlingRendererPort(): RendererPort {
  return {
    capabilities: () => ({
      rendererId: 'renderer-never',
      characterId: 'character-fixture',
      capabilityRevision: 1,
      actions: [
        { actionId: 'smile', description: 'smile', observability: 'observable', parameterBounds: [] },
      ],
    }),
    execute: () => NEVER_SETTLES,
  }
}

/** Player whose playback never returns and whose cancellation reports idle. */
export function createNeverSettlingPlayerPort(): PlayerPort {
  return {
    execute: () => NEVER_SETTLES,
    cancel: async () => null,
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

/**
 * Dialogue that returns a completed end immediately but only emits a segment
 * once the gate opens, i.e. after the bounded call has already finished.
 */
export function createLateSinkDialoguePort(gate: Promise<void>, onEnter?: () => void): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      onEnter?.()
      void gate
        .then(() =>
          sink.segment(
            dialogueSegmentSchema.parse({
              requestId: request.requestId,
              sessionId: request.sessionId,
              epoch: request.epoch,
              turnId: request.turnId,
              segmentId: `${request.turnId}-late-sink`,
              index: 0,
              text: 'A segment emitted after completion.',
              model: 'fixture',
              modelVersion: 'fixture-v1',
            }),
          ),
        )
        .catch(() => {})
      return dialogueEndSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        status: 'completed',
        segmentCount: 0,
        usage: fixtureUsage({ requestId: request.requestId }),
      })
    },
  }
}

/** Selection whose peer promise rejects only after its signal is aborted. */
export function createAbortingRejectionSelectionPort(): SelectionPort {
  return {
    select(_request, context) {
      return new Promise<never>((_resolve, reject) => {
        const rejectLater = (): void => {
          setTimeout(() => reject(new Error('late selection rejection after abort')), 1)
        }
        if (context.signal.aborted) rejectLater()
        else context.signal.addEventListener('abort', rejectLater, { once: true })
      })
    },
  }
}

/**
 * Player whose execute never settles on its own; only cancellation evidence
 * resolves it. The first `immediate` executes complete right away so a kept
 * first segment plus an interrupted later segment (C-04 history) is possible.
 */
export function createCancelReleasingPlayerPort(immediate = 1): PlayerPort {
  let immediateRemaining = immediate
  let pending: { command: PerformanceCommand; resolve: (receipt: PerformanceReceipt) => void } | null = null
  return {
    async execute(command) {
      if (immediateRemaining > 0) {
        immediateRemaining -= 1
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
      return new Promise<PerformanceReceipt>((resolve) => {
        pending = { command, resolve }
      })
    },
    async cancel(request) {
      if (pending === null) return null
      const { command, resolve } = pending
      pending = null
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
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

function scriptedSegment(
  request: DialogueRequest,
  index: number,
  overrides: Partial<DialogueSegment> = {},
): DialogueSegment {
  return dialogueSegmentSchema.parse({
    requestId: request.requestId,
    sessionId: request.sessionId,
    epoch: request.epoch,
    turnId: request.turnId,
    segmentId: `${request.turnId}-seg-${index}`,
    index,
    text: `scripted segment ${index}`,
    model: 'fixture',
    modelVersion: 'fixture-v1',
    ...overrides,
  })
}

function scriptedEnd(request: DialogueRequest, segmentCount: number): DialogueEnd {
  return dialogueEndSchema.parse({
    requestId: request.requestId,
    sessionId: request.sessionId,
    epoch: request.epoch,
    turnId: request.turnId,
    status: 'completed',
    segmentCount,
    usage: fixtureUsage({ requestId: request.requestId }),
  })
}

/** Dialogue whose only segment is punctuation and must not be spoken. */
export function createPunctuationOnlyDialoguePort(): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      await sink.segment(scriptedSegment(request, 0, { text: '...' }))
      return scriptedEnd(request, 1)
    },
  }
}

/** Dialogue that emits a schema-invalid segment. */
export function createMalformedSegmentDialoguePort(): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      await sink.segment({ segmentId: 'broken' } as unknown as DialogueSegment)
      return scriptedEnd(request, 1)
    },
  }
}

/** Dialogue that reuses index 0 for a second segment. */
export function createRepeatedIndexDialoguePort(): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      await sink.segment(scriptedSegment(request, 0))
      await sink.segment(scriptedSegment(request, 1, { index: 0, segmentId: `${request.turnId}-seg-1` }))
      return scriptedEnd(request, 1)
    },
  }
}

/** Dialogue that finishes with a mismatched segment count. */
export function createWrongEndCountDialoguePort(): DialoguePort {
  return {
    async generate(request, _context, sink): Promise<DialogueEnd> {
      await sink.segment(scriptedSegment(request, 0))
      return scriptedEnd(request, 0)
    },
  }
}

export interface StagedCancelPlayer extends PlayerPort {
  /** Release the first, deliberately delayed cancellation evidence. */
  releaseFirst(): void
  cancelCalls(): number
}

/**
 * Player whose first cancellation is held and resolves with non-terminal
 * evidence, while later cancellations resolve terminal immediately. It proves
 * an earlier Stop completion cannot clear a later Stop's confirmation.
 */
export function createStagedCancelPlayer(sessionId = FIXTURE_SESSION_ID): StagedCancelPlayer {
  let calls = 0
  let releaseFirst: (() => void) | null = null
  const receipt = (request: { revokedEpoch: number }, stage: 'started' | 'cancelled', suffix: string) =>
    performanceReceiptSchema.parse({
      receiptId: `receipt-staged-${suffix}`,
      outputId: 'output-staged',
      sessionId,
      epoch: request.revokedEpoch,
      turnId: 'turn-staged',
      segmentId: 'segment-staged',
      modality: 'audio',
      stage,
      localTimeMs: null,
      chunkIds: null,
      reasonCode: null,
      source: 'staged-player',
    })
  return {
    releaseFirst: () => releaseFirst?.(),
    cancelCalls: () => calls,
    execute: () => new Promise<PerformanceReceipt>(() => {}),
    async cancel(request) {
      calls += 1
      if (calls === 1) {
        return await new Promise<PerformanceReceipt>((resolve) => {
          releaseFirst = () => resolve(receipt(request, 'started', 'first'))
        })
      }
      return receipt(request, 'cancelled', 'second')
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

/**
 * Player whose first execute returns a completed receipt for its own output,
 * but every later execute returns a completed receipt for the previous output.
 * It proves an old terminal receipt cannot confirm the current output.
 */
export function createHistoricalReceiptPlayer(): PlayerPort {
  let previous: PerformanceCommand | null = null
  let calls = 0
  return {
    async execute(command) {
      calls += 1
      const target = calls > 1 && previous !== null ? previous : command
      previous = command
      return performanceReceiptSchema.parse({
        receiptId: `receipt-hist-${target.outputId}`,
        outputId: target.outputId,
        sessionId: target.sessionId,
        epoch: target.epoch,
        turnId: target.turnId,
        segmentId: target.segmentId,
        modality: 'audio',
        stage: 'completed',
        localTimeMs: 100,
        chunkIds: null,
        reasonCode: null,
        source: 'historical-player',
      })
    },
    async cancel() {
      return null
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

function receiptFor(
  command: PerformanceCommand,
  stage: ReceiptStage,
  receiptId: string,
  source: string,
): PerformanceReceipt {
  return performanceReceiptSchema.parse({
    receiptId,
    outputId: command.outputId,
    sessionId: command.sessionId,
    epoch: command.epoch,
    turnId: command.turnId,
    segmentId: command.segmentId,
    modality: 'audio',
    stage,
    localTimeMs: null,
    chunkIds: null,
    reasonCode: null,
    source,
  })
}

/** Player whose execute returns a non-terminal `accepted` receipt. */
export function createAcceptedReceiptPlayer(): CapturingPlayer {
  return createCapturingPlayer({
    async execute(command) {
      return receiptFor(command, 'accepted', `receipt-accepted-${command.outputId}`, 'accepted-player')
    },
    async cancel() {
      return null
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  })
}

/** Player whose execute returns a schema-invalid receipt. */
export function createMalformedReceiptPlayer(): PlayerPort {
  return {
    async execute() {
      return { outputId: 'not-a-receipt' } as unknown as PerformanceReceipt
    },
    async cancel() {
      return null
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}

/** Player whose execute stage/receipt id is scripted per call. */
export function createScriptedReceiptPlayer(
  makeSpec: (command: PerformanceCommand, call: number) => { stage: ReceiptStage; receiptId?: string },
): CapturingPlayer {
  let calls = 0
  return createCapturingPlayer({
    async execute(command) {
      const spec = makeSpec(command, calls)
      calls += 1
      return receiptFor(command, spec.stage, spec.receiptId ?? `receipt-${command.outputId}`, 'scripted-player')
    },
    async cancel() {
      return null
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  })
}

export interface CancelTerminalPlayer extends PlayerPort {
  commands(): PerformanceCommand[]
}

/**
 * Player whose first execute completes and whose later execute never settles,
 * while cancel returns valid terminal evidence for the latest output without
 * resolving execute. It proves delivery can be finalized from cancel evidence.
 */
export function createCancelTerminalPlayer(): CancelTerminalPlayer {
  const commands: PerformanceCommand[] = []
  return {
    commands: () => [...commands],
    async execute(command) {
      commands.push(command)
      if (commands.length === 1) {
        return receiptFor(command, 'completed', `receipt-audio-${command.outputId}`, 'cancel-terminal-player')
      }
      return new Promise<PerformanceReceipt>(() => {})
    },
    async cancel(request) {
      const command = commands[commands.length - 1]
      if (command === undefined) return null
      return receiptFor(command, 'cancelled', `receipt-cancel-${request.requestId}`, 'cancel-terminal-player')
    },
    status: () => ({ idle: true, activeOutputId: null, lastStage: null }),
  }
}
