import type { PlayerPort, RendererPort, SynthesisPort } from '../../src/contracts'
import {
  capabilitySnapshotSchema,
  performanceReceiptSchema,
  preparedAudioSchema,
} from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'
import { createCallContext } from '../support/context'
import {
  fixturePerformanceCommand,
  fixturePreparePerformance,
} from '../support/fixture-data'

export interface PerformanceKit {
  synthesis: SynthesisPort
  renderer: RendererPort
  player: PlayerPort
}

/**
 * M1 conformance: prepare-never-plays, capability honesty, receipt identity and
 * explicit player idle evidence. Run against correct and faulty adapters.
 */
export async function collectPerformanceViolations(
  create: () => PerformanceKit,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const kit = create()
  const context = createCallContext()
  let executeCalls = 0
  const player: PlayerPort = {
    execute: (command, ctx) => {
      executeCalls += 1
      return kit.player.execute(command, ctx)
    },
    cancel: (request, ctx) => kit.player.cancel(request, ctx),
    status: () => kit.player.status(),
  }

  const rawCapabilities = kit.renderer.capabilities()
  const ids = rawCapabilities.actions.map((action) => action.actionId)
  check('capabilities-unique', new Set(ids).size === ids.length, 'capability action ids must be unique')
  const capabilities = capabilitySnapshotSchema.safeParse(rawCapabilities)
  check('capabilities-valid', capabilities.success, 'renderer capabilities must validate')

  const renderCommand = fixturePerformanceCommand({ outputId: 'output-render-check' })
  const renderReceipt = await kit.renderer.execute(renderCommand, context)
  const parsedRenderReceipt = performanceReceiptSchema.safeParse(renderReceipt)
  check('renderer-receipt-valid', parsedRenderReceipt.success, 'renderer execution must return a valid receipt')
  if (parsedRenderReceipt.success) {
    check('renderer-receipt-output-match', parsedRenderReceipt.data.outputId === renderCommand.outputId, 'renderer receipt outputId must match the command')
    check(
      'renderer-receipt-stage',
      ['accepted', 'started', 'completed', 'cancelled', 'failed', 'unknown'].includes(parsedRenderReceipt.data.stage),
      'renderer receipt must report a valid stage',
    )
  }

  const prepared = await kit.synthesis.prepare(fixturePreparePerformance(), context)
  check('prepare-never-plays', executeCalls === 0, 'preparing speech must not play it')
  const parsedPrepared = preparedAudioSchema.safeParse(prepared)
  check('prepare-valid', parsedPrepared.success, 'prepared audio must validate')
  if (parsedPrepared.success && parsedPrepared.data.ok) {
    const ref = parsedPrepared.data.audioRef
    check(
      'audio-ref-opaque',
      !ref.startsWith('/') && !/^(file|https?):/i.test(ref),
      'audio reference must be an opaque server-controlled reference',
    )
  }

  const command = fixturePerformanceCommand()
  const receipt = await player.execute(command, context)
  const parsedReceipt = performanceReceiptSchema.safeParse(receipt)
  check('receipt-valid', parsedReceipt.success, 'player receipt must validate')
  if (parsedReceipt.success) {
    check('receipt-output-match', parsedReceipt.data.outputId === command.outputId, 'receipt outputId must match the dispatched command')
    check(
      'receipt-terminal',
      ['completed', 'cancelled', 'failed'].includes(parsedReceipt.data.stage),
      'audio completion must report a terminal stage',
    )
  }
  const status = player.status()
  check('player-idle-after-completion', status.idle === true, 'player must report idle once playback completes')
  const idleCancel = await player.cancel(
    { requestId: 'cancel-idle', revokedEpoch: 1, newEpoch: 2 },
    context,
  )
  check('cancel-idle-null', idleCancel === null, 'cancelling an idle player must return no evidence')

  return violations()
}

/** Cancellation evidence while playback is genuinely in flight (hold player). */
export async function collectPlayerCancellationViolations(
  create: () => PlayerPort,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const player = create()
  const context = createCallContext()
  const command = fixturePerformanceCommand({ outputId: 'output-hold-check' })
  const inFlight = player.execute(command, context)
  check('player-active-while-in-flight', player.status().idle === false, 'player must report active while playback is in flight')
  const cancelled = await player.cancel(
    { requestId: 'cancel-hold', revokedEpoch: 1, newEpoch: 2 },
    context,
  )
  check('cancel-evidence-present', cancelled !== null, 'cancelling active playback must return terminal evidence')
  if (cancelled !== null) {
    check('cancel-evidence-terminal', cancelled.stage === 'cancelled', 'cancellation evidence must be a cancelled receipt')
  }
  const settled = await inFlight
  check(
    'in-flight-settles',
    ['completed', 'cancelled', 'failed'].includes(settled.stage),
    'in-flight playback must settle to a terminal stage',
  )
  check('player-idle-after-cancel', player.status().idle === true, 'player must report idle after cancel')
  return violations()
}
