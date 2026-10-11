import type { UsageRecord } from '../contracts'

/**
 * Dialogue usage reporting.
 *
 * Usage must stay honest: M4-01 performs no model call, so token counts are
 * reported as null and `usageMissing` is true. M4-02 supplies measured counts
 * through the same builder; a provider that returns no counts keeps
 * `usageMissing` true rather than imputing numbers.
 */

export const DIALOGUE_PROVIDER = 'isla-dialogue'

/** Model identity reported by the deterministic M4-01 text source. */
export const FIXTURE_DIALOGUE_MODEL = 'fixture-v1'
export const FIXTURE_DIALOGUE_MODEL_VERSION = 'fixture-v1'

export interface DialogueUsageInput {
  requestId: string
  elapsedMs: number
  status: UsageRecord['status']
  provider?: string
  requestedModel?: string
  resolvedModel?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  pricingRef?: string | null
}

export function buildDialogueUsage(input: DialogueUsageInput): UsageRecord {
  const inputTokens = input.inputTokens ?? null
  const outputTokens = input.outputTokens ?? null
  return {
    provider: input.provider ?? DIALOGUE_PROVIDER,
    requestedModel: input.requestedModel ?? FIXTURE_DIALOGUE_MODEL,
    resolvedModel: input.resolvedModel ?? null,
    requestId: input.requestId,
    inputTokens,
    outputTokens,
    usageMissing: inputTokens === null || outputTokens === null,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    status: input.status,
    pricingRef: input.pricingRef ?? null,
  }
}
