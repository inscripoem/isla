import { describe, expect, it } from 'vitest'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createEventStore } from '../../src/storage/event-store'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import {
  createLoopCompositionBuilder,
  LOOP_INITIAL_SELECTION,
  LOOP_SESSION_ID,
} from '../browser/loop-server'

/**
 * Regression for the demo's character identity.
 *
 * The demo runtime must run as a personality profile that is actually registered
 * in M4 (`character-fixture`). If it points at an unregistered id, the demo
 * still accepts input, still reaches `dialogue.result`, and still looks healthy,
 * but produces zero segments and therefore no audio. Building the ACTUAL demo
 * composition here (not the test harness, whose defaults would mask the
 * mismatch) and running one turn proves the demo resolves its character and
 * yields speakable output.
 */
describe('I1 loop demo composition identity', () => {
  it('resolves the registered demo character and produces a two-segment turn', async () => {
    const backend = createInMemoryBackend()
    const store = createEventStore(backend)
    const clock = createMonotonicClock()
    const composition = await createLoopCompositionBuilder({ clock, backend, store })(
      LOOP_INITIAL_SELECTION,
    )
    try {
      expect(composition.sessionId).toBe(LOOP_SESSION_ID)

      const operatorContext = {
        connectionId: 'conn-loop-demo-operator',
        role: 'operator' as const,
        actorId: 'actor-loop-demo-operator',
        authenticated: true,
      }
      const resumeAck = await composition.coordinator.endpoint.control(
        {
          protocolVersion: '0.2',
          messageId: 'loop-demo-resume-1',
          sessionId: composition.sessionId,
          epoch: composition.coordinator.epoch(),
          kind: 'control.resume',
          payload: { requestId: 'loop-demo-resume-1' },
        },
        operatorContext,
      )
      expect(resumeAck.status).toBe('applied')

      const ack = await composition.coordinator.endpoint.submitInput(
        {
          protocolVersion: '0.2',
          messageId: 'loop-demo-input-1',
          sessionId: composition.sessionId,
          epoch: composition.coordinator.epoch(),
          kind: 'input.submit',
          payload: { source: 'local-audience', text: 'What did you say about the concert?' },
        },
        {
          connectionId: 'conn-loop-demo-test',
          role: 'viewer',
          actorId: 'actor-loop-demo-test',
          authenticated: false,
        },
      )
      expect(ack.status).toBe('accepted')

      await composition.coordinator.runTurn()

      const dialogueResult = composition.coordinator
        .events()
        .filter((event) => event.type === 'dialogue.result')
        .at(-1)
      const end = dialogueResult?.payload.end as
        | { status?: string; segmentCount?: number }
        | undefined
      expect(end?.status).toBe('completed')
      // A registered profile speaks the two catalogued segments; an unregistered
      // one would report a completed turn with zero segments.
      expect(end?.segmentCount).toBe(2)
    } finally {
      composition.dispose()
    }
  })
})
