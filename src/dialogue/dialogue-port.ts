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
import { replyLinesForIntent, resolveCharacterProfile } from './persona'

/**
 * Dialogue generation.
 *
 * Generation completion is NOT audio completion. Nothing emitted here enters
 * spoken history; only M5's CommitDelivery, backed by M1's playback receipt,
 * can do that. See ./memory-commit.
 */

export const DEFAULT_DIALOGUE_MODEL_VERSION = 'dialogue-v1'

/**
 * Text source boundary. M4-01 supplies a deterministic table; M4-02 supplies a
 * provider-backed implementation. Everything else in this module is unchanged
 * by that swap.
 */
export interface DialogueTextSource {
  /** Requested model identity reported in usage and on each segment. */
  readonly model: string
  readonly modelVersion: string
  /** Concrete model that served the call, or null when unknown. */
  readonly resolvedModel: string | null
  compose(view: AssembledDialogueContext, maxSegments: number): Promise<readonly string[]>
}

export function createIntentTextSource(): DialogueTextSource {
  return {
    model: FIXTURE_DIALOGUE_MODEL,
    modelVersion: FIXTURE_DIALOGUE_MODEL_VERSION,
    resolvedModel: FIXTURE_DIALOGUE_MODEL,
    async compose(view, maxSegments) {
      return replyLinesForIntent(view.replyIntent).slice(0, Math.max(0, maxSegments))
    },
  }
}

export interface DialoguePortOptions {
  /**
   * Injected clock, required.
   *
   * `CallContext.deadline` is expressed in the injected clock's domain, not in
   * wall-clock time. A silently defaulted clock would compare wall-clock
   * milliseconds against a fixture deadline such as `atMs: 60_000` and report
   * every request as expired. There is deliberately no fallback: callers must
   * supply the same clock the deadline was produced with.
   */
  clock: ClockPort
  /** M6 history source. Omitted means no confirmed history is available. */
  history?: HistoryQueryPort
  textSource?: DialogueTextSource
  /** Never exceeds MAX_DIALOGUE_SEGMENTS regardless of the supplied value. */
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
       * Deadline handling (in scope for M4-01).
       *
       * Two independent stop conditions are honoured at every segment boundary:
       *   1. `context.signal.aborted` — M5 revoked the turn (Stop or epoch
       *      change). Reported with usage status 'cancelled'.
       *   2. `context.deadline.atMs` — the server-owned deadline has passed.
       *      Reported with usage status 'timeout'.
       * Both produce DialogueEnd status 'cancelled' because the end-status enum
       * has no timeout member; the usage status carries the distinction.
       * Segments already emitted stay emitted: M4 reports what it produced and
       * never rewrites history.
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
        // An unknown persona is reported as a failure. Substituting a default
        // would claim a character the operator never selected.
        return buildEnd(request, 'failed', 0, startedAtMs, 'failed')
      }

      const view = await assembleDialogueContext({
        request,
        profile,
        ...(options.history === undefined ? {} : { history: options.history }),
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
         * No-speech discipline: text without a letter or digit is not speech, so
         * it is dropped before the sink is invoked. Generation stops here — a
         * pause is not a following segment, and continuing would emit content
         * past a deliberate silence.
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
