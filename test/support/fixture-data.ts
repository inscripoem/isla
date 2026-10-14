import type {
  CapabilitySnapshot,
  CommitDelivery,
  TrustedControlContext,
  DecisionRequest,
  DecisionResult,
  DialogueEnd,
  DialogueOutcome,
  DialogueRequest,
  DialogueSegment,
  InputEvent,
  PerformanceCommand,
  PerformanceReceipt,
  PreparedAudio,
  PreparePerformance,
  RuntimeEvent,
  SelectionRequest,
  SelectionResult,
  UsageRecord,
} from '../../src/contracts'
import { REPLY_INTENTS } from '../../src/contracts'

export const FIXTURE_SESSION_ID = 'session-fixture'
export const FIXTURE_TURN_ID = 'turn-fixture-1'
export const FIXTURE_SEGMENT_ID = 'segment-fixture-0'
export const FIXTURE_EVENT_ID = 'event-fixture-1'

/** Deterministic identifier source for fixtures; never a credential. */
export function createFixtureIds(prefix = 'fixture'): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

export function fixtureUsage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: 'fixture',
    requestedModel: 'fixture-v1',
    resolvedModel: 'fixture-v1',
    requestId: 'usage-fixture-1',
    inputTokens: 10,
    outputTokens: 20,
    usageMissing: false,
    elapsedMs: 5,
    status: 'ok',
    pricingRef: null,
    ...overrides,
  }
}

export function fixtureInputEvent(overrides: Partial<InputEvent> = {}): InputEvent {
  return {
    eventId: FIXTURE_EVENT_ID,
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    source: 'local-audience',
    actorId: 'actor-local-audience',
    text: 'What did you say about the concert?',
    receivedAtMs: 0,
    expiresAtMs: 60_000,
    trust: 'untrusted-content',
    ...overrides,
  }
}

export function fixtureSelectionRequest(
  overrides: Partial<SelectionRequest> = {},
): SelectionRequest {
  return {
    requestId: 'selection-req-1',
    task: 'response-plan',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    snapshotRevision: 1,
    candidates: [fixtureInputEvent()],
    personaSummary: 'A concise, friendly character.',
    currentTopic: 'concert',
    recentHistory: [],
    allowedIntents: [...REPLY_INTENTS],
    deadline: { atMs: 60_000 },
    policyVersion: 'policy-v1',
    providerVersion: 'provider-v1',
    ...overrides,
  }
}

export function fixtureSelectionResult(
  overrides: Partial<SelectionResult> = {},
): SelectionResult {
  return {
    requestId: 'selection-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    snapshotRevision: 1,
    disposition: 'respond',
    selectedEventIds: [FIXTURE_EVENT_ID],
    replyIntent: 'answer',
    reasonCode: 'fixture-selected',
    provider: 'fixture',
    modelVersion: 'fixture-v1',
    usage: fixtureUsage({ requestId: 'selection-req-1' }),
    ...overrides,
  }
}

export function fixtureDialogueRequest(
  overrides: Partial<DialogueRequest> = {},
): DialogueRequest {
  return {
    requestId: 'dialogue-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    selectedInput: {
      eventId: FIXTURE_EVENT_ID,
      text: 'What did you say about the concert?',
    },
    characterProfileId: 'character-fixture',
    characterProfileVersion: '1',
    responsePlan: {
      selectionRequestId: 'selection-req-1',
      selectedEventId: FIXTURE_EVENT_ID,
      replyIntent: 'answer',
      policyVersion: 'policy-v1',
    },
    confirmedEventRefs: [],
    contextLimits: { maxTurns: 8, maxCharacters: 2000 },
    ...overrides,
  }
}

export function fixtureDialogueSegment(
  overrides: Partial<DialogueSegment> = {},
): DialogueSegment {
  return {
    requestId: 'dialogue-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    index: 0,
    text: 'We talked about the concert.',
    model: 'fixture',
    modelVersion: 'fixture-v1',
    ...overrides,
  }
}

export function fixtureDialogueEnd(overrides: Partial<DialogueEnd> = {}): DialogueEnd {
  return {
    requestId: 'dialogue-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    status: 'completed',
    segmentCount: 1,
    usage: fixtureUsage({ requestId: 'dialogue-req-1' }),
    ...overrides,
  }
}

export function fixtureDialogueOutcome(
  overrides: Partial<DialogueOutcome> = {},
): DialogueOutcome {
  return {
    segments: [fixtureDialogueSegment()],
    end: fixtureDialogueEnd(),
    ...overrides,
  }
}

