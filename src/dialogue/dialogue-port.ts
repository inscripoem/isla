import { MAX_DIALOGUE_SEGMENTS, dialogueEndSchema, dialogueSegmentSchema } from '../contracts'
import type {
  CallContext,
  ClockPort,
  DialogueEnd,
  DialoguePort,
  DialogueRequest,
  DialogueSegment,
  DialogueSink,
  HistoryQueryPort,
  UsageRecord,
} from '../contracts'
import { assembleDialogueContext } from './context'
import type { AssembledDialogueContext } from './context'
import { createFinalizedSegmentRegistry, deriveSegmentId } from './segment-id'
import { isSubstantiveSpeech, normalizeFinalText } from './text'
import { buildDialogueUsage } from './usage'
import {
  FIXTURE_DIALOGUE_MODEL,
  FIXTURE_DIALOGUE_MODEL_VERSION,
} from './usage'
import { personaVersionKey, resolveCharacterProfile } from './persona'
import type { DialogueMemory } from './memory-commit'

/**
 * 对话生成。
 *
 * 生成完成不等于音频播放完成。这里发出的内容不会进入口述历史；只有由 M1
 * 播放回执支持的 M5 CommitDelivery 才能完成这件事。参见 ./memory-commit。
 */

export const DEFAULT_DIALOGUE_MODEL_VERSION = 'dialogue-v1'

/**
 * 文本源边界。M4-01 提供确定性表格，M4-02 提供由模型服务支持的实现。替换
 * 文本源时，本模块其余部分保持不变。
 */
export interface DialogueTextSource {
  /** 请求的模型身份，会写入用量和每个片段。 */
  readonly model: string
  readonly modelVersion: string
  /** 实际处理调用的模型；未知时为 null。 */
  readonly resolvedModel: string | null
  compose(view: AssembledDialogueContext, maxSegments: number): Promise<readonly string[]>
}

export function createIntentTextSource(): DialogueTextSource {
  return {
    model: FIXTURE_DIALOGUE_MODEL,
    modelVersion: FIXTURE_DIALOGUE_MODEL_VERSION,
    resolvedModel: FIXTURE_DIALOGUE_MODEL,
    async compose(view, maxSegments) {
      /*
       * 台词模板来自已解析的角色，而不是模块级表格：正式角色必须说自己的台词。
       * 空数组保持为空；无话可说的角色产生无语音结果，绝不在这里编造填充台词。
       */
      return view.replyTemplates.slice(0, Math.max(0, maxSegments))
    },
  }
}

export interface DialoguePortOptions {
  /**
   * 必须注入时钟。
   *
   * `CallContext.deadline` 使用注入时钟的时间域，而不是墙上时钟。静默使用默认
   * 时钟会将墙上时钟毫秒值与 `atMs: 60_000` 之类的 fixture 截止时间比较，从而
   * 把每个请求都报告为已过期。这里有意不提供回退；调用方必须传入生成截止时间
   * 时使用的同一个时钟。
   */
  clock: ClockPort
  /** M6 历史来源。省略表示没有可用的确认历史。 */
  history?: HistoryQueryPort
  /**
   * 带版本的记忆。在上下文组装时优先于 `history`，并记录每个生成回合背后的角色，
   * 使裁剪上下文时能够识别由旧角色写入的记忆。
   */
  memory?: DialogueMemory
  textSource?: DialogueTextSource
  /** 无论传入何值，都不会超过 MAX_DIALOGUE_SEGMENTS。 */
  maxSegments?: number
}

function clampMaxSegments(requested: number | undefined): number {
  if (requested === undefined) return MAX_DIALOGUE_SEGMENTS
  return Math.min(Math.max(0, requested), MAX_DIALOGUE_SEGMENTS)
}

