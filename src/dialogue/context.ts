import type { ConfirmedDelivery, DialogueRequest, HistoryQueryPort, ReplyIntent } from '../contracts'
import type { CharacterProfile } from './persona'
import {
  intentTemplatesFor,
  personaKeyFromDelivery,
  personaVersionKey,
  renderPersonaBlock,
} from './persona'
import type { RecalledFact } from './persona-recall'
import { MAX_RECALLED_FACTS } from './persona-recall'
import { turnKey, utteranceKey } from './delivery-key'
import type { PersonaRecallPort } from './persona-recall'
import { classifyMemoryBucket, isTruncatedSpeech, modalityRank, trimRank } from './memory-semantics'
import type { MemoryBucketReason } from './memory-semantics'

/**
 * Dialogue context assembly.
 *
 * What may enter context: only text the listener actually heard. M4 consumes M6's
 * HistoryQueryPort, which already excludes partially delivered and never
 * delivered records; this module does not widen that set, and it also blocks
 * delivery claims that carry no playback evidence. The admission rules live in
 * ./memory-semantics.
 *
 * What must never happen: presenting an interrupted half-sentence as something
 * the listener heard in full. Two guards prevent it:
 *   1. admission discards every record that was not fully delivered;
 *   2. speech that was fully delivered but still ends mid-sentence is marked
 *      `interrupted` in `turns` and rendered with an explicit marker, so the
 *      model reading the context cannot take it for a complete statement.
 *
 * Budget rule. `contextLimits.maxCharacters` covers the rendered confirmed
 * history AND the rendered recalled facts, which share it and therefore trade off
 * against each other. It does NOT cover the persona block (fixed per turn) or the
 * rest of the model prompt. The cap is hard: nothing assembled here may exceed it.
 * See `estimatedCharacters` for exactly which characters are counted.
 *
 * Known limitation (recorded rather than hidden): `confirmedEventRefs` carries
 * runtime event ids, but a confirmed record exposes no event id. A reference
 * therefore cannot be resolved to a record and is only used as an ordering hint.
 * If M6 later exposes the delivery-to-event relationship, `matchesReference`
 * should be replaced so the hint becomes an exact filter.
 */

/* -------------------------------------------------------------------------- */
/* Rendered form and character accounting                                     */
/* -------------------------------------------------------------------------- */

/** Prefix of one rendered item inside the history or recall block. */
export const ITEM_PREFIX = '- '

/** Appended to a turn that stopped mid-sentence. Counted in the budget. */
export const INTERRUPTED_SPEECH_MARKER = ' [cut off mid-sentence]'

/**
 * Rendered form of one confirmed turn. The single source of truth for both the
 * prompt and the character accounting, so the two cannot drift apart.
 */
export function renderHistoryLine(turn: AssembledTurn): string {
  return `${ITEM_PREFIX}${turn.text}${turn.interrupted ? INTERRUPTED_SPEECH_MARKER : ''}`
}

/**
 * Rendered form of one recalled fact, including its provenance. Recalled text
 * without provenance cannot be traced back to the bible, so the suffix is part of
 * the rendered line and is charged to the budget.
 */
export function renderRecallLine(entry: RecalledFact): string {
  return `${ITEM_PREFIX}${entry.fact.text} (bible: ${entry.fact.id})`
}

/* -------------------------------------------------------------------------- */
/* Assembled view                                                             */
/* -------------------------------------------------------------------------- */

/** M4's internal view of a stored delivery, including its persona attribution. */
export interface MemoryEntry {
  delivery: ConfirmedDelivery
  /**
   * Persona attribution of the record, derived only from its persisted
   * `personaProfileId`/`personaProfileVersion`. Null means the pair is not
   * completely known; a partial or absent pair stays unknown and is never filled
   * from process-local state. Null is treated as current rather than stale:
   * absence of evidence is not evidence that the memory is outdated.
   */
  personaVersion: string | null
}

/**
 * A sibling of HistoryQueryPort exposing confirmed records with their persona
 * attribution. Optional: it is the record source only when no durable history
 * was supplied. Attribution itself always comes from each record's persisted
 * fields, so this side cannot fill in a missing persona component.
 */
export interface MemoryEntrySource {
  memoryEntries(sessionId: string): Promise<readonly MemoryEntry[]>
}

