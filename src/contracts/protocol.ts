import { DIAGNOSTICS_PROTOCOL_VERSION } from './version'
import type {
  ConsistencyAuditSummary,
  InspectRecall,
  MemoryInspectReplyPayload,
  MemoryInspectUnavailable,
} from '../dialogue/memory-inspect-contract'

export const DIAGNOSTIC_KINDS = ['ping', 'get_health', 'get_memory_inspect'] as const

export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number]

export type ProtocolErrorCode =
  | 'malformed'
  | 'unsupported_version'
  | 'unknown_kind'
  | 'unsupported_action'

export interface DiagnosticRequest {
  v: number
  id?: string
  kind: string
  payload?: unknown
}

export interface ProtocolError {
  code: ProtocolErrorCode
  message: string
  requestedVersion?: number
  requestedKind?: string
}

export type DiagnosticReply =
  | {
      v: number
      id?: string
      ok: true
      kind: DiagnosticKind
      payload?: unknown
    }
  | {
      v: number
      id?: string
      ok: false
      kind: string
      error: {
        code: ProtocolErrorCode
        message: string
        requestedVersion?: number
        requestedKind?: string
      }
    }

/*
 * Reply for `get_memory_inspect`, on the diagnostics plane (protocol 1).
 *
 * The payload shape is declared once, in
 * src/dialogue/memory-inspect-contract.ts, so the producer (M4), this boundary
 * and the browser consumer (M2) cannot drift apart. It is imported here as a
 * TYPE ONLY: the contracts module must stay free of runtime imports from
 * src/dialogue, and an erased type import adds no edge to the module graph.
 *
 * `unavailable` is a protocol-1 SUCCESS with a stated reason, not an error: a
 * runtime that has not assembled a turn yet has no observation to report, and
 * "nothing observed" must not be confused with "no contradictions".
 */
export type MemoryInspectReply =
  | {
      v: number
      id?: string
      ok: true
      kind: 'get_memory_inspect'
      payload: MemoryInspectReplyPayload
    }
  | {
      v: number
      id?: string
      ok: true
      kind: 'get_memory_inspect'
      payload: MemoryInspectUnavailable
    }

export type ParseOutcome =
  | { ok: true; request: DiagnosticRequest }
  | { ok: false; error: ProtocolError }

const DOTTED_ACTION = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/

const SUPPORTED_KINDS: readonly string[] = DIAGNOSTIC_KINDS

export function parseDiagnosticRequest(raw: unknown): ParseOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'diagnostic request must be a JSON object' },
    }
  }

  const record = raw as Record<string, unknown>

  if (typeof record.v !== 'number' || !Number.isInteger(record.v)) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'diagnostic request requires an integer "v" version field' },
    }
  }

  if (record.v !== DIAGNOSTICS_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: 'unsupported_version',
        message:
          `unsupported diagnostic protocol version ${record.v}; ` +
          `supported version is ${DIAGNOSTICS_PROTOCOL_VERSION}`,
        requestedVersion: record.v,
      },
    }
  }

  if (typeof record.kind !== 'string' || record.kind.length === 0) {
    return {
      ok: false,
      error: { code: 'malformed', message: 'diagnostic request requires a non-empty string "kind"' },
    }
  }

  if (record.id !== undefined && typeof record.id !== 'string') {
    return {
      ok: false,
      error: {
        code: 'malformed',
        message: 'diagnostic request "id" must be a string when present',
        requestedKind: record.kind,
      },
    }
  }

  if (!SUPPORTED_KINDS.includes(record.kind)) {
    if (DOTTED_ACTION.test(record.kind)) {
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            `application action "${record.kind}" is not implemented by the ` +
            'loopback diagnostic boundary',
          requestedKind: record.kind,
        },
      }
    }
    return {
      ok: false,
      error: {
        code: 'unknown_kind',
        message: `unknown diagnostic kind "${record.kind}"`,
        requestedKind: record.kind,
      },
    }
  }

  return {
    ok: true,
    request: { v: record.v, id: record.id, kind: record.kind, payload: record.payload },
  }
}

