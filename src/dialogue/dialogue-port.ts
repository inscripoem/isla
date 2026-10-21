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
import type { AssembledDialogueContext, AssembledTurn } from './context'
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
   * Recorded owner of a candidate's memory (./memory-recall). The automatic
   * cross-session path refuses a candidate it cannot attribute, so a caller that
   * keeps an owner per record supplies this; a caller whose sessions arrive
   * through `explicitlySelectedSessionIds` does not need it. Nothing in this
   * repository supplies it yet: M6 does not persist an owner field.
   */
  ownerAudienceIdOf?: (turn: AssembledTurn) => string | null
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
  /**
   * Injected diagnostic boundary for generation/discard accounting.
   *
   * M5 owns persistence; M4 never writes to C6 here. This boundary only reports,
   * after each `generate` call, how many segments were produced, how many were
   * actually dispatched to the sink, and how many were dropped and why. It lets
   * an observer see "generated but never dispatched" without that evidence being
   * inferred from `DialogueEnd.segmentCount` alone. Omitted means no reporting.
   */
  onOutcome?: (report: DialogueOutcomeReport) => void
  /**
   * Render `[conflicting]` on turns the consistency scan flagged (see
   * `AssembleDialogueContextInput.markConflictingTurns`).
   *
   * Omitted means audit-only: the scan still runs and its findings still reach
   * `AssembledDialogueContext.conflicts` and `warnings`, but no prompt text is
   * added, so the character budget and the rendered block are unchanged.
   */
  markConflictingTurns?: boolean
}

/**
 * Correlated generation/discard accounting for one `generate` call.
 *
 * This is deterministic, local computation with no provider call (a hard
 * constraint alongside NFR-03 attribution). `generated` is the number of
 * candidates the text source produced; `emitted` is the number actually
 * delivered to the sink; `discarded` is the remainder. The reason counts sum to
 * `discarded` and describe why each candidate never reached the sink.
 */
export interface DialogueOutcomeReport {
  requestId: string
  sessionId: string
  epoch: number
  turnId: string
  /** Candidates produced by the text source for this call. */
  generated: number
  /** Segments actually delivered to the sink. */
  emitted: number
  /** `generated - emitted`; the candidates that never reached the sink. */
  discarded: number
  /** Why candidates were discarded, summing to `discarded`. */
  discards: Readonly<Record<string, number>>
  /** Terminal `DialogueEnd.status` for the call. */
  endStatus: DialogueEnd['status']
  /** Usage status for the call. */
  usageStatus: UsageRecord['status']
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

  const report = (input: {
    request: DialogueRequest
    endStatus: DialogueEnd['status']
    usageStatus: UsageRecord['status']
    generated: number
    emitted: number
    discards: Readonly<Record<string, number>>
  }): void => {
    options.onOutcome?.({
      requestId: input.request.requestId,
      sessionId: input.request.sessionId,
      epoch: input.request.epoch,
      turnId: input.request.turnId,
      generated: input.generated,
      emitted: input.emitted,
      discarded: input.generated - input.emitted,
      discards: input.discards,
      endStatus: input.endStatus,
      usageStatus: input.usageStatus,
    })
  }

