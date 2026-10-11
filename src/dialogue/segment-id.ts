import type { DialogueRequest } from '../contracts'

/**
 * 片段身份与最终文本注册表。
 *
 * 身份规则：片段由所属回合及其在回合中的位置确定。请求 ID 特意不参与身份，
 * 因为同一回合可能重新生成，而片段在整个回合期间必须保持稳定身份。
 *
 * 如果身份规则需要调整，只修改 `deriveSegmentId` 即可；所有调用方都通过
 * 该函数生成片段 ID。
 */
export function deriveSegmentId(request: DialogueRequest, index: number): string {
  return `${request.turnId}-seg-${index}`
}

export interface FinalizedSegmentRegistry {
  /** 片段此前已确定的文本；从未见过该片段时返回 null。 */
  finalizedText(segmentId: string): string | null
  /**
   * 注册候选文本，并返回该片段的权威文本。之后出现的不同候选文本会被忽略而
   * 不会应用，因此不可变性是结构性保证，而不是偶然结果。
   */
  finalize(segmentId: string, text: string): string
}

export function createFinalizedSegmentRegistry(): FinalizedSegmentRegistry {
  const finalized = new Map<string, string>()
  return {
    finalizedText: (segmentId) => finalized.get(segmentId) ?? null,
    finalize: (segmentId, text) => {
      const existing = finalized.get(segmentId)
      if (existing !== undefined) return existing
      finalized.set(segmentId, text)
      return text
    },
  }
}