/**
 * Which source supplied the confirmed records for this assembly.
 *
 *  - 'history-port': the durable source (M6). Authoritative.
 *  - 'local-stand-in': the in-memory store, used only because no durable source
 *    was supplied. An offline/test stand-in that must never be mistaken for
 *    durable history.
 *  - 'none': no source at all, so context carries no confirmed history.
 */
export type HistorySource = 'history-port' | 'local-stand-in' | 'none'

/** A recalled fact dropped before rendering, so the loss stays auditable. */
export interface RecallExclusion {
  factId: string
  reason: 'recall-budget'
}

/** One confirmed speaking turn, in speaking order. */
export interface AssembledTurn {
  sessionId: string
  turnId: string
  /** Segments of the turn, in segment order. */
  segments: readonly ConfirmedDelivery[]
  /** Concatenated turn text, without the rendering prefix or marker. */
  text: string
  /**
   * True when the turn ends mid-sentence. The words were delivered, but the
   * statement was not finished, so context must not present it as complete.
   */
  interrupted: boolean
  /** Persona version used to generate the turn; null when unknown. */
  personaVersion: string | null
  /** Rendered length of this turn inside the context block. */
  characters: number
}

export type ContextExclusionReason =
  | MemoryBucketReason
  | 'duplicate-modality'
  | 'turn-limit'
  | 'character-budget'
  | 'trim-stale-persona'
  | 'trim-truncated'

export interface ContextExclusion {
  sessionId: string
  turnId: string
  segmentId: string
  reason: ContextExclusionReason
}

export interface AssembledDialogueContext {
  /** Rendered persona block, ready to use in a prompt. */
  personaBlock: string
  personaSummary: string
  styleNotes: readonly string[]
  /** Reply templates resolved for this intent, in speaking order. */
  replyTemplates: readonly string[]
  /**
   * Recalled persona facts, deduplicated and charged to the same budget as
   * history. Empty under the default policy - see ./persona-recall. They are NOT
   * delivery memory: they never enter `confirmedHistory` and never claim "she
   * said this".
   */
  recalledFacts: readonly RecalledFact[]
  /** Recalled facts dropped for budget, with the reason. */
  recallExclusions: readonly RecallExclusion[]
  selectedInputText: string
  replyIntent: ReplyIntent
  /** Confirmed turns kept in context, oldest first. */
  turns: readonly AssembledTurn[]
  /** Flattened, bounded confirmed history for callers that read records. */
  history: readonly ConfirmedDelivery[]
  /** Where the confirmed records came from. See HistorySource. */
  historySource: HistorySource
  /** What was dropped from context and why. Audit only; never shown to a model. */
  exclusions: readonly ContextExclusion[]
  /**
   * Cost approximated as a character count. This is not a measured token count:
   * M4 has no tokenizer and must not present an estimate as a measurement.
   *
   * The counted characters are exactly those charged to `maxCharacters`:
   *   - each kept turn, as `renderHistoryLine` produces it (item prefix, turn
   *     text, and the interrupted marker when present);
   *   - each recalled fact, as `renderRecallLine` produces it (item prefix, fact
   *     text, and the provenance suffix).
   * Section headings, the persona block and the rest of the prompt are not
   * counted, because they are not part of this budget.
   */
  estimatedCharacters: number
  truncatedByTurnLimit: boolean
  truncatedByCharacterLimit: boolean
  warnings: readonly string[]
}

export interface AssembleDialogueContextInput {
  request: DialogueRequest
  profile: CharacterProfile
  /**
   * Durable history source (M6). When supplied it is AUTHORITATIVE and defines the
   * record set; see the composition rule in `assembleDialogueContext`.
   */
  history?: HistoryQueryPort
  /**
   * Local record source. Used only when no durable source was supplied; persona
   * attribution still comes from each record's persisted fields.
   */
  memory?: MemoryEntrySource
  /**
   * Persona fact recall. Omitted means no recall, equivalent to
   * `PERSONA_RECALL_POLICY = 'off'`.
   */
  personaRecall?: PersonaRecallPort
}

/**
 * Ordering comparison for segments within one turn.
 *
 * The authoritative carrier is the persisted `ConfirmedDelivery.segmentIndex`,
 * originally `DialogueSegment.index`. A known index sorts ascending; an unknown
 * index (`null`) sorts after every known one, because a legacy record's original
 * position is genuinely unknown. Ties and unknowns are resolved by the input
 * order, which is the supporting-event `seq` order the history port returns, so
 * the comparison is stable and never falls back to the identifier spelling.
 *
 * The strict-decoder note this replaced was wrong and is now obsolete:
 * `confirmedDeliverySchema` is a strictObject, so an unknown field would be
 * REJECTED by M4's own parse, never stripped; and the shared contract now
 * carries the field, so the read side adopts it directly instead of deriving it.
 */
