import { afterEach, describe, expect, it } from 'vitest'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { createControlledMediaDriver } from '../support/m1-kit'
import { createFixtureDialoguePort } from '../support/correct-ports'
import type { PerformanceCommand, PerformanceReceipt } from '../../src/contracts'

/**
 * M5 terminal-cache / observable-playback regressions (DELIVERY-PLAN
 * 2026-10-16.5, item 3).
 *
 * The PR36 repair deliberately retires settled records at a fixed bound and
 * allows a duplicate to be offered again in principle; a bridge offer is not
 * playback. The guarantee that matters is observable: after retirement, a retry
 * of a real command through the real bridge, application transport and M1
 * performer must return the same terminal without replaying media, and fresh
 * admission must still work. These assertions are on media creation (observable
 * playback), not on frame counts.
 */

const harnesses: LoopHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close()
})

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  await harness.client.bootstrapOperator(token)
  await harness.client.attach()
  await harness.client.resume()
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 60000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function firstOfferCommand(harness: LoopHarness): PerformanceCommand {
  const offer = harness.client
    .messages()
    .find((message) => message.kind === 'performance.offer')
  if (offer === undefined) throw new Error('no offer recorded')
  return offer.payload as PerformanceCommand
}

function firstCompletedReceipt(harness: LoopHarness, outputId: string): PerformanceReceipt {
  const receipt = harness.client
    .receipts()
    .find((candidate) => candidate.outputId === outputId && candidate.stage === 'completed')
  if (receipt === undefined) throw new Error('no completed receipt recorded')
  return receipt
}

describe('M5 terminal cache and observable playback', () => {
  it(
    'retries a retired command through the real transport without replaying media',
    async () => {
      const media = createControlledMediaDriver({ autoEvents: true })
      const harness = await createLoopHarness({
        media,
        dialogue: createFixtureDialoguePort({ segmentCount: 2 }),
      })
      harnesses.push(harness)
      await boot(harness)

      // Two segments per turn, so 33 distinct turns produce 66 outputs and cross
      // the 64-output retirement bound of both the bridge and the M1 machine's
      // completed-output cache.
      const turns = 33
      for (let index = 0; index < turns; index += 1) {
        const ack = await harness.client.input(`distinct turn ${index}`, `cache-input-${index}`)
        expect((ack.payload as { status: string }).status).toBe('accepted')
      }
      await until(
        async () => (await harness.confirmedHistory()).length,
        (count) => count >= turns * 2,
      )
      expect((await harness.confirmedHistory())).toHaveLength(turns * 2)
      expect(media.createCount()).toBe(turns * 2)

      // Retry the actual first command through the real bridge, application
      // transport and M1 performer. The M1 controller retains the current-epoch
      // terminal, so the retry resolves to the same fact without new media.
      const firstCommand = firstOfferCommand(harness)
      const original = firstCompletedReceipt(harness, firstCommand.outputId)
      const mediaBefore = media.createCount()
      const retried = await harness.composition.bridge.player.execute(firstCommand, {
        signal: new AbortController().signal,
        deadline: { atMs: harness.clock.nowMs() + 5000 },
      })
      expect(retried.stage).toBe('completed')
      expect(retried.receiptId).toBe(original.receiptId)
      expect(media.createCount()).toBe(mediaBefore)

      // A fresh turn after the retry is admitted and plays exactly once per
      // admitted output; wait for the whole two-segment turn before comparing.
      await harness.client.input('turn after retry')
      await until(
        async () => (await harness.confirmedHistory()).length,
        (count) => count >= turns * 2 + 2,
      )
      const history = await harness.confirmedHistory()
      expect(history).toHaveLength(turns * 2 + 2)
      expect(media.createCount()).toBe(history.length)
    },
    60000,
  )
})
