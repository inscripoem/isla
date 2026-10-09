import type { DiagnosticReply, DiagnosticRequest } from '../contracts'
import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  toErrorReply,
} from '../contracts'
import { parseDiagnosticRequest } from '../contracts'
import { createHealthResponse } from './health'

export function processDiagnosticMessage(raw: string, uptimeSec: number): DiagnosticReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return toErrorReply({ code: 'malformed', message: 'diagnostic message is not valid JSON' })
  }

  const outcome = parseDiagnosticRequest(parsed)
  if (!outcome.ok) return toErrorReply(outcome.error)

  return handleDiagnosticRequest(outcome.request, uptimeSec)
}

export function handleDiagnosticRequest(
  request: DiagnosticRequest,
  uptimeSec: number,
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

  return toErrorReply({
    code: 'unknown_kind',
    message: `diagnostic kind "${request.kind}" is not implemented`,
    requestedKind: request.kind,
  })
}