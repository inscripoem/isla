import { randomUUID } from 'node:crypto'
import type {
  ClockPort,
  ControlAuthorizerPort,
  DialoguePort,
  EventStorePort,
  HistoryQueryPort,
  MemoryCommitPort,
  PlayerPort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../contracts'
import { createDialoguePort } from '../dialogue/dialogue-port'
import type { DialogueTextSource } from '../dialogue/dialogue-port'
import { createDeliveryMemoryStore } from '../dialogue/memory-commit'
import type { DeliveryMemoryStore } from '../dialogue/memory-commit'
import type { PersonaRecallPort } from '../dialogue/persona-recall'
import { createFixedSynthesis } from '../performance/fixed-synthesis'
import type { FixedAudioEntry } from '../performance/fixed-synthesis'
import type { CycleTimings, RuntimeCoordinator, SessionProfileConfig } from './coordinator'
import { createRuntimeCoordinator } from './coordinator'
import type { RuntimeDeadlineGate } from './deadline'
import { createPerformanceBridge } from './performance-bridge'
import type { PerformanceBridge } from './performance-bridge'
import {
  createReconstructedHistoryPort,
  validateArchiveSelection,
} from './session-archives'
import type { ArchiveSelectionConfig, ValidatedArchiveSelection } from './session-archives'

/**
 * Controlled server-side audio resource ownership used by the composition on
 * Stop and disposal. It is structurally satisfied by the M1
 * `AudioResourceRegistry`; the composition never resolves or plays bytes and
 * never decides whether a prepared reference may be dispatched.
 */
export interface CompositionAudioResources {
  /** Retire every session resource below `newEpoch`; later epochs stay admissible. */
  retireBefore(sessionId: string, newEpoch: number): number
  /** Retire every session resource and refuse all later epochs. */
  retireSession(sessionId: string): number
}

/**
 * Production composition for one interactive session. It wires the M5
 * coordinator to an injected synthesis port (or the merged M1 fixed synthesis
 * over explicit catalog entries), the injected renderer adapter (the M1 mapped
 * renderer with its driver supplied by the caller) and the server-side audio
 * bridge, and to injected M3/M4 ports and the M6 store. Missing peer modules
 * are supplied by the caller as explicit substitutes (the demo/test harness);
 * this module imports no test code and makes no provider assumptions.
 */
export interface RuntimeCompositionDeps {
  clock: ClockPort
  authorizer: ControlAuthorizerPort
  selection: SelectionPort
  reaction: ReactionPort
  dialogue: DialoguePort
  commit: MemoryCommitPort
  store: EventStorePort
  /** Reaction/avatar adapter; the merged M1 mapped renderer in production. */
  renderer: RendererPort
  /** Server-owned deadline gate; shared with the mapped renderer and the bridge. */
  gate: RuntimeDeadlineGate
  /**
   * Catalogued fixed audio entries used by M1 fixed synthesis. At least one of
   * `synthesis` or `audioEntries` must be supplied; supplying neither is an
   * explicit missing-configuration failure rather than an empty catalog. When
   * both are supplied, `synthesis` takes precedence.
   */
  audioEntries?: readonly FixedAudioEntry[]
  /** Injected synthesis port (for example M1 Kokoro); preferred over `audioEntries`. */
  synthesis?: SynthesisPort
  /**
   * Optional controlled audio resource ownership: resources of a revoked epoch
   * are retired on Stop and all session resources are retired on dispose. A
   * fault here is isolated and can never prevent Stop or disposal.
   */
  audioResources?: CompositionAudioResources
  sessionId?: string
  profile?: Partial<SessionProfileConfig>
  timings?: Partial<CycleTimings>
  inputTtlMs?: number
  storageTtlMs?: number
  cancelTtlMs?: number
  maxPendingInputs?: number
}

export interface RuntimeComposition {
  readonly coordinator: RuntimeCoordinator
  readonly bridge: PerformanceBridge
  readonly synthesis: SynthesisPort
  readonly sessionId: string
  /** Releases bridge and gate resources; safe to call once on shutdown. */
  dispose(): void
}

/**
 * Real M4 dialogue composition. The text source substitutes the provider only;
 * context assembly, persona resolution, delivery memory and admission are the
 * production M4 implementation. `history` is the shared M6 history port, so
 * context is built from durable confirmed history rather than the local view.
 */
export interface DialogueCompositionDeps {
  clock: ClockPort
  /** Shared M6 HistoryQueryPort; authoritative for which records exist. */
  history: HistoryQueryPort
  /** Provider substitute for dialogue text; M4-02 supplies a live one. */
  textSource?: DialogueTextSource
  personaRecall?: PersonaRecallPort
}

export interface DialogueComposition {
  readonly dialogue: DialoguePort
  /** M4 MemoryCommitPort and attribution/audit store. */
  readonly memory: DeliveryMemoryStore
}

export function createDialogueComposition(deps: DialogueCompositionDeps): DialogueComposition {
  const memory = createDeliveryMemoryStore()
  const dialogue = createDialoguePort({
    clock: deps.clock,
    history: deps.history,
    memory,
    ...(deps.textSource !== undefined ? { textSource: deps.textSource } : {}),
    ...(deps.personaRecall !== undefined ? { personaRecall: deps.personaRecall } : {}),
  })
  return { dialogue, memory }
}

/**
 * Real M4 dialogue composition with cross-session reconstruction. The live
 * session's history query returns the selected archives in order followed by the
 * live session, through the same production M4 dialogue port. The selection is
 * validated and snapshotted once, so a later external mutation cannot change it.
 */
export interface ReconstructedDialogueCompositionDeps {
  clock: ClockPort
  /** Base M6 history reader over the shared store, for the live and archived sessions. */
  history: HistoryQueryPort
  selection: ArchiveSelectionConfig
  textSource?: DialogueTextSource
  personaRecall?: PersonaRecallPort
}

export interface ReconstructedDialogueFromSelectionDeps {
  clock: ClockPort
  history: HistoryQueryPort
  textSource?: DialogueTextSource
  personaRecall?: PersonaRecallPort
}

export interface ReconstructedDialogueComposition extends DialogueComposition {
  readonly selection: ValidatedArchiveSelection
  /** The composed, live-scoped history view M4 consumes. */
  readonly history: HistoryQueryPort
}

/**
 * Build the reconstructed M4 dialogue from an ALREADY validated selection.
 * Callers that hold a validated snapshot use this directly so the selection is
 * never re-read from mutable input.
 */
export function createReconstructedDialogueFromSelection(
  selection: ValidatedArchiveSelection,
  deps: ReconstructedDialogueFromSelectionDeps,
): ReconstructedDialogueComposition {
  const composedHistory = createReconstructedHistoryPort({
    selection,
    readSessionHistory: (sessionId) => deps.history.confirmedHistory(sessionId),
  })
  const composed = createDialogueComposition({
    clock: deps.clock,
    history: composedHistory,
    ...(deps.textSource !== undefined ? { textSource: deps.textSource } : {}),
    ...(deps.personaRecall !== undefined ? { personaRecall: deps.personaRecall } : {}),
  })
  return { ...composed, selection, history: composedHistory }
}

export function createReconstructedDialogueComposition(
  deps: ReconstructedDialogueCompositionDeps,
): ReconstructedDialogueComposition {
  return createReconstructedDialogueFromSelection(validateArchiveSelection(deps.selection), deps)
}

export type ReconstructedSessionErrorCode = 'preflight_read_failed' | 'live_session_not_fresh'

export class ReconstructedSessionError extends Error {
  readonly code: ReconstructedSessionErrorCode

  constructor(code: ReconstructedSessionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ReconstructedSessionError'
    this.code = code
  }
}

/**
 * Coherent production entry for a reconstructed runtime. It OWNS the binding
 * between the cross-session reconstruction and the running session: the runtime
 * session id and character identity are taken from the validated selection, so a
 * caller cannot accidentally pair reconstruction with a different runtime.
 *
 * Before any runtime is constructed it preflights the fresh live id through the
 * existing store port: the id must not reuse a catalogued/selected archive
 * session, nor any session already present in the store (events or partial
 * deliveries count, not only confirmed history). A conflict or a read failure
 * fails visibly before startup. The returned runtime starts stopped and
 * dispatches nothing on construction.
 *
 * M4's own dialogue composition remains usable directly (see
 * `createDialogueComposition`) for callers that do not reconstruct history.
 */
export interface ReconstructedRuntimeDeps {
  clock: ClockPort
  authorizer: ControlAuthorizerPort
  selection: SelectionPort
  reaction: ReactionPort
  store: EventStorePort
  /** Base M6 history reader over the shared store, for the live and archived sessions. */
  history: HistoryQueryPort
  renderer: RendererPort
  gate: RuntimeDeadlineGate
  /**
   * At least one of `synthesis` or `audioEntries` must be supplied; supplying
   * neither fails visibly before any runtime is constructed. When both are
   * supplied, `synthesis` takes precedence.
   */
  audioEntries?: readonly FixedAudioEntry[]
  /** Injected synthesis port (for example M1 Kokoro); preferred over `audioEntries`. */
  synthesis?: SynthesisPort
  /** Optional controlled audio resource ownership (Stop/dispose retirement). */
  audioResources?: CompositionAudioResources
  reconstruction: ArchiveSelectionConfig
  textSource?: DialogueTextSource
  personaRecall?: PersonaRecallPort
  /** Any remaining session-profile fields (for example voice). Character identity is always bound to the selection. */
  profile?: Partial<SessionProfileConfig>
  timings?: Partial<CycleTimings>
  inputTtlMs?: number
  storageTtlMs?: number
  cancelTtlMs?: number
  maxPendingInputs?: number
}

export interface ReconstructedRuntimeComposition extends RuntimeComposition {
  readonly selection: ValidatedArchiveSelection
  readonly memory: DeliveryMemoryStore
  /** The live-scoped composed history view M4 consumes. */
  readonly history: HistoryQueryPort
}

export async function createReconstructedRuntimeComposition(
  deps: ReconstructedRuntimeDeps,
): Promise<ReconstructedRuntimeComposition> {
  const selection = validateArchiveSelection(deps.reconstruction)

  // Fresh-session preflight through the store port before any runtime exists.
  let existing: Awaited<ReturnType<EventStorePort['readSession']>>
  try {
    existing = await deps.store.readSession(selection.liveSessionId)
  } catch (error) {
    throw new ReconstructedSessionError(
      'preflight_read_failed',
      `failed to preflight the fresh live session ${selection.liveSessionId}`,
      { cause: error },
    )
  }
  if (existing.length > 0) {
    throw new ReconstructedSessionError(
      'live_session_not_fresh',
      `the live session id ${selection.liveSessionId} already has stored evidence and cannot be reused`,
    )
  }

  const dialogueComposition = createReconstructedDialogueFromSelection(selection, {
    clock: deps.clock,
    history: deps.history,
    ...(deps.textSource !== undefined ? { textSource: deps.textSource } : {}),
    ...(deps.personaRecall !== undefined ? { personaRecall: deps.personaRecall } : {}),
  })

  const composition = createRuntimeComposition({
    clock: deps.clock,
    authorizer: deps.authorizer,
    selection: deps.selection,
    reaction: deps.reaction,
    dialogue: dialogueComposition.dialogue,
    commit: dialogueComposition.memory,
    store: deps.store,
    renderer: deps.renderer,
    gate: deps.gate,
    ...(deps.synthesis !== undefined ? { synthesis: deps.synthesis } : {}),
    ...(deps.audioEntries !== undefined ? { audioEntries: deps.audioEntries } : {}),
    ...(deps.audioResources !== undefined ? { audioResources: deps.audioResources } : {}),
    sessionId: selection.liveSessionId,
    // Character identity is bound to the validated selection, never to an ad-hoc
    // caller override.
    profile: {
      ...(deps.profile ?? {}),
      characterProfileId: selection.liveProfile.profileId,
      characterProfileVersion: selection.liveProfile.profileVersion,
    },
    ...(deps.timings !== undefined ? { timings: deps.timings } : {}),
    ...(deps.inputTtlMs !== undefined ? { inputTtlMs: deps.inputTtlMs } : {}),
    ...(deps.storageTtlMs !== undefined ? { storageTtlMs: deps.storageTtlMs } : {}),
    ...(deps.cancelTtlMs !== undefined ? { cancelTtlMs: deps.cancelTtlMs } : {}),
    ...(deps.maxPendingInputs !== undefined ? { maxPendingInputs: deps.maxPendingInputs } : {}),
  })

  return { ...composition, selection, memory: dialogueComposition.memory, history: dialogueComposition.history }
}

export function createRuntimeComposition(deps: RuntimeCompositionDeps): RuntimeComposition {
  const sessionId = deps.sessionId ?? `session-${randomUUID()}`
  // Explicit missing-configuration failure: a composition without a synthesis
  // port cannot prepare speech, and silently using an empty fixed catalog would
  // misreport every prepared segment as `fixed_audio_missing`.
  const synthesis =
    deps.synthesis ??
    (deps.audioEntries !== undefined
      ? createFixedSynthesis({ entries: deps.audioEntries, clock: deps.clock })
      : undefined)
  if (synthesis === undefined) {
    throw new TypeError(
      'runtime composition requires a synthesis port: supply `synthesis` or `audioEntries`',
    )
  }
  const bridge = createPerformanceBridge({
    sessionId,
    gate: deps.gate,
    clock: deps.clock,
    ...(deps.cancelTtlMs !== undefined ? { cancelTtlMs: deps.cancelTtlMs } : {}),
  })
  const resources = deps.audioResources
  // Stop reaches the runtime through the coordinator's player call. Wrapping
  // `cancel` retires the revoked epoch's audio resources at the same boundary;
  // the retirement is isolated so a registry fault can never prevent Stop or
  // change the cancellation evidence the bridge returns.
  const player: PlayerPort =
    resources === undefined
      ? bridge.player
      : {
          ...bridge.player,
          cancel: (request, context) => {
            try {
              resources.retireBefore(sessionId, request.newEpoch)
            } catch {
              // Best-effort resource retirement; Stop proceeds regardless.
            }
            return bridge.player.cancel(request, context)
          },
        }
  let coordinator: RuntimeCoordinator
  try {
    coordinator = createRuntimeCoordinator({
      clock: deps.clock,
      authorizer: deps.authorizer,
      selection: deps.selection,
      reaction: deps.reaction,
      dialogue: deps.dialogue,
      synthesis,
      renderer: deps.renderer,
      player,
      commit: deps.commit,
      store: deps.store,
      sessionId,
      ...(deps.profile !== undefined ? { profile: deps.profile } : {}),
      ...(deps.timings !== undefined ? { timings: deps.timings } : {}),
      ...(deps.inputTtlMs !== undefined ? { inputTtlMs: deps.inputTtlMs } : {}),
      ...(deps.storageTtlMs !== undefined ? { storageTtlMs: deps.storageTtlMs } : {}),
      ...(deps.cancelTtlMs !== undefined ? { cancelTtlMs: deps.cancelTtlMs } : {}),
      ...(deps.maxPendingInputs !== undefined ? { maxPendingInputs: deps.maxPendingInputs } : {}),
    })
  } catch (error) {
    // The bridge was created here; a failed coordinator construction must
    // release it instead of leaking an unowned performance bridge. The
    // synthesis port and the gate stay caller-owned.
    bridge.dispose()
    throw error
  }
  let disposed = false
  return {
    coordinator,
    bridge,
    synthesis,
    sessionId,
    dispose(): void {
      if (disposed) return
      disposed = true
      coordinator.dispose()
      bridge.dispose()
      deps.gate.dispose()
      if (resources !== undefined) {
        try {
          resources.retireSession(sessionId)
        } catch {
          // Best-effort resource retirement; disposal is already complete.
        }
      }
    },
  }
}
