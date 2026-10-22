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
import type { RecalledTurn, DeliveryRecallPort } from './memory-recall'
import { MAX_RECALLED_TURNS } from './memory-recall'
import type { ConsistencyAuditSummary, Contradiction, StatementRef } from './consistency'
import { scanContradictions, summarizeConsistencyAudit } from './consistency'
import { scoreSalience, SALIENCE_PIN_THRESHOLD, MAX_PINNED_TURNS } from './salience'
import type { SalienceSignal } from './salience'
import { turnKey, utteranceKey } from './delivery-key'
import type { PersonaRecallPort } from './persona-recall'
import { classifyMemoryBucket, isTruncatedSpeech, modalityRank, trimRank } from './memory-semantics'
import type { MemoryBucketReason } from './memory-semantics'
import { scopeFor } from './audience'
import type { AudienceIdentity, MemoryKind, MemoryScope } from './audience'

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
 * history AND the rendered recalls (persona facts and delivery-memory recalls),
 * which share it and therefore trade off against each other. It does NOT cover
 * the persona block (fixed per turn) or the rest of the model prompt. The cap
 * is hard: nothing assembled here may exceed it. See `estimatedCharacters` for
 * exactly which characters are counted.
 *
 * Retention extras. Two deterministic mechanisms fight the loss of important
 * old turns without widening the budget: salience pinning (./salience) makes
 * high-value turns the last victims of trimming, and a rollup line
 * (`renderRollupLine`) states how many turns were omitted so the model knows
 * something was left out. Neither invents content.
 *
 * Known limitation (recorded rather than hidden): `confirmedEventRefs` carries
 * runtime event ids, but a confirmed record exposes no event id, so a reference
 * cannot be resolved to a record. An unresolved hint must not move durable
 * records, so the references are reported through `warnings` and otherwise
 * ignored: they do not affect which records exist or what order they appear in.
 * If a later contract exposes the delivery-to-event relationship, they can become
 * an exact filter over the authoritative order rather than a reordering hint.
 */

/* -------------------------------------------------------------------------- */
/* Rendered form and character accounting                                     */
/* -------------------------------------------------------------------------- */

/** Prefix of one rendered item inside the history or recall block. */
export const ITEM_PREFIX = '- '

/** Appended to a turn that stopped mid-sentence. Counted in the budget. */
export const INTERRUPTED_SPEECH_MARKER = ' [cut off mid-sentence]'

/**
 * Appended to a turn the consistency scan (./consistency) flagged as
 * contradicting another admitted statement or a standing fact.
 *
 * Opt-in, and OFF by default, because adding text to a rendered line spends
 * budget: with the marker enabled the extra characters are charged and can push
 * a turn out of context. With it disabled the scan is audit-only, so the default
 * behaviour and the character accounting are exactly what they were before the
 * detector existed.
 */
export const CONFLICT_MARKER = ' [conflicting]'

/**
 * Rendered form of one confirmed turn. The single source of truth for both the
 * prompt and the character accounting, so the two cannot drift apart.
 */
export function renderHistoryLine(turn: AssembledTurn): string {
  return `${ITEM_PREFIX}${turn.text}${turn.interrupted ? INTERRUPTED_SPEECH_MARKER : ''}${
    turn.conflicting === true ? CONFLICT_MARKER : ''
  }`
}

/**
 * Rendered form of one recalled fact, including its provenance. Recalled text
 * without provenance cannot be traced back to the bible, so the suffix is part of
 * the rendered line and is charged to the budget.
 */
export function renderRecallLine(entry: RecalledFact): string {
  return `${ITEM_PREFIX}${entry.fact.text} (bible: ${entry.fact.id})`
}

/**
 * Rendered form of the rollup line standing in for turns dropped under budget
 * pressure. It states a COUNT and nothing else: a rollup that paraphrased the
 * dropped turns would be a claim about content the model can no longer see, and
 * inventing it would break the same honesty rule as unmarked truncation.
 */
export function renderRollupLine(omittedTurns: number): string {
  return `${ITEM_PREFIX}(${omittedTurns} earlier turn${omittedTurns === 1 ? '' : 's'} omitted)`
}

/**
 * Rendered form of one recalled older turn, with its provenance. The
 * `(turn: session:turn)` suffix lets a reviewer trace the line back to the
 * stored record, and is charged to the budget like every other rendered
 * character.
 */
