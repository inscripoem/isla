import { z } from 'zod'
import {
  APPLICATION_CONTRACT_VERSION,
  counter,
  deliveryClassificationSchema,
  modalitySchema,
  nonEmptyString,
  nullableString,
} from './primitives'

/**
 * C6 — CommitDelivery (M5 -> M4).
 *
 * Internal storage-contract revision 2026-10-14.1 adds explicit delivery
 * attribution: the original segment index and the identity and version of the
 * persona that generated the output. The index is captured from the original
 * segment; the persona identity and version are captured from the original
 * dialogue request. Both are persisted with the delivery; a genuine legacy
 * unknown is an explicit `null`, never a fabricated index or the current
 * persona. The application contract version stays `0.2`; the strict decoders
 * roll out together with their constructors.
 */

export const TERMINAL_OUTCOMES = ['completed', 'cancelled', 'failed', 'unknown'] as const
export type CommitTerminalOutcome = (typeof TERMINAL_OUTCOMES)[number]
export const terminalOutcomeSchema = z.enum(TERMINAL_OUTCOMES)

/**
 * Evidence-based compatibility of `classification` and `terminalOutcome`.
 *
 * Traced from the M5 producer (`classifyAudioDelivery`): an observed
 * `completed` stage is `fully-delivered`; a started-then-cancelled/failed or
 * unresolved stage is `partial-unknown`; no observed start is `not-delivered`.
 * The enforced rule is the compatibility converse: `completed` is valid only
 * for `fully-delivered`, while `cancelled`, `failed` and `unknown` outcomes may
 * pair with `partial-unknown` or `not-delivered`. `unknown` is missing
 * knowledge, not evidence that no start was observed, so it does not by itself
 * decide the classification. This is a compatibility constraint, not an
 * evidence claim: it adds no classification and no start observation of its
 * own. A genuinely unknown legacy classification is not inferred here — the
 * producer must supply a real value.
 */
const TERMINAL_OUTCOMES_BY_CLASSIFICATION: Record<
  z.infer<typeof deliveryClassificationSchema>,
  readonly CommitTerminalOutcome[]
> = {
  'fully-delivered': ['completed'],
  'partial-unknown': ['cancelled', 'failed', 'unknown'],
  'not-delivered': ['cancelled', 'failed', 'unknown'],
}

export const commitDeliverySchema = z.strictObject({
  sessionId: nonEmptyString,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  textHash: nonEmptyString,
  /** Immutable finalized text, so an independent module can retrieve history. */
  text: nonEmptyString,
  outputId: nullableString,
  receiptId: nullableString,
  classification: deliveryClassificationSchema,
  terminalOutcome: terminalOutcomeSchema,
  modality: modalitySchema,
  /** Original `DialogueSegment.index`; never parsed from `segmentId`. */
  segmentIndex: counter.nullable(),
  /** Generating persona identity, paired with its version below. */
  personaProfileId: nonEmptyString.nullable(),
  personaProfileVersion: nonEmptyString.nullable(),
}).superRefine((delivery, ctx) => {
  if (
    !TERMINAL_OUTCOMES_BY_CLASSIFICATION[delivery.classification].includes(
      delivery.terminalOutcome,
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['terminalOutcome'],
      message: `terminalOutcome "${delivery.terminalOutcome}" is inconsistent with classification "${delivery.classification}"`,
    })
  }
})
export type CommitDelivery = z.infer<typeof commitDeliverySchema>

export const deliveryCommitAckSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    effectiveClassification: deliveryClassificationSchema,
    recordId: nonEmptyString,
  }),
  z.strictObject({
    status: z.literal('duplicate'),
    effectiveClassification: deliveryClassificationSchema,
    recordId: nonEmptyString,
  }),
  z.strictObject({
    status: z.literal('conflict'),
    recordedClassification: deliveryClassificationSchema,
    incomingClassification: deliveryClassificationSchema,
    conflictRecordId: nonEmptyString,
  }),
  z.strictObject({
    status: z.literal('failed'),
    reasonCode: nonEmptyString,
    message: z.string(),
  }),
])
export type DeliveryCommitAck = z.infer<typeof deliveryCommitAckSchema>

/** C7 — RuntimeEvent and append acknowledgement (M5 -> M6). */

