import { z } from 'zod'
import {
  APPLICATION_CONTRACT_VERSION,
  counter,
  errorCodeSchema,
  inputSourceSchema,
  nonEmptyString,
  nullableString,
  outputConfirmationSchema,
  sessionLifecycleSchema,
} from './primitives'
import {
  performanceCancelSchema,
  performanceCommandSchema,
  performanceReceiptSchema,
} from './pipeline'

/**
 * Browser transport envelope (INTERFACES section 3). Every message shares
 * protocolVersion, messageId, sessionId and epoch. Identity that also appears
 * inside a payload must match the envelope.
 */
const envelopeBase = {
  protocolVersion: z.literal(APPLICATION_CONTRACT_VERSION),
  messageId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
}

export const inputSubmitPayloadSchema = z.strictObject({
  source: inputSourceSchema,
  text: z.string().min(1),
})
export const inputSubmitMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('input.submit'),
  payload: inputSubmitPayloadSchema,
})
export type InputSubmitMessage = z.infer<typeof inputSubmitMessageSchema>

export const controlPayloadSchema = z.strictObject({ requestId: nonEmptyString })
export const controlStopMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('control.stop'),
  payload: controlPayloadSchema,
})
export type ControlStopMessage = z.infer<typeof controlStopMessageSchema>
export const controlResumeMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('control.resume'),
  payload: controlPayloadSchema,
})
export type ControlResumeMessage = z.infer<typeof controlResumeMessageSchema>

export const performerStatusSchema = z.enum(['unknown', 'idle', 'busy'])
export type PerformerStatus = z.infer<typeof performerStatusSchema>

/**
 * Complete bootstrap snapshot. It carries the identities a fresh console needs
 * to construct its first request, plus the last sequence number and output
 * confirmation state. It is not a partial payload.
 */
export const bootstrapSnapshotSchema = z.strictObject({
  protocolVersion: z.literal(APPLICATION_CONTRACT_VERSION),
  messageId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  seq: counter,
  lifecycle: sessionLifecycleSchema,
  activeTurnId: nullableString,
  performerStatus: performerStatusSchema,
  outputConfirmation: outputConfirmationSchema,
  capabilityRevision: counter,
})
export type BootstrapSnapshot = z.infer<typeof bootstrapSnapshotSchema>

export const sessionSnapshotPayloadSchema = z.strictObject({
  lifecycle: sessionLifecycleSchema,
  activeTurnId: nullableString,
  performerStatus: performerStatusSchema,
  outputConfirmation: outputConfirmationSchema,
  capabilityRevision: counter,
  lastSeq: counter,
})
export type SessionSnapshotPayload = z.infer<typeof sessionSnapshotPayloadSchema>

export const sessionSnapshotMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.snapshot'),
  payload: sessionSnapshotPayloadSchema,
})
export type SessionSnapshotMessage = z.infer<typeof sessionSnapshotMessageSchema>

export const sessionEventPayloadSchema = z.strictObject({
  seq: counter,
  type: nonEmptyString,
  data: z.record(z.string(), z.unknown()),
})
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>

export const sessionEventMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.event'),
  payload: sessionEventPayloadSchema,
})

export const performanceExecuteMessageSchema = z
  .strictObject({
    ...envelopeBase,
    kind: z.literal('performance.execute'),
    payload: performanceCommandSchema,
  })
  .superRefine((value, context) => {
    if (value.payload.sessionId !== value.sessionId) {
      context.addIssue({ code: 'custom', message: 'payload sessionId must match envelope sessionId' })
    }
    if (value.payload.epoch !== value.epoch) {
      context.addIssue({ code: 'custom', message: 'payload epoch must match envelope epoch' })
    }
  })

export const performanceCancelMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('performance.cancel'),
  payload: performanceCancelSchema,
})

export const performanceReceiptMessageSchema = z
  .strictObject({
    ...envelopeBase,
    kind: z.literal('performance.receipt'),
    payload: performanceReceiptSchema,
  })
  .superRefine((value, context) => {
    if (value.payload.sessionId !== value.sessionId) {
      context.addIssue({ code: 'custom', message: 'payload sessionId must match envelope sessionId' })
    }
    if (value.payload.epoch !== value.epoch) {
      context.addIssue({ code: 'custom', message: 'payload epoch must match envelope epoch' })
    }
  })

