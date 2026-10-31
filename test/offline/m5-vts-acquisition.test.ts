import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVtsClient } from '../../src/performance/vts-client'
import {
  VtsCredentialBusyError,
  createVtsCredentialCoordinator,
} from '../../src/runtime/vts-acquisition'
import type { VtsCredentialRecord } from '../../src/runtime/vts-acquisition'
import { createFixtureVtsSocket } from '../support/m1-vts-connection-kit'
import {
  M1_VTS_PAIRING_FIXTURE_STATE,
  M1_VTS_PAIRING_FIXTURE_TOKEN,
  createM1VtsPairingCountingSignal,
} from '../support/m1-vts-pairing-kit'
import {
  createM5VtsAcquisitionKit,
  createM5VtsControlledStore,
  createM5VtsReleasingFailureHandle,
} from '../support/m5-vts-acquisition-kit'
import type {
  M5VtsAcquisitionKit,
  M5VtsAcquisitionKitOptions,
} from '../support/m5-vts-acquisition-kit'

/**
 * M5 VTS acquisition lifecycle (first stage).
 *
 * Every case runs the production acquisition module, the real D2 pairing
 * primitive and, on the handed-off transport, the real C protocol client.
 * Controlled sockets, peers, a controlled multi-record credential store and
 * connector timing stand in for the deployment's endpoint and store. No real
 * VTube Studio instance, credential file or physical silence is involved.
 */

const kits: M5VtsAcquisitionKit[] = []

afterEach(async () => {
  const pending = kits.splice(0)
  for (const kit of pending) kit.releaseConnections()
  vi.useRealTimers()
  for (const kit of pending) await kit.acquisition.release().catch(() => {})
})

function createKit(options: M5VtsAcquisitionKitOptions = {}): M5VtsAcquisitionKit {
  const kit = createM5VtsAcquisitionKit(options)
  kits.push(kit)
  return kit
}

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Flush pending microtask chains while fake timers are installed. */
async function drainMicrotasks(turns = 32): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

