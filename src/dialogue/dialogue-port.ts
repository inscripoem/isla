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
import type { PersonaRecallPort } from './persona-recall'
import type { DeliveryRecallPort } from './memory-recall'
import type { AudienceIdentity } from './audience'
import { createFinalizedSegmentRegistry, deriveSegmentId } from './segment-id'
import { isSubstantiveSpeech, normalizeFinalText } from './text'
import { buildDialogueUsage } from './usage'
import { FIXTURE_DIALOGUE_MODEL, FIXTURE_DIALOGUE_MODEL_VERSION } from './usage'
import { resolveCharacterProfile } from './persona'
import type { MemoryEntrySource } from './context'

/**
 * Dialogue generation.
 *
 * Generation complete is not audio playback complete. What is emitted here does
 * not enter spoken history; only an M5 CommitDelivery backed by an M1 playback
 * receipt can do that. See ./memory-commit.
 */

export const DEFAULT_DIALOGUE_MODEL_VERSION = 'dialogue-v1'

/**
 * Text source boundary. M4-01 supplies a deterministic table; M4-02 supplies an
 * implementation backed by a model service. Replacing the text source leaves the
 * rest of this module unchanged.
 */
export interface DialogueTextSource {
  /** Requested model identity, recorded in usage and on every segment. */
  readonly model: string
  readonly modelVersion: string
  /** Model that actually served the call; null when unknown. */
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
       * Reply templates come from the resolved character rather than a module-level
       * table: the authored persona has to speak its own lines. An empty array
       * stays empty; a character with nothing to say produces a voiceless result,
       * and no filler line is ever invented here.
       */
      return view.replyTemplates.slice(0, Math.max(0, maxSegments))
    },
  }
}

export interface DialoguePortOptions {
  /**
   * Time source. Required.
   *
   * `CallContext.deadline` lives in the injected clock's domain, not wall-clock
   * time. Silently defaulting to a clock would compare wall-clock milliseconds
   * against a fixture deadline such as `atMs: 60_000` and report every request as
   * already expired. There is deliberately no fallback: the caller must pass the
   * same clock that produced the generation deadline.
   */
  clock: ClockPort
  /**
   * Durable history source (M6). When supplied it is AUTHORITATIVE and defines the
   * records context is built from. Omitted means there is no durable history and
   * only a local stand-in is available.
   */
  history?: HistoryQueryPort
  /**
   * Local record source. It is used as the record source only when no durable
   * `history` was supplied - see `assembleDialogueContext`. Persona attribution
   * travels on the persisted delivery itself, so this side no longer carries a
   * separate version map.
   */
  memory?: MemoryEntrySource
  /**
   * Persona fact recall. Omitted means no recall, equivalent to
   * `PERSONA_RECALL_POLICY = 'off'`. The recall block shares one character budget
   * with confirmed history, see ./persona-recall.
   */
  personaRecall?: PersonaRecallPort
  /**
   * Delivery-memory recall over confirmed turns that aged out of the recency
   * window. Adds no I/O (candidates are already loaded during assembly) and no
   * model call; see ./memory-recall. Omitted means no delivery recall.
   */
  deliveryRecall?: DeliveryRecallPort
  /** Validated M5 archive sessions authorized for cross-session recall. */
  explicitlySelectedSessionIds?: readonly string[]
  /**
   * Who is listening (./audience). Omitted means anonymous.
   *
   * Anonymous is the safe default on purpose: an unidentified listener produces
   * session-scoped memory only, so a caller that has not wired an identity yet
   * gets the conservative behaviour rather than durable retention by accident.
   * See `mayRecallCandidate` in ./memory-recall for what this gates.
   */
  audience?: AudienceIdentity
  textSource?: DialogueTextSource
  /** Clamped to MAX_DIALOGUE_SEGMENTS whatever value is passed. */
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
       * Deadline handling, which is in M4-01 scope.
       *
       * Two independent stop conditions are checked at every segment boundary:
       *   1. `context.signal.aborted` - M5 revoked the turn (stop or epoch change);
       *      the usage status reports 'cancelled'.
       *   2. `context.deadline.atMs` - the server-owned deadline has passed; the
       *      usage status reports 'timeout'.
       * Both end as DialogueEnd status 'cancelled', because the end-status enum has
       * no timeout member; the usage status distinguishes the two causes. Segments
       * already emitted are untouched: M4 reports what was produced and never
       * rewrites history.
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
        // An unknown character reports failure. Substituting a default character
        // would impersonate one the operator never selected.
        return buildEnd(request, 'failed', 0, startedAtMs, 'failed')
      }

      const view = await assembleDialogueContext({
        request,
        profile,
        ...(options.history === undefined ? {} : { history: options.history }),
        ...(options.memory === undefined ? {} : { memory: options.memory }),
        ...(options.personaRecall === undefined ? {} : { personaRecall: options.personaRecall }),
        ...(options.deliveryRecall === undefined ? {} : { deliveryRecall: options.deliveryRecall }),
        ...(options.audience === undefined ? {} : { audience: options.audience }),
        ...(options.explicitlySelectedSessionIds === undefined
          ? {}
          : { explicitlySelectedSessionIds: options.explicitlySelectedSessionIds }),
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
         * No-speech constraint: text with no letter or digit is not speech, so it is
         * dropped before the sink is called. Generation stops here - a pause is not a
         * later segment, and continuing would step past an intentional silence and
         * emit more content.
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
