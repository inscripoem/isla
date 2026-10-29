import type {
  CallContext,
  ClockPort,
  SelectionPort,
  SelectionRequest,
  SelectionResult,
} from '../contracts'
import { selectionResultSchema } from '../contracts'

/**
 * M3's minimal deterministic response-plan rule.
 *
 * This is the M3-01 prerequisite needed for offline execution, not a general
 * model adapter. The caller owns eligibility, deadline expiry and fallback
 * authority; this port only performs a local rule over the candidates it was
 * offered. It deliberately has no provider call, retry or label input.
 */

export type SelectionCallErrorCode =
  | 'aborted'
  | 'deadline-exceeded'
  | 'invalid-deadline'

/** A local call-boundary failure, not a SelectionResult and not a fallback. */
export class SelectionCallError extends Error {
  readonly code: SelectionCallErrorCode

  constructor(code: SelectionCallErrorCode, message: string) {
    super(message)
    this.name = 'SelectionCallError'
    this.code = code
  }
}

export interface RuleSelectionPortOptions {
  /**
   * The exact server clock used to construct SelectionRequest deadlines.
   * A separate clock has a different origin and is therefore invalid here.
   */
  readonly clock: ClockPort
}

export const RULE_SELECTION_PROVIDER = 'm3-rules'
export const RULE_SELECTION_MODEL_VERSION = 'm3-rules-v0.1'

function assertLive(
  request: SelectionRequest,
  context: CallContext,
  clock: ClockPort,
): void {
  const requestAtMs = request.deadline.atMs
  const contextAtMs = context.deadline.atMs
  if (!Number.isFinite(requestAtMs) || !Number.isFinite(contextAtMs)) {
    throw new SelectionCallError(
      'invalid-deadline',
      'selection requires finite request and call deadlines',
    )
  }
  const governingAtMs = Math.min(requestAtMs, contextAtMs)
  if (clock.nowMs() >= governingAtMs) {
    throw new SelectionCallError(
      'deadline-exceeded',
      `selection deadline ${governingAtMs} has expired`,
    )
  }
}

export function createRuleSelectionPort(
  options: RuleSelectionPortOptions,
): SelectionPort {
  if (
    options === null ||
    typeof options !== 'object' ||
    options.clock === null ||
    typeof options.clock !== 'object' ||
    typeof options.clock.nowMs !== 'function'
  ) {
    throw new TypeError('rule selection port requires a ClockPort')
  }
  const { clock } = options

  return {
    async select(
      request: SelectionRequest,
      context: CallContext,
    ): Promise<SelectionResult> {
      if (context.signal.aborted) {
        throw new SelectionCallError(
          'aborted',
          'selection aborted before rule evaluation',
        )
      }
      assertLive(request, context, clock)

      if (request.candidates.length === 0) {
        throw new Error('selection request has no candidates')
      }
      let oldest = request.candidates[0]!
      for (const candidate of request.candidates) {
        if (candidate.receivedAtMs < oldest.receivedAtMs) oldest = candidate
      }

      const replyIntent = request.allowedIntents.includes('answer')
        ? 'answer'
        : request.allowedIntents[0]
      if (replyIntent === undefined) {
        throw new Error('selection request has no allowed intents')
      }

      return selectionResultSchema.parse({
        requestId: request.requestId,
        sessionId: request.sessionId,
        epoch: request.epoch,
        snapshotRevision: request.snapshotRevision,
        disposition: 'respond',
        selectedEventIds: [oldest.eventId],
        replyIntent,
        reasonCode: 'oldest-offered',
        provider: RULE_SELECTION_PROVIDER,
        modelVersion: RULE_SELECTION_MODEL_VERSION,
        usage: {
          provider: RULE_SELECTION_PROVIDER,
          requestedModel: RULE_SELECTION_MODEL_VERSION,
          resolvedModel: RULE_SELECTION_MODEL_VERSION,
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