describe('M5 VTS acquisition lifecycle', () => {
  it('hands the identical authenticated handle to the real client and allows a later explicit attempt', async () => {
    const kit = createKit()
    const result = await kit.acquisition.acquire(new AbortController().signal)
    expect(result.kind).toBe('acquired')
    if (result.kind !== 'acquired') return

    const attempt = kit.attempts()[0]
    expect(result.handle).toBe(attempt.handle)
    expect(attempt.peer.requestFor('AuthenticationRequest')).toBeDefined()
    expect(kit.acquisition.state()).toBe('ready')
    expect(await kit.acquisition.acquire()).toEqual({
      kind: 'refused',
      reason: 'already_acquired',
    })

    attempt.peer.setApiStateAuto(true)
    const client = createVtsClient({
      transport: result.handle.transport,
      timeoutMs: 1_000,
      maxPending: 1,
    })
    const state = await client.apiState(new AbortController().signal)
    expect(state).toEqual({
      kind: 'ok',
      attempted: true,
      data: { ...M1_VTS_PAIRING_FIXTURE_STATE },
    })
    client.dispose()
    await result.handle.closed

    expect(await kit.acquisition.release()).toBe('stopped')
    expect(await kit.acquisition.release()).toBe('stopped')
    expect(kit.acquisition.state()).toBe('stopped')

    const later = await kit.acquisition.acquire()
    expect(later.kind).toBe('acquired')
    expect(kit.connectCount()).toBe(2)
  })

  it('does not start a connector for an already-aborted owner signal', async () => {
    const kit = createKit()
    const owner = new AbortController()
    owner.abort()
    const result = await kit.acquisition.acquire(owner.signal)
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      reason: 'cancelled',
      cause: 'owner',
      pairing: null,
      cleanup: { pairing: 'not_started', save: 'not_admitted', lateHandle: 'none' },
    })
    expect(kit.connectCount()).toBe(0)
    expect(kit.acquisition.state()).toBe('idle')
  })

  it('settles on the acquisition deadline while a load hangs and keeps replacement blocked until it resolves', async () => {
    vi.useFakeTimers()
    const kit = createKit({ acquisitionTimeoutMs: 1_000 })
    kit.store.setLoad({ kind: 'hang' })
    const pending = kit.acquisition.acquire()
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'deadline',
      reason: 'deadline_exceeded',
      cause: 'deadline',
    })
    expect(kit.acquisition.state()).toBe('blocked')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'blocked' })
    expect(await kit.acquisition.release()).toBe('blocked')
    expect(kit.attempts()[0].socket.closeCount()).toBe(1)

    kit.store.resolveLoad(null)
    await vi.advanceTimersByTimeAsync(0)
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('failed')

    kit.store.setLoad({ kind: 'value', value: M1_VTS_PAIRING_FIXTURE_TOKEN })
    const later = await kit.acquisition.acquire()
    expect(later.kind).toBe('acquired')
  })

  it('preserves owner cancellation during a pending prompt and removes its listener', async () => {
    const kit = createKit({ mode: 'allow-prompt' })
    kit.store.setLoad({ kind: 'value', value: null })
    kit.setOnConnect((attempt) => {
      attempt.peer.setTokenReply({ kind: 'silent' })
    })
    const counting = createM1VtsPairingCountingSignal()
    const pending = kit.acquisition.acquire(counting.signal)
    await until(
      () => kit.attempts()[0]?.peer.requestFor('AuthenticationTokenRequest') !== undefined,
    )
    counting.controller.abort()
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      reason: 'cancelled',
      cause: 'owner',
    })
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.attempts()[0].socket.closeCount()).toBe(1)
    expect(counting.addCount()).toBe(1)
    expect(counting.removeCount()).toBe(1)
  })

  it('closes a handle returned after cancellation and keeps replacement blocked until that cleanup settles', async () => {
    const kit = createKit()
    kit.holdConnections(true)
    const owner = new AbortController()
    const pending = kit.acquisition.acquire(owner.signal)
    await until(() => kit.connectCount() === 1)
    expect(kit.attempts()).toHaveLength(0)

    owner.abort()
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      reason: 'cancelled',
      cause: 'owner',
    })
    expect(kit.acquisition.state()).toBe('blocked')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'blocked' })

    kit.releaseConnections()
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.attempts()).toHaveLength(1)
    expect(kit.attempts()[0].socket.closeCount()).toBe(1)
    expect(kit.attempts()[0].peer.requests()).toHaveLength(0)
    expect(await kit.acquisition.release()).toBe('stopped')
  })

  it('keeps quarantine latched when a late handle close times out and later completes physically', async () => {
    vi.useFakeTimers()
    const kit = createKit({
      closeTimeoutMs: 10,
      socket: () => createFixtureVtsSocket({ closeEmission: 'manual' }),
    })
    kit.holdConnections(true)
    const owner = new AbortController()
    const pending = kit.acquisition.acquire(owner.signal)
    await drainMicrotasks()
    expect(kit.connectCount()).toBe(1)
    expect(kit.attempts()).toHaveLength(0)

    owner.abort()
    const cancelled = await pending
    expect(cancelled).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      reason: 'cancelled',
      cause: 'owner',
    })
    expect(kit.acquisition.state()).toBe('blocked')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'blocked' })

    // The connector now returns the handle it acquired after cancellation.
    // Its bounded close is still running, so replacement stays blocked.
    kit.releaseConnections()
    await drainMicrotasks()
    expect(kit.attempts()).toHaveLength(1)
    const attempt = kit.attempts()[0]
    expect(attempt.socket.closeCount()).toBe(1)
    expect(attempt.peer.requests()).toHaveLength(0)
    expect(kit.acquisition.state()).toBe('blocked')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'blocked' })

    // The bounded close expires without a physical close. Quarantine latches
    // and no later completion can clear it.
    await vi.advanceTimersByTimeAsync(10)
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('quarantined')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'quarantined' })
    expect(await kit.acquisition.release()).toBe('quarantined')

    attempt.socket.emitClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempt.socket.readyState).toBe(3)
    expect(kit.acquisition.state()).toBe('quarantined')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'quarantined' })
    expect(await kit.acquisition.release()).toBe('quarantined')
  })

  it('settles on the acquisition deadline while the connector is still opening', async () => {
    vi.useFakeTimers()
    const kit = createKit({ acquisitionTimeoutMs: 1_000 })
    kit.holdConnections(true)
    const pending = kit.acquisition.acquire()
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'deadline',
      reason: 'deadline_exceeded',
      cause: 'deadline',
    })
    expect(kit.acquisition.state()).toBe('blocked')

    kit.releaseConnections()
    await vi.advanceTimersByTimeAsync(0)
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.attempts()[0].socket.closeCount()).toBe(1)
  })

  it('reports a connector rejection as a clean failure without leaking its detail', async () => {
    const kit = createKit()
    kit.failNextConnect(new Error('connector detail must not escape'))
    const first = await kit.acquisition.acquire()
    expect(first).toMatchObject({
      kind: 'failed',
      stage: 'connect',
      reason: 'connection_failed',
      cause: null,
      pairing: null,
    })
    expect(JSON.stringify(first)).not.toContain('connector detail')
    expect(kit.acquisition.state()).toBe('failed')

    const second = await kit.acquisition.acquire()
    expect(second.kind).toBe('acquired')
  })

  it('does not start pairing when the attempt is cancelled before the connector returns', async () => {
    const kit = createKit()
    const owner = new AbortController()
    kit.setOnConnect(() => {
      owner.abort()
    })
    const result = await kit.acquisition.acquire(owner.signal)
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      reason: 'cancelled',
      cause: 'owner',
    })
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.attempts()[0].peer.requests()).toHaveLength(0)
    expect(kit.attempts()[0].socket.closeCount()).toBe(1)
  })

  it('does not accept a handle that is already physically closed', async () => {
    const kit = createKit()
    kit.setOnConnect((attempt) => {
      attempt.socket.emitClose()
    })
    const result = await kit.acquisition.acquire()
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.pairing).toBe('transport_error')
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.attempts()[0].peer.requests()).toHaveLength(0)
  })

  it('latches quarantine when the physical close cannot be confirmed and refuses replacement', async () => {
    vi.useFakeTimers()
    const kit = createKit({
      closeTimeoutMs: 10,
      socket: () => createFixtureVtsSocket({ closeEmission: 'manual' }),
    })
    kit.setOnConnect((attempt) => {
      attempt.peer.setAuthReply({ kind: 'authenticated', value: false })
    })
    const pending = kit.acquisition.acquire()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      pairing: 'authentication_rejected',
      cleanup: { connection: { kind: 'failed', code: 'close_timeout' } },
    })
    expect(kit.acquisition.state()).toBe('quarantined')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'quarantined' })
    expect(await kit.acquisition.release()).toBe('quarantined')

    // A physical close observed after the bounded close attempt must never
    // clear the quarantine latch.
    kit.attempts()[0].socket.emitClose()
    await vi.advanceTimersByTimeAsync(0)
    expect(kit.acquisition.state()).toBe('quarantined')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'quarantined' })
  })

  it('coordinates credential operations per store and record while admitted saves are unresolved', async () => {
    const store = createM5VtsControlledStore()
    const coordinator = createVtsCredentialCoordinator(store)
    const first = createKit({ store, coordinator, mode: 'allow-prompt' })
    store.setLoad({ kind: 'value', value: null })
    store.setSave({ kind: 'hang' })
    const owner = new AbortController()
    const pending = first.acquisition.acquire(owner.signal)
    await store.waitForSaveEntry()
    expect(coordinator.isBusy(first.record)).toBe(true)

    owner.abort()
    const abandoned = await pending
    expect(abandoned).toMatchObject({
      kind: 'failed',
      cause: 'owner',
      cleanup: { save: 'pending' },
    })
    expect(first.acquisition.state()).toBe('blocked')

    const sameRecord = createKit({ store, coordinator })
    const excluded = await sameRecord.acquisition.acquire()
    expect(excluded).toMatchObject({
      kind: 'failed',
      stage: 'pairing',
      pairing: 'credential_read_failed',
    })
    expect(() =>
      coordinator.run(first.record, 'load', () => Promise.resolve(null)),
    ).toThrow(VtsCredentialBusyError)

    store.setSave({ kind: 'stored' })
    const otherTarget = createKit({ store, coordinator, mode: 'allow-prompt', target: 'fixture-other-target' })
    expect(otherTarget.record).not.toEqual(first.record)
    const independent = await otherTarget.acquisition.acquire()
    expect(independent.kind).toBe('acquired')

    const otherIdentity = createKit({
      store,
      coordinator,
      mode: 'allow-prompt',
      identity: { pluginName: 'Isla Other Record', pluginDeveloper: 'Isla Team' },
      target: first.target,
    })
    const independentIdentity = await otherIdentity.acquisition.acquire()
    expect(independentIdentity.kind).toBe('acquired')

    const firstLoad = store.loads()[0]
    expect(firstLoad.record).toEqual(first.record)
    expect(Object.isFrozen(firstLoad.record)).toBe(true)
    const firstSave = store.saves()[0]
    expect(firstSave.record).toEqual(first.record)
    expect(firstSave.value).toBe(M1_VTS_PAIRING_FIXTURE_TOKEN)
    const otherLoad = store.loads().find((operation) => operation.record.target === 'fixture-other-target')
    expect(otherLoad?.record).toEqual(otherTarget.record)

    store.resolveSave()
    await first.acquisition.whenSettled()
    expect(first.acquisition.state()).toBe('failed')
    expect(coordinator.isBusy(first.record)).toBe(false)

    store.setLoad({ kind: 'value', value: M1_VTS_PAIRING_FIXTURE_TOKEN })
    const retried = await sameRecord.acquisition.acquire()
    expect(retried.kind).toBe('acquired')
  })

  it('maps same-record contention to credential_read_failed without deleting the stored value or prompting again', async () => {
    const store = createM5VtsControlledStore()
    const coordinator = createVtsCredentialCoordinator(store)
    const first = createKit({ store, coordinator, mode: 'allow-prompt' })
    store.setLoad({ kind: 'value', value: null })
    store.setSave({ kind: 'hang' })
    // A prior value exists while the controlled load forces the prompt path
    // that admits a save. Only an admitted save may replace that value.
    store.seed(first.record, 'preserved-credential')

    const owner = new AbortController()
    const pending = first.acquisition.acquire(owner.signal)
    await store.waitForSaveEntry()
    owner.abort()
    expect((await pending).kind).toBe('failed')
    expect(first.acquisition.state()).toBe('blocked')

    // A competing allow-prompt attempt for the same record is refused by the
    // coordinator before the store effect. D2 sees a rejected load, not a
    // missing or invalid credential, so it neither deletes nor prompts.
    const competing = createKit({ store, coordinator, mode: 'allow-prompt' })
    const contended = await competing.acquisition.acquire()
    expect(contended).toMatchObject({
      kind: 'failed',
      stage: 'pairing',
      pairing: 'credential_read_failed',
    })
    expect(store.loadCalls()).toBe(1)
    expect(store.saveCalls()).toBe(1)
    expect(store.valueOf(first.record)).toBe('preserved-credential')
    expect(competing.attempts()[0].peer.requests()).toHaveLength(0)
    expect(coordinator.isBusy(first.record)).toBe(true)

    store.resolveSave()
    await first.acquisition.whenSettled()
    expect(first.acquisition.state()).toBe('failed')
    expect(coordinator.isBusy(first.record)).toBe(false)

    // The same-record value admitted by the delayed save is readable later
    // without a second prompt.
    store.setLoad({ kind: 'stored' })
    const later = await competing.acquisition.acquire()
    expect(later.kind).toBe('acquired')
    const prompts = [...first.attempts(), ...competing.attempts()]
      .flatMap((attempt) => attempt.peer.requests())
      .filter((request) => request.messageType === 'AuthenticationTokenRequest')
    expect(prompts).toHaveLength(1)
    expect(store.loadCalls()).toBe(2)
    expect(store.saveCalls()).toBe(1)
  })

  it('preserves a rejected save as a write failure without a second prompt, load substitution or erased value', async () => {
    const kit = createKit({ mode: 'allow-prompt' })
    kit.store.setLoad({ kind: 'value', value: null })
    kit.store.setSave({ kind: 'reject', error: new Error('store rejected the write') })
    kit.store.seed(kit.record, 'preserved-credential')
    const result = await kit.acquisition.acquire()
    expect(result).toMatchObject({
      kind: 'failed',
      pairing: 'credential_write_failed',
      cleanup: { save: 'rejected' },
    })
    expect(kit.store.loadCalls()).toBe(1)
    expect(kit.store.saveCalls()).toBe(1)
    expect(
      kit
        .attempts()[0]
        .peer.requests()
        .filter((request) => request.messageType === 'AuthenticationTokenRequest'),
    ).toHaveLength(1)
    expect(kit.store.valueOf(kit.record)).toBe('preserved-credential')
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.coordinator.isBusy(kit.record)).toBe(false)

    kit.store.setLoad({ kind: 'value', value: M1_VTS_PAIRING_FIXTURE_TOKEN })
    const later = await kit.acquisition.acquire()
    expect(later.kind).toBe('acquired')
    expect(kit.store.saveCalls()).toBe(1)
  })

  it('reports a save the store enters and throws from synchronously as admitted', async () => {
    const kit = createKit({ mode: 'allow-prompt' })
    kit.store.setLoad({ kind: 'value', value: null })
    kit.store.setSave({
      kind: 'throw',
      error: new Error('raw store detail must not escape'),
    })
    const result = await kit.acquisition.acquire()
    expect(result).toMatchObject({
      kind: 'failed',
      pairing: 'credential_write_failed',
      cleanup: { save: 'rejected' },
    })
    expect(JSON.stringify(result)).not.toContain('raw store detail')
    expect(kit.store.saveCalls()).toBe(1)
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.coordinator.isBusy(kit.record)).toBe(false)
  })

  it('keeps a synchronously cancelled admitted save visible and reuses its settled value', async () => {
    const kit = createKit({ mode: 'allow-prompt' })
    kit.store.setLoad({ kind: 'value', value: null })
    kit.store.setSave({ kind: 'hang' })
    const owner = new AbortController()
    kit.store.setSaveEntryHook(() => owner.abort())
    const pending = kit.acquisition.acquire(owner.signal)
    const cancelled = await pending
    expect(cancelled).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      cause: 'owner',
      cleanup: { save: 'pending' },
    })
    expect(kit.acquisition.state()).toBe('blocked')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'blocked' })

    kit.store.resolveSave()
    await kit.acquisition.whenSettled()
    expect(kit.acquisition.state()).toBe('failed')
    expect(kit.store.valueOf(kit.record)).toBe(M1_VTS_PAIRING_FIXTURE_TOKEN)

    // A later explicit attempt reads the value the delayed save actually
    // committed; no load override, reseed or second prompt is involved.
    kit.store.setLoad({ kind: 'stored' })
    const later = await kit.acquisition.acquire()
    expect(later.kind).toBe('acquired')
    expect(kit.store.saveCalls()).toBe(1)
    expect(
      kit
        .attempts()
        .flatMap((attempt) => attempt.peer.requests())
        .filter((request) => request.messageType === 'AuthenticationTokenRequest'),
    ).toHaveLength(1)
    expect(kit.store.loads().at(-1)?.record).toEqual(kit.record)
  })

  it('cancels an in-flight attempt on release, reports stopped after real cleanup and allows a later attempt', async () => {
    const kit = createKit({ mode: 'allow-prompt' })
    kit.store.setLoad({ kind: 'value', value: null })
    kit.setOnConnect((attempt) => {
      attempt.peer.setTokenReply({ kind: 'silent' })
    })
    const pending = kit.acquisition.acquire()
    await until(
      () => kit.attempts()[0]?.peer.requestFor('AuthenticationTokenRequest') !== undefined,
    )
    expect(await kit.acquisition.release()).toBe('stopped')
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'released',
      reason: 'released',
      cause: 'released',
    })
    expect(kit.acquisition.state()).toBe('stopped')
    expect(kit.attempts()[0].socket.closeCount()).toBe(1)

    kit.store.setLoad({ kind: 'value', value: M1_VTS_PAIRING_FIXTURE_TOKEN })
    const later = await kit.acquisition.acquire()
    expect(later.kind).toBe('acquired')
  })

  it('does not start the connector when the owner aborts synchronously after acquire', async () => {
    const kit = createKit()
    const owner = new AbortController()
    const pending = kit.acquisition.acquire(owner.signal)
    owner.abort()
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'cancelled',
      cause: 'owner',
    })
    await kit.acquisition.whenSettled()
    expect(kit.connectCount()).toBe(0)
    expect(kit.attempts()).toHaveLength(0)
    expect(kit.acquisition.state()).toBe('failed')
  })

  it('does not start the connector when release wins immediately after acquire', async () => {
    const kit = createKit()
    const pending = kit.acquisition.acquire()
    const releasing = kit.acquisition.release()
    const result = await pending
    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'released',
      cause: 'released',
    })
    expect(await releasing).toBe('stopped')
    expect(kit.connectCount()).toBe(0)
    expect(kit.attempts()).toHaveLength(0)
    expect(kit.acquisition.state()).toBe('stopped')
  })

  it('keeps admission closed until a release continuation finishes so it cannot clear a successor', async () => {
    const kit = createKit({ mode: 'allow-prompt' })
    kit.store.setLoad({ kind: 'value', value: null })
    kit.setOnConnect((attempt) => {
      attempt.peer.setTokenReply({ kind: 'silent' })
    })
    const pending = kit.acquisition.acquire()
    await until(
      () => kit.attempts()[0]?.peer.requestFor('AuthenticationTokenRequest') !== undefined,
    )
    const settled = kit.acquisition.whenSettled()
    const releasing = kit.acquisition.release()
    await settled

    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'busy' })
    expect(await releasing).toBe('stopped')
    expect(kit.acquisition.state()).toBe('stopped')
    expect((await pending).kind).toBe('failed')
  })

  it('keeps the first cancellation cause when a later cancellation or deadline arrives', async () => {
    vi.useFakeTimers()
    const ownerFirst = createKit({ mode: 'allow-prompt', acquisitionTimeoutMs: 1_000 })
    ownerFirst.store.setLoad({ kind: 'value', value: null })
    ownerFirst.setOnConnect((attempt) => {
      attempt.peer.setTokenReply({ kind: 'silent' })
    })
    const owner = new AbortController()
    const ownerPending = ownerFirst.acquisition.acquire(owner.signal)
    await drainMicrotasks()
    expect(
      ownerFirst.attempts()[0]?.peer.requestFor('AuthenticationTokenRequest'),
    ).toBeDefined()
    owner.abort()
    const ownerResult = await ownerPending
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ownerResult).toMatchObject({ stage: 'cancelled', cause: 'owner' })
    await ownerFirst.acquisition.whenSettled()
    expect(ownerFirst.acquisition.state()).toBe('failed')

    const deadlineFirst = createKit({ mode: 'allow-prompt', acquisitionTimeoutMs: 1_000 })
    deadlineFirst.store.setLoad({ kind: 'value', value: null })
    deadlineFirst.setOnConnect((attempt) => {
      attempt.peer.setTokenReply({ kind: 'silent' })
    })
    const deadlineOwner = new AbortController()
    const deadlinePending = deadlineFirst.acquisition.acquire(deadlineOwner.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    const deadlineResult = await deadlinePending
    deadlineOwner.abort()
    expect(deadlineResult).toMatchObject({ stage: 'deadline', cause: 'deadline' })
    await deadlineFirst.acquisition.whenSettled()
    expect(deadlineFirst.acquisition.state()).toBe('failed')
  })

  it('clears the acquisition timer and owner listener at a successful handoff', async () => {
    vi.useFakeTimers()
    const kit = createKit()
    const counting = createM1VtsPairingCountingSignal()
    const pending = kit.acquisition.acquire(counting.signal)
    await drainMicrotasks()
    const result = await pending
    expect(result.kind).toBe('acquired')
    expect(vi.getTimerCount()).toBe(0)
    expect(counting.addCount()).toBe(1)
    expect(counting.removeCount()).toBe(1)
    expect(kit.acquisition.state()).toBe('ready')
  })

  it('remains quarantined when the pairing subscription release fails', async () => {
    const kit = createKit({ wrapHandle: createM5VtsReleasingFailureHandle })
    const result = await kit.acquisition.acquire()
    expect(result).toMatchObject({
      kind: 'failed',
      pairing: 'pairing_cleanup_failed',
      cleanup: { connection: { kind: 'closed' }, pairing: 'release_failed' },
    })
    expect(kit.attempts()[0].peer.requestFor('AuthenticationRequest')).toBeDefined()
    expect(kit.acquisition.state()).toBe('quarantined')
    expect(await kit.acquisition.acquire()).toEqual({ kind: 'refused', reason: 'quarantined' })
    expect(await kit.acquisition.release()).toBe('quarantined')
  })

  it('keeps the constructed record when the caller mutates identity afterwards', async () => {
    const store = createM5VtsControlledStore()
    const coordinator = createVtsCredentialCoordinator(store)
    const identity = { pluginName: 'Isla Mutable', pluginDeveloper: 'Isla Team' }
    const kit = createKit({ store, coordinator, identity, mode: 'allow-prompt' })
    store.setLoad({ kind: 'value', value: null })
    identity.pluginName = 'Mutated After Construction'

    const result = await kit.acquisition.acquire()
    expect(result.kind).toBe('acquired')
    const load = store.loads()[0]
    expect(load.record).toEqual({
      pluginName: 'Isla Mutable',
      pluginDeveloper: 'Isla Team',
      target: kit.target,
    })
    expect(Object.isFrozen(load.record)).toBe(true)
    expect(kit.attempts()[0].peer.requestFor('AuthenticationTokenRequest')?.data).toEqual({
      pluginName: 'Isla Mutable',
      pluginDeveloper: 'Isla Team',
    })
    expect(store.saves()[0].record).toEqual(load.record)
  })
})

