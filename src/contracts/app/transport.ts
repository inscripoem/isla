import { z } from 'zod'
import {
  APPLICATION_CONTRACT_VERSION,
  counter,
  nonEmptyString,
  type ErrorCode,
} from './primitives'
import { performanceCommandSchema, type PerformanceCommand } from './pipeline'
import {
  controlResumeMessageSchema,
  controlStopMessageSchema,
  inputSubmitMessageSchema,
  performanceReceiptMessageSchema,
  requestErrorMessageSchema,
  serverMessageSchema,
  type ServerMessage,
} from './wire'

/**
 * Application transport extension (protocol 0.2).
 *
 * These schemas extend the shared `wire.ts` contracts with the transport-level
 * exchanges needed to bind a browser connection and authorize delayed playback.
 * They live in the shared, browser-safe contracts subtree so the product console
 * (M2), the runtime (M5) and the demo/test clients all validate against one
 * definition instead of duplicating casts. The C1–C7 business schemas are
 * unchanged.
 *
 * Security rule: none of these messages carries a privilege a payload can
 * self-declare. The performer claim only reserves the single active playback
 * connection. Operator authority requires a one-time token issued by the local,
 * same-origin HTTP bootstrap; it never comes from a self-reported `role` field.
 */

export const APPLICATION_PATH = '/app'

export const OPERATOR_BOOTSTRAP_PATH = '/operator/bootstrap'

/** Header required on the bootstrap POST so a cross-origin caller needs preflight. */
export const OPERATOR_BOOTSTRAP_HEADER = 'x-isla-operator-bootstrap'

const envelopeBase = {
  protocolVersion: z.literal(APPLICATION_CONTRACT_VERSION),
  messageId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
}

/** Claims the single active performer slot for a session. Not a privilege. */
export const sessionAttachMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.attach'),
  payload: z.strictObject({}),
})
export type SessionAttachMessage = z.infer<typeof sessionAttachMessageSchema>

export const sessionAttachAckMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.attach.ack'),
  payload: z.strictObject({
    connectionId: nonEmptyString,
    performer: z.literal(true),
  }),
})
export type SessionAttachAckMessage = z.infer<typeof sessionAttachAckMessageSchema>

/** Exchanges a same-origin, one-time bootstrap token for operator authority. */
export const operatorBootstrapMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('operator.bootstrap'),
  payload: z.strictObject({ token: nonEmptyString }),
})
export type OperatorBootstrapMessage = z.infer<typeof operatorBootstrapMessageSchema>

export const operatorAckMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('operator.ack'),
  payload: z.strictObject({
    role: z.literal('operator'),
    requestMessageId: nonEmptyString,
  }),
})
export type OperatorAckMessage = z.infer<typeof operatorAckMessageSchema>

/**
 * Delayed-execution protocol extension.
 *
 * The server sends an `offer` carrying the performance command but authorizing
 * no playback. The browser records its own local request time and answers
 * `ready`. The server revalidates identity, connection generation and epoch,
 * then sends a `grant` carrying the remaining server lifetime as a duration
 * (never an absolute reading). The browser's conservative local expiry is its
 * own request start plus that remaining lifetime, and its remaining local time
 * at receipt is `serverRemaining - (localNow - localRequestStart)`. No absolute
 * monotonic reading crosses the clock domains.
 */
export const performanceOfferMessageSchema = z
  .strictObject({
    ...envelopeBase,
    kind: z.literal('performance.offer'),
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
export type PerformanceOfferMessage = z.infer<typeof performanceOfferMessageSchema>

export const performanceGrantIdentitySchema = z.strictObject({
  outputId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
})

export const performanceGrantMessageSchema = z
  .strictObject({
    ...envelopeBase,
    kind: z.literal('performance.grant'),
    payload: z.strictObject({
      ...performanceGrantIdentitySchema.shape,
      remainingLifetimeMs: z.number().finite().nonnegative(),
    }),
  })
  .superRefine((value, context) => {
    if (value.payload.sessionId !== value.sessionId) {
      context.addIssue({ code: 'custom', message: 'payload sessionId must match envelope sessionId' })
    }
    if (value.payload.epoch !== value.epoch) {
      context.addIssue({ code: 'custom', message: 'payload epoch must match envelope epoch' })
    }
  })
export type PerformanceGrantMessage = z.infer<typeof performanceGrantMessageSchema>

export const performanceReadyMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('performance.ready'),
  payload: z.strictObject({
    outputId: nonEmptyString,
    turnId: nonEmptyString,
    segmentId: nonEmptyString,
  }),
})
export type PerformanceReadyMessage = z.infer<typeof performanceReadyMessageSchema>

/** Envelope for an offer; the command already carries its own identity. */
export function performanceOffer(
  command: PerformanceCommand,
  messageId: string,
): PerformanceOfferMessage {
  return performanceOfferMessageSchema.parse({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId,
    sessionId: command.sessionId,
    epoch: command.epoch,
    kind: 'performance.offer',
    payload: command,
  })
}

export function performanceGrant(
  command: PerformanceCommand,
  remainingLifetimeMs: number,
  messageId: string,
): PerformanceGrantMessage {
  return performanceGrantMessageSchema.parse({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId,
    sessionId: command.sessionId,
    epoch: command.epoch,
    kind: 'performance.grant',
    payload: {
      outputId: command.outputId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      turnId: command.turnId,
      segmentId: command.segmentId,
      remainingLifetimeMs,
    },
  })
}

export const applicationClientMessageSchema = z.discriminatedUnion('kind', [
  inputSubmitMessageSchema,
  controlStopMessageSchema,
  controlResumeMessageSchema,
  performanceReceiptMessageSchema,
  performanceReadyMessageSchema,
  sessionAttachMessageSchema,
  operatorBootstrapMessageSchema,
])
export type ApplicationClientMessage = z.infer<typeof applicationClientMessageSchema>

export const applicationServerMessageSchema = z.union([
  serverMessageSchema,
  sessionAttachAckMessageSchema,
  operatorAckMessageSchema,
  performanceOfferMessageSchema,
  performanceGrantMessageSchema,
])
export type ApplicationServerMessage = z.infer<typeof applicationServerMessageSchema>

export type ApplicationParseOutcome =
  | { readonly ok: true; readonly message: ApplicationClientMessage }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string }

export function parseApplicationClientMessage(raw: unknown): ApplicationParseOutcome {
  const parsed = applicationClientMessageSchema.safeParse(raw)
  if (parsed.success) return { ok: true, message: parsed.data }
  const issue = parsed.error.issues[0]
  return {
    ok: false,
    code: 'malformed',
    message: issue?.message ?? 'message failed schema validation',
  }
}

export type ApplicationServerParseOutcome =
  | { readonly ok: true; readonly message: ApplicationServerMessage }
  | { readonly ok: false; readonly message: string }

export function parseApplicationServerMessage(raw: unknown): ApplicationServerParseOutcome {
  const parsed = applicationServerMessageSchema.safeParse(raw)
  if (parsed.success) return { ok: true, message: parsed.data }
  const issue = parsed.error.issues[0]
  return { ok: false, message: issue?.message ?? 'message failed schema validation' }
}

/** Builds a correlated `request.error` envelope. */
export function requestError(
  sessionId: string,
  epoch: number,
  messageId: string,
  requestId: string | null,
  code: ErrorCode,
  message: string,
  retryable = false,
): ServerMessage {
  return requestErrorMessageSchema.parse({
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId,
    sessionId,
    epoch,
    kind: 'request.error',
    payload: { requestId, code, retryable, message },
  })
}