export function renderRecalledTurnLine(turn: AssembledTurn): string {
  const marker = turn.interrupted ? INTERRUPTED_SPEECH_MARKER : ''
  const conflict = turn.conflicting === true ? CONFLICT_MARKER : ''
  return `${ITEM_PREFIX}${turn.text}${marker}${conflict} (turn: ${turn.sessionId}:${turn.turnId})`
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
  /**
   * How long this record may live. Defaults to `'utterance'` when the source
   * does not classify it, because an unclassified confirmed record is still
   * something the character said - and an unclassified record must never be
   * treated as a durable one by accident.
   */
  kind?: MemoryKind
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

/** A recalled older turn dropped before rendering, so the loss stays auditable. */
export interface TurnRecallExclusion {
  sessionId: string
  turnId: string
  reason: 'recall-budget'
}

/**
 * The rollup standing in for turns dropped under budget pressure. Null when
 * nothing was trimmed or when even the rollup line did not fit the budget.
 */
export interface ContextRollup {
  omittedTurns: number
  /** Rendered length of the rollup line, charged to the character budget. */
  characters: number
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
  /**
   * True when salience scoring (./salience) pinned this turn. Pinned turns are
   * trimmed last, after every unpinned candidate, but are never exempt from the
   * character budget. Recomputed at every assembly; never persisted.
   */
  pinned: boolean
  /** Raw salience score, kept for the pin cap tie-break and for auditing. */
  salienceScore: number
  /**
   * How long this turn may be kept, decided from its kind and the current
   * audience (./audience). Recomputed at every assembly; never persisted.
   *
   * A `'session-only'` turn is still rendered in this session - scope governs
   * RETENTION, not visibility. It is recorded here so a later stage can refuse
   * to carry the turn past this session instead of having to re-derive the
   * audience to find out.
   */
  scope: MemoryScope
  /** What the turn is about; defaults to `'utterance'`. See `MemoryEntry.kind`. */
  kind: MemoryKind
  /** Which salience signals fired; empty for an unpinned turn. */
  salienceSignals: readonly SalienceSignal[]
  /**
   * True when the consistency scan (./consistency) found this turn contradicting
   * another admitted statement or a standing fact.
   *
   * A review flag, not a verdict: the turn is still admitted and still charged,
   * and its text is never rewritten. Absent on every turn the scan did not flag,
   * and on every turn when the scan found nothing.
   */
  conflicting?: boolean
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
  /** A candidate was dropped for crossing a session boundary without the
   *  durable audience identity that crossing requires. See ./audience. */
  | 'cross-session-scope'

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
  /**
   * Older confirmed turns recalled by delivery-memory recall (./memory-recall).
   * They aged out of the recency window but matched the listener's current
   * message; they are rendered in their own section, charged to the same
   * budget, and never reordered into the recent history. Empty when no
   * `deliveryRecall` port is supplied.
   */
  recalledTurns: readonly RecalledTurn[]
  /** Recalled turns dropped for budget, with the reason. */
  deliveryRecallExclusions: readonly TurnRecallExclusion[]
  /** Rollup line for turns dropped under budget pressure; see ContextRollup. */
  rollup: ContextRollup | null
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
   *     text, and the interrupted / conflict markers when present);
   *   - each recalled fact, as `renderRecallLine` produces it (item prefix, fact
   *     text, and the provenance suffix);
   *   - each recalled older turn, as `renderRecalledTurnLine` produces it;
   *   - the rollup line, as `renderRollupLine` produces it.
   * Section headings, the persona block and the rest of the prompt are not
   * counted, because they are not part of this budget.
   */
  estimatedCharacters: number
  truncatedByTurnLimit: boolean
  truncatedByCharacterLimit: boolean
  warnings: readonly string[]
  /**
   * Contradictions found among admitted statements and standing facts, as ids
   * and counts only (./consistency). Audit evidence: nothing here changes
   * admission, ordering or budget, and no statement text is carried. PARTIAL
   * when `consistencyAudit.incomplete` is true.
   */
  conflicts?: readonly Contradiction[]
  /**
   * Redacted completion summary of the consistency audit (./consistency):
   * counts and a completeness flag only, never statement text. `incomplete` is
   * true when a work ceiling or the findings cap stopped the scan, in which case
   * `conflicts` covers only the inspected part of the history.
   */
  consistencyAudit: ConsistencyAuditSummary
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
  /**
   * Delivery-memory recall over confirmed turns that aged out of the recency
   * window (./memory-recall). The candidates are turns the assembly already
   * loaded, so supplying this port adds no I/O. Omitted means no delivery
   * recall and context is identical to running without the feature.
   */
  deliveryRecall?: DeliveryRecallPort
  /**
   * Who is listening (./audience). Omitted means anonymous, which is the safe
   * direction: an unidentified listener never produces a durable memory.
   *
   * This does not change what is rendered in the current session. It decides how
   * long the assembled turns may be KEPT, and it is the input that lets a later
   * stage refuse a cross-session recall.
   */
  audience?: AudienceIdentity
  /**
   * Archive sessions explicitly authorized by M5's validated reconstruction.
   * This does not grant access to any session outside the selection.
   */
  explicitlySelectedSessionIds?: readonly string[]
  /**
   * Recorded owner of a candidate's memory, when the caller has one
   * (./memory-recall). Automatic cross-session recall is refused without it;
   * explicitly selected archives do not consult it.
   */
  ownerAudienceIdOf?: (turn: AssembledTurn) => string | null
  /**
   * Render `CONFLICT_MARKER` on turns the consistency scan flagged.
   *
   * Off by default and opt-in, because the marker is prompt text: it is charged
   * to `maxCharacters` and can therefore displace another turn. Leave it off
   * when the audit record is enough; turn it on for an operator who wants the
   * model itself to see that an entry is contested. Either way the scan runs and
   * `conflicts` is populated - this switch only decides whether the marker is
   * rendered, never whether the contradiction is detected.
   */
  markConflictingTurns?: boolean
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
    const kind: MemoryKind = first.kind ?? 'utterance'
    const scope = scopeFor(kind, input.audience).scope
    const segments = entries
      .map((entry, order) => ({ entry, order }))
      .sort(
        (left, right) =>
          compareSegmentOrder(left.entry.delivery, right.entry.delivery) ||
          left.order - right.order,
      )
      .map(({ entry }) => entry.delivery)
    const text = turnText(segments)
    const salience = scoreSalience(text)
    const turn: AssembledTurn = {
      sessionId: first.delivery.sessionId,
      turnId: first.delivery.turnId,
      segments,
      text,
      interrupted: isTruncatedSpeech(text),
      personaVersion: first.personaVersion,
      pinned: salience.score >= SALIENCE_PIN_THRESHOLD,
      salienceScore: salience.score,
      salienceSignals: salience.signals,
      scope,
      kind,
      characters: 0,
    }
    // Charged as rendered, so the budget matches what actually reaches the prompt.
    turn.characters = renderHistoryLine(turn).length
    return turn
  })

  /*
   * Consistency scan, BEFORE the recency window and before trimming.
   *
   * Running it here rather than on the kept turns has two reasons. First, a
   * contradiction is evidence about the records, not about the budget: which
   * turns happen to fit must not decide which contradictions are reported.
   * Second, an opt-in `CONFLICT_MARKER` lengthens a rendered line, so marking
   * has to happen before `characters` is used for trimming - otherwise the
   * marker would quietly push the block past `maxCharacters`, and a cap that
   * only applies when convenient is not a bound.
   *
   * The scan covers admitted confirmed turns plus the profile's standing facts,
   * which are the two things the model reads as true. It never runs on recalled
   * persona facts (absent under the `off` policy anyway) and never on the
   * listener's current message.
   *
   * The scan is itself bounded (./consistency): it visits a fixed maximum of
   * statements, text units, claims and comparisons, independent of
   * `maxCharacters`.
   * A tiny prompt budget therefore cannot make the scan unbounded; it can only
   * make the audit partial, and that partiality is reported through
   * `consistencyAudit.incomplete` and the warnings rather than hidden.
   */
  const consistencyScan = scanContradictions({
    statements: [
      ...allTurns.map((turn) => ({
        ref: { kind: 'turn', sessionId: turn.sessionId, turnId: turn.turnId } satisfies StatementRef,
        text: turn.text,
      })),
      ...(profile.standingFacts ?? []).map((text, factIndex) => ({
        ref: { kind: 'persona-fact', factIndex } satisfies StatementRef,
        text,
      })),
    ],
  })
  const conflicts: readonly Contradiction[] = consistencyScan.findings
  const consistencyAudit = summarizeConsistencyAudit(consistencyScan)
  if (input.markConflictingTurns === true && conflicts.length > 0) {
    const flagged = new Set<string>()
    for (const conflict of conflicts) {
      for (const ref of [conflict.left, conflict.right]) {
        if (ref.kind === 'turn') flagged.add(turnKey(ref))
      }
    }
    for (const turn of allTurns) {
      if (!flagged.has(turnKey({ sessionId: turn.sessionId, turnId: turn.turnId }))) continue
      turn.conflicting = true
      turn.characters = renderHistoryLine(turn).length
    }
  }

  const recent = maxTurns === 0 ? [] : allTurns.slice(-maxTurns)
  const truncatedByTurnLimit = recent.length < allTurns.length
  const turnLimitDropped = allTurns.slice(0, Math.max(0, allTurns.length - recent.length))
  for (const turn of turnLimitDropped) {
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
   * Enforce the pin cap. Without it, pinned turns could accumulate until they
   * alone consume the whole budget, recreating the starvation the pin exists to
   * prevent. Highest scores keep the pin; ties keep the OLDER turn, because the
   * pin's purpose is to protect important memories formed early.
   */
  const pinnedTurns = recent.filter((turn) => turn.pinned)
  if (pinnedTurns.length > MAX_PINNED_TURNS) {
    const keep = new Set(
      [...pinnedTurns].sort((a, b) => b.salienceScore - a.salienceScore).slice(0, MAX_PINNED_TURNS),
    )
    for (const turn of pinnedTurns) {
      if (!keep.has(turn)) turn.pinned = false
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

  /*
   * Delivery-memory recall runs on the turns the recency window dropped. The
   * candidates were already loaded with the history, so this adds no I/O. The
   * recalled turns share the same budget, charged after persona recall and
   * before history trimming, and are rendered in their own section so they
   * never blur into the recent chronological order.
   *
   * `maxTurns` is a bound on the turns that reach the prompt in total, not only
   * on the recency window, so recall can never claim more slots than the caller
   * allowed - with `maxTurns: 0` there is no allowance at all.
   */
  const recallAllowance = Math.min(MAX_RECALLED_TURNS, Math.max(0, maxTurns))
  const deliveryRecallResult: readonly RecalledTurn[] =
    maxTurns === 0 || input.deliveryRecall === undefined
      ? []
      : input.deliveryRecall.recall({
          inputText: request.selectedInput.text,
          replyIntent: request.responsePlan.replyIntent,
          candidates: turnLimitDropped,
          // The guard needs the requesting session to compare against; a
          // candidate's own sessionId cannot supply both sides of the check.
          sessionId: request.sessionId,
          scope: scopeFor('utterance', input.audience).scope,
          audience: input.audience,
          explicitlySelectedSessionIds: input.explicitlySelectedSessionIds,
          ...(input.ownerAudienceIdOf === undefined
            ? {}
            : { ownerAudienceIdOf: input.ownerAudienceIdOf }),
        })

  const recalledTurns: RecalledTurn[] = []
  const deliveryRecallExclusions: TurnRecallExclusion[] = []
  let recalledTurnCharacters = 0
  for (const entry of deliveryRecallResult.slice(0, recallAllowance)) {
    const cost = renderRecalledTurnLine(entry.turn).length
    if (recalledCharacters + recalledTurnCharacters + cost > maxCharacters) {
      deliveryRecallExclusions.push({
        sessionId: entry.turn.sessionId,
        turnId: entry.turn.turnId,
        reason: 'recall-budget',
      })
      continue
    }
    recalledTurns.push(entry)
    recalledTurnCharacters += cost
  }

  /*
   * A recalled older turn is still history, so it displaces a recent turn rather
   * than adding to it. Without this, `maxTurns` would bound only the recency
   * window and recall could exceed the caller's request limit - M5's probe with
   * `maxTurns: 0` rendered recalled turns, which is not what the limit says.
   *
   * Displacement starts with the oldest unpinned turn so a pinned turn keeps the
   * protection it was scored for; pinned turns are displaced oldest-first only
   * when the quota cannot be met otherwise. Every displaced turn is recorded, so
   * the loss is auditable rather than silent.
   *
   * Records are identified by the session-and-turn pair, never by `turnId`
   * alone: the turn counter is session-scoped, so a restored session reuses ids
   * that earlier sessions already used. Keying displacement by the bare id made
   * an unrelated turn in another session disappear alongside the intended one —
   * and it took a pinned turn first, which is the record the pin exists to keep.
   */
  const recentQuota = Math.max(0, maxTurns - recalledTurns.length)
  const displaced = new Set<string>()
  const displacementKey = (turn: AssembledTurn): string =>
    turnKey({ sessionId: turn.sessionId, turnId: turn.turnId })
  for (const turn of recent) {
    if (recent.length - displaced.size <= recentQuota) break
    if (!turn.pinned) displaced.add(displacementKey(turn))
  }
  for (const turn of recent) {
    if (recent.length - displaced.size <= recentQuota) break
    displaced.add(displacementKey(turn))
  }
  const recentTurns = recent.filter((turn) => !displaced.has(displacementKey(turn)))
  for (const turn of recent) {
    if (!displaced.has(displacementKey(turn))) continue
    for (const segment of turn.segments) {
      exclusions.push({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        segmentId: segment.segmentId,
        reason: 'turn-limit',
      })
    }
  }

  const availableHistoryCharacters = Math.max(
    0,
    maxCharacters - recalledCharacters - recalledTurnCharacters,
  )

  const kept = trimToCharacterBudget({
    turns: recentTurns,
    maxCharacters: availableHistoryCharacters,
    activePersonaVersion: personaVersionKey(profile.profileId, profile.version),
    exclusions,
  })

  const historyFlat = kept.turns.flatMap((turn) => turn.segments)
  const warnings: string[] = []
  if (refs.size > 0) {
    warnings.push(
      'confirmedEventRefs could not be resolved to records; they are reported only and do not affect order',
    )
  }
  if (kept.turns.some((turn) => turn.interrupted)) {
    warnings.push('context contains an interrupted utterance; it is marked, not completed')
  }
  /*
   * A contradiction is reported as a count only. The finding itself carries ids
   * and counts (./consistency), never text, so this warning stays safe to log
   * and to render in an operator console. Nothing is rewritten or withheld: the
   * model still sees both statements, which is deliberate - silently dropping
   * one would pick a winner on lexical evidence alone.
   */
  if (conflicts.length > 0) {
    warnings.push(
      `${conflicts.length} potential contradiction(s) found among admitted statements or standing facts; recorded for audit and never rewritten`,
    )
  }
  /*
   * An incomplete audit is reported separately from its findings: the count
   * above is then partial, and an operator must not read it as "no further
   * contradictions exist".
   */
  if (consistencyAudit.incomplete) {
    warnings.push(
      'consistency audit is incomplete: some admitted statements or comparisons were not examined, so reported contradictions are partial',
    )
  }
  if (historySource === 'local-stand-in') {
    warnings.push(
      'confirmed history comes from the in-memory store because no durable history source was supplied',
    )
  }
  if (recallExclusions.length > 0) {
    warnings.push('some recalled persona facts were dropped to stay within the character budget')
  }
  if (deliveryRecallExclusions.length > 0) {
    warnings.push('some recalled older turns were dropped to stay within the character budget')
  }
  /*
   * A candidate refused for crossing a session boundary is a different loss from
   * one refused for budget: it happened even when there was room. Without this
   * warning the absence would be silent, and a listener who remembers telling
   * the character something would have no way to learn why it was forgotten.
   */
  const crossSessionDrops = input.deliveryRecall?.crossSessionDrops ?? 0
  if (crossSessionDrops > 0) {
    warnings.push(
      `${crossSessionDrops} older turn(s) from other sessions were not recalled: no durable audience identity with recorded owner evidence for this listener, and the session was not explicitly selected`,
    )
  }
  if (recalledCharacters + recalledTurnCharacters >= maxCharacters && recentTurns.length > 0) {
    warnings.push(
      'recalled content consumes the whole character budget, so no confirmed history is included',
    )
  }

  const newestTurn = recentTurns[recentTurns.length - 1]
  if (newestTurn !== undefined && kept.turns[kept.turns.length - 1]?.turnId !== newestTurn.turnId) {
    warnings.push(
      'the newest confirmed turn does not fit the character budget and was dropped from context',
    )
  }

  const historyCharacters = kept.turns.reduce((total, turn) => total + turn.characters, 0)
  const rollup: ContextRollup | null =
    kept.omittedTurns > 0 && kept.rollupCharacters > 0
      ? { omittedTurns: kept.omittedTurns, characters: kept.rollupCharacters }
      : null

  return {
    personaBlock: renderPersonaBlock(profile),
    personaSummary: profile.personaSummary,
    styleNotes: profile.styleNotes,
    replyTemplates: intentTemplatesFor(profile, request.responsePlan.replyIntent),
    recalledFacts,
    recallExclusions,
    recalledTurns,
    deliveryRecallExclusions,
    rollup,
    selectedInputText: request.selectedInput.text,
    replyIntent: request.responsePlan.replyIntent,
    turns: kept.turns,
    history: historyFlat,
    historySource,
    exclusions,
    estimatedCharacters:
      historyCharacters + recalledCharacters + recalledTurnCharacters + (rollup?.characters ?? 0),
    truncatedByTurnLimit,
    truncatedByCharacterLimit: kept.truncated,
    warnings,
    conflicts,
    consistencyAudit,
  }
}

interface TrimResult {
  turns: AssembledTurn[]
  truncated: boolean
  /** Turns dropped by this trimming, which the rollup line reports. */
  omittedTurns: number
  /** Rendered length of the rollup line that fits the budget; 0 when it does not. */
  rollupCharacters: number
}

/**
 * Remove turns until the character budget is satisfied.
 *
 * The drop order follows ./memory-semantics: pinned turns last; otherwise
 * segments from a superseded persona first, then whole turns from that persona,
 * then interrupted turns, then the oldest of what remains.
 *
 * The newest turn is protected only while some other turn can give way. When one
 * turn is left and it still exceeds the budget it is the victim as well: keeping
 * it would silently push the context past the configured cap, and a cap that only
 * applies when convenient is not a bound. The loss is recorded as an exclusion
 * and reported in `warnings`, so stored evidence stays complete while the context
 * view stays honest about what it left out.
 *
 * Rollup. Dropping a turn without a trace would make the omission invisible to
 * the model, so when at least one turn was dropped and the trimming left enough
 * room, a one-line rollup (`renderRollupLine`) states the count. It is
 * best-effort: it never costs an extra turn, and when it does not fit, the
 * exclusions still record the loss. The rollup never states content, only that
 * earlier turns existed - anything more specific would be a claim about text
 * the model can no longer see.
 */
function trimToCharacterBudget(input: {
  turns: readonly AssembledTurn[]
  maxCharacters: number
  activePersonaVersion: string
  exclusions: ContextExclusion[]
}): TrimResult {
  const { turns, maxCharacters, activePersonaVersion, exclusions } = input
  const kept: AssembledTurn[] = [...turns]
  const total = (): number => kept.reduce((sum, turn) => sum + turn.characters, 0)
  let omittedTurns = 0

  /*
   * Drop the single lowest-ranked candidate. The newest turn is protected while
   * another candidate exists; equal ranks drop the earlier, older turn.
   */
  const dropVictim = (): boolean => {
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
        pinned: turn.pinned,
      })
      if (rank < victimRank) {
        victimRank = rank
        victimIndex = index
      }
    }
    if (victimIndex === -1) return false

    const victim = kept[victimIndex]
    if (victim === undefined) return false
    kept.splice(victimIndex, 1)
    omittedTurns += 1
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
    return true
  }

  while (kept.length > 0 && total() > maxCharacters) {
    if (!dropVictim()) break
  }

  let rollupCharacters = 0
  if (omittedTurns > 0) {
    const line = renderRollupLine(omittedTurns)
    if (total() + line.length <= maxCharacters) {
      rollupCharacters = line.length
    }
  }

  return { turns: kept, truncated: omittedTurns > 0, omittedTurns, rollupCharacters }
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

  /*
   * Recalled older turns sit between background and recent history: they are
   * evidence like the history block, but they are NOT in speaking order with it
   * (they jumped the window by matching the current message), so they get their
   * own section with explicit provenance rather than blending into the recent
   * chronology.
   */
  if (view.recalledTurns.length > 0) {
    lines.push('Earlier, confirmed:')
    for (const entry of view.recalledTurns) lines.push(renderRecalledTurnLine(entry.turn))
  }

  if (view.turns.length > 0 || view.rollup !== null) {
    lines.push('Already said (confirmed spoken):')
    if (view.rollup !== null) lines.push(renderRollupLine(view.rollup.omittedTurns))
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
