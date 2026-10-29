import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  memoryInspectUnavailable,
  type DiagnosticReply,
  type MemoryInspectReply,
} from '../contracts'
import type { MemoryInspectPayload, MemoryInspectReplyPayload } from '../dialogue'

/*
 * The `get_memory_inspect` diagnostic reply builder (protocol 1).
 *
 * The dialogue module owns the payload; this builder owns only the reply
 * envelope, so the runtime does not depend on assembly internals and the
 * dialogue module does not depend on the transport.
 *
 * The observation is INJECTED, never derived here. M4 assembles the payload for
 * a specific (sessionId, turnId) and hands it in; when no observation exists
 * this returns an explicit `unavailable` payload, because an empty panel and a
 * "nothing observed" panel must not look the same. M2 refuses to patch zeros
 * from either.
 */

/** One observation the runtime is able to report, keyed by its own identity. */
export interface MemoryInspectObservation {
  readonly sessionId: string
  readonly turnId: string
  readonly payload: MemoryInspectPayload
}

/**
 * Source of inspection observations. Optional: a runtime that never assembled a
 * turn supplies none, and the reply is `no-observation` rather than an error.
 */
export interface MemoryInspectSource {
  /** The most recent assembled turn, or null when none exists. */
  latest(sessionId: string, turnId: string): MemoryInspectObservation | null
}

/** Envelope for one observation. */
export function toMemoryInspectPayload(
  observation: MemoryInspectObservation,
): MemoryInspectReplyPayload {
  return { section: 'memory.inspect', inspect: observation.payload }
}

/**
 * Build the reply for `get_memory_inspect`.
 *
 * When `source` is omitted the diagnostic plane is present but holds no
 * observation, which is `no-observation`. A request asking for a specific turn
 * that the source does not hold is also `no-observation`; it is never answered
 * with a zeroed payload.
 */
export function buildMemoryInspectReply(
  id: string | undefined,
  source: MemoryInspectSource | undefined,
  request: { sessionId?: string; turnId?: string } = {},
): DiagnosticReply & MemoryInspectReply {
  if (source === undefined) {
    return reply(id, memoryInspectUnavailable('diag-plane-unavailable'))
  }
  if (request.sessionId === undefined || request.turnId === undefined) {
    return reply(id, memoryInspectUnavailable('no-observation'))
  }
  const observation = source.latest(request.sessionId, request.turnId)
  if (observation === null) {
    return reply(id, memoryInspectUnavailable('no-observation'))
  }
  return reply(id, toMemoryInspectPayload(observation))
}

function reply(id: string | undefined, payload: MemoryInspectReplyPayload | ReturnType<typeof memoryInspectUnavailable>): DiagnosticReply & MemoryInspectReply {
  return {
    v: DIAGNOSTICS_PROTOCOL_VERSION,
    ...(id !== undefined ? { id } : {}),
    ok: true,
    kind: 'get_memory_inspect',
    payload,
  } as DiagnosticReply & MemoryInspectReply
}
