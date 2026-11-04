import type {
  CallContext,
  ClockPort,
  DecisionRequest,
  DecisionResult,
  ReactionPort,
} from '../contracts'
import { NO_OP_ACTION, decisionResultSchema } from '../contracts'

/**
 * M3's minimal deterministic segment-reaction rule.
 *
 * This is the M3-01 prerequisite needed for offline execution, not a general
 * model adapter. The caller owns eligibility, deadline expiry and fallback
 * authority; this port only performs a local rule over the actions it was
 * offered. It deliberately has no provider call, retry or label input.
 */

export type ReactionCallErrorCode =
  | 'REACTION_ABORTED'
  | 'REACTION_DEADLINE_EXCEEDED'
  | 'REACTION_INVALID_OPTIONS'
  | 'REACTION_INVALID_REQUEST'

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

/**
 * The C3 reaction request/decision shapes. These aliases keep the rule port's
 * public vocabulary separate from the frozen contract names while remaining
 * structurally identical to them.
 */
export type ReactionRequest = DecisionRequest
export type ReactionDecision = DecisionResult

const POSITIVE_CUE =
  /\b(thank|thanks|great|happy|awesome|glad|nice|love|welcome|yay)\b/i

type DeadlineExtension = {
  readonly deadlineMs?: number
  readonly deadline?: { readonly atMs?: number }
}

type ContextDeadlineExtension = {
  readonly deadlineMs?: number
  readonly deadline?: { readonly atMs?: number }
}

function requestDeadlineMs(request: ReactionRequest): number | undefined {
  const extended = request as ReactionRequest & DeadlineExtension
  if (typeof extended.deadlineMs === 'number') return extended.deadlineMs
  return extended.deadline?.atMs
}

function contextDeadlineMs(
  context: CallContext | undefined,
): number | undefined {
  if (context === undefined || context === null) return undefined
  const extended = context as CallContext & ContextDeadlineExtension
  if (typeof extended.deadlineMs === 'number') return extended.deadlineMs
  return extended.deadline?.atMs
}

function isAborted(context: CallContext | undefined): boolean {
  return context?.signal?.aborted === true
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen)
  }
  return Object.freeze(value)
}

function chooseReactionActionId(
  request: ReactionRequest,
): { readonly actionId: string; readonly reason: string } {
  const combined = [request.segmentText, request.interactionState ?? ''].join(' ')
  const eligible = request.eligibleActionIds
  if (POSITIVE_CUE.test(combined) && eligible.includes('smile')) {
    return { actionId: 'smile', reason: 'rule:positive-segment-cue' }
  }
  if (eligible.includes('neutral')) {
    return { actionId: 'neutral', reason: 'rule:default-eligible-neutral' }
  }
  const firstNonNoOp = eligible.find((actionId) => actionId !== NO_OP_ACTION)
  if (firstNonNoOp !== undefined) {
    return { actionId: firstNonNoOp, reason: 'rule:first-eligible-action' }
  }
  return { actionId: NO_OP_ACTION, reason: 'rule:no-op-only-eligible' }
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
    throw new ReactionCallError(
      'REACTION_INVALID_OPTIONS',
      'createRuleReactionPort requires a valid ClockPort',
    )
  }
  const { clock } = options

  return {
    async decide(
      request: ReactionRequest,
      context: CallContext,
    ): Promise<ReactionDecision> {
      const startedAtMs = clock.nowMs()
      if (!Number.isFinite(startedAtMs)) {
        throw new ReactionCallError(
          'REACTION_INVALID_OPTIONS',
          'ClockPort.nowMs must return a finite number',
        )
      }

      deepFreeze(request)

      const requestDeadline = requestDeadlineMs(request)
      const contextDeadline = contextDeadlineMs(context)
      if (
        requestDeadline === undefined ||
        !Number.isFinite(requestDeadline) ||
        (contextDeadline !== undefined && !Number.isFinite(contextDeadline))
      ) {
        throw new ReactionCallError(
          'REACTION_INVALID_REQUEST',
          'ReactionRequest deadlineMs and CallContext deadlineMs must be finite numbers',
        )
      }
      const effectiveDeadlineMs =
        contextDeadline === undefined
          ? requestDeadline
          : Math.min(requestDeadline, contextDeadline)

      if (isAborted(context)) {
        throw new ReactionCallError(
          'REACTION_ABORTED',
          'ReactionRequest aborted before decision started',
        )
      }

      if (startedAtMs >= effectiveDeadlineMs) {
        throw new ReactionCallError(
          'REACTION_DEADLINE_EXCEEDED',
          `ReactionRequest deadline exceeded before decision started (now=${startedAtMs}, deadline=${effectiveDeadlineMs})`,
        )
      }

      if (
        !Array.isArray(request.eligibleActionIds) ||
        request.eligibleActionIds.length === 0
      ) {
        throw new ReactionCallError(
          'REACTION_INVALID_REQUEST',
          'ReactionRequest requires at least one eligibleActionId',
        )
      }

      const choice = chooseReactionActionId(request)

      const completedAtMs = clock.nowMs()
      if (!Number.isFinite(completedAtMs)) {
        throw new ReactionCallError(
          'REACTION_INVALID_OPTIONS',
          'ClockPort.nowMs must return a finite number',
        )
      }
      if (isAborted(context)) {
        throw new ReactionCallError('REACTION_ABORTED', 'ReactionRequest aborted')
      }
      if (completedAtMs >= effectiveDeadlineMs) {
        throw new ReactionCallError(
          'REACTION_DEADLINE_EXCEEDED',
          `ReactionRequest deadline exceeded (now=${completedAtMs}, deadline=${effectiveDeadlineMs})`,
        )
      }

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
        reasonCode: choice.reason,
        confidence: null,
        usage: {
          provider: RULE_REACTION_PROVIDER,
          requestedModel: RULE_REACTION_MODEL_VERSION,
          resolvedModel: RULE_REACTION_MODEL_VERSION,
          requestId: request.requestId,
          inputTokens: null,
          outputTokens: null,
          usageMissing: true,
          elapsedMs: 0,
          status: 'ok',
          pricingRef: null,
        },
      })
    },
  }
}