export const sourceModuleSchema = z.enum(['M1', 'M2', 'M3', 'M4', 'M5', 'M6'])
export type SourceModule = z.infer<typeof sourceModuleSchema>

export const runtimeEventSchema = z.strictObject({
  protocolVersion: z.literal(APPLICATION_CONTRACT_VERSION),
  eventId: nonEmptyString,
  seq: counter,
  timestampMs: z.number().nonnegative(),
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nullableString,
  segmentId: nullableString,
  outputId: nullableString,
  type: nonEmptyString,
  sourceModule: sourceModuleSchema,
  versions: z.record(z.string(), z.string()).nullable(),
  payload: z.record(z.string(), z.unknown()),
})
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>

/**
 * Correlation rule for one atomic delivery commit (C7). Returns a short field
 * name when the delivery and its supporting event carry contradictory known
 * values, or `null` when they are consistent.
 *
 * `sessionId` is always known on both sides, so it must match exactly. For
 * `turnId`, `segmentId`, `outputId` and the two persona components only a
 * *known-vs-known* disagreement is rejected: an absent or explicit `null` on
 * either side is legacy raw partial knowledge and is never inferred from the
 * other, while two supplied components must agree. Unrelated `versions` entries
 * are ignored and preserved; a `null` map member is not a valid encoding (the
 * record values are strings) and is rejected by event validation before this
 * check. Consumers may compare a persona identity/version only when both sides
 * are known.
 */
export function deliveryEventCorrelationIssue(
  delivery: Pick<
    CommitDelivery,
    | 'sessionId'
    | 'turnId'
    | 'segmentId'
    | 'outputId'
    | 'personaProfileId'
    | 'personaProfileVersion'
  >,
  event: Pick<RuntimeEvent, 'sessionId' | 'turnId' | 'segmentId' | 'outputId' | 'versions'>,
): string | null {
  if (event.sessionId !== delivery.sessionId) return 'sessionId'
  if (event.turnId !== null && delivery.turnId !== null && event.turnId !== delivery.turnId) {
    return 'turnId'
  }
  if (event.segmentId !== null && delivery.segmentId !== null && event.segmentId !== delivery.segmentId) {
    return 'segmentId'
  }
  if (event.outputId !== null && delivery.outputId !== null && event.outputId !== delivery.outputId) {
    return 'outputId'
  }
  const versions = event.versions
  if (versions === null) return null
  const eventPersonaId = versions['personaProfileId']
  if (
    eventPersonaId !== undefined &&
    delivery.personaProfileId !== null &&
    eventPersonaId !== delivery.personaProfileId
  ) {
    return 'personaProfileId'
  }
  const eventPersonaVersion = versions['personaProfileVersion']
  if (
    eventPersonaVersion !== undefined &&
    delivery.personaProfileVersion !== null &&
    eventPersonaVersion !== delivery.personaProfileVersion
  ) {
    return 'personaProfileVersion'
  }
  return null
}

/** Narrow confirmed-history record returned by the M6 history query port. */
export const confirmedDeliverySchema = z.strictObject({
  sessionId: nonEmptyString,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  textHash: nonEmptyString,
  /** Confirmed spoken text; partial or generated-only records are excluded. */
  text: nonEmptyString,
  outputId: nullableString,
  receiptId: nullableString,
  classification: deliveryClassificationSchema,
  modality: modalitySchema,
  /** Attribution captured with the delivery (see `commitDeliverySchema`). */
  segmentIndex: counter.nullable(),
  personaProfileId: nonEmptyString.nullable(),
  personaProfileVersion: nonEmptyString.nullable(),
})
export type ConfirmedDelivery = z.infer<typeof confirmedDeliverySchema>

export const appendAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('stored'),
    eventId: nonEmptyString,
    seq: counter,
  }),
  z.strictObject({
    outcome: z.literal('duplicate'),
    eventId: nonEmptyString,
    seq: counter,
  }),
  z.strictObject({
    outcome: z.literal('failed'),
    eventId: nonEmptyString,
    seq: counter,
    reasonCode: nonEmptyString,
    message: z.string(),
  }),
])
export type AppendAck = z.infer<typeof appendAckSchema>

export const atomicCommitAckSchema = z.strictObject({
  delivery: deliveryCommitAckSchema,
  event: appendAckSchema,
})
export type AtomicCommitAck = z.infer<typeof atomicCommitAckSchema>
