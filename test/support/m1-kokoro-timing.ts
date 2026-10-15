/**
 * Test-only timing statistics for the M1-02 worker smoke.
 *
 * The worker smoke observes a real main-thread `setInterval` while a physical
 * generation is pending. The meaningful responsiveness statistic is the delay of
 * each individual callback, not the cumulative cadence drift: on some platforms
 * (for example Windows) a nominal 10 ms interval legitimately fires about every
 * 15 ms, so an `observed - (count * interval)` metric accumulates a growing
 * constant offset even when the event loop is never blocked.
 *
 * This module computes both, with no wall-clock dependency and no timers of its
 * own, so the metric definition is deterministic and independently recomputable:
 *
 * - `delayMs` is the individual callback delay
 *   `max(0, actualOffset - previousActualOffset - requestedInterval)`; the
 *   previous actual callback for the first sample is the probe start (`0`).
 * - `cumulativeDriftMs` is the advisory cadence offset
 *   `actualOffset - (index + 1) * requestedInterval`.
 */

/** One observed interval callback: monotonic offset plus whether a job was pending. */
export interface TimerCallbackSample {
  /** Monotonic offset in milliseconds from the probe start. */
  readonly offsetMs: number
  /** Whether the physical generation was still pending at this callback. */
  readonly pending: boolean
}

/** The derived per-callback measurement, preserving the raw timestamps. */
export interface TimerCallbackMeasurement {
  readonly index: number
  readonly offsetMs: number
  readonly previousOffsetMs: number
  readonly delayMs: number
  readonly cumulativeDriftMs: number
  readonly pending: boolean
}

export interface TimerMeasurement {
  readonly requestedIntervalMs: number
  readonly callbacks: readonly TimerCallbackMeasurement[]
  /** Largest individual callback delay across all callbacks. */
  readonly maxDelayMs: number
  /** Largest individual callback delay among callbacks with a pending job. */
  readonly maxPendingDelayMs: number
  /** Largest advisory cumulative cadence drift across all callbacks. */
  readonly maxCumulativeDriftMs: number
  /** Number of callbacks observed while a physical job was pending. */
  readonly pendingCallbacks: number
}

/**
 * Compute per-callback delay and advisory cumulative drift from raw monotonic
 * callback timestamps. An empty sample set yields all-zero statistics.
 */
export function measureTimerCallbacks(
  samples: readonly TimerCallbackSample[],
  requestedIntervalMs: number,
): TimerMeasurement {
  const callbacks: TimerCallbackMeasurement[] = []
  let previousOffsetMs = 0
  let maxDelayMs = 0
  let maxPendingDelayMs = 0
  let maxCumulativeDriftMs = 0
  let pendingCallbacks = 0

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    const offsetMs = sample.offsetMs
    const delayMs = Math.max(0, offsetMs - previousOffsetMs - requestedIntervalMs)
    const cumulativeDriftMs = offsetMs - (index + 1) * requestedIntervalMs
    callbacks.push({
      index,
      offsetMs,
      previousOffsetMs,
      delayMs,
      cumulativeDriftMs,
      pending: sample.pending,
    })
    if (delayMs > maxDelayMs) maxDelayMs = delayMs
    if (sample.pending) {
      pendingCallbacks += 1
      if (delayMs > maxPendingDelayMs) maxPendingDelayMs = delayMs
    }
    if (cumulativeDriftMs > maxCumulativeDriftMs) maxCumulativeDriftMs = cumulativeDriftMs
    previousOffsetMs = offsetMs
  }

  return {
    requestedIntervalMs,
    callbacks,
    maxDelayMs,
    maxPendingDelayMs,
    maxCumulativeDriftMs,
    pendingCallbacks,
  }
}
