import { describe, expect, it } from 'vitest'
import type { MemoryInspectPayload } from '../../src/contracts'
import { MEMORY_INSPECT_SCHEMA_VERSION } from '../../src/contracts'
import { processDiagnosticMessage } from '../../src/runtime/diagnostics'
import { collectRuntimeViolations } from '../conformance/runtime.conformance'
import {
  createCoordinatorRunner,
  createFaultyCoordinatorRunner,
  createFaultyRunner,
  createFixtureRunner,
} from '../support/runner-factories'

describe('M5 runtime conformance (fixture reference)', () => {
  it('accepts the composed correct fixture runner', async () => {
    const violations = await collectRuntimeViolations((options) => createFixtureRunner(options))
    expect(violations).toEqual([])
  })

  it('surfaces a faulty dependency set through the same assertions', async () => {
    const violations = await collectRuntimeViolations((options) => createFaultyRunner(options))
    expect(violations.length).toBeGreaterThan(0)
  })
})

describe('M5 runtime conformance (production coordinator)', () => {
  it('accepts the production coordinator with correct fixture peer ports', async () => {
    const violations = await collectRuntimeViolations((options) => createCoordinatorRunner(options))
    expect(violations).toEqual([])
  })

  it('surfaces a faulty dependency set through the same assertions', async () => {
    const violations = await collectRuntimeViolations((options) =>
      createFaultyCoordinatorRunner(options),
    )
    expect(violations.length).toBeGreaterThan(0)
  })
})

const OBSERVED_INSPECT: MemoryInspectPayload = {
  schemaVersion: MEMORY_INSPECT_SCHEMA_VERSION,
  sessionId: 'session-runtime',
  turnId: 'turn-runtime',
  replyIntent: 'reply',
  admission: { admitted: 2, exclusions: { budget: 1 }, noteM6Confirmed: 'audit-only' },
  recall: { persona: { used: 1, dropped: 0 }, delivery: { used: 1, dropped: 0 }, results: [] },
  budget: {
    estimatedCharacters: 120,
    truncatedByTurnLimit: false,
    truncatedByCharacterLimit: false,
  },
  consistency: {
    findings: 0,
    incomplete: false,
    statementsOffered: 1,
    statementsVisited: 1,
    statementsExamined: 1,
    textUnits: 12,
    claims: 1,
    comparisons: 0,
  },
  historySource: 'history-port',
  warnings: [],
}

function request(kind: string): string {
  return JSON.stringify({ v: 1, id: 'diag-1', kind })
}

describe('M5 diagnostics: get_memory_inspect', () => {
  it('reports no observation when the runtime has none', () => {
    const reply = processDiagnosticMessage(request('get_memory_inspect'), 1)
    expect(reply).toMatchObject({
      v: 1,
      id: 'diag-1',
      ok: true,
      kind: 'get_memory_inspect',
      payload: {
        section: 'memory.inspect',
        outcome: 'unavailable',
        reason: 'no-observation',
      },
    })
  })

  it('returns the retained payload unchanged and without an outcome field', () => {
    const reply = processDiagnosticMessage(request('get_memory_inspect'), 1, () => OBSERVED_INSPECT)
    expect(reply).toMatchObject({
      ok: true,
      kind: 'get_memory_inspect',
      payload: { section: 'memory.inspect', inspect: OBSERVED_INSPECT },
    })
    const payload = (reply as { payload: Record<string, unknown> }).payload
    expect(payload).not.toHaveProperty('outcome')
  })

  it('contains a throwing supplier as diag-plane-unavailable', () => {
    const reply = processDiagnosticMessage(request('get_memory_inspect'), 1, () => {
      throw new Error('supplier failed')
    })
    expect(reply).toMatchObject({
      ok: true,
      kind: 'get_memory_inspect',
      payload: {
        section: 'memory.inspect',
        outcome: 'unavailable',
        reason: 'diag-plane-unavailable',
      },
    })
  })

  it('leaves an unknown kind a protocol error even when a supplier is present', () => {
    const reply = processDiagnosticMessage(request('sing'), 1, () => OBSERVED_INSPECT)
    expect(reply.ok).toBe(false)
    if (reply.ok) throw new Error('expected a protocol error')
    expect(reply.error.code).toBe('unknown_kind')
  })
})