export function toErrorReply(error: ProtocolError): DiagnosticReply {
  return {
    v: DIAGNOSTICS_PROTOCOL_VERSION,
    ok: false,
    kind: error.requestedKind ?? 'diagnostic_error',
    error: {
      code: error.code,
      message: error.message,
      ...(error.requestedVersion !== undefined ? { requestedVersion: error.requestedVersion } : {}),
      ...(error.requestedKind !== undefined ? { requestedKind: error.requestedKind } : {}),
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Strict memory-inspect reply parsing                                        */
/* -------------------------------------------------------------------------- */

type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

function parseCountPair(value: unknown): Outcome<{ used: number; dropped: number }> {
  if (!isRecord(value) || !hasExactKeys(value, ['used', 'dropped'])) {
    return { ok: false, reason: 'recall count pair must carry exactly used and dropped' }
  }
  if (!isCount(value.used) || !isCount(value.dropped)) {
    return { ok: false, reason: 'recall counts must be non-negative integers' }
  }
  return { ok: true, value: { used: value.used, dropped: value.dropped } }
}

function parseRecall(value: unknown): Outcome<Record<string, unknown>> {
  if (!isRecord(value) || !hasExactKeys(value, ['provenance', 'score'])) {
    return { ok: false, reason: 'recall entry must carry exactly provenance and score' }
  }
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    return { ok: false, reason: 'recall score must be a finite number' }
  }
  const provenance = value.provenance
  if (!isRecord(provenance)) {
    return { ok: false, reason: 'recall provenance must be an object' }
  }
  if (provenance.kind === 'persona-fact') {
    if (!hasExactKeys(provenance, ['kind', 'factId']) || !isText(provenance.factId)) {
      return { ok: false, reason: 'persona-fact provenance carries kind and factId only' }
    }
    return { ok: true, value: { provenance, score: value.score } }
  }
  if (provenance.kind === 'delivery-turn') {
    if (
      !hasExactKeys(provenance, ['kind', 'sessionId', 'turnId']) ||
      !isText(provenance.sessionId) ||
      !isText(provenance.turnId)
    ) {
      return { ok: false, reason: 'delivery-turn provenance carries kind, sessionId and turnId only' }
    }
    return { ok: true, value: { provenance, score: value.score } }
  }
  return { ok: false, reason: 'recall provenance kind is unknown' }
}

/**
 * Parse one serialized `memory.inspect` payload from an untrusted reply.
 *
 * Strict by design. The consumer refuses an unknown `schemaVersion`, a missing
 * or extra field, a non-integer count and an unknown provenance kind, rather
 * than patching a default: a panel showing a patched zero would assert "no
 * contradictions" or "nothing admitted" on evidence it does not have.
 *
 * The optional `ContextExclusionReason` keys of `admission.exclusions` are not
 * enumerated here on purpose - they are open-ended in the producer - but every
 * value must still be a non-negative integer.
 */
export function parseMemoryInspectPayload(raw: unknown): Outcome<MemoryInspectReplyPayload> {
  if (!isRecord(raw) || !hasExactKeys(raw, ['section', 'inspect'])) {
    return { ok: false, reason: 'payload must carry exactly section and inspect' }
  }
  if (raw.section !== 'memory.inspect') {
    return { ok: false, reason: 'payload section is not memory.inspect' }
  }
  const inspect = raw.inspect
  const inspectKeys = [
    'schemaVersion',
    'sessionId',
    'turnId',
    'replyIntent',
    'admission',
    'recall',
    'budget',
    'consistency',
    'historySource',
    'warnings',
  ] as const
  if (!isRecord(inspect) || !hasExactKeys(inspect, inspectKeys)) {
    return { ok: false, reason: 'inspect record must carry exactly the declared fields' }
  }
  if (inspect.schemaVersion !== 1) {
    return { ok: false, reason: 'unknown memory.inspect schemaVersion' }
  }
  if (!isText(inspect.sessionId) || !isText(inspect.turnId) || !isText(inspect.replyIntent)) {
    return { ok: false, reason: 'sessionId, turnId and replyIntent must be non-empty strings' }
  }

  const admission = inspect.admission
  if (
    !isRecord(admission) ||
    !hasExactKeys(admission, ['admitted', 'exclusions', 'noteM6Confirmed'])
  ) {
    return { ok: false, reason: 'admission must carry admitted, exclusions and noteM6Confirmed' }
  }
  if (!isCount(admission.admitted)) {
    return { ok: false, reason: 'admission.admitted is an admitted SEGMENT count' }
  }
  if (!isRecord(admission.exclusions) || !Object.values(admission.exclusions).every(isCount)) {
    return { ok: false, reason: 'admission.exclusions must map reasons to non-negative counts' }
  }
  if (admission.noteM6Confirmed !== 'audit-only') {
    return { ok: false, reason: 'the M6 durable-confirmed view is audit-only' }
  }

  const recall = inspect.recall
  if (!isRecord(recall) || !hasExactKeys(recall, ['persona', 'delivery', 'results'])) {
    return { ok: false, reason: 'recall must carry persona, delivery and results' }
  }
  const persona = parseCountPair(recall.persona)
  if (!persona.ok) return persona
  const delivery = parseCountPair(recall.delivery)
  if (!delivery.ok) return delivery
  if (!Array.isArray(recall.results)) {
    return { ok: false, reason: 'recall.results must be an array' }
  }
  const results: Record<string, unknown>[] = []
  for (const entry of recall.results) {
    const parsed = parseRecall(entry)
    if (!parsed.ok) return parsed
    results.push(parsed.value)
  }

  const budget = inspect.budget
  if (
    !isRecord(budget) ||
    !hasExactKeys(budget, [
      'estimatedCharacters',
      'truncatedByTurnLimit',
      'truncatedByCharacterLimit',
    ])
  ) {
    return { ok: false, reason: 'budget must carry the three declared fields' }
  }
  if (!isCount(budget.estimatedCharacters)) {
    return { ok: false, reason: 'budget.estimatedCharacters must be a non-negative integer' }
  }
  if (
    typeof budget.truncatedByTurnLimit !== 'boolean' ||
    typeof budget.truncatedByCharacterLimit !== 'boolean'
  ) {
    return { ok: false, reason: 'budget truncation flags must be booleans' }
  }

  const consistency = inspect.consistency
  if (
    !isRecord(consistency) ||
    !hasExactKeys(consistency, [
      'findings',
      'incomplete',
      'statementsOffered',
      'statementsVisited',
      'statementsExamined',
      'textUnits',
      'claims',
      'comparisons',
    ])
  ) {
    return { ok: false, reason: 'consistency must carry the declared summary fields' }
  }
  for (const key of [
    'findings',
    'statementsOffered',
    'statementsVisited',
    'statementsExamined',
    'textUnits',
    'claims',
    'comparisons',
  ] as const) {
    if (!isCount(consistency[key])) {
      return { ok: false, reason: `consistency.${key} must be a non-negative integer` }
    }
  }
  if (typeof consistency.incomplete !== 'boolean') {
    return { ok: false, reason: 'consistency.incomplete must be a boolean' }
  }

  if (
    inspect.historySource !== 'history-port' &&
    inspect.historySource !== 'local-stand-in' &&
    inspect.historySource !== 'none'
  ) {
    return { ok: false, reason: 'historySource is not a declared history source' }
  }
  if (!isTextList(inspect.warnings)) {
    return { ok: false, reason: 'warnings must be an array of strings' }
  }

  return {
    ok: true,
    value: {
      section: 'memory.inspect',
      inspect: {
        schemaVersion: 1,
        sessionId: inspect.sessionId,
        turnId: inspect.turnId,
        replyIntent: inspect.replyIntent,
        admission: {
          admitted: admission.admitted,
          exclusions: admission.exclusions as Readonly<Record<string, number>>,
          noteM6Confirmed: 'audit-only',
        },
        recall: {
          persona: persona.value,
          delivery: delivery.value,
          results: results as unknown as readonly InspectRecall[],
        },
        budget: {
          estimatedCharacters: budget.estimatedCharacters,
          truncatedByTurnLimit: budget.truncatedByTurnLimit,
          truncatedByCharacterLimit: budget.truncatedByCharacterLimit,
        },
        consistency: consistency as unknown as ConsistencyAuditSummary,
        historySource: inspect.historySource,
        warnings: inspect.warnings,
      },
    },
  }
}

/**
 * The honest "nothing to report" reply: a valid protocol-1 success that says no
 * observation exists, so a consumer renders "not observed" and never a zero.
 */
export function memoryInspectUnavailable(reason: MemoryInspectUnavailable['reason']): MemoryInspectUnavailable {
  return { section: 'memory.inspect', outcome: 'unavailable', reason }
}