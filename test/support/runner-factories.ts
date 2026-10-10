import type {
  ControlAuthorizerPort,
  DialoguePort,
  PlayerPort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../../src/contracts'
import type { ContractRunner, RunnerDeps } from './contract-runner'
import { createContractRunner } from './contract-runner'
import { createVirtualClock } from './virtual-clock'
import * as correct from './correct-ports'
import type { FixtureEventStore } from './correct-ports'
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
  cancelDelayMs?: number
  inputTtlMs?: number
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
    commit: correct.createFixtureMemoryCommit(),
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

export { createVirtualClock }
