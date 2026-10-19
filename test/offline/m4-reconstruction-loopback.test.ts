import { afterEach, describe, expect, it } from 'vitest'
import type { ConfirmedDelivery } from '../../src/contracts'
import { ArchiveSelectionError } from '../../src/runtime/session-archives'
import type { ArchiveSelectionConfig } from '../../src/runtime/session-archives'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import type { StorageBackend } from '../../src/storage/backend'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'
import type { AssembledDialogueContext } from '../../src/dialogue'

/**
 * Cross-session reconstruction over the actual loopback composition.
 *
 * An M6 in-memory backend is reused across composition lifecycles, so this is
 * lifecycle reconstruction, not disk/process-crash durability. SQLite discovery,
 * catalogue and migrations remain M6's #25 work. The reconstructed runtime is a
 * genuinely fresh, stopped session that continues from selected archives without
 * replaying or upgrading unresolved/partial outputs.
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

interface SeedEntry {
  turnId: string
  segmentId: string
  segmentIndex: number | null
  text: string
  classification?: ConfirmedDelivery['classification']
  terminalOutcome?: 'completed' | 'cancelled' | 'failed' | 'unknown'
  personaProfileId?: string | null
  personaProfileVersion?: string | null
}

async function seedArchive(
  backend: StorageBackend,
  sessionId: string,
  entries: readonly SeedEntry[],
): Promise<void> {
  const store = createEventStore(backend)
  let seq = 0
  for (const entry of entries) {
    seq += 1
    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        sessionId,
        turnId: entry.turnId,
        segmentId: entry.segmentId,
        textHash: `hash-${sessionId}-${entry.segmentId}`,
        text: entry.text,
        classification: entry.classification ?? 'fully-delivered',
        terminalOutcome: entry.terminalOutcome ?? 'completed',
        segmentIndex: entry.segmentIndex,
        personaProfileId: entry.personaProfileId === undefined ? 'character-fixture' : entry.personaProfileId,
        personaProfileVersion:
          entry.personaProfileVersion === undefined ? '1' : entry.personaProfileVersion,
      }),
      fixtureRuntimeEvent({ sessionId, eventId: `evt-${sessionId}-${seq}`, seq, type: 'delivery.committed' }),
    )
    expect(ack.delivery.status).toBe('applied')
  }
}

const ARCHIVE_ENTRIES_A: SeedEntry[] = [
  // Out-of-order explicit indices, plus a legacy-null index.
  { turnId: 'turn-1', segmentId: 'a-1', segmentIndex: 1, text: 'Archive A second.' },
  { turnId: 'turn-1', segmentId: 'a-0', segmentIndex: 0, text: 'Archive A first.' },
  { turnId: 'turn-1', segmentId: 'a-null', segmentIndex: null, text: 'Archive A legacy.' },
  // Audit-only partial output that must never enter context.
  {
    turnId: 'turn-partial',
    segmentId: 'a-partial',
    segmentIndex: 0,
    text: 'Archive A partial.',
    classification: 'partial-unknown',
    terminalOutcome: 'cancelled',
  },
]
const ARCHIVE_ENTRIES_B: SeedEntry[] = [
  // Repeated turn id across sessions; must stay a separate turn.
  { turnId: 'turn-1', segmentId: 'b-0', segmentIndex: 0, text: 'Archive B first.' },
]

function selectionFor(overrides: Partial<ArchiveSelectionConfig> = {}): ArchiveSelectionConfig {
  return {
    liveSessionId: 'session-live',
    liveProfile: { profileId: 'character-fixture', profileVersion: '1' },
    selectedSources: [{ sessionId: 'archive-a' }, { sessionId: 'archive-b' }],
    catalogue: new Map([
      ['archive-a', { profileId: 'character-fixture', profileVersion: '1' }],
      ['archive-b', { profileId: 'character-fixture', profileVersion: '1' }],
    ]),
    ...overrides,
  }
}

describe('M5 reconstructed runtime over loopback', () => {
  it('starts stopped with a fresh id, restores archives in order, and excludes partial outputs', async () => {
    const backend = createInMemoryBackend()
    await seedArchive(backend, 'archive-a', ARCHIVE_ENTRIES_A)
    await seedArchive(backend, 'archive-b', ARCHIVE_ENTRIES_B)
    const archiveAEventsBefore = await createEventStore(backend).readSession('archive-a')

    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = await makeHarness({
      backend,
      reconstruction: selectionFor(),
      captureView: capture,
    })

    // Fresh, stopped, no dispatch and no replay on construction.
    expect(harness.sessionId).toBe('session-live')
    expect(harness.composition.coordinator.lifecycle()).toBe('stopped')
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
    expect(harness.client.receipts()).toHaveLength(0)

    await boot(harness)
    await harness.client.input('first live')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 2,
    )
    await harness.client.input('second live', 'msg-second')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 4,
    )

    // The second live turn's context carries the archives (selection order) then
    // the first live turn. Repeated turn ids stay separate turns by session.
    const view = capture.view
    expect(view).not.toBeNull()
    expect(view?.historySource).toBe('history-port')
    expect(view?.turns.map((turn) => turn.sessionId)).toEqual([
      'archive-a',
      'archive-b',
      'session-live',
    ])

    const archiveATurn = view?.turns.find((turn) => turn.sessionId === 'archive-a')
    expect(archiveATurn?.segments.map((segment) => segment.segmentId)).toEqual([
      'a-0',
      'a-1',
      'a-null',
    ])
    expect(archiveATurn?.segments[2]?.segmentIndex).toBeNull()

    // Partial/undelivered archived output is never reconstructed or replayed.
    expect(view?.history.every((record) => record.classification === 'fully-delivered')).toBe(true)
    expect(view?.history.some((record) => record.segmentId === 'a-partial')).toBe(false)
    expect(
      await createHistoryQuery(backend).confirmedHistory('archive-a'),
    ).toHaveLength(3)

    // Prior source sessions remain immutable.
    expect(await createEventStore(backend).readSession('archive-a')).toEqual(archiveAEventsBefore)
    expect(harness.composition.coordinator.deliveries().every((delivery) => delivery.sessionId === 'session-live')).toBe(true)
  })

  it('accepts an empty selection and only reconstructs the live session', async () => {
    const capture: { view: AssembledDialogueContext | null } = { view: null }
    const harness = await makeHarness({
      reconstruction: selectionFor({ selectedSources: [], catalogue: new Map() }),
      captureView: capture,
    })
    await boot(harness)
    await harness.client.input('live only')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 2,
    )
    expect(capture.view?.turns.every((turn) => turn.sessionId === 'session-live')).toBe(true)
  })

  it('fails visibly before startup on an incompatible selection', async () => {
    const backend = createInMemoryBackend()
    const selection = selectionFor({
      catalogue: new Map([['archive-a', { profileId: 'someone-else', profileVersion: '1' }]]),
      selectedSources: [{ sessionId: 'archive-a' }],
    })
    await expect(
      createLoopHarness({ backend, reconstruction: selection }),
    ).rejects.toBeInstanceOf(ArchiveSelectionError)
  })

  it('refuses to reuse an already stored live session, even without confirmed deliveries', async () => {
    const backend = createInMemoryBackend()
    // An events-only session: no confirmed deliveries, but it must still conflict.
    await createEventStore(backend).append(
      fixtureRuntimeEvent({ sessionId: 'session-live', eventId: 'evt-live-only', seq: 1 }),
    )
    await expect(
      createLoopHarness({ backend, reconstruction: selectionFor() }),
    ).rejects.toMatchObject({ code: 'live_session_not_fresh' })
  })

  it('fails closed with no speech when an archive source read fails', async () => {
    const backend = createInMemoryBackend()
    await seedArchive(backend, 'archive-a', ARCHIVE_ENTRIES_A)
    await seedArchive(backend, 'archive-b', ARCHIVE_ENTRIES_B)
    const harness = await makeHarness({
      backend,
      reconstruction: selectionFor(),
      reconstructionReadFailureSession: 'archive-a',
    })
    await boot(harness)

    await harness.client.input('reconstruction should fail')
    await until(
      () =>
        harness.composition.coordinator
          .events()
          .some((event) => event.type === 'provider.call' && event.payload['disposition'] === 'failed'),
      Boolean,
    )

    // Fail-closed: no durable delivery, no spoken history and no audio dispatched.
    expect(harness.composition.coordinator.deliveries()).toHaveLength(0)
    expect(await harness.confirmedHistory()).toHaveLength(0)
    expect(harness.client.receipts()).toHaveLength(0)
    expect(harness.composition.coordinator.lifecycle()).toBe('running')
  })
})

