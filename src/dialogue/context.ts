import type {
  ConfirmedDelivery,
  DialogueRequest,
  HistoryQueryPort,
  ReplyIntent,
} from '../contracts'
import type { CharacterProfile } from './persona'
import { intentTemplatesFor, personaVersionKey, renderPersonaBlock } from './persona'
import { classifyMemoryBucket, isTruncatedSpeech, modalityRank, trimRank } from './memory-semantics'
import type { MemoryBucketReason } from './memory-semantics'

/**
 * 对话上下文组装。
 *
 * 可以进入上下文的内容：只有听众确实听到的文本。M4 消费 M6 的
 * HistoryQueryPort，该端口已排除部分交付和从未交付的记录；本模块不会扩大
 * 这组记录，还会挡住没有播放证据的交付声明。准入规则见 ./memory-semantics。
 *
 * 绝不能发生的情况：把被中断的半句话呈现为听众已经完整听到的内容。两个保护
 * 条件保证这一点：
 *   1. 准入逻辑丢弃所有未完整交付的记录；
 *   2. 已完整交付但仍在句中结束的发言，会在 `turns` 中标记为 interrupted，
 *      并用显式标记渲染，使读取上下文的模型不会把它当作完整陈述。
 *
 * 已知限制（明确记录而不是隐藏）：`confirmedEventRefs` 携带运行时事件 ID，但
 * 确认记录不暴露事件 ID。因此引用无法直接解析到记录，只能作为排序提示。如果
 * M6 之后提供事件与交付的关联，应替换 `matchesReference`，使提示变为精确过滤。
 */

/** M4 内部使用的已存交付视图，包括其角色版本。 */
export interface MemoryEntry {
  delivery: ConfirmedDelivery
  /**
   * 生成该记录的角色版本；M4 没有记录时为 null。null 按当前版本处理，而不是
   * 按过期版本处理：没有证据不等于可以证明记忆过旧。
   */
  personaVersion: string | null
}

/**
 * HistoryQueryPort 的增强同级接口，暴露 M4 随每次交付维护的版本元数据。可选：
 * 缺少该接口时，组装逻辑回退到 HistoryQueryPort，并将所有记录视为当前角色生成。
 */
export interface MemoryEntrySource {
  memoryEntries(sessionId: string): Promise<readonly MemoryEntry[]>
}

/** 按说话顺序排列的一次确认发言回合。 */
export interface AssembledTurn {
  turnId: string
  /** 回合中的片段，按片段位置排序。 */
  segments: readonly ConfirmedDelivery[]
  /** 拼接后的回合文本。 */
  text: string
  /**
   * 当回合在句中结束时为 true。词语已经交付，但陈述并未完成；上下文不能把它
   * 呈现为完整内容。
   */
  interrupted: boolean
  /** 生成该回合时使用的角色版本；未知时为 null。 */
  personaVersion: string | null
  /** 该回合在上下文预算中预计消耗的字符数。 */
  characters: number
}

export type ContextExclusionReason =
  | MemoryBucketReason
  | 'duplicate-modality'
  | 'turn-limit'
  | 'character-budget'
  | 'trim-stale-persona'
  | 'trim-truncated'

export interface ContextExclusion {
  turnId: string
  segmentId: string
  reason: ContextExclusionReason
}

export interface AssembledDialogueContext {
  /** 已渲染、可直接用于提示词的角色区块。 */
  personaBlock: string
  personaSummary: string
  styleNotes: readonly string[]
  /** 已解析角色针对该意图的台词模板，按说话顺序排列。 */
  replyTemplates: readonly string[]
  selectedInputText: string
  replyIntent: ReplyIntent
  /** 保留在上下文中的确认回合，最旧的在前。 */
  turns: readonly AssembledTurn[]
  /** 扁平且有界的确认历史，供读取记录的调用方使用。 */
  history: readonly ConfirmedDelivery[]
  /** 从上下文中删除的内容及原因。仅用于审计，绝不展示给模型。 */
  exclusions: readonly ContextExclusion[]
  /**
   * 用字符数近似估算成本。这不是实测 token 数量；M4 没有 tokenizer，不能把估算
   * 值伪装成实测值。
   */
  estimatedCharacters: number
  truncatedByTurnLimit: boolean
  truncatedByCharacterLimit: boolean
  warnings: readonly string[]
}

