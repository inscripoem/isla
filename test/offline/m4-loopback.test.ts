import { afterEach, describe, expect, it } from 'vitest'
import type { MediaDriver, MediaEvent, MediaHandle } from '../../src/performance/browser/types'
import type { AssembledDialogueContext } from '../../src/dialogue'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { M1_FIXTURE_SEGMENT_0_TEXT } from '../support/m1-kit'
import { createCatalogDialogueTextSource, createDeliveryFailingBackend } from '../support/m4-kit'

/**
 * Loopback integration evidence over the actual I1 production composition and
 * transport: the real M5 coordinator, the real M4 dialogue composition, the real
 * M6 in-memory store and the real M1 browser `PlaybackController`, driven through
 * a genuine loopback WebSocket with a controlled media driver. Only M3
 * (selection/reaction) and the provider text are substitutes; the media events
 * are controlled synthetic evidence, not acoustic proof.
 */

const harnesses: LoopHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
})

async function makeHarness(
  options: Parameters<typeof createLoopHarness>[0] = {},
): Promise<LoopHarness> {
  const harness = await createLoopHarness(options)
  harnesses.push(harness)
  return harness
}

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  expect((await harness.client.bootstrapOperator(token)).kind).toBe('operator.ack')
  expect((await harness.client.attach()).kind).toBe('session.attach.ack')
  expect(((await harness.client.resume()).payload as { status: string }).status).toBe('applied')
}

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * A controlled media driver whose first handle reports `playing` then `error`
 * (a playback that started and then failed), and whose later handles report the
 * normal `playing`/`ended`. It emits on microtasks, never wall-clock timers.
 */
function createFailFirstMediaDriver(): MediaDriver {
  let index = 0
  return {
    create(): MediaHandle {
      const fail = index === 0
      index += 1
      const listeners = new Set<(event: MediaEvent) => void>()
      const emit = (event: MediaEvent): void => {
        for (const listener of [...listeners]) listener(event)
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        load() {},
        async play() {
          queueMicrotask(() => {
            emit({ type: 'playing' })
            if (fail) queueMicrotask(() => emit({ type: 'error', reasonCode: 'playback_failed' }))
            else queueMicrotask(() => emit({ type: 'ended' }))
          })
        },
        detach() {
          return true
        },
      }
    },
  }
}

describe('M4 loopback over the production composition', () => {
  it('carries confirmed previous text into the M4 context of a later turn', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = await makeHarness({ realM4: true, captureView: capture })
    await boot(harness)

    await harness.client.input('first message')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 2,
    )
    await harness.client.input('second message', 'msg-second')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 4,
    )

    const view = capture.view
    expect(view).not.toBeNull()
    expect(view?.historySource).toBe('history-port')
    expect(view?.turns).toHaveLength(1)
    expect(view?.turns[0]?.segments.map((segment) => segment.segmentIndex)).toEqual([0, 1])
    expect(view?.turns[0]?.text).toContain('We talked about the concert.')
  })

  it('keeps playback-started-then-failed audit-only without degrading the session', async () => {
    const harness = await makeHarness({
      realM4: true,
      media: createFailFirstMediaDriver(),
      // A single catalogued line, so the failed output is the whole turn.
      dialogueTextSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
    })
    await boot(harness)

    await harness.client.input('playback will fail')
    await until(
      () => harness.composition.coordinator.deliveries(),
      (deliveries) => deliveries.length >= 1,
    )
    const failed = harness.composition.coordinator
      .deliveries()
      .find((delivery) => delivery.classification === 'partial-unknown')
    expect(failed?.terminalOutcome).toBe('failed')
    expect(harness.composition.coordinator.lifecycle()).toBe('running')
    expect(await harness.confirmedHistory()).toHaveLength(0)
    expect(
      harness.m4Memory?.records().some((record) => record.classification === 'partial-unknown'),
    ).toBe(true)

    // The session is healthy: a later turn still completes and enters history.
    await harness.client.input('next message', 'msg-next')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect((await harness.confirmedHistory())[0]?.classification).toBe('fully-delivered')
  })

  it('never admits a delivery into M4 memory after a failed M6 atomic commit', async () => {
    const { backend, failNextDelivery } = createDeliveryFailingBackend()
    const harness = await makeHarness({ realM4: true, backend })
    await boot(harness)

    failNextDelivery()
    await harness.client.input('storage will fail')
    await until(
      () => harness.composition.coordinator.lifecycle(),
      (lifecycle) => lifecycle === 'degraded',
    )
    expect(harness.m4Memory?.records()).toHaveLength(0)
    expect(await harness.confirmedHistory()).toHaveLength(0)
  })
})
