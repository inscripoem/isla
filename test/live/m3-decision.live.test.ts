import { describe, expect, it } from 'vitest'
import { decisionResultSchema, selectionResultSchema } from '../../src/contracts'
import {
  createOpenAiCompatibleReactionPort,
  createOpenAiCompatibleSelectionPort,
} from '../../src/decision'
import { createCallContext } from '../support/context'
import {
  fixtureDecisionRequest,
  fixtureSelectionRequest,
} from '../support/fixture-data'
import { readLiveDecisionProviderConfig } from './live-config'

/*
 * Live acceptance harness for the M3 OpenAI-compatible decision adapters.
 *
 * The suite skips itself when the decision provider environment is not
 * configured, so running it without credentials is a clean skip, never a
 * failure. Nothing is constructed at module scope beyond reading that
 * configuration report; every port is built inside a case.
 *
 * Credential rules (AGENTS.md): the configured credential is compared, never
 * printed. No case logs a key, interpolates one into a message, or shows a
 * response body.
 */
const report = readLiveDecisionProviderConfig()

/** Wall-clock domain, matching the `Date.now()`-based deadlines built below. */
const clock = { nowMs: () => Date.now() }

describe.skipIf(!report.available)('M3 live decision provider', () => {
  it('returns a schema-valid selection result from a real provider call', async () => {
    const config = report.config!
    const port = createOpenAiCompatibleSelectionPort({ clock, ...config })
    const request = fixtureSelectionRequest({
      deadline: { atMs: Date.now() + 60_000 },
    })
    const result = await port.select(
      request,
      createCallContext(Date.now() + 60_000),
    )

    expect(selectionResultSchema.safeParse(result).success).toBe(true)
    expect(result.requestId).toBe(request.requestId)
    expect(result.sessionId).toBe(request.sessionId)
    expect(result.epoch).toBe(request.epoch)
    expect(result.snapshotRevision).toBe(request.snapshotRevision)
    expect(result.usage.requestedModel).toBe(config.model)
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

  it('returns a schema-valid reaction result from a real provider call', async () => {
    const config = report.config!
    const port = createOpenAiCompatibleReactionPort({ clock, ...config })
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
    expect(result.capabilityRevision).toBe(request.capabilityRevision)
    expect(result.usage.requestedModel).toBe(config.model)
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
      expect(result.actionId).toBeNull()
    }
  })

  it('never echoes the credential or a response body into an error message', async () => {
    const config = report.config!

    const unreachable = createOpenAiCompatibleSelectionPort({
      clock,
      ...config,
      baseUrl: 'http://127.0.0.1:9/v1',
    })
    let unreachableMessage = ''
    try {
      await unreachable.select(
        fixtureSelectionRequest({ deadline: { atMs: Date.now() + 10_000 } }),
        createCallContext(Date.now() + 10_000),
      )
      unreachableMessage = ''
    } catch (error) {
      unreachableMessage = error instanceof Error ? error.message : ''
    }
    expect(unreachableMessage.length).toBeGreaterThan(0)
    expect(unreachableMessage.includes(config.apiKey)).toBe(false)
    expect(unreachableMessage).not.toContain('response-body-never-echoed')

    const blankKey = createOpenAiCompatibleSelectionPort({
      clock,
      ...config,
      apiKey: '',
    })
    let blankKeyMessage = ''
    try {
      await blankKey.select(
        fixtureSelectionRequest({ deadline: { atMs: Date.now() + 10_000 } }),
        createCallContext(Date.now() + 10_000),
      )
      blankKeyMessage = ''
    } catch (error) {
      blankKeyMessage = error instanceof Error ? error.message : ''
    }
    expect(blankKeyMessage.length).toBeGreaterThan(0)
    expect(blankKeyMessage.includes(config.apiKey)).toBe(false)
  })
})