export interface AssembleDialogueContextInput {
  request: DialogueRequest
  profile: CharacterProfile
  /** 没有历史来源时省略；此时上下文不包含历史。 */
  history?: HistoryQueryPort
  /** 可选的带版本来源；优先级高于 `history`。 */
  memory?: MemoryEntrySource
}

function referenceIdentifiers(record: ConfirmedDelivery): readonly string[] {
  return [
    record.turnId,
    record.segmentId,
    record.textHash,
    record.outputId ?? '',
    record.receiptId ?? '',
  ].filter((value) => value.length > 0)
}

function matchesReference(record: ConfirmedDelivery, refs: ReadonlySet<string>): boolean {
  return referenceIdentifiers(record).some((identifier) => refs.has(identifier))
}

function segmentPosition(segmentId: string): number {
  const match = /(\d+)\s*$/.exec(segmentId)
  return match === null ? 0 : Number(match[1])
}

function turnText(segments: readonly ConfirmedDelivery[]): string {
  return segments.map((segment) => segment.text).join(' ')
}

export async function assembleDialogueContext(
  input: AssembleDialogueContextInput,
): Promise<AssembledDialogueContext> {
  const { request, profile, history, memory } = input
  const maxTurns = request.contextLimits.maxTurns
  const maxCharacters = request.contextLimits.maxCharacters

  const raw: readonly MemoryEntry[] =
    memory === undefined
      ? (history === undefined ? [] : await history.confirmedHistory(request.sessionId)).map(
          (delivery) => ({ delivery, personaVersion: null }),
        )
      : await memory.memoryEntries(request.sessionId)

  const exclusions: ContextExclusion[] = []
  const admitted: MemoryEntry[] = []
  for (const entry of raw) {
    const decision = classifyMemoryBucket(entry.delivery)
    if (decision.bucket === 'spoken') {
      admitted.push(entry)
    } else {
      exclusions.push({
        turnId: entry.delivery.turnId,
        segmentId: entry.delivery.segmentId,
        reason: decision.reason,
      })
    }
  }

  /*
   * 一次发言在上下文中只保留一条记录。同时被音频和字幕确认的片段仍是同一句话，
   * 因此删除优先级较低的模态，而不是重复加入。
   */
  const bySegment = new Map<string, MemoryEntry>()
  for (const entry of admitted) {
    const key = `${entry.delivery.turnId}:${entry.delivery.segmentId}`
    const current = bySegment.get(key)
    if (current === undefined) {
      bySegment.set(key, entry)
      continue
    }
    const preferred =
      modalityRank(entry.delivery.modality) < modalityRank(current.delivery.modality)
        ? entry
        : current
    const dropped = preferred === entry ? current : entry
    bySegment.set(key, preferred)
    exclusions.push({
      turnId: dropped.delivery.turnId,
      segmentId: dropped.delivery.segmentId,
      reason: 'duplicate-modality',
    })
  }

  const refs = new Set(request.confirmedEventRefs)
  const ordered = [...bySegment.values()].sort((left, right) => {
    const leftMatched = matchesReference(left.delivery, refs) ? 0 : 1
    const rightMatched = matchesReference(right.delivery, refs) ? 0 : 1
    return leftMatched - rightMatched
  })

  const grouped = new Map<string, MemoryEntry[]>()
  for (const entry of ordered) {
    const bucket = grouped.get(entry.delivery.turnId)
    if (bucket === undefined) grouped.set(entry.delivery.turnId, [entry])
    else bucket.push(entry)
  }

  const allTurns: AssembledTurn[] = [...grouped.entries()].map(([turnId, entries]) => {
    const segments = [...entries]
      .sort((left, right) => segmentPosition(left.delivery.segmentId) - segmentPosition(right.delivery.segmentId))
      .map((entry) => entry.delivery)
    const text = turnText(segments)
    return {
      turnId,
      segments,
      text,
      interrupted: isTruncatedSpeech(text),
      personaVersion: entries[0]?.personaVersion ?? null,
      characters: text.length,
    }
  })

  const recent = maxTurns === 0 ? [] : allTurns.slice(-maxTurns)
  const truncatedByTurnLimit = recent.length < allTurns.length
  for (const turn of allTurns.slice(0, Math.max(0, allTurns.length - recent.length))) {
    for (const segment of turn.segments) {
      exclusions.push({ turnId: turn.turnId, segmentId: segment.segmentId, reason: 'turn-limit' })
    }
  }

  const kept = trimToCharacterBudget({
    turns: recent,
    maxCharacters,
    activePersonaVersion: personaVersionKey(profile.profileId, profile.version),
    exclusions,
  })

  const historyFlat = kept.turns.flatMap((turn) => turn.segments)
  const warnings: string[] = []
  if (refs.size > 0) {
    warnings.push('confirmedEventRefs could not be resolved to records; used as ordering hint only')
  }
  if (kept.turns.some((turn) => turn.interrupted)) {
    warnings.push('context contains an interrupted utterance; it is marked, not completed')
  }

  return {
    personaBlock: renderPersonaBlock(profile),
    personaSummary: profile.personaSummary,
    styleNotes: profile.styleNotes,
    replyTemplates: intentTemplatesFor(profile, request.responsePlan.replyIntent),
    selectedInputText: request.selectedInput.text,
    replyIntent: request.responsePlan.replyIntent,
    turns: kept.turns,
    history: historyFlat,
    exclusions,
    estimatedCharacters: kept.turns.reduce((total, turn) => total + turn.characters, 0),
    truncatedByTurnLimit,
    truncatedByCharacterLimit: kept.truncated,
    warnings,
  }
}

