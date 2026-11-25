import { describe, expect, it } from 'vitest'
import { decisionResultSchema, selectionResultSchema } from '../../src/contracts'
import {
  JEV_DEFAULT_PROVIDER_NAME,
  createJevReactionPort,
  createJevSelectionPort,
} from '../../src/decision'
import { createCallContext } from '../support/context'
import {
  fixtureDecisionRequest,
  fixtureInputEvent,
  fixtureSelectionRequest,
} from '../support/fixture-data'
import { readLiveJevProviderConfig } from './live-config'

/*
 * Live acceptance harness for the M3 TypeSafe Jev decisions adapters.
 *
 * Jev is not an OpenAI chat model: it is called on `POST /v1/decisions` with a
 * typed `questions` array. The suite skips itself when the Jev provider group is
 * not configured, so running it without credentials is a clean skip, never a
 * failure. Nothing is constructed at module scope beyond reading that
 * configuration report; every port is built inside a case.
 *
 * Credential rules (AGENTS.md): the configured credential is compared, never
 * printed. No case logs a key, interpolates one into a message, or shows a
 * response body.
 */
const report = readLiveJevProviderConfig()

/** Wall-clock domain, matching the `Date.now()`-based deadlines built below. */
const clock = { nowMs: () => Date.now() }

describe.skipIf(!report.available)('M3 live Jev decisions provider', () => {
  it('returns a schema-valid selection result from a real decisions call', async () => {
    const config = report.config!
    const port = createJevSelectionPort({
      clock,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
    })
    const nowMs = Date.now()
    const request = fixtureSelectionRequest({
      deadline: { atMs: nowMs + 60_000 },
      candidates: [
        fixtureInputEvent({
          receivedAtMs: nowMs,
          expiresAtMs: nowMs + 60_000,
        }),
      ],
    })
    const result = await port.select(
      request,
      createCallContext(nowMs + 60_000),
    )

    expect(selectionResultSchema.safeParse(result).success).toBe(true)
    expect(result.requestId).toBe(request.requestId)
    expect(result.sessionId).toBe(request.sessionId)
    expect(result.epoch).toBe(request.epoch)
    expect(result.snapshotRevision).toBe(request.snapshotRevision)
    expect(result.provider).toBe(JEV_DEFAULT_PROVIDER_NAME)
    expect(result.usage.provider).toBe(JEV_DEFAULT_PROVIDER_NAME)
    expect(result.usage.requestedModel).toBe(config.model)
    expect(result.modelVersion.trim().length).toBeGreaterThan(0)
    expect(result.usage.resolvedModel).toBe(result.modelVersion)
    expect(result.usage.usageMissing).toBe(
      result.usage.inputTokens === null || result.usage.outputTokens === null,
    )

    if (result.disposition === 'respond') {
      expect(result.selectedEventIds).toHaveLength(1)
      expect(
        request.candidates.some(
          (candidate) => candidate.eventId === result.selectedEventIds[0],
        ),
      ).toBe(true)
      expect(
        result.replyIntent !== null &&
          request.allowedIntents.includes(result.replyIntent),
      ).toBe(true)
    } else {
      expect(result.selectedEventIds).toHaveLength(0)
      expect(result.replyIntent).toBeNull()
    }
  })

  it('returns a schema-valid reaction result from a real decisions call', async () => {
    const config = report.config!
    const port = createJevReactionPort({
      clock,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
    })
    const request = fixtureDecisionRequest({
      deadline: { atMs: Date.now() + 60_000 },
    })
    const result = await port.decide(
      request,
      createCallContext(Date.now() + 60_000),
    )

    expect(decisionResultSchema.safeParse(result).success).toBe(true)
    expect(result.requestId).toBe(request.requestId)
    expect(result.sessionId).toBe(request.sessionId)
    expect(result.epoch).toBe(request.epoch)
    expect(result.turnId).toBe(request.turnId)
    expect(result.segmentId).toBe(request.segmentId)
    expect(result.snapshotRevision).toBe(request.snapshotRevision)
    expect(result.capabilityRevision).toBe(request.capabilityRevision)
    expect(result.provider).toBe(JEV_DEFAULT_PROVIDER_NAME)
    expect(result.usage.provider).toBe(JEV_DEFAULT_PROVIDER_NAME)
    expect(result.usage.requestedModel).toBe(config.model)
    expect(result.modelVersion.trim().length).toBeGreaterThan(0)
    expect(result.usage.resolvedModel).toBe(result.modelVersion)
    expect(result.usage.usageMissing).toBe(
      result.usage.inputTokens === null || result.usage.outputTokens === null,
    )

    if (result.status === 'selected') {
      expect(result.actionId !== null).toBe(true)
      expect(
        result.actionId === 'no-op' ||
          request.eligibleActionIds.includes(result.actionId ?? ''),
      ).toBe(true)
    } else {
      expect(result.status).toBe('abstained')
      expect(result.actionId).toBeNull()
      expect(result.confidence).toBeNull()
    }
  })

  it('never echoes the credential or a response body into an error message', async () => {
    const config = report.config!

    const unreachable = createJevSelectionPort({
      clock,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: config.model,
      apiKey: config.apiKey,
    })
    let unreachableMessage = ''
    try {
      await unreachable.select(
        fixtureSelectionRequest({ deadline: { atMs: Date.now() + 10_000 } }),
        createCallContext(Date.now() + 10_000),
      )
    } catch (error) {
      unreachableMessage = error instanceof Error ? error.message : ''
    }
    expect(unreachableMessage.length).toBeGreaterThan(0)
    expect(unreachableMessage.includes(config.apiKey)).toBe(false)
    expect(unreachableMessage).not.toContain('response-body-never-echoed')

    const blankKey = createJevSelectionPort({
      clock,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: '',
    })
    let blankKeyMessage = ''
    try {
      await blankKey.select(
        fixtureSelectionRequest({ deadline: { atMs: Date.now() + 10_000 } }),
        createCallContext(Date.now() + 10_000),
      )
    } catch (error) {
      blankKeyMessage = error instanceof Error ? error.message : ''
    }
    expect(blankKeyMessage.length).toBeGreaterThan(0)
    expect(blankKeyMessage.includes(config.apiKey)).toBe(false)
  })
})
