import type {
  DialoguePort,
  PlayerPort,
  SelectionPort,
  TrustedControlContext,
} from '../../src/contracts'
import { createRuntimeCoordinator } from '../../src/runtime/coordinator'
import type { CycleTimings, SessionProfileConfig } from '../../src/runtime/coordinator'
import type { ContractRunner, RunnerDeps, RunnerHooks } from './contract-runner'
import { FIXTURE_SESSION_ID } from './fixture-data'
import type { VirtualClock } from './virtual-clock'

/**
 * Test-only conformance adapter. It connects the production M5 coordinator's
 * cycle driver, endpoint and trace to the `ContractRunner` shape the shared
 * conformance suite expects. Test hooks and fixture timing controls live only
 * here; production code never imports this module.
 */

export interface CoordinatorRunnerOptions {
  sessionId?: string
  cancelDelayMs?: number
  timings?: Partial<CycleTimings>
  profile?: Partial<SessionProfileConfig>
  storageTtlMs?: number
  cancelTtlMs?: number
}

function wrapSelection(delegate: SelectionPort, hooks: RunnerHooks): SelectionPort {
  return {
    async select(request, context) {
      if (hooks.beforeSelect !== undefined) await hooks.beforeSelect()
      return delegate.select(request, context)
    },
  }
}

function wrapDialogue(delegate: DialoguePort, hooks: RunnerHooks): DialoguePort {
  return {
    generate(request, context, sink) {
      let index = 0
      return delegate.generate(request, context, {
        async segment(segment) {
          await sink.segment(segment)
          if (hooks.afterSegmentDispatch !== undefined) await hooks.afterSegmentDispatch(index)
          index += 1
        },
      })
    },
  }
}

function wrapPlayer(
  delegate: PlayerPort,
  hooks: RunnerHooks,
  cancelDelayMs: number | undefined,
): PlayerPort {
  let index = 0
  return {
    async execute(command, context) {
      const playback = delegate.execute(command, context)
      if (hooks.onPlaybackStart !== undefined) await hooks.onPlaybackStart(index, command.outputId)
      index += 1
      return playback
    },
    async cancel(request, context) {
      if (cancelDelayMs !== undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, cancelDelayMs)
        })
      }
      return delegate.cancel(request, context)
    },
    status: () => delegate.status(),
  }
}

export function createCoordinatorContractRunner(
  clock: VirtualClock,
  deps: RunnerDeps,
  options: CoordinatorRunnerOptions = {},
): ContractRunner {
  const sessionId = options.sessionId ?? FIXTURE_SESSION_ID
  const hooks: RunnerHooks = {}
  const coordinator = createRuntimeCoordinator({
    clock,
    authorizer: deps.authorizer,
    selection: wrapSelection(deps.selection, hooks),
    reaction: deps.reaction,
    dialogue: wrapDialogue(deps.dialogue, hooks),
    synthesis: deps.synthesis,
    renderer: deps.renderer,
    player: wrapPlayer(deps.player, hooks, options.cancelDelayMs),
    commit: deps.commit,
    store: deps.store,
    sessionId,
    ...(deps.inputTtlMs !== undefined ? { inputTtlMs: deps.inputTtlMs } : {}),
    ...(options.storageTtlMs !== undefined ? { storageTtlMs: options.storageTtlMs } : {}),
    ...(options.cancelTtlMs !== undefined ? { cancelTtlMs: options.cancelTtlMs } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.timings !== undefined ? { timings: options.timings } : {}),
  })

  const operatorContext: TrustedControlContext = {
    connectionId: 'operator',
    role: 'operator',
    actorId: 'operator',
    authenticated: true,
  }
  const viewerContext: TrustedControlContext = {
    connectionId: 'audience',
    role: 'viewer',
    actorId: 'actor-local-audience',
    authenticated: true,
  }

  let messageCounter = 0
  const nextMessageId = (prefix: string): string => {
    messageCounter += 1
    return `${prefix}-${messageCounter}`
  }

  return {
    endpoint: coordinator.endpoint,
    hooks,
    clock,
    lifecycle: () => coordinator.lifecycle(),
    epoch: () => coordinator.epoch(),
    events: () => coordinator.events(),
    deliveries: () => coordinator.deliveries(),
    selectionCalls: () => coordinator.metrics().selectionAttempts,
    rejectedLate: () => coordinator.metrics().rejectedLate,
    rejectedReceipts: () => coordinator.metrics().rejectedReceipts,
    storageFailureObserved: () => coordinator.metrics().storageFailure,
    runTurn: () => coordinator.runTurn(),
    resume: () =>
      coordinator.endpoint.control(
        {
          protocolVersion: '0.2',
          kind: 'control.resume',
          messageId: nextMessageId('msg'),
          sessionId,
          epoch: coordinator.epoch(),
          payload: { requestId: nextMessageId('resume') },
        },
        operatorContext,
      ),
    stop: () =>
      coordinator.endpoint.control(
        {
          protocolVersion: '0.2',
          kind: 'control.stop',
          messageId: nextMessageId('msg'),
          sessionId,
          epoch: coordinator.epoch(),
          payload: { requestId: nextMessageId('stop') },
        },
        operatorContext,
      ),
    controlWith: (message, context) => coordinator.endpoint.control(message, context),
    accept: (text, messageId) =>
      coordinator.endpoint.submitInput(
        {
          protocolVersion: '0.2',
          messageId: messageId ?? nextMessageId('msg'),
          sessionId,
          epoch: coordinator.epoch(),
          kind: 'input.submit',
          payload: { source: 'local-audience', text },
        },
        viewerContext,
      ),
    async replay(targetSessionId) {
      const archive = await deps.replay.load(targetSessionId)
      return archive.events.length
    },
  }
}
