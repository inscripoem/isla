import type {
  ConfirmedDelivery,
  DialogueRequest,
  HistoryQueryPort,
  ReplyIntent,
} from '../contracts'
import type { CharacterProfile } from './persona'

/**
 * Dialogue context assembly.
 *
 * Only confirmed spoken history may enter context. M4 consumes M6's
 * HistoryQueryPort, which already excludes partial and never-delivered records;
 * this module never widens that set.
 *
 * Known M4-01 limitation, documented rather than hidden: `confirmedEventRefs`
 * carries runtime event ids, while HistoryQueryPort returns confirmed delivery
 * records that do not expose an event id. The refs therefore cannot be resolved
 * to records directly and are used only as an ordering hint. If M6 later
 * exposes event-to-delivery linkage, replace `matchesReference` and the hint
 * becomes an exact filter.
 */

export interface AssembledDialogueContext {
  personaSummary: string
  styleNotes: readonly string[]
  selectedInputText: string
  replyIntent: ReplyIntent
  /** Chronological, bounded confirmed history. Empty when nothing was spoken. */
  history: readonly ConfirmedDelivery[]
  /**
   * Character-count proxy for cost estimation. This is NOT a measured token
   * count; M4-01 has no tokenizer and must not present an estimate as measured.
   */
  estimatedCharacters: number
  truncatedByTurnLimit: boolean
  truncatedByCharacterLimit: boolean
}

export interface AssembleDialogueContextInput {
  request: DialogueRequest
  profile: CharacterProfile
  /** Omitted when no history source is available; context then has no history. */
  history?: HistoryQueryPort
}

function referenceIdentifiers(record: ConfirmedDelivery): readonly string[] {
  return [
    record.turnId,
    record.segmentId,
    record.textHash,
    record.outputId ?? '',
    record.receiptId ?? '',
  ].filter((value) => value.length > 0)
}

function matchesReference(record: ConfirmedDelivery, refs: ReadonlySet<string>): boolean {
  return referenceIdentifiers(record).some((identifier) => refs.has(identifier))
}

export async function assembleDialogueContext(
  input: AssembleDialogueContextInput,
): Promise<AssembledDialogueContext> {
  const { request, profile, history } = input
  const maxTurns = request.contextLimits.maxTurns
  const maxCharacters = request.contextLimits.maxCharacters

  const stored = history === undefined ? [] : await history.confirmedHistory(request.sessionId)

  const refs = new Set(request.confirmedEventRefs)
  const ordered =
    refs.size === 0
      ? [...stored]
      : [
          ...stored.filter((record) => matchesReference(record, refs)),
          ...stored.filter((record) => !matchesReference(record, refs)),
        ]

  const recent = maxTurns === 0 ? [] : ordered.slice(-maxTurns)
  const truncatedByTurnLimit = recent.length < ordered.length

  const kept: ConfirmedDelivery[] = []
  let characters = 0
  let truncatedByCharacterLimit = false
  for (const record of [...recent].reverse()) {
    const length = record.text.length
    // Always keep at least the most recent record, even if it alone exceeds the
    // budget; dropping everything would silently erase the live topic.
    if (kept.length > 0 && characters + length > maxCharacters) {
      truncatedByCharacterLimit = true
      break
    }
    kept.unshift(record)
    characters += length
  }

  return {
    personaSummary: profile.personaSummary,
    styleNotes: profile.styleNotes,
    selectedInputText: request.selectedInput.text,
    replyIntent: request.responsePlan.replyIntent,
    history: kept,
    estimatedCharacters: characters,
    truncatedByTurnLimit,
    truncatedByCharacterLimit,
  }
}
