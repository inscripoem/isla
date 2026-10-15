import type { ClockPort } from '../contracts'

/**
 * Server monotonic clock. Deadlines are expressed in this clock's domain and
 * never compared with a browser clock. Uses `process.hrtime` so the value is
 * monotonic and unaffected by wall-clock adjustments.
 */
export function createMonotonicClock(): ClockPort {
  const start = process.hrtime.bigint()
  return {
    nowMs: () => Number((process.hrtime.bigint() - start) / 1_000_000n),
  }
}
