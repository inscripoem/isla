import type { ClockPort } from '../../src/contracts'

export interface VirtualClock extends ClockPort {
  advance(ms: number): void
  set(ms: number): void
}

export function createVirtualClock(startMs = 0): VirtualClock {
  let now = startMs
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms
    },
    set: (ms) => {
      now = ms
    },
  }
}
