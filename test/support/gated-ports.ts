import type {
  DecisionResult,
  DialogueEnd,
  DialoguePort,
  DialogueRequest,
  PerformanceCommand,
  PerformanceReceipt,
  PlayerPort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../../src/contracts'
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
