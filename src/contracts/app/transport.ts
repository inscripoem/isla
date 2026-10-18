import { z } from 'zod'
import {
  APPLICATION_CONTRACT_VERSION,
  counter,
  nonEmptyString,
  type ErrorCode,
} from './primitives'
import {
  performanceCommandSchema,
  playerStatusSchema,
  type PerformanceCommand,
} from './pipeline'
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

/**
 * Physical-status report from the bound performer for one output.
 *
 * A delivery receipt proves the observed delivery fact; it does not by itself
 * prove that local media was released. The performer reports its own
 * `PlayerStatus` (the existing M1 `status()` interface) so the server can
 * separate the delivery fact from physical occupancy. The `outputId` and the
 * envelope `epoch`/`sessionId` correlate the report to the dispatch it
 * describes; a report whose identity or connection generation does not match
 * is not trusted. This is an additive protocol-0.2 client kind: an older strict
 * decoder that does not know it will reject it rather than ignore it, so
 * producers and consumers must be upgraded together.
 */
export const performanceStatusMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('performance.status'),
  payload: z.strictObject({
    outputId: nonEmptyString,
    status: playerStatusSchema,
  }),
})
export type PerformanceStatusMessage = z.infer<typeof performanceStatusMessageSchema>

/**
 * Explicit operator recovery action for an interrupted session.
 *
 * Disconnecting after playback started leaves the retired session's output
 * evidence unconfirmed and its physical occupancy unknown, so the retained
 * session can accept input but cannot produce output. The operator may end that
 * session and continue in a fresh successor that carries only confirmed history.
 *
 * The envelope `sessionId` is the session the operator intends to retire: a
 * request against the current session retires it, and a request against a
 * session already retired is answered idempotently. `acknowledgePlaybackEnded`
 * is the operator's own decision that they have ended playback in the previous
 * session. It is never measured media evidence and never a delivery fact, and
 * it is deliberately a required literal so the acknowledgement cannot be
 * omitted. This is an additive protocol-0.2 client kind: a strict decoder that
 * predates it rejects it rather than ignoring it, so producers and consumers
 * must be upgraded together.
 */
export const sessionRecoverMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.recover'),
  payload: z.strictObject({ acknowledgePlaybackEnded: z.literal(true) }),
})
export type SessionRecoverMessage = z.infer<typeof sessionRecoverMessageSchema>

/**
 * Server acknowledgement of one recovery request. The envelope stays on the
 * retiring session and the request's epoch so it correlates to the request; the
 * successor identity is carried in the payload. `applied` means this request
 * installed the successor; `already_applied` means an earlier (or concurrent)
 * request already did, so no second successor was created.
 */
export const sessionRecoveryAckMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.recovery.ack'),
  payload: z.strictObject({
    status: z.enum(['applied', 'already_applied']),
    requestMessageId: nonEmptyString,
    retiredSessionId: nonEmptyString,
    successorSessionId: nonEmptyString,
    recoveries: counter,
    remainingRecoveries: counter,
  }),
})
export type SessionRecoveryAckMessage = z.infer<typeof sessionRecoveryAckMessageSchema>

/**
 * Explicit application retirement state, pushed by the server.
 *
 * `retiring: true` means the runtime has begun retiring the session carried by
 * this envelope: the session is stopped and new input and Resume are refused
 * until a retry installs a successor. It is published when valid retirement
 * begins and to each newly connected client right after its snapshot, so a
 * reload after a failed retirement still reflects the retired state. A refusal
 * that never retires the live session (stale, unknown-session, unauthorized or
 * already-retired) never sets it. The successor session reports `retiring:
 * false` and remains stopped for a manual Resume. This is an additive
 * protocol-0.2 server kind: a strict decoder that predates it rejects it rather
 * than ignoring it, so producers and consumers must be upgraded together.
 */
export const sessionRecoveryStateMessageSchema = z.strictObject({
  ...envelopeBase,
  kind: z.literal('session.recovery.state'),
  payload: z.strictObject({ retiring: z.boolean() }),
})
export type SessionRecoveryStateMessage = z.infer<typeof sessionRecoveryStateMessageSchema>

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
  performanceStatusMessageSchema,
  sessionAttachMessageSchema,
  operatorBootstrapMessageSchema,
  sessionRecoverMessageSchema,
])
export type ApplicationClientMessage = z.infer<typeof applicationClientMessageSchema>

export const applicationServerMessageSchema = z.union([
  serverMessageSchema,
  sessionAttachAckMessageSchema,
  operatorAckMessageSchema,
  performanceOfferMessageSchema,
  performanceGrantMessageSchema,
  sessionRecoveryAckMessageSchema,
  sessionRecoveryStateMessageSchema,
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