export function createDialoguePort(options: DialoguePortOptions): DialoguePort {
  const clock = options.clock
  const source = options.textSource ?? createIntentTextSource()
  const registry = createFinalizedSegmentRegistry()
  const maxSegments = clampMaxSegments(options.maxSegments)

  const buildEnd = (
    request: DialogueRequest,
    status: DialogueEnd['status'],
    segmentCount: number,
    startedAtMs: number,
    usageStatus: UsageRecord['status'],
  ): DialogueEnd =>
    dialogueEndSchema.parse({
      requestId: request.requestId,
      sessionId: request.sessionId,
      epoch: request.epoch,
      turnId: request.turnId,
      status,
      segmentCount,
      usage: buildDialogueUsage({
        requestId: request.requestId,
        elapsedMs: clock.nowMs() - startedAtMs,
        status: usageStatus,
        requestedModel: source.model,
        resolvedModel: source.resolvedModel,
      }),
    })

  return {
    async generate(
      request: DialogueRequest,
      context: CallContext,
      sink: DialogueSink,
    ): Promise<DialogueEnd> {
      const startedAtMs = clock.nowMs()

      /*
       * 截止时间处理（属于 M4-01 范围）。
       *
       * 每个片段边界都会检查两个独立的停止条件：
       *   1. `context.signal.aborted` —— M5 撤销了回合（停止或 epoch 变化），
       *      用量状态报告为 'cancelled'。
       *   2. `context.deadline.atMs` —— 服务端拥有的截止时间已到，用量状态报告
       *      为 'timeout'。
       * 两者的 DialogueEnd 状态都为 'cancelled'，因为结束状态枚举没有 timeout；
       * 用量状态负责区分两种原因。已经发出的片段保持不变：M4 只报告已产生内容，
       * 绝不重写历史。
       */
      const deadlinePassed = (): boolean => clock.nowMs() > context.deadline.atMs

      if (context.signal.aborted) {
        return buildEnd(request, 'cancelled', 0, startedAtMs, 'cancelled')
      }
      if (deadlinePassed()) {
        return buildEnd(request, 'cancelled', 0, startedAtMs, 'timeout')
      }

      const profile = resolveCharacterProfile(
        request.characterProfileId,
        request.characterProfileVersion,
      )
      if (profile === null) {
        // 未知角色报告为失败。替换为默认角色会冒充操作员从未选择的角色。
        return buildEnd(request, 'failed', 0, startedAtMs, 'failed')
      }

      /*
       * 在生成前记录该回合背后的角色，使同一回合稍后提交时能够保存角色版本。
       * 对所说内容的记忆可能长于说话角色本身；裁剪时必须知道两者的对应关系。
       */
      options.memory?.noteTurnPersona(
        request.turnId,
        personaVersionKey(profile.profileId, profile.version),
      )

      const view = await assembleDialogueContext({
        request,
        profile,
        ...(options.history === undefined ? {} : { history: options.history }),
        ...(options.memory === undefined ? {} : { memory: options.memory }),
      })

      const candidates = (await source.compose(view, maxSegments)).slice(0, maxSegments)

      let emitted = 0
      for (const [index, candidate] of candidates.entries()) {
        if (context.signal.aborted) {
          return buildEnd(request, 'cancelled', emitted, startedAtMs, 'cancelled')
        }
        if (deadlinePassed()) {
          return buildEnd(request, 'cancelled', emitted, startedAtMs, 'timeout')
        }

        const text = normalizeFinalText(candidate)
        /*
         * 无语音约束：不含字母或数字的文本不属于语音，因此在调用 sink 前丢弃。
         * 生成在此停止——停顿不是后续片段，继续执行会越过有意设置的静音并发出
         * 更多内容。
         */
        if (!isSubstantiveSpeech(text)) {
          return buildEnd(request, 'completed', emitted, startedAtMs, 'ok')
        }

        const segmentId = deriveSegmentId(request, index)
        const finalizedText = registry.finalize(segmentId, text)

        const segment: DialogueSegment = dialogueSegmentSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          segmentId,
          index,
          text: finalizedText,
          model: source.model,
          modelVersion: source.modelVersion,
        })

        await sink.segment(segment)
        emitted += 1
      }

      return buildEnd(request, 'completed', emitted, startedAtMs, 'ok')
    },
  }
}
