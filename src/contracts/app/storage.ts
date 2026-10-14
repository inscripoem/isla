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
  terminalOutcome: z.enum(['completed', 'cancelled', 'failed', 'unknown']),
  modality: modalitySchema,
  /** Original `DialogueSegment.index`; never parsed from `segmentId`. */
  segmentIndex: counter.nullable(),
  /** Generating persona identity, paired with its version below. */
  personaProfileId: nonEmptyString.nullable(),
  personaProfileVersion: nonEmptyString.nullable(),
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
