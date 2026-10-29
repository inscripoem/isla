import type { AssembledDialogueContext, ContextExclusionReason } from './context'
import type {
  InspectRecall,
  MemoryInspectPayload,
  RecallProvenance,
} from './memory-inspect-contract'
import { MEMORY_INSPECT_SCHEMA_VERSION } from './memory-inspect-contract'

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
 *
 * The declared payload shape lives in ./memory-inspect-contract, so the
 * protocol-1 boundary and the browser consumer can share it without importing
 * assembly internals. This file only builds it.
 */

export type { InspectRecall, MemoryInspectPayload, RecallProvenance }

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
    schemaVersion: MEMORY_INSPECT_SCHEMA_VERSION,
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