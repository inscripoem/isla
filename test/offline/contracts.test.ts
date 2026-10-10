import { describe, expect, it } from 'vitest'
import {
  APPLICATION_CONTRACT_VERSION,
  MAX_SELECTION_CANDIDATES,
  bootstrapSnapshotSchema,
  bootstrapSnapshotToWire,
  browserMessageSchema,
  controlAckCorrelates,
  controlAckMessageSchema,
  controlAckToWire,
  decisionResultSchema,
  dialogueOutcomeSchema,
  dialogueRequestSchema,
  inputAckCorrelates,
  inputAckMessageSchema,
  inputAckToWire,
  normalizeBootstrapSnapshot,
  normalizeControlAck,
  normalizeInputAck,
  parseClientMessage,
  parseControlAckMessage,
  parseInputAckMessage,
  performanceExecuteMessageSchema,
  selectionRequestSchema,
  selectionResultSchema,
  wireToBootstrapSnapshot,
  wireToControlAck,
  wireToInputAck,
} from '../../src/contracts'
import {
  FIXTURE_SESSION_ID,
  fixtureDecisionResult,
  fixtureDialogueOutcome,
  fixtureDialogueRequest,
  fixtureInputEvent,
  fixtureSelectionRequest,
  fixtureSelectionResult,
} from '../support/fixture-data'

const validInputSubmit = {
  protocolVersion: APPLICATION_CONTRACT_VERSION,
  messageId: 'm-1',
  sessionId: FIXTURE_SESSION_ID,
  epoch: 1,
  kind: 'input.submit',
  payload: { source: 'local-audience', text: 'hello' },
}

describe('browser envelope validation', () => {
  it('accepts a valid input submission', () => {
    expect(browserMessageSchema.safeParse(validInputSubmit).success).toBe(true)
    const parsed = parseClientMessage(validInputSubmit)
    expect(parsed.ok).toBe(true)
  })

  it('rejects unknown fields on strict boundary objects', () => {
    expect(browserMessageSchema.safeParse({ ...validInputSubmit, extra: true }).success).toBe(false)
    expect(
      browserMessageSchema.safeParse({
        ...validInputSubmit,
        payload: { source: 'local-audience', text: 'hello', extra: 1 },
      }).success,
    ).toBe(false)
  })

  it('rejects an unsupported protocol version', () => {
    expect(browserMessageSchema.safeParse({ ...validInputSubmit, protocolVersion: '9.9' }).success).toBe(false)
  })

  it('rejects a performance command whose payload identity differs from the envelope', () => {
    const message = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'm-2',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'performance.execute',
      payload: {
        outputId: 'o-1',
        sessionId: 'other-session',
        epoch: 1,
        turnId: 't-1',
        segmentId: 's-1',
        audioRef: 'audio://fixture/a',
        subtitleText: 'hello',
        actionId: 'smile',
        capabilityRevision: 1,
      },
    }
    expect(performanceExecuteMessageSchema.safeParse(message).success).toBe(false)
  })
})

describe('C1 selection bounds and semantics', () => {
  it('rejects more than the maximum candidates', () => {
    const candidates = Array.from({ length: MAX_SELECTION_CANDIDATES + 1 }, (_, index) =>
      fixtureInputEvent({ eventId: `candidate-${index}` }),
    )
    expect(selectionRequestSchema.safeParse(fixtureSelectionRequest({ candidates })).success).toBe(false)
  })

  it('rejects a respond result with the wrong number of selected events', () => {
    expect(
      selectionResultSchema.safeParse(fixtureSelectionResult({ selectedEventIds: ['a', 'b'] })).success,
    ).toBe(false)
  })

  it('rejects a defer result carrying an intent', () => {
    expect(
      selectionResultSchema.safeParse(
        fixtureSelectionResult({ disposition: 'defer', selectedEventIds: [], replyIntent: 'answer' }),
      ).success,
    ).toBe(false)
  })

  it('accepts a valid respond result', () => {
    expect(selectionResultSchema.safeParse(fixtureSelectionResult()).success).toBe(true)
  })
})

