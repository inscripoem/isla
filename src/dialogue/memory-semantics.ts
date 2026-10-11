import type { ConfirmedDelivery, DeliveryClassification, Modality } from '../contracts'
import { isSubstantiveSpeech } from './text'

/**
 * M4 记忆语义：哪些内容算作已说出口、哪些内容只能进入审计视图，以及在
 * 有界上下文中按什么顺序丢弃带版本的记忆。
 *
 * 权限划分——修改本文件前请先阅读。
 *   M5 决定如何对一次交付进行分类。M4 不会升级、降级或“修正”分类。M4 负责
 *   准入：给定一条记录，决定它是否可以进入口述历史，并被回忆为听众确实听到
 *   的内容。拒绝一项声明并不违背 M5 的分类，而是拒绝记住缺乏证据的内容。
 *
 * FR-02 依赖本文件。如果缺乏播放证据的记录进入口述历史，后续每次回复都可能
 * 引用听众从未听到的话，而且只有当人发现角色记住了它从未说过的内容时，错误
 * 才会暴露。
 */

/**
 * `spoken` —— 可以进入确认历史，并在后续上下文中被回忆。
 * `audit-only` —— 仅为追踪而保留，绝不回忆，也不汇总到上下文中。
 *                “听众可能听到了”不等于记忆。
 */
export type MemoryBucket = 'spoken' | 'audit-only'

export type MemoryBucketReason =
  | 'delivered-with-receipt'
  | 'delivered-without-receipt'
  | 'not-fully-delivered'
  | 'empty-text'

export interface MemoryBucketDecision {
  bucket: MemoryBucket
  reason: MemoryBucketReason
}

/**
 * 策略——音频必须有播放证据才能算作已说出口。
 *
 * M1 的 receipt 是声音确实播放过的唯一证据；M5 的分类建立在该证据之上。因此，
 * 没有 receipt 的 `fully-delivered` 音频记录只有声明而没有证据，必须暂缓进入
 * 记忆。
 *
 * 如需放宽策略，只改这里：
 *   1. 'required' —— 每条 fully-delivered 记录都需要 receiptId。
 *   2. 'required-for-audio' —— 音频需要 receipt；字幕和头像是展示而非播放，
 *                              因此不需要（默认值）。
 *   3. 'preferred' —— 信任 M5 的分类，receipt 只作为元数据；仅当确认 M5 会漏记
 *                    真实播放音频的 receipt 时才选择此项。
 * 无论选择哪项，`not-fully-delivered` 都只能进入审计视图；这是 FR-02 的要求，
 * 不是可调策略。
 */
export type SpokenReceiptPolicy = 'required' | 'required-for-audio' | 'preferred'
export const SPOKEN_RECEIPT_POLICY: SpokenReceiptPolicy = 'required-for-audio'

function hasReceipt(record: ConfirmedDelivery): boolean {
  const receiptId = record.receiptId
  return typeof receiptId === 'string' && receiptId.length > 0
}

/**
 * 决定一条记录是否准入。
 *
 * 以下顺序是有意保持保守：
 *   1. 除 `fully-delivered` 外全部排除——部分交付或从未交付的文本不是记忆；
 *   2. 不含字母或数字的文本排除——没有可听见的内容；
 *   3. 没有 receipt 的音频排除——只有声明，没有证明。
 */
export function classifyMemoryBucket(record: ConfirmedDelivery): MemoryBucketDecision {
  if (record.classification !== 'fully-delivered') {
    return { bucket: 'audit-only', reason: 'not-fully-delivered' }
  }
  if (!isSubstantiveSpeech(record.text)) {
    return { bucket: 'audit-only', reason: 'empty-text' }
  }
  if (SPOKEN_RECEIPT_POLICY !== 'preferred') {
    const needsReceipt = SPOKEN_RECEIPT_POLICY === 'required' || record.modality === 'audio'
    if (needsReceipt && !hasReceipt(record)) {
      return { bucket: 'audit-only', reason: 'delivered-without-receipt' }
    }
  }
  return { bucket: 'spoken', reason: 'delivered-with-receipt' }
}

/**
 * 哪些分类可以进入口述历史。
 *
 * `fully-delivered` —— 按上方 receipt 策略决定是否准入。
 * `partial-unknown` —— 永不准入。播放可能开始后中断，回忆它会把半句话重新
 *                       当作完整陈述。
 * `not-delivered` —— 永不准入。
 *
 * 冲突会冻结记录：既不准入，也不覆盖。被冻结的记录只能在审计视图中看到。
 */