function compareSegmentOrder(left: ConfirmedDelivery, right: ConfirmedDelivery): number {
  const a = left.segmentIndex
  const b = right.segmentIndex
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a - b
}

function turnText(segments: readonly ConfirmedDelivery[]): string {
  return segments.map((segment) => segment.text).join(' ')
}

export async function assembleDialogueContext(
  input: AssembleDialogueContextInput,
): Promise<AssembledDialogueContext> {
  const { request, profile, history, memory } = input
  const maxTurns = request.contextLimits.maxTurns
  const maxCharacters = request.contextLimits.maxCharacters

  /*
   * Composition rule, settled in issue #22 after M5's correction.
   *
   * The durable source is authoritative and defines WHICH records exist. The
   * local store never substitutes for it while it is available, because a local
   * view that only holds what this process has seen is not a complete history:
   * choosing it merely because it is non-empty would let one new local delivery
   * replace ten reconstructed records. The local store becomes the record source
   * only when no durable source was supplied at all, which is flagged in
   * `historySource` and reported as a warning. Persona attribution is read from
   * each record's own persisted fields, so the local store is no longer consulted
   * as an attribution side and cannot fill in a missing persisted component.
   *
   * The two sources are never merged into one list, so a delivery held by both
   * cannot be counted twice.
   */
  const historySource: HistorySource =
    history !== undefined ? 'history-port' : memory !== undefined ? 'local-stand-in' : 'none'

  let raw: readonly MemoryEntry[]
  if (history !== undefined) {
    raw = (await history.confirmedHistory(request.sessionId)).map((delivery) => ({
      delivery,
      // Attribution is read only from the record's persisted persona fields. A
      // partial or absent pair stays unknown; it is never inferred from local
      // state.
      personaVersion: personaKeyFromDelivery(delivery),
    }))
  } else if (memory !== undefined) {
    raw = await memory.memoryEntries(request.sessionId)
  } else {
    raw = []
  }

  const exclusions: ContextExclusion[] = []
  const admitted: MemoryEntry[] = []
  for (const entry of raw) {
    const decision = classifyMemoryBucket(entry.delivery)
    if (decision.bucket === 'spoken') {
      admitted.push(entry)
    } else {
      exclusions.push({
        sessionId: entry.delivery.sessionId,
        turnId: entry.delivery.turnId,
        segmentId: entry.delivery.segmentId,
        reason: decision.reason,
      })
    }
  }

  /*
   * One utterance keeps one record in context. A segment confirmed for both audio
   * and subtitle is still the same sentence, so the lower-priority modality is
   * dropped rather than added twice.
   */
  const byUtterance = new Map<string, MemoryEntry>()
  for (const entry of admitted) {
    const key = utteranceKey(entry.delivery)
    const current = byUtterance.get(key)
    if (current === undefined) {
      byUtterance.set(key, entry)
      continue
    }
    const preferred =
      modalityRank(entry.delivery.modality) < modalityRank(current.delivery.modality)
        ? entry
        : current
    const dropped = preferred === entry ? current : entry
    byUtterance.set(key, preferred)
    exclusions.push({
      sessionId: dropped.delivery.sessionId,
      turnId: dropped.delivery.turnId,
      segmentId: dropped.delivery.segmentId,
      reason: 'duplicate-modality',
    })
  }

  /*
   * `confirmedEventRefs` names runtime event ids, but a `ConfirmedDelivery`
   * exposes no event id, so a reference cannot be resolved to a record. It is
   * therefore never used to reorder the authoritative history: an unresolved
   * hint must not move durable records. The references are reported through a
   * warning and otherwise deferred to a later contract that exposes the
   * delivery-to-event relationship.
   */
  const refs = new Set(request.confirmedEventRefs)
  const ordered = [...byUtterance.values()]

  /*
   * Group by `(sessionId, turnId)`, not by `turnId` alone. The session-scoped turn
   * counter restarts for every session, so grouping on the turn id alone would
   * merge two different sessions' turns into one fabricated turn as soon as
   * multi-session history is assembled.
   */
  const grouped = new Map<string, MemoryEntry[]>()
  for (const entry of ordered) {
    const key = turnKey(entry.delivery)
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [entry])
    else bucket.push(entry)
  }

  const allTurns: AssembledTurn[] = [...grouped.values()].map((entries) => {
    const first = entries[0]
    if (first === undefined) throw new Error('grouped turn is empty')
    const segments = entries
      .map((entry, order) => ({ entry, order }))
      .sort(
        (left, right) =>
          compareSegmentOrder(left.entry.delivery, right.entry.delivery) ||
          left.order - right.order,
      )
      .map(({ entry }) => entry.delivery)
    const text = turnText(segments)
    const turn: AssembledTurn = {
      sessionId: first.delivery.sessionId,
      turnId: first.delivery.turnId,
      segments,
      text,
      interrupted: isTruncatedSpeech(text),
      personaVersion: first.personaVersion,
      characters: 0,
    }
    // Charged as rendered, so the budget matches what actually reaches the prompt.
    turn.characters = renderHistoryLine(turn).length
    return turn
  })

  const recent = maxTurns === 0 ? [] : allTurns.slice(-maxTurns)
  const truncatedByTurnLimit = recent.length < allTurns.length
  for (const turn of allTurns.slice(0, Math.max(0, allTurns.length - recent.length))) {
    for (const segment of turn.segments) {
      exclusions.push({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        segmentId: segment.segmentId,
        reason: 'turn-limit',
      })
    }
  }

  /*
   * Recall happens BEFORE history trimming: both share one `maxCharacters`, so the
   * recall block has to be measured before history can know its remainder.
   * Reversing the order would let recall quietly overshoot the total.
   *
   * Recall items are deduplicated against the standing facts by the port; text that
   * is already rendered every turn must not be rendered a second time. With recall
   * disabled (no `personaRecall`), the result is an empty list, so context is
   * identical to running with the feature off and callers need no branch.
   */
  const recallResult: readonly RecalledFact[] =
    input.personaRecall === undefined
      ? []
      : input.personaRecall.recall({
          inputText: request.selectedInput.text,
          recentHistory: recent.map((turn) => turn.text),
          replyIntent: request.responsePlan.replyIntent,
          standingFacts: profile.standingFacts ?? [],
        })

  /*
   * Recalled facts must fit the budget too. A warning would not be sufficient: the
   * recall block is charged to the same cap as history, so if recall alone
   * exceeded it, every later assembly would silently lose all confirmed history
   * while still reporting a healthy run. Facts are taken in the order the port
   * returned them and the remainder is dropped with an auditable exclusion.
   */
  const recalledFacts: RecalledFact[] = []
  const recallExclusions: RecallExclusion[] = []
  let recalledCharacters = 0
  for (const entry of recallResult.slice(0, MAX_RECALLED_FACTS)) {
    const cost = renderRecallLine(entry).length
    if (recalledCharacters + cost > maxCharacters) {
      recallExclusions.push({ factId: entry.fact.id, reason: 'recall-budget' })
      continue
    }
    recalledFacts.push(entry)
    recalledCharacters += cost
  }

  const availableHistoryCharacters = Math.max(0, maxCharacters - recalledCharacters)

  const kept = trimToCharacterBudget({
    turns: recent,
    maxCharacters: availableHistoryCharacters,
    activePersonaVersion: personaVersionKey(profile.profileId, profile.version),
    exclusions,
  })

  const historyFlat = kept.turns.flatMap((turn) => turn.segments)
  const warnings: string[] = []
  if (refs.size > 0) {
    warnings.push('confirmedEventRefs could not be resolved to records; used as ordering hint only')
  }
  if (kept.turns.some((turn) => turn.interrupted)) {
    warnings.push('context contains an interrupted utterance; it is marked, not completed')
  }
  if (historySource === 'local-stand-in') {
    warnings.push(
      'confirmed history comes from the in-memory store because no durable history source was supplied',
    )
  }
  if (recallExclusions.length > 0) {
    warnings.push('some recalled persona facts were dropped to stay within the character budget')
  }
  if (recalledCharacters >= maxCharacters && recent.length > 0) {
    warnings.push(
      'recalled persona facts consume the whole character budget, so no confirmed history is included',
    )
  }

  const newestTurn = recent[recent.length - 1]
  if (newestTurn !== undefined && kept.turns[kept.turns.length - 1]?.turnId !== newestTurn.turnId) {
    warnings.push(
      'the newest confirmed turn does not fit the character budget and was dropped from context',
    )
  }

  const historyCharacters = kept.turns.reduce((total, turn) => total + turn.characters, 0)

  return {
    personaBlock: renderPersonaBlock(profile),
    personaSummary: profile.personaSummary,
    styleNotes: profile.styleNotes,
    replyTemplates: intentTemplatesFor(profile, request.responsePlan.replyIntent),
    recalledFacts,
    recallExclusions,
    selectedInputText: request.selectedInput.text,
    replyIntent: request.responsePlan.replyIntent,
    turns: kept.turns,
    history: historyFlat,
    historySource,
    exclusions,
    estimatedCharacters: historyCharacters + recalledCharacters,
    truncatedByTurnLimit,
    truncatedByCharacterLimit: kept.truncated,
    warnings,
  }
}

