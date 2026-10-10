import { z } from 'zod'
import type { ErrorCode } from './primitives'
import {
  appendAckSchema,
  atomicCommitAckSchema,
  confirmedDeliverySchema,
  runtimeEventSchema,
} from './storage'
import type { AppendAck, AtomicCommitAck, ConfirmedDelivery, RuntimeEvent } from './storage'
import {
  bootstrapSnapshotSchema,
  browserMessageSchema,
  clientMessageSchema,
  controlAckMessageSchema,
  controlAckSchema,
  inputAckMessageSchema,
  inputAckSchema,
  playerMessageSchema,
  serverMessageSchema,
  sessionSnapshotMessageSchema,
} from './wire'
import type {
  BootstrapSnapshot,
  BrowserMessage,
  ClientMessage,
  ControlAck,
  ControlAckMessage,
  ControlResumeMessage,
  ControlStopMessage,
  InputAck,
  InputAckMessage,
  InputSubmitMessage,
  PlayerMessage,
  ServerMessage,
  SessionSnapshotMessage,
} from './wire'

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; path?: string } }

type SafeParseLike<T> =
  | { success: true; data: T }
  | { success: false; error: z.ZodError }

/**
 * Boundary parsing only. Business policy (epoch/freshness, fallback, receipt
 * reconciliation, delivery classification) belongs to its owning module (M5/M4)
 * and is not implemented here.
 */
function fromZod<T>(result: SafeParseLike<T>): ValidationResult<T> {
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : undefined
  return {
    ok: false,
    error: {
      code: 'invalid_field',
      message: issue?.message ?? 'payload failed validation',
      ...(path !== undefined ? { path } : {}),
    },
  }
}

export function parseBrowserMessage(raw: unknown): ValidationResult<BrowserMessage> {
  return fromZod(browserMessageSchema.safeParse(raw))
}

export function parseClientMessage(raw: unknown): ValidationResult<ClientMessage> {
  return fromZod(clientMessageSchema.safeParse(raw))
}

export function parseServerMessage(raw: unknown): ValidationResult<ServerMessage> {
  return fromZod(serverMessageSchema.safeParse(raw))
}

export function parsePlayerMessage(raw: unknown): ValidationResult<PlayerMessage> {
  return fromZod(playerMessageSchema.safeParse(raw))
}

export function parseBootstrapSnapshot(raw: unknown): ValidationResult<BootstrapSnapshot> {
  return fromZod(bootstrapSnapshotSchema.safeParse(raw))
}

export function parseInputAck(raw: unknown): ValidationResult<InputAck> {
  return fromZod(inputAckSchema.safeParse(raw))
}

export function parseControlAck(raw: unknown): ValidationResult<ControlAck> {
  return fromZod(controlAckSchema.safeParse(raw))
}

export function parseInputAckMessage(raw: unknown): ValidationResult<InputAckMessage> {
  return fromZod(inputAckMessageSchema.safeParse(raw))
}

export function parseControlAckMessage(raw: unknown): ValidationResult<ControlAckMessage> {
  return fromZod(controlAckMessageSchema.safeParse(raw))
}

/**
 * Pure wire-to-port conversion shared by both transports.
 *
 * A session.snapshot wire message carries `payload.lastSeq`; the Bootstrap
 * snapshot's `seq` is that value. These helpers do not perform any side effects
 * or decode anything but the corresponding envelope, so M2 and M5 cannot drift.
 */
export function wireToBootstrapSnapshot(raw: unknown): ValidationResult<BootstrapSnapshot> {
  const parsed = sessionSnapshotMessageSchema.safeParse(raw)
  if (!parsed.success) return fromZod(parsed)
  const message = parsed.data
  return {
    ok: true,
    value: {
      protocolVersion: message.protocolVersion,
      messageId: message.messageId,
      sessionId: message.sessionId,
      epoch: message.epoch,
      seq: message.payload.lastSeq,
      lifecycle: message.payload.lifecycle,
      activeTurnId: message.payload.activeTurnId,
      performerStatus: message.payload.performerStatus,
      outputConfirmation: message.payload.outputConfirmation,
      capabilityRevision: message.payload.capabilityRevision,
    },
  }
}

