import { z } from 'zod'

/**
 * Application contract version. This is deliberately separate from the
 * diagnostic protocol version (see ./version) and from runtime application
 * readiness, which the health payload still reports as null.
 */
export const APPLICATION_CONTRACT_VERSION = '0.2' as const
export type ApplicationContractVersion = typeof APPLICATION_CONTRACT_VERSION

export const nonEmptyString = z.string().min(1)
export const counter = z.number().int().nonnegative()
export const nullableString = z.string().min(1).nullable()

export const REPLY_INTENTS = [
  'answer',
  'clarify',
  'acknowledge',
  'support',
  'playful',
  'check-correction',
] as const
export type ReplyIntent = (typeof REPLY_INTENTS)[number]
export const replyIntentSchema = z.enum(REPLY_INTENTS)

/** Dispatch no renderer command. It is a decision outcome, not a mapped action. */
export const NO_OP_ACTION = 'no-op' as const
/** Base candidate actions; only actually mapped actions may be advertised. */
export const BASE_ACTION_IDS = ['neutral', 'listening', 'smile', 'surprise'] as const
export const actionIdSchema = z.string().min(1)

export const INPUT_SOURCES = ['local-audience', 'cohost-text', 'external-fixture'] as const
export const inputSourceSchema = z.enum(INPUT_SOURCES)
export type InputSource = (typeof INPUT_SOURCES)[number]

export const trustClassificationSchema = z.enum(['untrusted-content', 'trusted-control'])
export type TrustClassification = z.infer<typeof trustClassificationSchema>

export const connectionRoleSchema = z.enum(['operator', 'viewer'])
export type ConnectionRole = z.infer<typeof connectionRoleSchema>

export const sessionLifecycleSchema = z.enum(['stopped', 'running', 'degraded'])
export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>

export const outputConfirmationSchema = z.enum(['pending', 'confirmed', 'unknown'])
export type OutputConfirmation = z.infer<typeof outputConfirmationSchema>

export const receiptStageSchema = z.enum([
  'accepted',
  'started',
  'completed',
  'cancelled',
  'failed',
  'unknown',
])
export type ReceiptStage = z.infer<typeof receiptStageSchema>

export const modalitySchema = z.enum(['audio', 'subtitle', 'avatar'])
export type Modality = z.infer<typeof modalitySchema>

export const deliveryClassificationSchema = z.enum([
  'fully-delivered',
  'partial-unknown',
  'not-delivered',
])
export type DeliveryClassification = z.infer<typeof deliveryClassificationSchema>

export const observabilitySchema = z.enum(['observable', 'acceptance-only', 'unknown'])
export type Observability = z.infer<typeof observabilitySchema>

export const dispositionSchema = z.enum(['respond', 'defer'])
export type SelectionDisposition = z.infer<typeof dispositionSchema>

export const decisionStatusSchema = z.enum(['selected', 'abstained', 'failed'])
export type DecisionStatus = z.infer<typeof decisionStatusSchema>

export const dialogueEndStatusSchema = z.enum(['completed', 'cancelled', 'failed', 'deadline_exceeded'])
export type DialogueEndStatus = z.infer<typeof dialogueEndStatusSchema>

export const ERROR_CODES = [
  'malformed',
  'unsupported_version',
  'unknown_kind',
  'unsupported_action',
  'invalid_field',
  'unauthorized',
  'stale',
  'deadline_exceeded',
  'dependency_failed',
  'storage_unavailable',
  'conflict',
  'internal',
] as const
export const errorCodeSchema = z.enum(ERROR_CODES)
export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * Server-owned monotonic deadline, expressed in the injected clock's domain.
 * Clients can neither lengthen it nor reinterpret it.
 */
export const deadlineSchema = z.strictObject({ atMs: z.number() })
export type Deadline = z.infer<typeof deadlineSchema>

export interface CallContext {
  readonly signal: AbortSignal
  readonly deadline: Deadline
}

/**
 * Server-produced control context. It is never parsed from a client payload;
 * audience or model text cannot grant these privileges.
 */
export const trustedControlContextSchema = z.strictObject({
  connectionId: nonEmptyString,
  role: connectionRoleSchema,
  actorId: nonEmptyString,
  authenticated: z.boolean(),
})
export type TrustedControlContext = z.infer<typeof trustedControlContextSchema>

export const usageRecordSchema = z.strictObject({
  provider: nonEmptyString,
  requestedModel: nonEmptyString,
  resolvedModel: nullableString,
  requestId: nonEmptyString,
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  usageMissing: z.boolean(),
  elapsedMs: z.number().nonnegative(),
  status: z.enum(['ok', 'failed', 'timeout', 'cancelled']),
  pricingRef: nullableString,
})
export type UsageRecord = z.infer<typeof usageRecordSchema>
