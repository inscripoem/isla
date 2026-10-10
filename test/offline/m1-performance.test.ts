import { describe, expect, it } from 'vitest'
import {
  collectPerformanceViolations,
  collectPlayerCancellationViolations,
} from '../conformance/performance.conformance'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'

describe('M1 performance conformance', () => {
  it('accepts the correct fixture kit', async () => {
    const violations = await collectPerformanceViolations(() => ({
      synthesis: correct.createFixtureSynthesisPort(),
      renderer: correct.createFixtureRendererPort(),
      player: correct.createFixturePlayer(),
    }))
    expect(violations).toEqual([])
  })

  it('rejects faulty renderer, synthesis and player adapters', async () => {
    const violations = await collectPerformanceViolations(() => ({
      synthesis: faulty.createFaultySynthesisPort(),
      renderer: faulty.createFaultyRendererPort(),
      player: faulty.createFaultyPlayer(),
    }))
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('capabilities-unique')
    expect(codes).toContain('audio-ref-opaque')
    expect(codes).toContain('receipt-output-match')
  })

  it('accepts cancellation evidence from the correct hold player', async () => {
    const violations = await collectPlayerCancellationViolations(() =>
      correct.createFixturePlayer({ hold: true }),
    )
    expect(violations).toEqual([])
  })

  it('rejects a hold player that cancels without evidence', async () => {
    const violations = await collectPlayerCancellationViolations(() =>
      faulty.createFaultyPlayer({ hold: true }),
    )
    expect(violations.map((violation) => violation.code)).toContain('cancel-evidence-present')
  })
})
