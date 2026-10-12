import type {
  ControlAuthorizerPort,
  DialoguePort,
  MemoryCommitPort,
  PlayerPort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../../src/contracts'
import type { CycleTimings, SessionProfileConfig } from '../../src/runtime/coordinator'
import type { ContractRunner, RunnerDeps } from './contract-runner'
import { createContractRunner } from './contract-runner'
import { createCoordinatorContractRunner } from './coordinator-runner'
import { createVirtualClock } from './virtual-clock'
import * as correct from './correct-ports'
import type { FixtureEventStore } from './correct-ports'
import { FIXTURE_SESSION_ID } from './fixture-data'
import * as faulty from './faulty-ports'

export interface RunnerOptions {
  holdPlayer?: boolean
  holdPlayerAfter?: number
  segmentCount?: number
  beforeSegment?: (index: number) => Promise<void>
  selection?: SelectionPort
  reaction?: ReactionPort
  dialogue?: DialoguePort
  synthesis?: SynthesisPort
  authorizer?: ControlAuthorizerPort
  player?: PlayerPort
  renderer?: RendererPort
  store?: FixtureEventStore
  commit?: MemoryCommitPort
  cancelDelayMs?: number
  inputTtlMs?: number
  timings?: Partial<CycleTimings>
  profile?: Partial<SessionProfileConfig>
  storageTtlMs?: number
  cancelTtlMs?: number
}

function buildDeps(
  store: RunnerDeps['store'],
  history: RunnerDeps['history'],
  replay: RunnerDeps['replay'],
  projection: RunnerDeps['projection'],
  options: RunnerOptions,
): RunnerDeps {
  return {
    selection: options.selection ?? correct.createFixtureSelectionPort(),
    reaction: options.reaction ?? correct.createFixtureReactionPort(),
    dialogue:
      options.dialogue ??
      correct.createFixtureDialoguePort({
        segmentCount: options.segmentCount,
        ...(options.beforeSegment !== undefined ? { beforeSegment: options.beforeSegment } : {}),
      }),
    synthesis: options.synthesis ?? correct.createFixtureSynthesisPort(),
    renderer: options.renderer ?? correct.createFixtureRendererPort(),
    player:
      options.player ??
      correct.createFixturePlayer({
        hold: options.holdPlayer,
        ...(options.holdPlayerAfter !== undefined ? { holdAfter: options.holdPlayerAfter } : {}),
      }),
    commit: options.commit ?? correct.createFixtureMemoryCommit(),
    store,
    history,
    projection,
    replay,
    authorizer: options.authorizer ?? correct.createFixtureControlAuthorizer(),
    ...(options.cancelDelayMs !== undefined ? { cancelDelayMs: options.cancelDelayMs } : {}),
    ...(options.inputTtlMs !== undefined ? { inputTtlMs: options.inputTtlMs } : {}),
  }
}

export function createFixtureRunner(options: RunnerOptions = {}): ContractRunner {
  const clock = createVirtualClock()
  const store = options.store ?? correct.createFixtureEventStore()
  const deps = buildDeps(
    store,
    correct.createFixtureHistoryQuery(store),
    correct.createFixtureReplayReader(store),
    correct.createFixtureMemoryProjection(),
    options,
  )
  return createContractRunner(clock, deps)
}

export function createFaultyRunner(options: RunnerOptions = {}): ContractRunner {
  const clock = createVirtualClock()
  const faultyStore = faulty.createFaultyEventStore()
  const deps = buildDeps(
    faultyStore.store,
    correct.createFixtureHistoryQuery(faultyStore),
    correct.createFixtureReplayReader(faultyStore.store),
    faulty.createFaultyMemoryProjection(),
    {
      ...options,
      selection: options.selection ?? faulty.createFaultySelectionPort(),
      reaction: options.reaction ?? faulty.createFaultyReactionPort(),
    },
  )
  return createContractRunner(clock, deps)
}

/** Production coordinator backed by the correct fixture peer ports. */
export function createCoordinatorRunner(options: RunnerOptions = {}): ContractRunner {
  const clock = createVirtualClock()
  const store = options.store ?? correct.createFixtureEventStore()
  const deps = buildDeps(
    store,
    correct.createFixtureHistoryQuery(store),
    correct.createFixtureReplayReader(store),
    correct.createFixtureMemoryProjection(),
    options,
  )
  return createCoordinatorContractRunner(clock, deps, {
    sessionId: FIXTURE_SESSION_ID,
    ...(options.cancelDelayMs !== undefined ? { cancelDelayMs: options.cancelDelayMs } : {}),
    ...(options.timings !== undefined ? { timings: options.timings } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.storageTtlMs !== undefined ? { storageTtlMs: options.storageTtlMs } : {}),
    ...(options.cancelTtlMs !== undefined ? { cancelTtlMs: options.cancelTtlMs } : {}),
  })
}

/**
 * Production coordinator backed by deliberately faulty peer ports. The faulty
 * store is always injected (the store option is intentionally ignored) so the
 * shared assertions exercise the negative wiring.
 */
export function createFaultyCoordinatorRunner(options: RunnerOptions = {}): ContractRunner {
  const clock = createVirtualClock()
  const faultyStore = faulty.createFaultyEventStore()
  const deps = buildDeps(
    faultyStore.store,
    correct.createFixtureHistoryQuery(faultyStore),
    correct.createFixtureReplayReader(faultyStore.store),
    faulty.createFaultyMemoryProjection(),
    {
      ...options,
      selection: options.selection ?? faulty.createFaultySelectionPort(),
      reaction: options.reaction ?? faulty.createFaultyReactionPort(),
    },
  )
  return createCoordinatorContractRunner(clock, deps, { sessionId: FIXTURE_SESSION_ID })
}

export { createVirtualClock }
