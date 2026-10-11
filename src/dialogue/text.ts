/**
 * 有效语音判断与最终文本规范化。
 *
 * M4 负责决定是否存在语音内容。不含字母或数字的最终片段不属于语音。
 * 调用方必须在调用 DialogueSink 之前过滤此类文本；先发出再丢弃仍会使其
 * 成为已生成文本，这正是该不变量禁止的行为。
 *
 * 下方模式与 `dialogue-substantive` 一致性断言保持一致；如果任一方变化，
 * 另一方也必须同步调整。
 */

const SUBSTANTIVE_PATTERN = /\p{L}|\p{N}/u

/** 当文本至少包含一个字母或数字时返回 true。 */
export function isSubstantiveSpeech(text: string): boolean {
  return SUBSTANTIVE_PATTERN.test(text)
}

/**
 * 在最终确定候选文本前进行规范化。这里只移除首尾空白，不改写实际说出的内容。
 */
export function normalizeFinalText(text: string): string {
  return text.trim()
}