export function fixtureDecisionRequest(
  overrides: Partial<DecisionRequest> = {},
): DecisionRequest {
  return {
    requestId: 'decision-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    snapshotRevision: 1,
    capabilityRevision: 1,
    task: 'segment-reaction',
    segmentText: 'We talked about the concert.',
    personaSummary: 'A concise, friendly character.',
    interactionState: 'calm',
    eligibleActionIds: ['neutral', 'smile'],
    deadline: { atMs: 60_000 },
    policyVersion: 'policy-v1',
    providerVersion: 'provider-v1',
    ...overrides,
  }
}

export function fixtureDecisionResult(
  overrides: Partial<DecisionResult> = {},
): DecisionResult {
  return {
    requestId: 'decision-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    snapshotRevision: 1,
    capabilityRevision: 1,
    status: 'selected',
    actionId: 'smile',
    provider: 'fixture',
    modelVersion: 'fixture-v1',
    reasonCode: 'fixture-rule',
    confidence: null,
    usage: fixtureUsage({ requestId: 'decision-req-1' }),
    ...overrides,
  }
}

export function fixtureCapabilitySnapshot(
  overrides: Partial<CapabilitySnapshot> = {},
): CapabilitySnapshot {
  return {
    rendererId: 'renderer-fixture',
    characterId: 'character-fixture',
    capabilityRevision: 1,
    actions: [
      { actionId: 'neutral', description: 'neutral face', observability: 'observable', parameterBounds: [] },
      { actionId: 'smile', description: 'smile', observability: 'observable', parameterBounds: [] },
    ],
    ...overrides,
  }
}

export function fixturePreparePerformance(
  overrides: Partial<PreparePerformance> = {},
): PreparePerformance {
  return {
    requestId: 'prepare-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    text: 'We talked about the concert.',
    voiceProfileId: 'voice-fixture',
    voiceProfileVersion: '1',
    deadline: { atMs: 60_000 },
    ...overrides,
  }
}

export function fixturePreparedAudio(
  overrides: Partial<Extract<PreparedAudio, { ok: true }>> = {},
): PreparedAudio {
  return {
    ok: true,
    requestId: 'prepare-req-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    audioRef: 'audio://fixture/segment-0',
    format: 'audio/wav',
    durationMs: 1200,
    timing: { startMs: 0, endMs: 1200 },
    ...overrides,
  }
}

export function fixturePerformanceCommand(
  overrides: Partial<PerformanceCommand> = {},
): PerformanceCommand {
  return {
    outputId: 'output-fixture-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    audioRef: 'audio://fixture/segment-0',
    subtitleText: 'We talked about the concert.',
    actionId: 'smile',
    capabilityRevision: 1,
    ...overrides,
  }
}

export function fixturePerformanceReceipt(
  overrides: Partial<PerformanceReceipt> = {},
): PerformanceReceipt {
  return {
    receiptId: 'receipt-fixture-1',
    outputId: 'output-fixture-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    modality: 'audio',
    stage: 'completed',
    localTimeMs: 1200,
    chunkIds: null,
    reasonCode: null,
    source: 'fixture-player',
    ...overrides,
  }
}

export function fixtureCommitDelivery(
  overrides: Partial<CommitDelivery> = {},
): CommitDelivery {
  return {
    sessionId: FIXTURE_SESSION_ID,
    turnId: FIXTURE_TURN_ID,
    segmentId: FIXTURE_SEGMENT_ID,
    textHash: 'hash-fixture-0',
    text: 'We talked about the concert.',
    outputId: 'output-fixture-1',
    receiptId: 'receipt-fixture-1',
    classification: 'fully-delivered',
    terminalOutcome: 'completed',
    modality: 'audio',
    segmentIndex: 0,
    personaProfileId: 'character-fixture',
    personaProfileVersion: '1',
    ...overrides,
  }
}

export function fixtureRuntimeEvent(
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    protocolVersion: '0.2',
    eventId: 'runtime-event-fixture-1',
    seq: 1,
    timestampMs: 0,
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    turnId: null,
    segmentId: null,
    outputId: null,
    type: 'input.accepted',
    sourceModule: 'M5',
    versions: null,
    payload: {},
    ...overrides,
  }
}

export function fixtureOperatorContext(
  overrides: Partial<TrustedControlContext> = {},
): TrustedControlContext {
  return {
    connectionId: 'connection-operator',
    role: 'operator',
    actorId: 'actor-operator',
    authenticated: true,
    ...overrides,
  }
}

export function fixtureViewerContext(
  overrides: Partial<TrustedControlContext> = {},
): TrustedControlContext {
  return {
    connectionId: 'connection-viewer',
    role: 'viewer',
    actorId: 'actor-viewer',
    authenticated: true,
    ...overrides,
  }
}