interface TrimResult {
  turns: AssembledTurn[]
  truncated: boolean
}

/**
 * Remove turns until the character budget is satisfied.
 *
 * The drop order follows ./memory-semantics: segments from a superseded persona
 * first, then whole turns from that persona, then interrupted turns, then the
 * oldest of what remains.
 *
 * The newest turn is protected only while some other turn can give way. When one
 * turn is left and it still exceeds the budget it is the victim as well: keeping
 * it would silently push the context past the configured cap, and a cap that only
 * applies when convenient is not a bound. The loss is recorded as an exclusion
 * and reported in `warnings`, so stored evidence stays complete while the context
 * view stays honest about what it left out.
 */
function trimToCharacterBudget(input: {
  turns: readonly AssembledTurn[]
  maxCharacters: number
  activePersonaVersion: string
  exclusions: ContextExclusion[]
}): TrimResult {
  const { turns, maxCharacters, activePersonaVersion, exclusions } = input
  let dropped = false
  const kept: AssembledTurn[] = [...turns]
  const total = (): number => kept.reduce((sum, turn) => sum + turn.characters, 0)

  while (kept.length > 0 && total() > maxCharacters) {
    const candidateCount = kept.length > 1 ? kept.length - 1 : 1
    let victimIndex = -1
    let victimRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < candidateCount; index += 1) {
      const turn = kept[index]
      if (turn === undefined) continue
      const rank = trimRank({
        personaVersion: turn.personaVersion,
        activePersonaVersion,
        truncated: turn.interrupted,
      })
      // A lower rank is dropped earlier; equal ranks drop the earlier, older turn.
      if (rank < victimRank) {
        victimRank = rank
        victimIndex = index
      }
    }
    if (victimIndex === -1) break

    const victim = kept[victimIndex]
    if (victim === undefined) break
    kept.splice(victimIndex, 1)
    dropped = true
    for (const segment of victim.segments) {
      exclusions.push({
        sessionId: victim.sessionId,
        turnId: victim.turnId,
        segmentId: segment.segmentId,
        reason:
          victim.personaVersion !== null && victim.personaVersion !== activePersonaVersion
            ? 'trim-stale-persona'
            : victim.interrupted
              ? 'trim-truncated'
              : 'character-budget',
      })
    }
  }

  return { turns: kept, truncated: dropped }
}

