import type { DiagnosticReply, DiagnosticRequest } from '../contracts'
import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  toErrorReply,
} from '../contracts'
import { parseDiagnosticRequest } from '../contracts'
import { createHealthResponse } from './health'
import { buildMemoryInspectReply, type MemoryInspectSource } from './memory-inspect-reply'

export interface DiagnosticOptions {
  /** Optional observation source for `get_memory_inspect`; omit when none exists. */
  readonly memoryInspect?: MemoryInspectSource
}

export function processDiagnosticMessage(
  raw: string,
  uptimeSec: number,
  options: DiagnosticOptions = {},
): DiagnosticReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return toErrorReply({ code: 'malformed', message: 'diagnostic message is not valid JSON' })
  }

  const outcome = parseDiagnosticRequest(parsed)
  if (!outcome.ok) return toErrorReply(outcome.error)

  return handleDiagnosticRequest(outcome.request, uptimeSec, options)
}

export function handleDiagnosticRequest(
  request: DiagnosticRequest,
  uptimeSec: number,
  options: DiagnosticOptions = {},
): DiagnosticReply {
  if (request.kind === 'ping') {
    return {
      v: DIAGNOSTICS_PROTOCOL_VERSION,
      ...(request.id !== undefined ? { id: request.id } : {}),
      ok: true,
      kind: 'ping',
      payload: { pong: true, at: new Date().toISOString() },
    }
  }

  if (request.kind === 'get_health') {
    return {
      v: DIAGNOSTICS_PROTOCOL_VERSION,
      ...(request.id !== undefined ? { id: request.id } : {}),
      ok: true,
      kind: 'get_health',
      payload: createHealthResponse(uptimeSec),
    }
  }

  if (request.kind === 'get_memory_inspect') {
    /*
     * The identity comes from the request payload. A malformed payload is a
     * request error, not an "unavailable" answer: asking for nothing is a
     * client defect and must not be indistinguishable from "nothing observed".
     */
    const scope = parseInspectScope(request.payload)
    if (scope === null) {
      return toErrorReply({
        code: 'malformed',
        message: 'get_memory_inspect requires payload { sessionId, turnId } as non-empty strings',
        requestedKind: request.kind,
      })
    }
    return buildMemoryInspectReply(request.id, options.memoryInspect, scope)
  }

  return toErrorReply({
    code: 'unknown_kind',
    message: `diagnostic kind "${request.kind}" is not implemented`,
    requestedKind: request.kind,
  })
}

/** Strict scope parser: the inspection is always for one explicit turn. */
export function parseInspectScope(
  payload: unknown,
): { readonly sessionId: string; readonly turnId: string } | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('sessionId') || !keys.includes('turnId')) return null
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return null
  if (typeof record.turnId !== 'string' || record.turnId.length === 0) return null
  return { sessionId: record.sessionId, turnId: record.turnId }
}