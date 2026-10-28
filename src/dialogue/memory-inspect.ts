import type { AssembledDialogueContext, ContextExclusionReason, HistorySource } from './context'
import type { ConsistencyAuditSummary } from './consistency'
import type { ReplyIntent } from '../contracts'

/**
 * Operator memory inspection for one assembled turn.
 *
 * This is a READ-ONLY diagnostic on the diagnostics plane (protocol 1), not an
 * application-contract 0.2 surface. It is owned by M4; M2 consumes a serialized
 * payload and never imports M4 internals into the browser graph.
 *
 * Redaction boundary, by default: this payload carries identifiers, counts,
 * reasons and character counts, and NEVER the text of a memory or of persona
 * content. The consistency audit summary (./consistency) follows the same
 * boundary: counts and a completeness flag only. A debugging workflow that
 * needs text must use an explicit operator-mode switch; the redaction boundary
 * belongs here (the port), not in the consumer.
 *
 * The two admission views are deliberately separate and labelled:
 *   - `admission` (M4) — what this module admitted into spoken context, and why
 *     anything was excluded. This answers "may the character recall this".
 *   - durable confirmed (M6) — durable `fully-delivered` evidence, an audit view
 *     M6 supplies. "Confirmed by M6" is NOT "admitted by M4"; the operator console
 *     must label them separately.
 */

/** Provenance of one recall, as structured fields (not a rendered string). */
export type RecallProvenance =
  | { kind: 'persona-fact'; factId: string }
  | { kind: 'delivery-turn'; sessionId: string; turnId: string }

/** One recall actually injected into the assembled context. */
export interface InspectRecall {
  provenance: RecallProvenance
  /** Deterministic overlap score that selected the item. */
  score: number
}

/** Admission summary for the assembled turn. */
export interface InspectAdmission {
  /**
   * Number of records admitted into spoken history (M4 admission). This is the
   * "may be recalled" view; it is not the M6 durable-confirmed audit view.
   */
  admitted: number
  /** Records excluded from admission, grouped by the reason, with counts. */
  exclusions: Readonly<Partial<Record<ContextExclusionReason, number>>>
  /** Explicit mention of the M6 durable-confirmed view, which is audit-only here. */
  readonly noteM6Confirmed: 'audit-only'
}

/** Redacted memory inspection for one turn. */
export interface MemoryInspectPayload {
  sessionId: string
  turnId: string
  replyIntent: ReplyIntent
  admission: InspectAdmission
  recall: {
    /** Persona facts injected and dropped (budget), with counts. */
    persona: { used: number; dropped: number }
    /** Delivery-memory turns injected and dropped (budget), with counts. */
    delivery: { used: number; dropped: number }
    /** The recalls actually injected, with score and structured provenance. */
    results: readonly InspectRecall[]
  }
  budget: {
    /** Estimated characters charged to the shared context budget. */
    estimatedCharacters: number
    truncatedByTurnLimit: boolean
    truncatedByCharacterLimit: boolean
  }
  /**
   * Redacted completion summary of the consistency audit (./consistency):
   * counts and a completeness flag only, never statement text. `incomplete`
   * means the audit was cut short by a work ceiling or the findings cap, so the
   * reported finding count is partial.
   */
  consistency: ConsistencyAuditSummary
  historySource: HistorySource
  warnings: readonly string[]
}

/**
 * Build the redacted inspection payload for an assembled context.
 *
 * Pure and deterministic: it reads only the fields already assembled and writes
 * nothing. Provenance is returned as structured fields, so the consumer formats
 * it rather than parsing a rendered line. The session/turn identity comes from
 * the generating request, not from the assembled context, which does not carry
 * them.
 */
export function buildMemoryInspect(
  context: AssembledDialogueContext,
  sessionId: string,
  turnId: string,
): MemoryInspectPayload {
  const exclusions: Partial<Record<ContextExclusionReason, number>> = {}
  for (const exclusion of context.exclusions) {
    exclusions[exclusion.reason] = (exclusions[exclusion.reason] ?? 0) + 1
  }

  const results: InspectRecall[] = [
    ...context.recalledFacts.map((entry) => ({
      provenance: { kind: 'persona-fact' as const, factId: entry.fact.id },
      score: entry.score,
    })),
    ...context.recalledTurns.map((entry) => ({
      provenance: {
        kind: 'delivery-turn' as const,
        sessionId: entry.turn.sessionId,
        turnId: entry.turn.turnId,
      },
      score: entry.score,
    })),
  ]

  return {
    sessionId,
    turnId,
    replyIntent: context.replyIntent,
    admission: {
      admitted: context.turns.reduce(
        (total, turn) => total + turn.segments.length,
        0,
      ),
      exclusions,
      noteM6Confirmed: 'audit-only',
    },
    recall: {
      persona: {
        used: context.recalledFacts.length,
        dropped: context.recallExclusions.length,
      },
      delivery: {
        used: context.recalledTurns.length,
        dropped: context.deliveryRecallExclusions.length,
      },
      results,
    },
    budget: {
      estimatedCharacters: context.estimatedCharacters,
      truncatedByTurnLimit: context.truncatedByTurnLimit,
      truncatedByCharacterLimit: context.truncatedByCharacterLimit,
    },
    consistency: { ...context.consistencyAudit },
    historySource: context.historySource,
    warnings: [...context.warnings],
  }
}