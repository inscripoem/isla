import { describe, expect, it } from 'vitest'
import { collectConsoleViolations } from '../conformance/console.conformance'
import { createBootstrapOnlyRuntime, createFixtureConsoleTransport } from '../support/correct-ports'
import { createFaultyConsoleTransport } from '../support/faulty-ports'

describe('M2 console conformance', () => {
  it('accepts a transport built on a fixture runtime', async () => {
    const violations = await collectConsoleViolations(() =>
      createFixtureConsoleTransport(createBootstrapOnlyRuntime()),
    )
    expect(violations).toEqual([])
  })

  it('rejects a transport that replays stale history', async () => {
    const violations = await collectConsoleViolations(() => createFaultyConsoleTransport())
    expect(violations.map((violation) => violation.code)).toContain('no-history-autoplay')
  })
})