export const requestErrorPayloadSchema = z.strictObject({
  requestId: nullableString,
  code: errorCodeSchema,
  retryable: z.boolean(),
  message: z.string(),
})
export type RequestErrorPayload = z.infer<typeof requestErrorPayloadSchema>

export const requestErrorMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('request.error'),
  payload: requestErrorPayloadSchema,
})

/** Input acceptance acknowledgement. */
export const inputAckSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    requestMessageId: nonEmptyString,
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    seq: counter,
  }),
  z.strictObject({
    status: z.literal('duplicate'),
    requestMessageId: nonEmptyString,
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    seq: counter,
  }),
  z.strictObject({
    status: z.literal('rejected'),
    requestMessageId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    code: errorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
])
export type InputAck = z.infer<typeof inputAckSchema>

/** Authorized control acknowledgement covering Stop and Resume. */
export const controlAckSchema = z.strictObject({
  sessionId: nonEmptyString,
  requestId: nonEmptyString,
  requestMessageId: nonEmptyString,
  action: z.enum(['stop', 'resume']),
  status: z.enum(['applied', 'duplicate', 'refused']),
  previousEpoch: counter,
  epoch: counter,
  lifecycle: sessionLifecycleSchema,
  outputConfirmation: outputConfirmationSchema,
  reasonCode: nullableString,
  message: z.string(),
})
export type ControlAck = z.infer<typeof controlAckSchema>

/**
 * v0.2 reply envelopes. The envelope carries transport identity; the payload
 * must agree with it, and payload.requestMessageId correlates the ack to the
 * client request that produced it.
 */
export const inputAckMessageSchema = z
  .strictObject({
    ...envelopeBase,
    kind: z.literal('input.ack'),
    payload: inputAckSchema,
  })
  .superRefine((value, context) => {
    if (value.payload.sessionId !== value.sessionId) {
      context.addIssue({ code: 'custom', message: 'payload sessionId must match envelope sessionId' })
    }
    if (value.payload.epoch !== value.epoch) {
      context.addIssue({ code: 'custom', message: 'payload epoch must match envelope epoch' })
    }
  })
export type InputAckMessage = z.infer<typeof inputAckMessageSchema>

export const controlAckMessageSchema = z
  .strictObject({
    ...envelopeBase,
    kind: z.literal('control.ack'),
    payload: controlAckSchema,
  })
  .superRefine((value, context) => {
    if (value.payload.sessionId !== value.sessionId) {
      context.addIssue({ code: 'custom', message: 'payload sessionId must match envelope sessionId' })
    }
    if (value.payload.epoch !== value.epoch) {
      context.addIssue({ code: 'custom', message: 'payload epoch must match envelope epoch' })
    }
  })
export type ControlAckMessage = z.infer<typeof controlAckMessageSchema>

export const clientMessageSchema = z.discriminatedUnion('kind', [
  inputSubmitMessageSchema,
  controlStopMessageSchema,
  controlResumeMessageSchema,
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

export const serverMessageSchema = z.discriminatedUnion('kind', [
  inputAckMessageSchema,
  controlAckMessageSchema,
  sessionSnapshotMessageSchema,
  sessionEventMessageSchema,
  performanceExecuteMessageSchema,
  performanceCancelMessageSchema,
  requestErrorMessageSchema,
])
export type ServerMessage = z.infer<typeof serverMessageSchema>

export const playerMessageSchema = performanceReceiptMessageSchema
export type PlayerMessage = z.infer<typeof playerMessageSchema>

export const browserMessageSchema = z.discriminatedUnion('kind', [
  inputSubmitMessageSchema,
  controlStopMessageSchema,
  controlResumeMessageSchema,
  inputAckMessageSchema,
  controlAckMessageSchema,
  sessionSnapshotMessageSchema,
  sessionEventMessageSchema,
  performanceExecuteMessageSchema,
  performanceCancelMessageSchema,
  performanceReceiptMessageSchema,
  requestErrorMessageSchema,
])
export type BrowserMessage = z.infer<typeof browserMessageSchema>
