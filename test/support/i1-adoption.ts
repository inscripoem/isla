import type { EventStorePort, RuntimeEvent } from '../../src/contracts'
import { createEventStore } from '../../src/storage/event-store'
import { createLoopHarness } from './i1-harness'
import type { LoopHarness, LoopHarnessOptions } from './i1-harness'

/**
 * Small test-only adoption entry for the local I1 loop.
 *
 * It boots one already-resumed performer over the real application endpoint and
 * exposes only the reads a future owner port needs to replace: the session's
 * recorded events, a bounded observable wait, and shutdown. It adds no behaviour
 * to the harness and is never imported by production code.
 */
export interface AdoptionSession {
  readonly harness: LoopHarness
  /**
   * Recorded events for the live session (or an explicit session id). It reads
   * the harness's own store, or the explicitly supplied `store` option.
   */
  events(sessionId?: string): Promise<RuntimeEvent[]>
  /**
   * Bounded observable wait over a live read. It polls every few milliseconds
   * and is not a proof of absence; a test that needs to show "no event" must say
   * so explicitly and bound the observation.
   */
  until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs?: number): Promise<T>
  close(): Promise<void>
}

export async function openAdoptionSession(
  options: LoopHarnessOptions = {},
): Promise<AdoptionSession> {
  const harness = await createLoopHarness(options)
  try {
    const token = await harness.bootstrapOperator()
    await harness.client.bootstrapOperator(token)
    const attach = await harness.client.attach()
    if (attach.kind !== 'session.attach.ack') {
      throw new Error('adoption session: performer attach was refused')
    }
    const resume = await harness.client.resume()
    if ((resume.payload as { status?: string }).status !== 'applied') {
      throw new Error('adoption session: performer resume was refused')
    }
  } catch (error) {
    // A refused or faulted setup must not leak the server and performer it
    // already started. Cleanup failure is secondary: the setup error is the
    // original, more useful diagnostic.
    await harness.close().catch(() => {})
    throw error
  }
  // Read through the same store the composition writes to: an explicitly
  // supplied store is not necessarily the harness's default backend.
  const store: EventStorePort = options.store ?? createEventStore(harness.backend)
  return {
    harness,
    events: (sessionId = harness.currentSessionId()) => store.readSession(sessionId),
    until: async (read, done, timeoutMs = 4000) => {
      const started = Date.now()
      for (;;) {
        const value = await read()
        if (done(value)) return value
        if (Date.now() - started > timeoutMs) {
          throw new Error('adoption session: bounded wait never observed its condition')
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    close: () => harness.close(),
  }
}