  return {
    async generate(
      request: DialogueRequest,
      context: CallContext,
      sink: DialogueSink,
    ): Promise<DialogueEnd> {
      const startedAtMs = clock.nowMs()

      /*
       * Deadline and cancellation handling.
       *
       * Two independent stop conditions are checked at every await boundary:
       *   1. `context.signal.aborted` - M5 revoked the turn (stop or epoch change);
       *      the end status reports 'cancelled' and usage 'cancelled'.
       *   2. `context.deadline.atMs` - the server-owned deadline has passed; the end
       *      status reports 'deadline_exceeded' and usage 'timeout'.
       * The end-status enum (see primitives) now distinguishes the two causes, so a
       * consumer reading `DialogueEnd.status` alone no longer folds a one-ms-off
       * deadline into a Stop. The boundary uses `>=`, aligned with M1's deadline gate.
       * Segments already emitted are untouched: M4 reports what was produced and
       * never rewrites history.
       */
      const deadlinePassed = (): boolean => clock.nowMs() >= context.deadline.atMs

      if (context.signal.aborted) {
        return buildEnd(request, 'cancelled', 0, startedAtMs, 'cancelled')
      }
      if (deadlinePassed()) {
        return buildEnd(request, 'deadline_exceeded', 0, startedAtMs, 'timeout')
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
        ...(options.ownerAudienceIdOf === undefined
          ? {}
          : { ownerAudienceIdOf: options.ownerAudienceIdOf }),
        ...(options.markConflictingTurns === undefined
          ? {}
          : { markConflictingTurns: options.markConflictingTurns }),
      })

      /*
       * Re-check after context assembly: a Stop or deadline that arrived during the
       * awaited assembly must not compose a reply, and must not emit a first segment
       * that the caller will then have to revoke.
       */
      if (context.signal.aborted) {
        return buildEnd(request, 'cancelled', 0, startedAtMs, 'cancelled')
      }
      if (deadlinePassed()) {
        return buildEnd(request, 'deadline_exceeded', 0, startedAtMs, 'timeout')
      }

      const candidates = (await source.compose(view, maxSegments)).slice(0, maxSegments)

      let emitted = 0
      const discards: Record<string, number> = {}

      const discard = (reason: string, count: number): void => {
        if (count > 0) discards[reason] = (discards[reason] ?? 0) + count
      }

      for (const [index, candidate] of candidates.entries()) {
        if (context.signal.aborted) {
          discard('aborted', candidates.length - index)
          report({
            request,
            endStatus: 'cancelled',
            usageStatus: 'cancelled',
            generated: candidates.length,
            emitted,
            discards,
          })
          return buildEnd(request, 'cancelled', emitted, startedAtMs, 'cancelled')
        }
        if (deadlinePassed()) {
          discard('deadline', candidates.length - index)
          report({
            request,
            endStatus: 'deadline_exceeded',
            usageStatus: 'timeout',
            generated: candidates.length,
            emitted,
            discards,
          })
          return buildEnd(request, 'deadline_exceeded', emitted, startedAtMs, 'timeout')
        }

        const text = normalizeFinalText(candidate)
        /*
         * No-speech constraint: text with no letter or digit is not speech, so it is
         * dropped before the sink is called. Generation stops here - a pause is not a
         * later segment, and continuing would step past an intentional silence and
         * emit more content.
         */
        if (!isSubstantiveSpeech(text)) {
          discard('no-speech', 1)
          discard('leftover', candidates.length - index - 1)
          report({
            request,
            endStatus: 'completed',
            usageStatus: 'ok',
            generated: candidates.length,
            emitted,
            discards,
          })
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
        /*
         * Re-check after the await: a Stop arrived during the sink write must not
         * let a further segment be emitted. The just-emitted segment stays (it was
         * delivered), and the remainder is reported as not dispatched.
         */
        emitted += 1
        if (context.signal.aborted) {
          discard('aborted', candidates.length - index - 1)
          report({
            request,
            endStatus: 'cancelled',
            usageStatus: 'cancelled',
            generated: candidates.length,
            emitted,
            discards,
          })
          return buildEnd(request, 'cancelled', emitted, startedAtMs, 'cancelled')
        }
        if (deadlinePassed()) {
          discard('deadline', candidates.length - index - 1)
          report({
            request,
            endStatus: 'deadline_exceeded',
            usageStatus: 'timeout',
            generated: candidates.length,
            emitted,
            discards,
          })
          return buildEnd(request, 'deadline_exceeded', emitted, startedAtMs, 'timeout')
        }
      }

      report({
        request,
        endStatus: 'completed',
        usageStatus: 'ok',
        generated: candidates.length,
        emitted,
        discards,
      })
      return buildEnd(request, 'completed', emitted, startedAtMs, 'ok')
    },
  }
}
