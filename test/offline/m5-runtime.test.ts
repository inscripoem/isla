import { describe, expect, it } from 'vitest'
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
