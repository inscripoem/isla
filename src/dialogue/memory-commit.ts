import { confirmedDeliverySchema } from '../contracts'
import type {
  CommitDelivery,
  ConfirmedDelivery,
  DeliveryClassification,
  DeliveryCommitAck,
} from '../contracts'
import type { MemoryEntry, MemoryEntrySource } from './context'
import { classifyMemoryBucket } from './memory-semantics'

/**
 * 交付记忆：生成文本只有在这里才能转为口述历史。
 *
 * 权限划分是有意设计的：
 *   - M4 决定生成是否结束（DialogueEnd）。
 *   - M1 决定声音是否实际播放（PerformanceReceipt）。
 *   - M5 决定交付如何分类（CommitDelivery）。
 *   - M4 只保存 M5 交付的结果，绝不升级分类。
 *
 * 将未交付片段保存为已说内容，会使后续回复引用听众从未听到的话，因此下面的
 * 口述投影只接收 `fully-delivered` 记录。
 */

type TerminalOutcome = CommitDelivery['terminalOutcome']

/**
 * 策略——分类与 terminalOutcome 的配对（硬拒绝）。
 *
 * 原因：两个字段必须描述同一个结果。例如 `fully-delivered` + `failed` 是调用方
 * 错误，保存它会把从未播放的片段放入口述历史。
 *
 * M4 负责人已批准将其作为拒绝规则，而不是警告。
 *
 * 如需放宽，只改这里：
 *   1. 完全停止拒绝：将 `DELIVERY_PAIR_POLICY` 设为 'lenient'，`commit()` 将跳过
 *      检查并保存 M5 提供的任何配对。
 *   2. 缩小或扩大规则：编辑 `ALLOWED_DELIVERY_PAIRS`。配对只在该表中定义。
 *   3. 降级为记录警告：将 `commit()` 中的提前返回改为类似冲突的确认；被拒绝的
 *      配对不能复用 'applied' 状态。
 *
 * 无论如何修改，都必须保留 `commit-no-overwrite`：冲突绝不覆盖已有记录，被拒绝
 * 的配对完全不会存储。
 */
export type DeliveryPairPolicy = 'strict' | 'lenient'
export const DELIVERY_PAIR_POLICY: DeliveryPairPolicy = 'strict'

export const ALLOWED_DELIVERY_PAIRS: Readonly<
  Record<DeliveryClassification, readonly TerminalOutcome[]>
> = {
  'fully-delivered': ['completed'],
  'partial-unknown': ['cancelled', 'unknown'],
  'not-delivered': ['failed', 'cancelled', 'unknown'],
}

export function isAllowedDeliveryPair(
  classification: DeliveryClassification,
  terminalOutcome: TerminalOutcome,
): boolean {
  return ALLOWED_DELIVERY_PAIRS[classification].includes(terminalOutcome)
}

/**
 * 已存交付及 M4 在旁边维护的版本元数据。
 *
 * `personaVersion` 是 M4 内部字段：C6 线协议不携带它，M4 也不能为了记住说话者
 * 而向共享契约添加字段。对话端口记录回合使用的角色，下面的提交逻辑按 turnId
 * 查找它。null 表示 M4 没有记录，裁剪逻辑会将其视为当前版本，而不是过期版本。
 */
export interface StoredDelivery {
  delivery: CommitDelivery
  personaVersion: string | null
  /** 到达顺序，仅用于保持审计视图稳定。 */
  seq: number
}

/**
 * 对话端口生成回合时设置，M5 提交该回合交付时读取。保持接口窄化，使提交端口
 * 不依赖完整存储实现。
 */
export interface TurnPersonaSink {
  noteTurnPersona(turnId: string, personaVersion: string): void
}

/**
 * 对话端口需要的记忆能力：带版本的读取端，以及记录回合由哪个角色生成的位置。
 * `createDeliveryMemoryStore()` 同时满足两者；M4-02 可以改用 M6 存储而不改变
 * 此接口。
 */
export type DialogueMemory = MemoryEntrySource & TurnPersonaSink

