import { DIAGNOSTICS_PROTOCOL_VERSION } from './version'

export const DIAGNOSTIC_KINDS = ['ping', 'get_health'] as const

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