export const SPOKEN_ADMISSION: Readonly<
  Record<DeliveryClassification, 'admitted' | 'audit-only'>
> = {
  'fully-delivered': 'admitted',
  'partial-unknown': 'audit-only',
  'not-delivered': 'audit-only',
}

/* -------------------------------------------------------------------------- */
/* 被中断的语音                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 表示陈述结束的字符。用于检测在句中停止的发言：完整交付文本不等于句子完整，
 * 上下文不能把被截断的片段呈现为听众已经听完整的想法。
 */
const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？'])

/** 可能跟在终止符后的引号和括号，例如 `He said "hello."`。 */
const SENTENCE_CLOSERS = new Set(['”', '"', "'", ')', ']', '】', '」'])

/** 移除末尾闭合符，使 `"hello."` 按真实句末判断。 */
function stripClosers(text: string): string {
  let end = text.length
  while (end > 0 && SENTENCE_CLOSERS.has(text.charAt(end - 1))) {
    end -= 1
  }
  return text.slice(0, end)
}

/**
 * 当文本结尾没有结束句子时返回 true。
 *
 * 这是启发式判断而非语法分析：目的是让组装逻辑标记片段，而不是把它呈现为
 * 完整内容。假阴性会导致缺少标记，但不是正确性错误；假阳性只会多加一个标记。
 */
export function isTruncatedSpeech(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  const body = stripClosers(trimmed)
  if (body.length === 0) return false
  const last = body.charAt(body.length - 1)
  return !SENTENCE_TERMINATORS.has(last)
}

/* -------------------------------------------------------------------------- */
/* 带版本的记忆与裁剪                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 同一片段被多次确认时的模态优先级（例如音频和字幕）。上下文只保留其中一个；
 * 同时展示两者会重复计算同一段话，并增加字符预算。
 */
export const MODALITY_PREFERENCE: readonly Modality[] = ['audio', 'subtitle', 'avatar']

export function modalityRank(modality: Modality): number {
  const index = MODALITY_PREFERENCE.indexOf(modality)
  return index === -1 ? MODALITY_PREFERENCE.length : index
}

/**
 * 裁剪类别，顺序从“最先丢弃”到“最后丢弃”。
 *
 * 记忆有两种版本信息，预算紧张时都会影响保留结果：
 *   - 角色版本：记录知道是哪一个角色说的。旧角色说过的话仍是听众听到的内容，
 *     因此不会立即删除；空间不足时才优先删除，因为当前角色的连续性更重要。
 *   - 截断状态：被中断的片段连续性低于完整陈述，因此先于完整陈述被删除。
 */
export type TrimClass =
  | 'stale-persona-truncated'
  | 'stale-persona'
  | 'truncated'
  | 'current-persona'

export const TRIM_ORDER: readonly TrimClass[] = [
  'stale-persona-truncated',
  'stale-persona',
  'truncated',
  'current-persona',
]

export interface TrimInput {
  /** 生成记录时使用的角色版本；未知时为 null。 */
  personaVersion: string | null
  /** 当前正在组装的回合所使用的角色版本。 */
  activePersonaVersion: string | null
  truncated: boolean
}

/**
 * 未知角色版本按当前版本处理，而不是按过期版本处理：M4 无法证明记录过旧，
 * 删除它会静默缩短角色对实际说过内容的记忆。
 */
export function trimClassOf(input: TrimInput): TrimClass {
  const stale =
    input.personaVersion !== null &&
    input.activePersonaVersion !== null &&
    input.personaVersion !== input.activePersonaVersion

  if (stale && input.truncated) return 'stale-persona-truncated'
  if (stale) return 'stale-persona'
  if (input.truncated) return 'truncated'
  return 'current-persona'
}

export function trimRank(input: TrimInput): number {
  const index = TRIM_ORDER.indexOf(trimClassOf(input))
  return index === -1 ? TRIM_ORDER.length : index
}

/**
 * 策略——有界上下文裁剪。
 *
 * `alwaysKeepMostRecent` 是保护措施：即使单个回合超过字符预算，也保留最新回合。
 * 全部删除会让角色失去仍在进行主题的记忆，表现为失忆，而不是上下文窗口被截断。
 */
export const MEMORY_TRIM_POLICY = {
  dropOrder: TRIM_ORDER,
  alwaysKeepMostRecent: true,
} as const
