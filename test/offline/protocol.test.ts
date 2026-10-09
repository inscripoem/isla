import { describe, expect, it } from 'vitest'
import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  parseDiagnosticRequest,
  toErrorReply,
  type ParseOutcome,
  type ProtocolError,
} from '../../src/contracts'

function failure(outcome: ParseOutcome): ProtocolError {
  if (outcome.ok) throw new Error('expected the request to be rejected')
  return outcome.error
}

describe('parseDiagnosticRequest', () => {
  it('accepts a ping request', () => {
    const outcome = parseDiagnosticRequest({ v: 1, id: 'p1', kind: 'ping' })
    expect(outcome).toEqual({
      ok: true,
      request: { v: 1, id: 'p1', kind: 'ping', payload: undefined },
    })
  })

  it('accepts a get_health request without an id', () => {
    const outcome = parseDiagnosticRequest({ v: 1, kind: 'get_health' })
    expect(outcome).toEqual({
      ok: true,
      request: { v: 1, id: undefined, kind: 'get_health', payload: undefined },
    })
  })

  it('rejects non-object payloads', () => {
    expect(failure(parseDiagnosticRequest('ping')).code).toBe('malformed')
    expect(failure(parseDiagnosticRequest(['ping'])).code).toBe('malformed')
    expect(failure(parseDiagnosticRequest(null)).code).toBe('malformed')
  })

  it('rejects a missing or non-integer version', () => {
    expect(failure(parseDiagnosticRequest({ kind: 'ping' })).code).toBe('malformed')
    expect(failure(parseDiagnosticRequest({ v: 1.5, kind: 'ping' })).code).toBe('malformed')
  })

  it('rejects an unsupported version and reports the requested version', () => {
    const error = failure(parseDiagnosticRequest({ v: 99, kind: 'ping' }))
    expect(error.code).toBe('unsupported_version')
    expect(error.requestedVersion).toBe(99)
  })

  it('rejects an empty or non-string kind', () => {
    expect(failure(parseDiagnosticRequest({ v: 1, kind: '' })).code).toBe('malformed')
    expect(failure(parseDiagnosticRequest({ v: 1, kind: 3 })).code).toBe('malformed')
  })

  it('rejects a non-string id', () => {
    expect(failure(parseDiagnosticRequest({ v: 1, id: 7, kind: 'ping' })).code).toBe('malformed')
  })

  it('classifies unknown kinds apart from unimplemented application actions', () => {
    expect(failure(parseDiagnosticRequest({ v: 1, kind: 'sing' })).code).toBe('unknown_kind')
    const action = failure(parseDiagnosticRequest({ v: 1, kind: 'app.chat' }))
    expect(action.code).toBe('unsupported_action')
  })
})

describe('toErrorReply', () => {
  it('always reports the current diagnostics protocol version', () => {
    const reply = toErrorReply({
      code: 'unsupported_version',
      message: 'unsupported',
      requestedVersion: 99,
    })
    expect(reply.ok).toBe(false)
    expect(reply.v).toBe(DIAGNOSTICS_PROTOCOL_VERSION)
    if (reply.ok) throw new Error('expected an error reply')
    expect(reply.error.code).toBe('unsupported_version')
  })
})