/**
 * Render an assembled context as a prompt block.
 *
 * An interrupted turn carries an explicit marker. Without it the model would read
 * a truncated fragment as a finished statement and continue from a sentence the
 * audience never heard completed, which is exactly the failure NFR-03 character
 * consistency is meant to catch.
 */
export function renderDialoguePrompt(view: AssembledDialogueContext): string {
  const lines: string[] = [view.personaBlock]

  /*
   * The recall block sits after the standing persona and before history: it is
   * background knowledge rather than a conversation record, and placing it next to
   * the persona makes the model read it as "facts about her" instead of "things
   * she said". Provenance is rendered with the bible entry id so a reviewer can
   * trace it back to character.md.
   */
  if (view.recalledFacts.length > 0) {
    lines.push('Relevant background:')
    for (const entry of view.recalledFacts) lines.push(renderRecallLine(entry))
  }

  if (view.turns.length > 0) {
    lines.push('Already said (confirmed spoken):')
    for (const turn of view.turns) lines.push(renderHistoryLine(turn))
  }

  lines.push(`Listener said: ${view.selectedInputText}`)
  lines.push(`Intent: ${view.replyIntent}`)
  if (view.replyTemplates.length > 0) {
    lines.push('Reference lines for this intent:')
    for (const template of view.replyTemplates) lines.push(`${ITEM_PREFIX}${template}`)
  }

  return lines.join('\n')
}
