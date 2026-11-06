import {
  APPLICATION_CONTRACT_VERSION,
  applicationServerMessageSchema,
  inputAckSchema,
  inputEventSchema,
  inputSubmitMessageSchema,
  selectionResultSchema,
  sessionEventMessageSchema,
  type DeliveryClassification,
  type InputAck,
  type InputEvent,
  type InputSource,
  type InputSubmitMessage,
  type ReplyIntent,
  type ServerMessage,
  type SelectionResult,
} from '../../src/contracts'

/**
 * M2-01 session C3 test-only batch-input fixture.
 *
 * This module is a server substitute. It builds protocol-0.2 messages from the
 * shared schemas so a scenario can never contain a shape the contract would
 * reject, and so an invalid fixture fails loudly at construction. It carries no
 * runtime, provider or playback: the `receivedAtMs`/`expiresAtMs` values below
 * are fixture clock readings, not delivery evidence, and nothing here is
 * measured audio or local playback proof.
 */

type SessionEventMessage = Extract<ServerMessage, { kind: 'session.event' }>

export const DEFAULT_BATCH_TEXTS: readonly string[] = [
  'What did you think of the opening song?',
  'The chorus was my favourite part.',
  'Will you sing it again later?',
]

const FIXTURE_ACTOR_ID = 'fixture-audience'
const FIXTURE_PROVIDER = 'fixture-provider'
const FIXTURE_MODEL = 'fixture-model-v1'
const FIXTURE_REASON_CODE = 'fixture-batch'
const DEFAULT_RECEIVED_AT_MS = 1_000
const DEFAULT_RECEIPT_LIFETIME_MS = 30_000

export interface BatchInputScenarioOptions {
  readonly sessionId: string
  readonly epoch: number
  readonly startSeq: number
  readonly source?: InputSource
  readonly texts?: readonly string[]
  readonly selectedIndex?: number
  /** Fixture clock values, not delivery evidence. */
  readonly receivedAtMs?: number
  readonly expiresAtMs?: number
}

export interface BatchInputScenario {
  readonly messages: readonly InputSubmitMessage[]
  readonly acknowledgements: readonly InputAck[]
  readonly events: readonly SessionEventMessage[]
  readonly inputs: readonly InputEvent[]
  readonly selectedInput: InputEvent
}

function messageId(explicit: string | undefined, fallback: string): string {
  return explicit === undefined ? fallback : explicit
}

function validateEvent(message: SessionEventMessage): SessionEventMessage {
  return sessionEventMessageSchema.parse(applicationServerMessageSchema.parse(message))
}

/** Builds one accepted `input.accepted` session event for a validated input. */
export function inputAcceptedMessage(options: {
  sessionId: string
  epoch: number
  seq: number
  input: InputEvent
  messageId?: string
}): SessionEventMessage {
  const input = inputEventSchema.parse(options.input)
  return validateEvent({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId: messageId(options.messageId, `fixture-input-accepted-${options.seq}`),
    sessionId: options.sessionId,
    epoch: options.epoch,
    kind: 'session.event',
    payload: {
      seq: options.seq,
      type: 'input.accepted',
      data: { eventId: input.eventId, input },
    },
  })
}

/** Builds one `selection.plan` event carrying a schema-validated plan. */
export function selectionPlanMessage(options: {
  sessionId: string
  epoch: number
  seq: number
  plan: SelectionResult
  synthetic: boolean
  messageId?: string
}): SessionEventMessage {
  const plan = selectionResultSchema.parse(options.plan)
  return validateEvent({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId: messageId(options.messageId, `fixture-selection-plan-${options.seq}`),
    sessionId: options.sessionId,
    epoch: options.epoch,
    kind: 'session.event',
    payload: {
      seq: options.seq,
      type: 'selection.plan',
      data: { plan, synthetic: options.synthetic },
    },
  })
}

/**
 * Builds one `turn.started` event with the runtime's actual event payload
 * shape: the application wire carries the stored event payload only, and it is
 * `{ replyIntent }`. The durable turn identity stays on the stored event.
 */
export function turnStartedMessage(options: {
  sessionId: string
  epoch: number
  seq: number
  replyIntent: ReplyIntent
  messageId?: string
}): SessionEventMessage {
  return validateEvent({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId: messageId(options.messageId, `fixture-turn-started-${options.seq}`),
    sessionId: options.sessionId,
    epoch: options.epoch,
    kind: 'session.event',
    payload: {
      seq: options.seq,
      type: 'turn.started',
      data: { replyIntent: options.replyIntent },
    },
  })
}

/**
 * Builds one `delivery.committed` event with the runtime's actual event payload
 * shape: the application wire carries the stored event payload only, and it is
 * `{ classification }`. The durable output, turn and segment identity stays on
 * the stored event.
 */