describe('C3 decision consistency', () => {
  it('rejects a selected decision without an action', () => {
    expect(
      decisionResultSchema.safeParse(fixtureDecisionResult({ status: 'selected', actionId: null })).success,
    ).toBe(false)
  })

  it('rejects an abstained decision carrying an action', () => {
    expect(
      decisionResultSchema.safeParse(fixtureDecisionResult({ status: 'abstained', actionId: 'smile' })).success,
    ).toBe(false)
  })
})

describe('C2 dialogue identity and bounds', () => {
  it('rejects a selected input that does not match the response plan', () => {
    const request = fixtureDialogueRequest()
    expect(
      dialogueRequestSchema.safeParse({
        ...request,
        selectedInput: { eventId: 'mismatch', text: 'x' },
      }).success,
    ).toBe(false)
  })

  it('rejects a dialogue outcome whose count disagrees with its segments', () => {
    const outcome = fixtureDialogueOutcome()
    expect(
      dialogueOutcomeSchema.safeParse({
        ...outcome,
        end: { ...outcome.end, segmentCount: 0 },
      }).success,
    ).toBe(false)
  })
})

describe('bootstrap snapshot', () => {
  it('requires session identity, epoch, sequence and output confirmation', () => {
    expect(
      bootstrapSnapshotSchema.safeParse({
        protocolVersion: APPLICATION_CONTRACT_VERSION,
        messageId: 'bootstrap',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 0,
        seq: 0,
        lifecycle: 'stopped',
        activeTurnId: null,
        performerStatus: 'idle',
        outputConfirmation: 'confirmed',
        capabilityRevision: 1,
      }).success,
    ).toBe(true)
    expect(
      bootstrapSnapshotSchema.safeParse({ protocolVersion: APPLICATION_CONTRACT_VERSION }).success,
    ).toBe(false)
  })
})

const ackEnvelope = {
  protocolVersion: APPLICATION_CONTRACT_VERSION,
  messageId: 'ack-1',
  sessionId: FIXTURE_SESSION_ID,
  epoch: 1,
}

