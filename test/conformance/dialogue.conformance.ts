import type {
  CallContext,
  DialogueOutcome,
  DialoguePort,
  DialogueSegment,
  HistoryQueryPort,
  MemoryCommitPort,
} from '../../src/contracts'
import { MAX_DIALOGUE_SEGMENTS, dialogueOutcomeSchema } from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'
import { createCallContext } from '../support/context'
import { fixtureCommitDelivery, fixtureDialogueRequest } from '../support/fixture-data'

export interface DialogueKit {
  dialogue: DialoguePort
  commit: MemoryCommitPort
  history?: HistoryQueryPort
}

async function collectOutcome(
  dialogue: DialoguePort,
  request: ReturnType<typeof fixtureDialogueRequest>,
  context: CallContext,
): Promise<DialogueOutcome> {
  const segments: DialogueSegment[] = []
  const end = await dialogue.generate(request, context, {
    segment: async (segment) => {
      segments.push(segment)
    },
  })
  return { segments, end }
}

/** M4 conformance: bounded immutable segments, no-speech discipline and delivery memory. */
export async function collectDialogueViolations(
  create: () => DialogueKit,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const kit = create()
  const context = createCallContext()
  const request = fixtureDialogueRequest()

  const first = await collectOutcome(kit.dialogue, request, context)
  const parsed = dialogueOutcomeSchema.safeParse(first)
  check('dialogue-valid', parsed.success, 'dialogue outcome must be ordered, bounded and consistent')
  if (parsed.success) {
    check('dialogue-max-two', parsed.data.segments.length <= MAX_DIALOGUE_SEGMENTS, 'a turn must emit at most two segments')
    check('dialogue-count-consistent', parsed.data.end.segmentCount === parsed.data.segments.length, 'dialogue end count must match emitted segments')
    check(
      'dialogue-substantive',
      parsed.data.segments.every((segment) => /\p{L}|\p{N}/u.test(segment.text)),
      'punctuation-only output must not be treated as substantive speech',
    )
  }

  // Immutability forbids changing text under a reused segmentId; distinct valid
  // segments across separate generations may differ.
  const second = await collectOutcome(kit.dialogue, request, context)
  const secondBySegment = new Map(second.segments.map((segment) => [segment.segmentId, segment.text]))
  const mutated = first.segments.some(
    (segment) =>
      secondBySegment.has(segment.segmentId) && secondBySegment.get(segment.segmentId) !== segment.text,
  )
  check('dialogue-immutable', !mutated, 'finalized text must not change for a reused segmentId')

  const applied = await kit.commit.commit(fixtureCommitDelivery())
  check('commit-applied', applied.status === 'applied', 'the first confirmed delivery must apply')
  const duplicate = await kit.commit.commit(fixtureCommitDelivery())
  check('commit-idempotent', duplicate.status === 'duplicate', 'a repeated delivery commit must be idempotent')
  const conflict = await kit.commit.commit(
    fixtureCommitDelivery({ classification: 'not-delivered', terminalOutcome: 'failed' }),
  )
  check('commit-no-overwrite', conflict.status === 'conflict', 'a contradictory delivery must not overwrite a confirmed fact')

  if (kit.history !== undefined) {
    const history = await kit.history.confirmedHistory(fixtureCommitDelivery().sessionId)
    check(
      'history-spoken-only',
      history.every((record) => record.classification === 'fully-delivered' && record.text.length > 0),
      'confirmed history must expose spoken text and exclude partial records',
    )
  }

  return violations()
}