export function bootstrapSnapshotToWire(
  snapshot: BootstrapSnapshot,
  messageId: string = snapshot.messageId,
): SessionSnapshotMessage {
  return sessionSnapshotMessageSchema.parse({
    protocolVersion: snapshot.protocolVersion,
    messageId,
    sessionId: snapshot.sessionId,
    epoch: snapshot.epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: snapshot.lifecycle,
      activeTurnId: snapshot.activeTurnId,
      performerStatus: snapshot.performerStatus,
      outputConfirmation: snapshot.outputConfirmation,
      capabilityRevision: snapshot.capabilityRevision,
      lastSeq: snapshot.seq,
    },
  })
}

export function wireToInputAck(raw: unknown): ValidationResult<InputAck> {
  const parsed = inputAckMessageSchema.safeParse(raw)
  if (!parsed.success) return fromZod(parsed)
  return { ok: true, value: parsed.data.payload }
}

export function inputAckToWire(payload: InputAck, messageId: string): InputAckMessage {
  return inputAckMessageSchema.parse({
    protocolVersion: '0.2',
    messageId,
    sessionId: payload.sessionId,
    epoch: payload.epoch,
    kind: 'input.ack',
    payload,
  })
}

/**
 * Correlates an input ack to the originating input.submit request: the ack must
 * echo the request message id, session and epoch.
 */
export function inputAckCorrelates(payload: InputAck, request: InputSubmitMessage): boolean {
  return (
    payload.requestMessageId === request.messageId &&
    payload.sessionId === request.sessionId &&
    payload.epoch === request.epoch
  )
}

export function wireToControlAck(raw: unknown): ValidationResult<ControlAck> {
  const parsed = controlAckMessageSchema.safeParse(raw)
  if (!parsed.success) return fromZod(parsed)
  return { ok: true, value: parsed.data.payload }
}

export function controlAckToWire(payload: ControlAck, messageId: string): ControlAckMessage {
  return controlAckMessageSchema.parse({
    protocolVersion: '0.2',
    messageId,
    sessionId: payload.sessionId,
    epoch: payload.epoch,
    kind: 'control.ack',
    payload,
  })
}

/**
 * Correlates a control ack to the originating control request. The session,
 * request id, message id and action must match, and the resulting epoch may be
 * unchanged (refused or duplicate) or advanced by one (applied), never anything
 * else. This is identity/correlation validation only; it does not verify the
 * authoritative runtime state transition, which the runtime owns.
 */
export function controlAckCorrelates(
  payload: ControlAck,
  request: ControlStopMessage | ControlResumeMessage,
): boolean {
  const expectsAction = request.kind === 'control.stop' ? 'stop' : 'resume'
  return (
    payload.requestId === request.payload.requestId &&
    payload.requestMessageId === request.messageId &&
    payload.sessionId === request.sessionId &&
    payload.action === expectsAction &&
    (payload.epoch === payload.previousEpoch || payload.epoch === payload.previousEpoch + 1)
  )
}

/** Validation alias that accepts the raw wire message for the snapshot. */
export function normalizeBootstrapSnapshot(raw: unknown): ValidationResult<BootstrapSnapshot> {
  return wireToBootstrapSnapshot(raw)
}

export function normalizeInputAck(raw: unknown): ValidationResult<InputAck> {
  return wireToInputAck(raw)
}

export function normalizeControlAck(raw: unknown): ValidationResult<ControlAck> {
  return wireToControlAck(raw)
}

export function parseRuntimeEvent(raw: unknown): ValidationResult<RuntimeEvent> {
  return fromZod(runtimeEventSchema.safeParse(raw))
}

export function parseAppendAck(raw: unknown): ValidationResult<AppendAck> {
  return fromZod(appendAckSchema.safeParse(raw))
}

export function parseAtomicCommitAck(raw: unknown): ValidationResult<AtomicCommitAck> {
  return fromZod(atomicCommitAckSchema.safeParse(raw))
}

export function parseConfirmedDelivery(raw: unknown): ValidationResult<ConfirmedDelivery> {
  return fromZod(confirmedDeliverySchema.safeParse(raw))
}
