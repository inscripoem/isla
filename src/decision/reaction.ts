import type {
  CallContext,
  ClockPort,
  DecisionRequest,
  DecisionResult,
  ReactionPort,
} from '../contracts'
import {
  BASE_ACTION_IDS,
  NO_OP_ACTION,
  decisionRequestSchema,
  decisionResultSchema,
} from '../contracts'

/**
 * M3's minimal deterministic segment-reaction rule.
 *
 * This is the M3-01 prerequisite needed for offline execution, not a general
 * model adapter. The caller owns eligibility, deadline expiry and fallback
 * authority; this port only performs a local rule over the actions it was
 * offered. It deliberately has no provider call, retry or label input.
 */

export type ReactionCallErrorCode =
  | 'aborted'
  | 'deadline-exceeded'
  | 'invalid-deadline'
  | 'invalid-request'

/** A local call-boundary failure, not a DecisionResult and not a fallback. */
export class ReactionCallError extends Error {
  readonly code: ReactionCallErrorCode

  constructor(code: ReactionCallErrorCode, message: string) {
    super(message)
    this.name = 'ReactionCallError'
    this.code = code
  }
}

export interface RuleReactionPortOptions {
  /**
   * The exact server clock used to construct DecisionRequest deadlines.
   * A separate clock has a different origin and is therefore invalid here.
   */
  readonly clock: ClockPort
}

export const RULE_REACTION_PROVIDER = 'm3-rules'
export const RULE_REACTION_MODEL_VERSION = 'm3-rules-v0.1'

const SMILE_ACTION = BASE_ACTION_IDS[2]
const NEUTRAL_ACTION = BASE_ACTION_IDS[0]

/**
 * A deterministic lexical-token baseline over `segmentText` only. It matches
 * individual cue words and deliberately does not parse negation, intensity or
 * the surrounding sentiment context; that interpretation belongs to the M3-02
 * model adapters.
 */
const POSITIVE_CUE =
  /\b(thank|thanks|great|happy|awesome|glad|nice|love|welcome|yay)\b/i

function isUsableContext(value: CallContext): boolean {
  const candidate = value as unknown
  if (candidate === null || typeof candidate !== 'object') return false
  const signal = (candidate as { readonly signal?: unknown }).signal
  return signal !== null && typeof signal === 'object'
}

function isUsableRequest(value: DecisionRequest): boolean {
  return value !== null && typeof value === 'object'
}

function isAborted(context: CallContext): boolean {
  return context.signal.aborted === true
}

function chooseReactionActionId(
  request: DecisionRequest,
): { readonly actionId: string; readonly reasonCode: string } {
  const eligible = request.eligibleActionIds
  if (POSITIVE_CUE.test(request.segmentText) && eligible.includes(SMILE_ACTION)) {
    return { actionId: SMILE_ACTION, reasonCode: 'rule:positive-segment-cue' }
  }
  if (eligible.includes(NEUTRAL_ACTION)) {
    return { actionId: NEUTRAL_ACTION, reasonCode: 'rule:default-eligible-neutral' }
  }
  const firstNonNoOp = eligible.find((actionId) => actionId !== NO_OP_ACTION)
  if (firstNonNoOp !== undefined) {
    return { actionId: firstNonNoOp, reasonCode: 'rule:first-eligible-action' }
  }
  return { actionId: NO_OP_ACTION, reasonCode: 'rule:no-op-only-eligible' }
}

export function createRuleReactionPort(
  options: RuleReactionPortOptions,
): ReactionPort {
  if (
    options === null ||
    typeof options !== 'object' ||
    options.clock === null ||
    typeof options.clock !== 'object' ||
    typeof options.clock.nowMs !== 'function'
  ) {
    throw new TypeError('rule reaction port requires a ClockPort')
  }
  const { clock } = options

  return {
    async decide(
      request: DecisionRequest,
      context: CallContext,
    ): Promise<DecisionResult> {
      if (!isUsableContext(context)) {
        throw new ReactionCallError(
          'invalid-request',
          'reaction requires a valid CallContext',
        )
      }
      if (isAborted(context)) {
        throw new ReactionCallError(
          'aborted',
          'reaction aborted before rule evaluation',
        )
      }
      if (!isUsableRequest(request)) {
        throw new ReactionCallError(
          'invalid-request',
          'reaction requires a valid DecisionRequest',
        )
      }

      const startedAtMs = clock.nowMs()
      const requestAtMs = request.deadline?.atMs
      const contextAtMs = context.deadline?.atMs
      if (
        typeof requestAtMs !== 'number' ||
        !Number.isFinite(requestAtMs) ||
        typeof contextAtMs !== 'number' ||
        !Number.isFinite(contextAtMs) ||
        typeof startedAtMs !== 'number' ||
        !Number.isFinite(startedAtMs)
      ) {
        throw new ReactionCallError(
          'invalid-deadline',
          'reaction requires finite request, call and clock deadlines',
        )
      }
      const governingAtMs = Math.min(requestAtMs, contextAtMs)
      if (startedAtMs >= governingAtMs) {
        throw new ReactionCallError(
          'deadline-exceeded',
          `reaction deadline ${governingAtMs} has expired`,
        )
      }

      const parsedRequest = decisionRequestSchema.safeParse(request)
      if (
        !parsedRequest.success ||
        parsedRequest.data.segmentText.trim().length === 0 ||
        parsedRequest.data.eligibleActionIds.some(
          (actionId) => actionId.trim().length === 0,
        )
      ) {
        throw new ReactionCallError(
          'invalid-request',
          'reaction request failed schema validation',
        )
      }

      const choice = chooseReactionActionId(request)

      const completedAtMs = clock.nowMs()
      if (
        typeof completedAtMs !== 'number' ||
        !Number.isFinite(completedAtMs)
      ) {
        throw new ReactionCallError(
          'invalid-deadline',
          'reaction requires finite request, call and clock deadlines',
        )
      }
      if (isAborted(context)) {
        throw new ReactionCallError('aborted', 'reaction aborted')
      }
      if (completedAtMs >= governingAtMs) {
        throw new ReactionCallError(
          'deadline-exceeded',
          `reaction deadline ${governingAtMs} has expired`,
        )
      }

      const elapsedMs = Math.max(0, completedAtMs - startedAtMs)
      return decisionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        turnId: request.turnId,
        segmentId: request.segmentId,
        snapshotRevision: request.snapshotRevision,
        capabilityRevision: request.capabilityRevision,
        status: 'selected',
        actionId: choice.actionId,
        provider: RULE_REACTION_PROVIDER,
        modelVersion: RULE_REACTION_MODEL_VERSION,
        reasonCode: choice.reasonCode,
        confidence: null,
        usage: {
          provider: RULE_REACTION_PROVIDER,
          requestedModel: RULE_REACTION_MODEL_VERSION,
          resolvedModel: RULE_REACTION_MODEL_VERSION,
          requestId: request.requestId,
          inputTokens: null,
          outputTokens: null,
          usageMissing: true,
          elapsedMs,
          status: 'ok',
          pricingRef: null,
        },
      })
    },
  }
}
