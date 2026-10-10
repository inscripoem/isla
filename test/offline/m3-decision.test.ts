import { describe, expect, it } from 'vitest'
import { collectDecisionViolations } from '../conformance/decision.conformance'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'

describe('M3 decision conformance', () => {
  it('accepts the correct selection and reaction adapters', async () => {
    const violations = await collectDecisionViolations(() => ({
      selection: correct.createFixtureSelectionPort(),
      reaction: correct.createFixtureReactionPort(),
    }))
    expect(violations).toEqual([])
  })

  it('rejects an unoffered selection and an ineligible reaction', async () => {
    const violations = await collectDecisionViolations(() => ({
      selection: faulty.createFaultySelectionPort(),
      reaction: faulty.createFaultyReactionPort(),
    }))
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('selection-offered')
    expect(codes).toContain('reaction-eligible')
  })
})