interface TrimResult {
  turns: AssembledTurn[]
  truncated: boolean
}

/**
 * 删除回合，直到满足字符预算。
 *
 * 删除顺序遵循 ./memory-semantics：先删过期角色的片段，再删过期角色回合，
 * 然后删被中断回合，最后删剩余回合中最旧的一个。最新回合永不删除，即使它
 * 单独就超过预算——空上下文表现为失忆，超预算上下文则表现为长记忆。
 */
function trimToCharacterBudget(input: {
  turns: readonly AssembledTurn[]
  maxCharacters: number
  activePersonaVersion: string
  exclusions: ContextExclusion[]
}): TrimResult {
  const { turns, maxCharacters, activePersonaVersion, exclusions } = input
  let dropped = false
  const kept: AssembledTurn[] = [...turns]
  const total = (): number => kept.reduce((sum, turn) => sum + turn.characters, 0)

  while (kept.length > 1 && total() > maxCharacters) {
    const protectedIndex = kept.length - 1
    let victimIndex = -1
    let victimRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < protectedIndex; index += 1) {
      const turn = kept[index]
      if (turn === undefined) continue
      const rank = trimRank({
        personaVersion: turn.personaVersion,
        activePersonaVersion,
        truncated: turn.interrupted,
      })
      // 等级越低越先删除；等级相同时删除数组中更早、也就是更旧的回合。
      if (rank < victimRank) {
        victimRank = rank
        victimIndex = index
      }
    }
    if (victimIndex === -1) break

    const victim = kept[victimIndex]
    if (victim === undefined) break
    kept.splice(victimIndex, 1)
    dropped = true
    for (const segment of victim.segments) {
      exclusions.push({
        turnId: victim.turnId,
        segmentId: segment.segmentId,
        reason:
          victim.personaVersion !== null && victim.personaVersion !== activePersonaVersion
            ? 'trim-stale-persona'
            : victim.interrupted
              ? 'trim-truncated'
              : 'character-budget',
      })
    }
  }

  if (kept.length === 1 && total() > maxCharacters) dropped = true

  return { turns: kept, truncated: dropped }
}

/**
 * 将已组装上下文渲染为提示词区块。
 *
 * 被中断的回合会带有显式标记。没有该标记时，模型会把截断片段当作完整陈述，
 * 并从听众从未听完整的句子继续生成；这正是 NFR-03 角色一致性要捕获的问题。
 */
export function renderDialoguePrompt(view: AssembledDialogueContext): string {
  const lines: string[] = [view.personaBlock]

  if (view.turns.length > 0) {
    lines.push('Already said (confirmed spoken):')
    for (const turn of view.turns) {
      const marker = turn.interrupted ? ' [cut off mid-sentence]' : ''
      lines.push(`- ${turn.text}${marker}`)
    }
  }

  lines.push(`Listener said: ${view.selectedInputText}`)
  lines.push(`Intent: ${view.replyIntent}`)
  if (view.replyTemplates.length > 0) {
    lines.push('Reference lines for this intent:')
    for (const template of view.replyTemplates) lines.push(`- ${template}`)
  }

  return lines.join('\n')
}