describe('M5 VTS credential coordinator', () => {
  it('binds the frozen record to the store and excludes only the same record', async () => {
    const store = createM5VtsControlledStore()
    const coordinator = createVtsCredentialCoordinator(store)
    const identity = { pluginName: 'Isla Coordinator', pluginDeveloper: 'Isla Team' }
    const record: VtsCredentialRecord = {
      pluginName: identity.pluginName,
      pluginDeveloper: identity.pluginDeveloper,
      target: 'target-a',
    }
    const otherTarget: VtsCredentialRecord = { ...record, target: 'target-b' }
    const otherIdentity: VtsCredentialRecord = {
      pluginName: 'Isla Other Identity',
      pluginDeveloper: 'Isla Team',
      target: 'target-a',
    }
    store.seed(record, 'seed-value')
    const provider = coordinator.provider(record)
    identity.pluginName = 'Mutated After Provider'
    const signal = new AbortController().signal

    await expect(provider.load(signal)).resolves.toBe('seed-value')
    expect(store.loads()[0].record).toEqual(record)
    expect(store.loads()[0].record).not.toBe(record)
    expect(Object.isFrozen(store.loads()[0].record)).toBe(true)

    store.setSaveFor(record, { kind: 'hang' })
    const saving = provider.save('next-value', signal)
    await store.waitForSaveEntry()
    expect(coordinator.isBusy(record)).toBe(true)
    expect(coordinator.isBusy(otherTarget)).toBe(false)
    expect(coordinator.isBusy(otherIdentity)).toBe(false)
    expect(() => coordinator.run(record, 'load', () => Promise.resolve(null))).toThrow(
      VtsCredentialBusyError,
    )
    expect(() => coordinator.provider(record).load(signal)).toThrow(VtsCredentialBusyError)

    let refusal: unknown
    try {
      coordinator.provider(record).load(signal)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(VtsCredentialBusyError)
    if (refusal instanceof VtsCredentialBusyError) {
      expect(refusal.record).toEqual(record)
      expect(refusal.operation).toBe('load')
      expect(JSON.parse(refusal.recordKey)).toEqual([
        record.pluginName,
        record.pluginDeveloper,
        record.target,
      ])
    }

    store.resolveSave()
    await saving
    expect(coordinator.isBusy(record)).toBe(false)
    expect(store.saves()[0].record).toEqual(record)
    expect(store.saves()[0].value).toBe('next-value')
    expect(store.valueOf(record)).toBe('next-value')

    store.setSaveFor(record, { kind: 'reject' })
    await expect(provider.save('rejected-value', signal)).rejects.toThrow('fixture store failure')
    expect(store.valueOf(record)).toBe('next-value')
    expect(coordinator.isBusy(record)).toBe(false)
    expect(store.saves()[1].record).toEqual(record)

    await expect(coordinator.provider(otherTarget).load(signal)).resolves.toBeNull()
    await expect(coordinator.provider(otherIdentity).load(signal)).resolves.toBeNull()
  })
})