export function deliveryCommittedMessage(options: {
  sessionId: string
  epoch: number
  seq: number
  classification: DeliveryClassification
  messageId?: string
}): SessionEventMessage {
  return validateEvent({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId: messageId(options.messageId, `fixture-delivery-committed-${options.seq}`),
    sessionId: options.sessionId,
    epoch: options.epoch,
    kind: 'session.event',
    payload: {
      seq: options.seq,
      type: 'delivery.committed',
      data: { classification: options.classification },
    },
  })
}

function buildInput(
  options: BatchInputScenarioOptions,
  text: string,
  index: number,
  receivedAtMs: number,
  expiresAtMs: number,
): InputEvent {
  return inputEventSchema.parse({
    eventId: `fixture-batch-input-${index + 1}`,
    sessionId: options.sessionId,
    epoch: options.epoch,
    source: options.source ?? 'local-audience',
    actorId: FIXTURE_ACTOR_ID,
    text,
    receivedAtMs,
    expiresAtMs,
    trust: 'untrusted-content',
  })
}

/**
 * Builds a complete three-input batch: submit envelopes, correlated
 * acknowledgements, then the accepted-input, plan, turn and delivery events.
 *
 * Sequence values start at `startSeq + 1` and increase monotonically across the
 * whole batch, so the console accepts each event exactly once and in order.
 */
export function createBatchInputScenario(options: BatchInputScenarioOptions): BatchInputScenario {
  const texts = options.texts ?? DEFAULT_BATCH_TEXTS
  if (texts.length === 0) throw new Error('fixture batch scenario requires at least one text')
  const selectedIndex = options.selectedIndex ?? 1
  if (selectedIndex < 0 || selectedIndex >= texts.length) {
    throw new Error('fixture batch scenario selectedIndex is outside the batch')
  }
  const receivedAtMs = options.receivedAtMs ?? DEFAULT_RECEIVED_AT_MS
  const expiresAtMs = options.expiresAtMs ?? receivedAtMs + DEFAULT_RECEIPT_LIFETIME_MS
  if (expiresAtMs <= receivedAtMs) {
    throw new Error('fixture batch scenario expiry must follow receipt')
  }

  const inputs = texts.map((text, index) => buildInput(options, text, index, receivedAtMs, expiresAtMs))

  // Three accepted inputs, then plan, turn and delivery: one sequence each.
  const firstEventSeq = options.startSeq + 1
  const acceptanceSeqs = inputs.map((_input, index) => firstEventSeq + index)
  const planSeq = firstEventSeq + inputs.length
  const turnSeq = planSeq + 1
  const deliverySeq = turnSeq + 1

  const messages = inputs.map((input, index) =>
    inputSubmitMessageSchema.parse({
      protocolVersion: APPLICATION_CONTRACT_VERSION,
      messageId: `fixture-batch-submit-${index + 1}`,
      sessionId: options.sessionId,
      epoch: options.epoch,
      kind: 'input.submit',
      payload: { source: input.source, text: input.text },
    }),
  )

  const acknowledgements = inputs.map((input, index) =>
    inputAckSchema.parse({
      status: 'accepted',
      requestMessageId: messages[index]!.messageId,
      eventId: input.eventId,
      sessionId: options.sessionId,
      epoch: options.epoch,
      seq: acceptanceSeqs[index]!,
    }),
  )

  const acceptedEvents = inputs.map((input, index) =>
    inputAcceptedMessage({
      sessionId: options.sessionId,
      epoch: options.epoch,
      seq: acceptanceSeqs[index]!,
      input,
    }),
  )

  const selectedInput = inputs[selectedIndex]!
  const plan = selectionResultSchema.parse({
    requestId: 'fixture-batch-selection',
    sessionId: options.sessionId,
    epoch: options.epoch,
    snapshotRevision: 1,
    disposition: 'respond',
    selectedEventIds: [selectedInput.eventId],
    replyIntent: 'answer',
    reasonCode: FIXTURE_REASON_CODE,
    provider: FIXTURE_PROVIDER,
    modelVersion: FIXTURE_MODEL,
    usage: {
      provider: FIXTURE_PROVIDER,
      requestedModel: FIXTURE_MODEL,
      resolvedModel: FIXTURE_MODEL,
      requestId: 'fixture-batch-selection',
      inputTokens: 12,
      outputTokens: 8,
      usageMissing: false,
      elapsedMs: 5,
      status: 'ok',
      pricingRef: null,
    },
  })

  const events: readonly SessionEventMessage[] = [
    ...acceptedEvents,
    selectionPlanMessage({
      sessionId: options.sessionId,
      epoch: options.epoch,
      seq: planSeq,
      plan,
      synthetic: false,
    }),
    turnStartedMessage({
      sessionId: options.sessionId,
      epoch: options.epoch,
      seq: turnSeq,
      replyIntent: 'answer',
    }),
    deliveryCommittedMessage({
      sessionId: options.sessionId,
      epoch: options.epoch,
      seq: deliverySeq,
      classification: 'fully-delivered',
    }),
  ]

  return { messages, acknowledgements, events, inputs, selectedInput }
}
