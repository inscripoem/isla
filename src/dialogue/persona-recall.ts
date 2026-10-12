/**
 * 人设事实的按需召回 —— **接口与开关**，实现留到 L3。
 *
 * 为什么先落接缝而不落实现：
 *   1. 接口形状一旦在 M4-01 定型，NFR-03 的 A/B 归因口径就固定下来 —— 先有
 *      「召回开 / 关」这个轴，才谈得上比较召回对角色一致性的贡献。
 *   2. 开关默认 `off`，因此现有行为一字不变：不召回时上下文与今天完全相同，
 *      38 项测试不受影响。
 *
 * 为什么与交付记忆分开：
 *   - 交付记忆是**证据**（她说过什么），必须过 FR-02 准入、走 `MemoryCommitPort`。
 *   - 人设事实是**规范**（她是谁），来自角色设定集，不存在「听众有没有听到」，
 *     因此**不过准入、不进 `confirmedHistory`、不声称「她说过」**。
 *   两者可以共用检索机制，但数据源必须分离。
 *
 * 硬约束（实现时必须遵守）：
 *   - 与 `standingFacts` 去重：已经每轮常驻的事实不再召回。
 *   - **不另开预算**：召回段与已确认历史共用 `contextLimits.maxCharacters`，
 *     召回越多，历史留下的空间越少。
 *   - 每条召回项必须带 provenance（来自设定集哪一条），使评审可以回溯。
 */

/** 召回策略。默认 `off`，便于 A/B 与 NFR-03 归因。 */
export type PersonaRecallPolicy = 'off' | 'keyword'

export const PERSONA_RECALL_POLICY: PersonaRecallPolicy = 'off'

/**
 * 单次召回最多注入的事实条数。
 *
 * 与 `MAX_STANDING_FACTS` 同量级：常驻块已经占了预算的一大块，召回块再大就会
 * 挤掉本应支持的近期对话。
 */
export const MAX_RECALLED_FACTS = 5

/** 一条可召回的人设事实。`id` 必须能在角色设定集中找到，便于防漂移。 */
export interface PersonaFact {
  /** 稳定标识，用于去重与 provenance 渲染。 */
  id: string
  /** 事实文本，渲染进提示词。 */
  text: string
  /** 触发关键词；本轮消息或近期历史命中即加分。 */
  keywords: readonly string[]
  /** 命中这些意图时加分。 */
  intents?: readonly string[]
}

/** 召回结果，附带 provenance。 */
export interface RecalledFact {
  fact: PersonaFact
  score: number
}

/** 召回输入：只看本轮消息、近期历史与意图，不额外调用模型。 */
export interface PersonaRecallRequest {
  inputText: string
  recentHistory: readonly string[]
  replyIntent: string
  /** 已经常驻的事实文本，用于去重。 */
  standingFacts: readonly string[]
}

/**
 * 人设事实来源与召回器。
 *
 * 实现应为**确定性打分**，不额外调用模型：零延迟、零成本、可复现（NFR-03 人工
 * 评估需要）、离线可测，并避开校园网关的限流。将来若换 LLM/embedding 实现，
 * 接口不变。
 */
export interface PersonaRecallPort {
  recall(request: PersonaRecallRequest): readonly RecalledFact[]
}

/**
 * `off` 策略下的空召回器。
 *
 * 返回空结果而不是抛错：调用方不需要为「召回未启用」写分支，上下文组装保持
 * 单一代码路径。
 */
export function createDisabledPersonaRecall(): PersonaRecallPort {
  return {
    recall() {
      return []
    },
  }
}