export interface DeliveryMemoryStore {
  /** 保存一次交付。操作幂等；矛盾输入绝不应用。 */
  commit(delivery: CommitDelivery): Promise<DeliveryCommitAck>
  /** 仅返回口述历史：通过准入规则的记录。 */
  confirmedHistory(sessionId: string): Promise<ConfirmedDelivery[]>
  /** 完整审计视图，包括部分交付和从未交付的记录。 */
  records(): readonly CommitDelivery[]
  /** 带版本元数据的审计视图；作为上下文组装的输入。 */
  audit(): readonly StoredDelivery[]
  /** 提供给 `MemoryEntrySource` 的带版本确认记录。 */
  memoryEntries(sessionId: string): Promise<readonly MemoryEntry[]>
  /** 记住哪个角色生成了某个回合。参见 TurnPersonaSink。 */
  noteTurnPersona(turnId: string, personaVersion: string): void
}

function deliveryRecordKey(delivery: CommitDelivery): string {
  return `${delivery.turnId}:${delivery.segmentId}:${delivery.modality}`
}

function toConfirmedDelivery(delivery: CommitDelivery): ConfirmedDelivery {
  return confirmedDeliverySchema.parse({
    sessionId: delivery.sessionId,
    turnId: delivery.turnId,
    segmentId: delivery.segmentId,
    textHash: delivery.textHash,
    text: delivery.text,
    outputId: delivery.outputId,
    receiptId: delivery.receiptId,
    classification: delivery.classification,
    modality: delivery.modality,
  })
}

function conflictAck(
  existing: CommitDelivery,
  incoming: CommitDelivery,
  key: string,
): DeliveryCommitAck {
  return {
    status: 'conflict',
    recordedClassification: existing.classification,
    incomingClassification: incoming.classification,
    conflictRecordId: `${key}:conflict`,
  }
}

export function createDeliveryMemoryStore(): DeliveryMemoryStore {
  const stored = new Map<string, StoredDelivery>()
  const turnPersona = new Map<string, string>()
  let seq = 0

  return {
    async commit(delivery) {
      if (
        DELIVERY_PAIR_POLICY === 'strict' &&
        !isAllowedDeliveryPair(delivery.classification, delivery.terminalOutcome)
      ) {
        return {
          status: 'failed',
          reasonCode: 'invalid-delivery-pair',
          message:
            `classification ${delivery.classification} is inconsistent with ` +
            `terminal outcome ${delivery.terminalOutcome}`,
        }
      }

      const key = deliveryRecordKey(delivery)
      const existing = stored.get(key)

      if (existing === undefined) {
        stored.set(key, {
          delivery,
          personaVersion: turnPersona.get(delivery.turnId) ?? null,
          seq: seq++,
        })
        return {
          status: 'applied',
          effectiveClassification: delivery.classification,
          recordId: key,
        }
      }

      // 文本哈希变化表示最终文本在稳定的片段身份下发生移动。这违反不可变性，
      // 因此应报告冲突，而不是执行更新。
      if (existing.delivery.textHash !== delivery.textHash) {
        return conflictAck(existing.delivery, delivery, key)
      }

      if (existing.delivery.classification === delivery.classification) {
        return {
          status: 'duplicate',
          effectiveClassification: existing.delivery.classification,
          recordId: key,
        }
      }

      return conflictAck(existing.delivery, delivery, key)
    },

    async confirmedHistory(sessionId) {
      return [...stored.values()]
        .filter((entry) => entry.delivery.sessionId === sessionId)
        .filter((entry) => classifyMemoryBucket(toConfirmedDelivery(entry.delivery)).bucket === 'spoken')
        .map((entry) => toConfirmedDelivery(entry.delivery))
    },

    records() {
      return [...stored.values()].map((entry) => entry.delivery)
    },

    audit() {
      return [...stored.values()].sort((left, right) => left.seq - right.seq)
    },

    async memoryEntries(sessionId) {
      return [...stored.values()]
        .filter((entry) => entry.delivery.sessionId === sessionId)
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => ({ delivery: toConfirmedDelivery(entry.delivery), personaVersion: entry.personaVersion }))
    },

    noteTurnPersona(turnId, personaVersion) {
      turnPersona.set(turnId, personaVersion)
    },
  }
}
