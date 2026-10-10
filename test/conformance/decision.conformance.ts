import type { ReactionPort, SelectionPort } from '../../src/contracts'
import { NO_OP_ACTION, decisionResultSchema, selectionResultSchema } from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'
import { createCallContext } from '../support/context'
import {
  fixtureDecisionRequest,
  fixtureInputEvent,
  fixtureSelectionRequest,
} from '../support/fixture-data'

export interface DecisionKit {
  selection: SelectionPort
  reaction: ReactionPort
}

/** M3 conformance: proposal validity, intent bounds and reaction eligibility. */
export async function collectDecisionViolations(
  create: () => DecisionKit,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const kit = create()
  const context = createCallContext()

  const request = fixtureSelectionRequest({
    candidates: [fixtureInputEvent({ eventId: 'candidate-1' }), fixtureInputEvent({ eventId: 'candidate-2' })],
  })
  const selection = selectionResultSchema.safeParse(await kit.selection.select(request, context))
  check('selection-valid', selection.success, 'selection result must validate')
  if (selection.success) {
    check(
      'selection-echo-identity',
      selection.data.requestId === request.requestId &&
        selection.data.sessionId === request.sessionId &&
        selection.data.epoch === request.epoch &&
        selection.data.snapshotRevision === request.snapshotRevision,
      'selection result must echo request identity and revision',
    )
    if (selection.data.disposition === 'respond') {
      check('selection-single', selection.data.selectedEventIds.length === 1, 'respond must select exactly one event')
      const selected = selection.data.selectedEventIds[0]
      check('selection-offered', request.candidates.some((candidate) => candidate.eventId === selected), 'selected event must be one of the offered candidates')
      check('selection-intent-allowed', selection.data.replyIntent !== null && request.allowedIntents.includes(selection.data.replyIntent), 'reply intent must be allowed')
    }
  }

  const decisionRequest = fixtureDecisionRequest({ eligibleActionIds: ['neutral', 'smile'] })
  const decision = decisionResultSchema.safeParse(await kit.reaction.decide(decisionRequest, context))
  check('reaction-valid', decision.success, 'decision result must validate')
  if (decision.success) {
    check(
      'reaction-echo-identity',
      decision.data.requestId === decisionRequest.requestId &&
        decision.data.epoch === decisionRequest.epoch &&
        decision.data.capabilityRevision === decisionRequest.capabilityRevision,
      'decision result must echo identity and capability revision',
    )
    if (decision.data.status === 'selected') {
      check(
        'reaction-eligible',
        decision.data.actionId !== null &&
          (decision.data.actionId === NO_OP_ACTION || decisionRequest.eligibleActionIds.includes(decision.data.actionId)),
        'selected action must be eligible or no-op',
      )
    }
  }

  return violations()
}