describe('ack reply envelopes, wire<->port conversion and correlation', () => {
  const bootstrapWire = {
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId: 'snap',
    sessionId: FIXTURE_SESSION_ID,
    epoch: 1,
    kind: 'session.snapshot',
    payload: {
      lifecycle: 'running',
      activeTurnId: null,
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 3,
      lastSeq: 7,
    },
  }

  it('accepts a correlated input.ack envelope', () => {
    const message = {
      ...ackEnvelope,
      kind: 'input.ack',
      payload: {
        status: 'accepted',
        requestMessageId: 'm-in',
        eventId: 'event-1',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        seq: 2,
      },
    }
    expect(inputAckMessageSchema.safeParse(message).success).toBe(true)
    expect(parseInputAckMessage(message).ok).toBe(true)
    expect(browserMessageSchema.safeParse(message).success).toBe(true)
  })

  it('rejects an input.ack whose payload session or epoch disagrees', () => {
    const message = {
      ...ackEnvelope,
      kind: 'input.ack',
      payload: {
        status: 'accepted',
        requestMessageId: 'm-in',
        eventId: 'event-1',
        sessionId: 'other-session',
        epoch: 1,
        seq: 2,
      },
    }
    expect(inputAckMessageSchema.safeParse(message).success).toBe(false)
    expect(
      inputAckMessageSchema.safeParse({
        ...message,
        payload: { ...message.payload, sessionId: FIXTURE_SESSION_ID, epoch: 9 },
      }).success,
    ).toBe(false)
  })

  it('accepts a correlated control.ack envelope', () => {
    const message = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'ack-2',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 2,
      kind: 'control.ack',
      payload: {
        sessionId: FIXTURE_SESSION_ID,
        requestId: 'r-1',
        requestMessageId: 'm-stop',
        action: 'stop',
        status: 'applied',
        previousEpoch: 1,
        epoch: 2,
        lifecycle: 'stopped',
        outputConfirmation: 'pending',
        reasonCode: null,
        message: 'stop applied',
      },
    }
    expect(controlAckMessageSchema.safeParse(message).success).toBe(true)
    expect(parseControlAckMessage(message).ok).toBe(true)
  })

  it('rejects a control.ack whose payload session disagrees', () => {
    const message = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'ack-2',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 2,
      kind: 'control.ack',
      payload: {
        sessionId: 'other-session',
        requestId: 'r-1',
        requestMessageId: 'm-stop',
        action: 'stop',
        status: 'applied',
        previousEpoch: 1,
        epoch: 2,
        lifecycle: 'stopped',
        outputConfirmation: 'pending',
        reasonCode: null,
        message: 'stop applied',
      },
    }
    expect(controlAckMessageSchema.safeParse(message).success).toBe(false)
  })

  it('converts a session.snapshot wire message into a canonical bootstrap snapshot', () => {
    const snapshot = normalizeBootstrapSnapshot(bootstrapWire)
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.value.sessionId).toBe(FIXTURE_SESSION_ID)
    expect(snapshot.value.epoch).toBe(1)
    expect(snapshot.value.seq).toBe(7)
    expect(snapshot.value.capabilityRevision).toBe(3)
    // exact round-trip preserves every value
    expect(wireToBootstrapSnapshot(bootstrapSnapshotToWire(snapshot.value))).toEqual(snapshot)
  })

  it('rejects a wrong kind for the bootstrap wire conversion', () => {
    expect(normalizeBootstrapSnapshot({ ...bootstrapWire, kind: 'input.ack' }).ok).toBe(false)
  })

  it('round-trips input.ack and correlates it to the originating request', () => {
    const wire = {
      ...ackEnvelope,
      kind: 'input.ack',
      payload: {
        status: 'accepted',
        requestMessageId: 'm-in',
        eventId: 'event-1',
        sessionId: FIXTURE_SESSION_ID,
        epoch: 1,
        seq: 2,
      },
    }
    const ack = wireToInputAck(wire)
    expect(ack.ok).toBe(true)
    if (!ack.ok || ack.value.status === 'rejected') return
    expect(ack.value.seq).toBe(2)
    expect(inputAckToWire(ack.value, 'ack-1')).toEqual(wire)
    const request = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'm-in',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'input.submit' as const,
      payload: { source: 'local-audience' as const, text: 'hello' },
    }
    expect(inputAckCorrelates(ack.value, request)).toBe(true)
    expect(inputAckCorrelates(ack.value, { ...request, epoch: 9 })).toBe(false)
  })

  it('round-trips control.ack and correlates it to the originating request', () => {
    const wire = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'ack-2',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 2,
      kind: 'control.ack',
      payload: {
        sessionId: FIXTURE_SESSION_ID,
        requestId: 'r-stop',
        requestMessageId: 'm-stop',
        action: 'stop',
        status: 'applied',
        previousEpoch: 1,
        epoch: 2,
        lifecycle: 'stopped',
        outputConfirmation: 'pending',
        reasonCode: null,
        message: 'stop applied',
      },
    }
    const ack = wireToControlAck(wire)
    expect(ack.ok).toBe(true)
    if (!ack.ok) return
    expect(controlAckToWire(ack.value, 'ack-2')).toEqual(wire)
    const request = {
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: 'm-stop',
      sessionId: FIXTURE_SESSION_ID,
      epoch: 1,
      kind: 'control.stop' as const,
      payload: { requestId: 'r-stop' },
    }
    expect(controlAckCorrelates(ack.value, request)).toBe(true)
    // wrong originating request id fails correlation
    expect(
      controlAckCorrelates(ack.value, { ...request, payload: { requestId: 'r-other' } }),
    ).toBe(false)
    // a resume ack must not correlate to a stop request
    expect(controlAckCorrelates({ ...ack.value, action: 'resume' }, request)).toBe(false)
    // an epoch that is neither unchanged nor advanced by one is not a valid ack
    expect(
      controlAckCorrelates({ ...ack.value, epoch: 5, previousEpoch: 1 }, request),
    ).toBe(false)
  })

  it('rejects a wrong kind for the ack wire conversions', () => {
    expect(normalizeInputAck({ ...ackEnvelope, kind: 'control.ack', payload: {} }).ok).toBe(false)
    expect(normalizeControlAck({ ...ackEnvelope, kind: 'input.ack', payload: {} }).ok).toBe(false)
  })
})
