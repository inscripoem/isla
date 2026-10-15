import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createControlledMediaDriver, createControlledResolver } from '../support/m1-kit'
import { createGate } from '../support/context'
import { createGatedDialoguePort, createGatedSelectionPort } from '../support/gated-ports'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import type { PerformerClient } from '../support/performer-client'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'

/**
 * I1-01 acceptance: a real M5 coordinator and the real M1 browser playback
 * controller over a genuine loopback application socket, backed by the real M6
 * in-memory store. The receipts come from the M1 controller's admission and
 * terminal logic; the injected media driver emits controlled synthetic media
 * events, so this is API evidence, not acoustic proof.
 */

const harnesses: LoopHarness[] = []
const clients: PerformerClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.close()
})

function trackClient(client: PerformerClient): PerformerClient {
  clients.push(client)
  return client
}

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  const ack = await harness.client.bootstrapOperator(token)
  expect(ack.kind).toBe('operator.ack')
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

async function makeHarness(options: Parameters<typeof createLoopHarness>[0] = {}): Promise<LoopHarness> {
  const harness = await createLoopHarness(options)
  harnesses.push(harness)
  return harness
}

describe('I1 application loop over loopback', () => {
  it('runs two turns and attributes confirmed history', async () => {
    const harness = await makeHarness()
    await boot(harness)

    const firstAck = await harness.client.input('What did you say about the concert?')
    expect((firstAck.payload as { status: string }).status).toBe('accepted')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    const first = await harness.confirmedHistory()
    expect(first).toHaveLength(1)
    expect(first[0]?.classification).toBe('fully-delivered')
    expect(first[0]?.segmentIndex).toBe(0)
    expect(first[0]?.personaProfileId).toBe('character-i1')
    expect(first[0]?.text.length).toBeGreaterThan(0)

    await harness.client.input('a second, distinct question', 'msg-second')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 2,
    )
    const history = await harness.confirmedHistory()
    expect(history).toHaveLength(2)
    expect(new Set(history.map((record) => record.turnId)).size).toBe(2)
    expect(history.every((record) => record.personaProfileVersion === '1')).toBe(true)
  })

  it('keeps Stop during playback as partial-unknown and never fully delivered', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    media.holdEndedFrom(0)
    const harness = await makeHarness({ media })
    await boot(harness)

    await harness.client.input('held playback')
    await until(
      () => harness.client.receipts().some((receipt) => receipt.stage === 'started'),
      (started) => started,
    )
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')

    await until(
      () => harness.composition.coordinator.deliveries().length,
      (count) => count >= 1,
    )
    const deliveries = harness.composition.coordinator.deliveries()
    expect(deliveries.every((delivery) => delivery.classification !== 'fully-delivered')).toBe(true)
    expect(await harness.confirmedHistory()).toHaveLength(0)
  })

  it('resumes after Stop and completes a fresh turn', async () => {
    const harness = await makeHarness()
    await boot(harness)
    expect(((await harness.client.stop()).payload as { status: string }).status).toBe('applied')

    await until(
      async () => ((await harness.client.resume()).payload as { status: string }).status,
      (status) => status === 'applied',
    )
    await harness.client.input('after resume')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect((await harness.confirmedHistory())[0]?.classification).toBe('fully-delivered')
  })

  it('is idempotent for duplicate input, refuses unauthorized control and a second performer', async () => {
    const harness = await makeHarness()
    const token = await harness.bootstrapOperator()
    await harness.client.bootstrapOperator(token)
    // A viewer connection may submit input but may not control the session.
    const second = trackClient(harness.newClient())
    await second.snapshot
    const refused = await second.resume()
    expect((refused.payload as { status: string }).status).toBe('refused')

    expect((await harness.client.attach()).kind).toBe('session.attach.ack')
    const secondAttach = await second.attach()
    expect(secondAttach.kind).toBe('request.error')

    await harness.client.resume()
    await harness.client.input('hello', 'dup-1')
    const duplicate = await harness.client.input('hello', 'dup-1')
    expect((duplicate.payload as { status: string }).status).toBe('duplicate')
  })

  it('rejects a malformed transport message without closing the loop', async () => {
    const harness = await makeHarness()
    const raw = new WebSocket(`ws://127.0.0.1:${harness.port}/app`, { origin: harness.origin })
    await new Promise<void>((resolve, reject) => {
      raw.once('open', () => resolve())
      raw.once('error', reject)
    })
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      raw.on('message', (data: Buffer) => {
        const parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>
        if (parsed.kind === 'request.error') resolve(parsed)
      })
      raw.send('not json')
    })
    expect(reply.kind).toBe('request.error')
    expect((reply.payload as { code: string }).code).toBe('malformed')
    raw.close()
  })

  it('degrades on storage failure and keeps Stop responsive', async () => {
    const base = createInMemoryBackend()
    const failing = {
      ...base,
      commit: (): void => {
        throw new Error('injected storage failure')
      },
    }
    const harness = await makeHarness({ backend: failing })
    await boot(harness)
    await harness.client.input('this write will fail')
    await until(
      () => harness.composition.coordinator.lifecycle(),
      (lifecycle) => lifecycle === 'degraded',
    )
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')
  })

  it('reconnects snapshot-first without silently clearing unknown delivery', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    media.holdEndedFrom(0)
    const harness = await makeHarness({ media })
    await boot(harness)
    await harness.client.input('held for disconnect')
    await until(
      () => harness.client.receipts().some((receipt) => receipt.stage === 'started'),
      (started) => started,
    )
    // The performer disappears mid-playback without local cancellation, so the
    // server cannot prove the media stopped. Confirmation must not stay (or
    // become) confirmed.
    await harness.client.disconnect()
    await until(
      async () => (await harness.composition.coordinator.endpoint.snapshot()).outputConfirmation,
      (confirmation) => confirmation !== 'confirmed',
    )

    const reconnected = trackClient(harness.newClient())
    const snapshot = await reconnected.snapshot
    expect((snapshot.payload as { outputConfirmation: string }).outputConfirmation).not.toBe('confirmed')
    // Bootstrap operator on the replacement connection so a refusal proves
    // evidence protection, not missing authority.
    const token = await harness.bootstrapOperator()
    expect((await reconnected.bootstrapOperator(token)).kind).toBe('operator.ack')
    expect((await reconnected.attach()).kind).toBe('session.attach.ack')
    const resume = await reconnected.resume()
    const payload = resume.payload as { status: string; reasonCode: string | null }
    expect(payload.status).toBe('refused')
    expect(payload.reasonCode).not.toBe('unauthorized')
    // No replayed audio: the server grants nothing to the replacement connection.
    expect(reconnected.messages().some((message) => message.kind === 'performance.grant')).toBe(false)
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
  })

  it('drains more than one burst of accepted inputs without spinning', async () => {
    const harness = await makeHarness()
    await boot(harness)
    for (let index = 0; index < 10; index += 1) {
      const ack = await harness.client.input(`input number ${index}`, `burst-${index}`)
      expect((ack.payload as { status: string }).status).toBe('accepted')
    }
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 10,
      8000,
    )
    expect(await harness.confirmedHistory()).toHaveLength(10)
    // No provider call happens for an unchanged deferred snapshot.
    expect(harness.composition.coordinator.metrics().selectionAttempts).toBeLessThanOrEqual(10)
  })

  it('releases the deadline gate on shutdown', async () => {
    const harness = await makeHarness()
    await boot(harness)
    await harness.close()
    // A disposed gate aborts new bindings and retains no entries.
    const binding = harness.gate.bind({
      signal: new AbortController().signal,
      deadline: { atMs: Date.now() + 60_000 },
    })
    expect(binding.signal.aborted).toBe(true)
    binding.release()
  })

  it('settles Stop before any grant as no-dispatch and completes a fresh turn after Resume', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const harness = await makeHarness({
      beforeReady: () => {
        if (held) return undefined
        held = true
        return gate
      },
    })
    await boot(harness)
    await harness.client.input('before grant')
    await until(
      () => harness.client.messages().some((message) => message.kind === 'performance.offer'),
      (offered) => offered,
    )
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')
    // Never granted: no delivery and confirmation returns to confirmed, so a
    // Resume is not wedged by playback that was never authorized.
    await until(
      async () => (await harness.composition.coordinator.endpoint.snapshot()).outputConfirmation,
      (confirmation) => confirmation === 'confirmed',
    )
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
    release()
    await until(
      async () => ((await harness.client.resume()).payload as { status: string }).status,
      (status) => status === 'applied',
    )
    await harness.client.input('fresh turn after before-grant stop')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect((await harness.confirmedHistory())[0]?.classification).toBe('fully-delivered')
  })

  it('settles Stop during audio resolution and resumes a fresh turn', async () => {
    const resolver = createControlledResolver()
    const media = createControlledMediaDriver({ autoEvents: true })
    const harness = await makeHarness({ resolver, media })
    await boot(harness)
    await harness.client.input('during audio resolution')
    await until(
      () => harness.client.messages().some((message) => message.kind === 'performance.grant'),
      (granted) => granted,
    )
    // No media event yet: the resolver is still outstanding.
    expect(harness.client.receipts().some((receipt) => receipt.stage === 'completed')).toBe(false)
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')
    await until(
      async () => ((await harness.client.resume()).payload as { status: string }).status,
      (status) => status === 'applied',
    )
    resolver.resolveNext()
    resolver.setAutoResolve()
    await harness.client.input('fresh turn after resolution stop')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect((await harness.confirmedHistory())[0]?.classification).toBe('fully-delivered')
  })

  it('revokes held selection work on shutdown', async () => {
    const gate = createGate()
    const harness = await makeHarness({ selection: createGatedSelectionPort(gate.promise) })
    await boot(harness)
    await harness.client.input('held selection')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await harness.close()
    gate.release()
    expect(harness.composition.coordinator.lifecycle()).toBe('stopped')
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
  })

  it('revokes granted playback on shutdown', async () => {
    const media = createControlledMediaDriver({ autoEvents: true })
    media.holdEndedFrom(0)
    const harness = await makeHarness({ media })
    await boot(harness)
    await harness.client.input('held playback on shutdown')
    await until(
      () => harness.client.receipts().some((receipt) => receipt.stage === 'started'),
      (started) => started,
    )
    await harness.close()
    expect(harness.composition.coordinator.lifecycle()).toBe('stopped')
  })

  it('revokes held dialogue work on shutdown', async () => {
    const gate = createGate()
    const harness = await makeHarness({ dialogue: createGatedDialoguePort(gate.promise) })
    await boot(harness)
    await harness.client.input('held dialogue')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await harness.close()
    gate.release()
    expect(harness.composition.coordinator.lifecycle()).toBe('stopped')
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
  })

  it('revokes work held at the offer on shutdown', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const harness = await makeHarness({
      beforeReady: () => {
        if (held) return undefined
        held = true
        return gate
      },
    })
    await boot(harness)
    await harness.client.input('held offer on shutdown')
    await until(
      () => harness.client.messages().some((message) => message.kind === 'performance.offer'),
      (offered) => offered,
    )
    await harness.close()
    release()
    expect(harness.composition.coordinator.lifecycle()).toBe('stopped')
  })

  it('treats a duplicate attach as idempotent and does not invalidate work', async () => {
    const harness = await makeHarness()
    const token = await harness.bootstrapOperator()
    await harness.client.bootstrapOperator(token)
    const first = await harness.client.attach()
    expect(first.kind).toBe('session.attach.ack')
    const second = await harness.client.attach()
    expect(second.kind).toBe('session.attach.ack')
    expect((second.payload as { connectionId: string }).connectionId).toBe(
      (first.payload as { connectionId: string }).connectionId,
    )
    await harness.client.resume()
    await harness.client.input('after duplicate attach')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect(await harness.confirmedHistory()).toHaveLength(1)
  })

  it('bounds queued inputs under a held selection while Stop stays responsive', async () => {
    const gate = createGate()
    const harness = await makeHarness({
      selection: createGatedSelectionPort(gate.promise),
      maxPendingInputs: 2,
    })
    await boot(harness)
    const acks = []
    for (let index = 0; index < 5; index += 1) {
      acks.push((await harness.client.input(`queued ${index}`, `queued-${index}`)).payload)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const rejected = acks.find((ack) => (ack as { status: string }).status === 'rejected')
    expect(rejected).toBeDefined()
    expect((rejected as { code: string }).code).toBe('conflict')
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')
    gate.release()
  })
})
