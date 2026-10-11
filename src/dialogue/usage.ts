import type { UsageRecord } from '../contracts'

/**
 * 对话用量报告。
 *
 * 用量信息必须真实：M4-01 不调用模型，因此 token 数量报告为 null，
 * `usageMissing` 为 true。M4-02 通过同一个构造器提供实测数量；如果提供方
 * 没有返回数量，则保持 `usageMissing` 为 true，而不是臆造数字。
 */

export const DIALOGUE_PROVIDER = 'isla-dialogue'

/** 确定性 M4-01 文本源报告的模型身份。 */
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
