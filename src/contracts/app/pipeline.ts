import { z } from 'zod'
import {
  actionIdSchema,
  counter,
  deadlineSchema,
  decisionStatusSchema,
  dialogueEndStatusSchema,
  dispositionSchema,
  inputSourceSchema,
  modalitySchema,
  nonEmptyString,
  observabilitySchema,
  receiptStageSchema,
  replyIntentSchema,
  usageRecordSchema,
} from './primitives'

/** Maximum eligible candidates inspected for one response plan (INTERFACES C1). */
export const MAX_SELECTION_CANDIDATES = 5
/** v0.2 emits at most two finalized dialogue segments per turn. */
export const MAX_DIALOGUE_SEGMENTS = 2

/** C1 — InputEvent, SelectionRequest and SelectionResult (M5 <-> M3). */

export const inputEventSchema = z.strictObject({
  eventId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  source: inputSourceSchema,
  actorId: nonEmptyString,
  text: z.string().min(1),
  receivedAtMs: z.number().nonnegative(),
  expiresAtMs: z.number().nonnegative(),
  trust: z.literal('untrusted-content'),
})
export type InputEvent = z.infer<typeof inputEventSchema>

export const selectionRequestSchema = z.strictObject({
  requestId: nonEmptyString,
  task: z.literal('response-plan'),
  sessionId: nonEmptyString,
  epoch: counter,
  snapshotRevision: counter,
  candidates: z.array(inputEventSchema).min(1).max(MAX_SELECTION_CANDIDATES),
  personaSummary: z.string(),
  currentTopic: z.string(),
  recentHistory: z.array(z.string()),
  allowedIntents: z.array(replyIntentSchema).min(1),
  deadline: deadlineSchema,
  policyVersion: nonEmptyString,
  providerVersion: nonEmptyString,
})
export type SelectionRequest = z.infer<typeof selectionRequestSchema>

export const selectionResultSchema = z
  .strictObject({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    snapshotRevision: counter,
    disposition: dispositionSchema,
    selectedEventIds: z.array(nonEmptyString),
    replyIntent: replyIntentSchema.nullable(),
    reasonCode: nonEmptyString,
    provider: nonEmptyString,
    modelVersion: nonEmptyString,
    usage: usageRecordSchema,
  })
  .superRefine((value, context) => {
    if (value.disposition === 'respond') {
      if (value.selectedEventIds.length !== 1) {
        context.addIssue({ code: 'custom', message: 'respond requires exactly one selected event id' })
      }
      if (value.replyIntent === null) {
        context.addIssue({ code: 'custom', message: 'respond requires a reply intent' })
      }
      return
    }
    if (value.selectedEventIds.length !== 0) {
      context.addIssue({ code: 'custom', message: 'defer requires no selected event ids' })
    }
    if (value.replyIntent !== null) {
      context.addIssue({ code: 'custom', message: 'defer must not carry a reply intent' })
    }
  })
export type SelectionResult = z.infer<typeof selectionResultSchema>

/** C2 — DialogueRequest, DialogueSegment and DialogueEnd (M5 <-> M4). */

export const responsePlanSchema = z.strictObject({
  selectionRequestId: nonEmptyString,
  selectedEventId: nonEmptyString,
  replyIntent: replyIntentSchema,
  policyVersion: nonEmptyString,
})
export type ResponsePlan = z.infer<typeof responsePlanSchema>

export const contextLimitsSchema = z.strictObject({
  maxTurns: counter,
  maxCharacters: counter,
})
export type ContextLimits = z.infer<typeof contextLimitsSchema>

/**
 * Selected input supplied to dialogue. Ids alone are insufficient: M4 must not
 * need to guess the selected text or perform an implicit lookup.
 */
export const selectedInputSchema = z.strictObject({
  eventId: nonEmptyString,
  text: z.string().min(1),
})
export type SelectedInput = z.infer<typeof selectedInputSchema>

export const dialogueRequestSchema = z
  .strictObject({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    turnId: nonEmptyString,
    selectedInput: selectedInputSchema,
    characterProfileId: nonEmptyString,
    characterProfileVersion: nonEmptyString,
    responsePlan: responsePlanSchema,
    confirmedEventRefs: z.array(nonEmptyString),
    contextLimits: contextLimitsSchema,
  })
  .superRefine((value, context) => {
    if (value.selectedInput.eventId !== value.responsePlan.selectedEventId) {
      context.addIssue({
        code: 'custom',
        message: 'selectedInput.eventId must match responsePlan.selectedEventId',
      })
    }
  })
export type DialogueRequest = z.infer<typeof dialogueRequestSchema>

export const dialogueSegmentSchema = z.strictObject({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  index: counter.max(MAX_DIALOGUE_SEGMENTS - 1),
  text: z.string().min(1),
  model: nonEmptyString,
  modelVersion: nonEmptyString,
})
export type DialogueSegment = z.infer<typeof dialogueSegmentSchema>

export const dialogueEndSchema = z.strictObject({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  status: dialogueEndStatusSchema,
  /** A completed end with zero segments is the documented no-speech outcome. */
  segmentCount: counter.max(MAX_DIALOGUE_SEGMENTS),
  usage: usageRecordSchema,
})
export type DialogueEnd = z.infer<typeof dialogueEndSchema>

