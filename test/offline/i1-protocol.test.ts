import { describe, expect, it } from 'vitest'
import {
  applicationClientMessageSchema,
  applicationServerMessageSchema,
  parseApplicationClientMessage,
  performanceGrantMessageSchema,
  performanceOfferMessageSchema,
  performanceReadyMessageSchema,
  requestError,
} from '../../src/contracts'
import { fixturePerformanceCommand } from '../support/fixture-data'

const command = fixturePerformanceCommand()

describe('I1 application transport extension', () => {
  it('accepts a performer ready on the client union and rejects server-only kinds', () => {
    const ready = {
      protocolVersion: '0.2',
      messageId: 'ready-1',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.ready',
      payload: { outputId: command.outputId, turnId: command.turnId, segmentId: command.segmentId },
    }
    expect(performanceReadyMessageSchema.safeParse(ready).success).toBe(true)
    expect(applicationClientMessageSchema.safeParse(ready).success).toBe(true)
    const parsed = parseApplicationClientMessage(ready)
    expect(parsed.ok).toBe(true)
    // A server-only grant must not be accepted from a client.
    const grant = {
      protocolVersion: '0.2',
      messageId: 'g-1',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.grant',
      payload: {
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        remainingLifetimeMs: 100,
      },
    }
    expect(applicationClientMessageSchema.safeParse(grant).success).toBe(false)
    expect(applicationServerMessageSchema.safeParse(grant).success).toBe(true)
  })

  it('validates offer and grant payloads strictly', () => {
    const offer = {
      protocolVersion: '0.2',
      messageId: 'o-1',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.offer',
      payload: command,
    }
    expect(performanceOfferMessageSchema.safeParse(offer).success).toBe(true)
    expect(
      performanceOfferMessageSchema.safeParse({ ...offer, payload: { ...command, extra: true } }).success,
    ).toBe(false)

    const grantMessage = {
      protocolVersion: '0.2',
      messageId: 'g-2',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.grant',
      payload: {
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        remainingLifetimeMs: 250,
      },
    }
    expect(performanceGrantMessageSchema.safeParse(grantMessage).success).toBe(true)
    expect(
      performanceGrantMessageSchema.safeParse({
        ...grantMessage,
        payload: { ...grantMessage.payload, remainingLifetimeMs: -1 },
      }).success,
    ).toBe(false)
    expect(
      performanceGrantMessageSchema.safeParse({
        ...grantMessage,
        payload: { ...grantMessage.payload, remainingLifetimeMs: Number.NaN },
      }).success,
    ).toBe(false)
  })

  it('rejects offer and grant envelope/payload identity mismatch', () => {
    const offer = {
      protocolVersion: '0.2',
      messageId: 'o-1',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.offer',
      payload: command,
    }
    expect(performanceOfferMessageSchema.safeParse(offer).success).toBe(true)
    expect(
      performanceOfferMessageSchema.safeParse({ ...offer, epoch: command.epoch + 1 }).success,
    ).toBe(false)
    expect(
      performanceOfferMessageSchema.safeParse({ ...offer, sessionId: 'other-session' }).success,
    ).toBe(false)

    const grant = {
      protocolVersion: '0.2',
      messageId: 'g-3',
      sessionId: command.sessionId,
      epoch: command.epoch,
      kind: 'performance.grant',
      payload: {
        outputId: command.outputId,
        sessionId: command.sessionId,
        epoch: command.epoch,
        turnId: command.turnId,
        segmentId: command.segmentId,
        remainingLifetimeMs: 250,
      },
    }
    expect(performanceGrantMessageSchema.safeParse(grant).success).toBe(true)
    expect(
      performanceGrantMessageSchema.safeParse({
        ...grant,
        payload: { ...grant.payload, epoch: command.epoch + 1 },
      }).success,
    ).toBe(false)
    expect(
      performanceGrantMessageSchema.safeParse({
        ...grant,
        payload: { ...grant.payload, sessionId: 'other-session' },
      }).success,
    ).toBe(false)
  })

  it('builds a correlated request.error envelope', () => {
    const error = requestError(command.sessionId, command.epoch, 'm-err', 'req-1', 'unauthorized', 'no')
    expect(error.kind).toBe('request.error')
    expect(error.sessionId).toBe(command.sessionId)
    const payload = error.payload as { requestId?: string | null; code?: string }
    expect(payload.requestId).toBe('req-1')
    expect(payload.code).toBe('unauthorized')
  })
})
