import { describe, expect, it } from 'vitest'
import { createDeadlineGate } from '../../src/runtime/deadline'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * Production deadline gate: immediate expiry, invalid deadlines, source-abort
 * forwarding, listener/timer cleanup and disposal retention.
 */
describe('runtime deadline gate', () => {
  it('aborts immediately for an already-expired deadline and releases idempotently', () => {
    const clock = createVirtualClock(1_000)
    const gate = createDeadlineGate(clock)
    const source = new AbortController()
    const binding = gate.bind({ signal: source.signal, deadline: { atMs: 1_000 } })
    expect(binding.signal.aborted).toBe(true)
    binding.release()
    binding.release()
  })

  it('aborts for a non-finite deadline', () => {
    const clock = createVirtualClock(0)
    const gate = createDeadlineGate(clock)
    for (const atMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const binding = gate.bind({ signal: new AbortController().signal, deadline: { atMs } })
      expect(binding.signal.aborted).toBe(true)
      binding.release()
    }
  })

  it('forwards a source abort and removes the source listener on release', () => {
    const clock = createVirtualClock(0)
    const gate = createDeadlineGate(clock)
    const source = new AbortController()
    const binding = gate.bind({ signal: source.signal, deadline: { atMs: 60_000 } })
    source.abort()
    expect(binding.signal.aborted).toBe(true)
    binding.release()

    const second = new AbortController()
    const binding2 = gate.bind({ signal: second.signal, deadline: { atMs: 60_000 } })
    binding2.release()
    // After release the source listener is gone: aborting it must not touch the
    // released binding.
    second.abort()
    expect(binding2.signal.aborted).toBe(false)
  })

  it('aborts when the deadline elapses on the injected clock', async () => {
    const clock = createVirtualClock(0)
    const gate = createDeadlineGate(clock)
    const binding = gate.bind({ signal: new AbortController().signal, deadline: { atMs: 30 } })
    expect(binding.signal.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(binding.signal.aborted).toBe(true)
    binding.release()
  })

  it('disposes active bindings, aborts future binds and retains no entries', () => {
    const clock = createVirtualClock(0)
    const gate = createDeadlineGate(clock)
    const source = new AbortController()
    const active = gate.bind({ signal: source.signal, deadline: { atMs: 60_000 } })
    gate.dispose()
    expect(active.signal.aborted).toBe(true)
    // A released binding's source listener was removed by dispose as well.
    source.abort()
    const after = gate.bind({ signal: new AbortController().signal, deadline: { atMs: 60_000 } })
    expect(after.signal.aborted).toBe(true)
    after.release()
  })
})
