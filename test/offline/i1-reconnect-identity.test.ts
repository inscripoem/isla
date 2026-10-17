import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import type { PerformerClient } from '../support/performer-client'
import {
  createControlledMediaDriver,
  createControlledResolver,
} from '../support/m1-kit'
import { FIXTURE_SESSION_ID, fixturePerformanceCommand } from '../support/fixture-data'

/**
 * Client identity across page/realm lifetimes.
 *
 * A browser reload re-evaluates the shared performer machine in a fresh JS
 * realm, so a module-scoped sequence restarts. If default message or receipt
 * identities were derived only from that sequence, a reloaded page would reuse
 * ids a retained server session still remembers, and its receipts would be
 * rejected as conflicts (no delivery committed). These regressions exercise a
 * genuinely fresh module graph, not merely a second instance of the same
 * module, and an actual application reconnect over the loopback socket.
 */

const harnesses: LoopHarness[] = []
const clients: PerformerClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.close()
})

async function makeHarness(): Promise<LoopHarness> {
  const harness = await createLoopHarness()
  harnesses.push(harness)
  return harness
}

function track(client: PerformerClient): PerformerClient {
  clients.push(client)
  return client
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
 * A client factory from a genuinely fresh module graph (fresh realm), so its
 * identity sequence and realm nonce restart exactly as a browser reload does.
 */
async function freshClientModule(): Promise<
  (options: Parameters<typeof import('../support/performer-client').createPerformerClient>[0]) => PerformerClient
> {
  vi.resetModules()
  const fresh = await import('../support/performer-client')
  return (options) => fresh.createPerformerClient(options) as unknown as PerformerClient
}

function snapshotMessage(epoch: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'snap-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: 'running',
      activeTurnId: null,
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 1,
      lastSeq: 0,
    },
  }
}

/** Drives one offer through a machine built from a freshly evaluated module. */
async function captureDefaultIdentities(): Promise<{ readyId: string; receiptId: string }> {
  vi.resetModules()
  const fresh = await import('../browser/performer-machine')
  const media = createControlledMediaDriver({ autoEvents: true })
  const resolver = createControlledResolver()
  resolver.setAutoResolve()
  const sent: Array<Record<string, unknown>> = []
  const machine = fresh.createPerformerMachine({
    transport: {
      send: (raw) => {
        sent.push(JSON.parse(raw) as Record<string, unknown>)
      },
    },
    media,
    resolver,
    now: () => 5_000,
  })
  machine.handleMessage(snapshotMessage(1))
  const cmd = fixturePerformanceCommand()
  machine.handleMessage({
    protocolVersion: '0.2',
    messageId: 'offer-1',
    sessionId: cmd.sessionId,
    epoch: cmd.epoch,
    kind: 'performance.offer',
    payload: cmd,
  })
  machine.handleMessage({
    protocolVersion: '0.2',
    messageId: 'grant-1',
    sessionId: cmd.sessionId,
    epoch: cmd.epoch,
    kind: 'performance.grant',
    payload: {
      outputId: cmd.outputId,
      sessionId: cmd.sessionId,
      epoch: cmd.epoch,
      turnId: cmd.turnId,
      segmentId: cmd.segmentId,
      remainingLifetimeMs: 1_000,
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const ready = sent.find((message) => message.kind === 'performance.ready')
  const receipt = sent.find((message) => message.kind === 'performance.receipt')
  if (ready === undefined || receipt === undefined) throw new Error('no default-identity traffic')
  return {
    readyId: ready.messageId as string,
    receiptId: (receipt.payload as { receiptId: string }).receiptId,
  }
}

describe('performer identity across fresh module realms', () => {
  it('does not reuse default message or receipt identities across realms', async () => {
    const first = await captureDefaultIdentities()
    const second = await captureDefaultIdentities()
    expect(first.readyId).not.toBe(second.readyId)
    expect(first.receiptId).not.toBe(second.receiptId)
  })
})

describe('I1 application reconnect after a fresh-realm reload', () => {
  it('commits the next turn when a reloaded client identity does not collide', async () => {
    const harness = await makeHarness()
    const url = `ws://127.0.0.1:${harness.port}/app`

    // First page lifetime: a fresh module graph, default identities.
    const createFirst = await freshClientModule()
    const first = track(
      createFirst({
        url,
        origin: harness.origin,
        sessionId: harness.sessionId,
        resolver: harness.resolver,
        media: harness.media,
      }),
    )
    await first.snapshot
    expect((await first.bootstrapOperator(await harness.bootstrapOperator())).kind).toBe('operator.ack')
    expect((await first.attach()).kind).toBe('session.attach.ack')
    expect(((await first.resume()).payload as { status: string }).status).toBe('applied')
    await first.input('first realm turn')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    await first.disconnect()

    // Fresh JS realm: re-evaluating the module restarts its sequence, exactly as
    // a browser reload does. This is not merely a second same-module instance;
    // without a realm-unique nonce both clients would restart at `m1`.
    const createSecond = await freshClientModule()
    const second = track(
      createSecond({
        url,
        origin: harness.origin,
        sessionId: harness.sessionId,
        resolver: harness.resolver,
        media: harness.media,
      }),
    )
    await second.snapshot
    expect((await second.bootstrapOperator(await harness.bootstrapOperator())).kind).toBe('operator.ack')
    expect((await second.attach()).kind).toBe('session.attach.ack')
    // Mirror the first page's action sequence so a realm-scoped identity
    // sequence would restart identically (the resume is refused but still
    // consumes the same deterministic identity slot).
    await second.resume()

    const before = (await harness.confirmedHistory()).length
    await second.input('second realm turn')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count > before,
    )
    expect((await harness.confirmedHistory()).length).toBeGreaterThan(before)
  })
})
