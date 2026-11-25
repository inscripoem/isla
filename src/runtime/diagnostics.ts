import type {
  DiagnosticReply,
  DiagnosticRequest,
  MemoryInspectPayload,
  MemoryInspectReply,
  MemoryInspectSource,
} from '../contracts'
import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  MEMORY_INSPECT_KIND,
  MEMORY_INSPECT_SECTION,
  toErrorReply,
} from '../contracts'
import { parseDiagnosticRequest } from '../contracts'
import { createHealthResponse } from './health'

type InspectRead =
  | { readonly observed: MemoryInspectPayload }
  | { readonly unavailable: 'no-observation' | 'diag-plane-unavailable' }

/**
 * Read the supplier, containing a fault.
 *
 * The diagnostics plane must never fail the request because the runtime's
 * observation source failed: a supplier that throws is reported as
 * `diag-plane-unavailable`, and a missing or `null` observation is reported as
 * `no-observation`. Neither is a protocol error.
 */
function readMemoryInspect(source: MemoryInspectSource | undefined): InspectRead {
  if (source === undefined) return { unavailable: 'no-observation' }
  try {
    const payload = source()
    return payload === null ? { unavailable: 'no-observation' } : { observed: payload }
  } catch {
    return { unavailable: 'diag-plane-unavailable' }
  }
}

export function processDiagnosticMessage(
  raw: string,
  uptimeSec: number,
  memoryInspect?: MemoryInspectSource,
): DiagnosticReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return toErrorReply({ code: 'malformed', message: 'diagnostic message is not valid JSON' })
  }

  const outcome = parseDiagnosticRequest(parsed)
  if (!outcome.ok) return toErrorReply(outcome.error)

  return handleDiagnosticRequest(outcome.request, uptimeSec, memoryInspect)
}

export function handleDiagnosticRequest(
  request: DiagnosticRequest,
  uptimeSec: number,
  memoryInspect?: MemoryInspectSource,
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

  if (request.kind === MEMORY_INSPECT_KIND) {
    const read = readMemoryInspect(memoryInspect)
    const payload: MemoryInspectReply =
      'observed' in read
        ? { section: MEMORY_INSPECT_SECTION, inspect: read.observed }
        : { section: MEMORY_INSPECT_SECTION, outcome: 'unavailable', reason: read.unavailable }
    return {
      v: DIAGNOSTICS_PROTOCOL_VERSION,
      ...(request.id !== undefined ? { id: request.id } : {}),
      ok: true,
      kind: MEMORY_INSPECT_KIND,
      payload,
    }
  }

  return toErrorReply({
    code: 'unknown_kind',
    message: `diagnostic kind "${request.kind}" is not implemented`,
    requestedKind: request.kind,
  })
}