export const dialogueOutcomeSchema = z
  .strictObject({
    segments: z.array(dialogueSegmentSchema).max(MAX_DIALOGUE_SEGMENTS),
    end: dialogueEndSchema,
  })
  .superRefine((value, context) => {
    value.segments.forEach((segment, position) => {
      if (segment.index !== position) {
        context.addIssue({
          code: 'custom',
          message: `segment index ${segment.index} must equal its position ${position}`,
        })
      }
    })
    if (value.end.segmentCount !== value.segments.length) {
      context.addIssue({
        code: 'custom',
        message: 'dialogue end segmentCount must equal the number of emitted segments',
      })
    }
  })
export type DialogueOutcome = z.infer<typeof dialogueOutcomeSchema>

/** C3 — DecisionRequest and DecisionResult (M5 <-> M3). */

export const decisionRequestSchema = z.strictObject({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  snapshotRevision: counter,
  capabilityRevision: counter,
  task: z.literal('segment-reaction'),
  segmentText: z.string().min(1),
  personaSummary: z.string(),
  interactionState: z.string(),
  eligibleActionIds: z.array(actionIdSchema).min(1),
  deadline: deadlineSchema,
  policyVersion: nonEmptyString,
  providerVersion: nonEmptyString,
})
export type DecisionRequest = z.infer<typeof decisionRequestSchema>

export const decisionResultSchema = z
  .strictObject({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    turnId: nonEmptyString,
    segmentId: nonEmptyString,
    snapshotRevision: counter,
    capabilityRevision: counter,
    status: decisionStatusSchema,
    actionId: actionIdSchema.nullable(),
    provider: nonEmptyString,
    modelVersion: nonEmptyString,
    reasonCode: nonEmptyString,
    confidence: z.number().min(0).max(1).nullable(),
    usage: usageRecordSchema,
  })
  .superRefine((value, context) => {
    if (value.status === 'selected' && value.actionId === null) {
      context.addIssue({ code: 'custom', message: 'selected decision requires an action id' })
    }
    if (value.status !== 'selected' && value.actionId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'abstained or failed decision must not carry an action id',
      })
    }
  })
export type DecisionResult = z.infer<typeof decisionResultSchema>

/** C4 — CapabilitySnapshot (M1 -> M5 -> M3). */

export const parameterBoundSchema = z.strictObject({
  name: nonEmptyString,
  minimum: z.number(),
  maximum: z.number(),
})

export const capabilityActionSchema = z.strictObject({
  actionId: actionIdSchema,
  description: z.string(),
  observability: observabilitySchema,
  parameterBounds: z.array(parameterBoundSchema),
})
export type CapabilityAction = z.infer<typeof capabilityActionSchema>

export const capabilitySnapshotSchema = z
  .strictObject({
    rendererId: nonEmptyString,
    characterId: nonEmptyString,
    capabilityRevision: counter,
    actions: z.array(capabilityActionSchema),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const action of value.actions) {
      if (seen.has(action.actionId)) {
        context.addIssue({ code: 'custom', message: `duplicate action id ${action.actionId}` })
      }
      seen.add(action.actionId)
    }
  })
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>

/** M1 player status evidence used to prove idle/cancellation state. */
export const playerStatusSchema = z.strictObject({
  idle: z.boolean(),
  activeOutputId: z.string().min(1).nullable(),
  lastStage: receiptStageSchema.nullable(),
})
export type PlayerStatus = z.infer<typeof playerStatusSchema>

/** C5 — PreparePerformance, PerformanceCommand and PerformanceReceipt (M5 <-> M1). */

export const preparePerformanceSchema = z.strictObject({
  requestId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  text: z.string().min(1),
  voiceProfileId: nonEmptyString,
  voiceProfileVersion: nonEmptyString,
  deadline: deadlineSchema,
})
export type PreparePerformance = z.infer<typeof preparePerformanceSchema>

export const audioTimingSchema = z.strictObject({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
})

export const preparedAudioSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    turnId: nonEmptyString,
    segmentId: nonEmptyString,
    audioRef: nonEmptyString,
    format: nonEmptyString,
    durationMs: z.number().nonnegative().nullable(),
    timing: audioTimingSchema.nullable(),
  }),
  z.strictObject({
    ok: z.literal(false),
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    epoch: counter,
    turnId: nonEmptyString,
    segmentId: nonEmptyString,
    reasonCode: nonEmptyString,
    message: z.string(),
  }),
])
export type PreparedAudio = z.infer<typeof preparedAudioSchema>

export const performanceCommandSchema = z.strictObject({
  outputId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  audioRef: nonEmptyString,
  subtitleText: z.string().min(1),
  actionId: actionIdSchema,
  capabilityRevision: counter,
})
export type PerformanceCommand = z.infer<typeof performanceCommandSchema>

export const performanceReceiptSchema = z.strictObject({
  receiptId: nonEmptyString,
  outputId: nonEmptyString,
  sessionId: nonEmptyString,
  epoch: counter,
  turnId: nonEmptyString,
  segmentId: nonEmptyString,
  modality: modalitySchema,
  stage: receiptStageSchema,
  localTimeMs: z.number().nonnegative().nullable(),
  chunkIds: z.array(nonEmptyString).nullable(),
  reasonCode: nonEmptyString.nullable(),
  source: nonEmptyString,
})
export type PerformanceReceipt = z.infer<typeof performanceReceiptSchema>

export const performanceCancelSchema = z.strictObject({
  requestId: nonEmptyString,
  revokedEpoch: counter,
  newEpoch: counter,
})
export type PerformanceCancel = z.infer<typeof performanceCancelSchema>
