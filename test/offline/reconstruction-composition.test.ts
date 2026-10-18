import { describe, expect, it } from 'vitest'
import type { EventStorePort } from '../../src/contracts'
import { createReconstructedRuntimeComposition } from '../../src/runtime/composition'
import type { ReconstructedRuntimeDeps } from '../../src/runtime/composition'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type { ArchiveSelectionConfig, ArchiveSource, SessionProfile } from '../../src/runtime/session-archives'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import type { StorageBackend } from '../../src/storage/backend'
import * as correct from '../support/correct-ports'
import { fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'
import { createM1ActualAssetEntries } from '../support/m1-kit'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import { createVirtualClock } from '../support/virtual-clock'

/**
 * Factory-level tests for the reconstructed runtime composition: the single
 * validated selection must be used for both the runtime binding and M4, even if
 * the caller mutates the original config while the async preflight is held; and
 * a preflight read failure must fail before any runtime exists.
 */

async function until<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function seedArchive(backend: StorageBackend, sessionId: string): Promise<void> {
  const store = createEventStore(backend)
  let seq = 0
  for (const [segmentId, segmentIndex] of [
    ['a-1', 1],
    ['a-0', 0],
  ] as const) {
    seq += 1
    const ack = await store.commitDeliveryWithEvent(
      fixtureCommitDelivery({
        sessionId,
        turnId: 'turn-1',
        segmentId,
        textHash: `hash-${segmentId}`,
        text: `text-${segmentId}`,
        segmentIndex,
        personaProfileId: 'character-fixture',
        personaProfileVersion: '1',
      }),
      fixtureRuntimeEvent({ sessionId, eventId: `evt-${sessionId}-${seq}`, seq, type: 'delivery.committed' }),
    )
    expect(ack.delivery.status).toBe('applied')
  }
}

function baseDeps(
  backend: StorageBackend,
  store: EventStorePort,
  reconstruction: ArchiveSelectionConfig,
): ReconstructedRuntimeDeps {
  const clock = createVirtualClock()
  return {
    clock,
    authorizer: correct.createFixtureControlAuthorizer(),
    selection: correct.createFixtureSelectionPort(),
    reaction: correct.createFixtureReactionPort(),
    store,
    history: createHistoryQuery(backend),
    renderer: correct.createFixtureRendererPort(),
    gate: createDeadlineGate(clock),
    audioEntries: createM1ActualAssetEntries(),
    reconstruction,
    textSource: createCatalogDialogueTextSource(),
  }
}

function makeConfig(): {
  liveSessionId: string
  liveProfile: SessionProfile
  selectedSources: ArchiveSource[]
  catalogue: Map<string, SessionProfile>
} {
  return {
    liveSessionId: 'session-live',
    liveProfile: { profileId: 'character-fixture', profileVersion: '1' },
    selectedSources: [{ sessionId: 'archive-a' }],
    catalogue: new Map([['archive-a', { profileId: 'character-fixture', profileVersion: '1' }]]),
  }
}

describe('reconstructed runtime composition binding', () => {
  it('uses one validated selection even when the config mutates during preflight', async () => {
    const backend = createInMemoryBackend()
    await seedArchive(backend, 'archive-a')
    const base = createEventStore(backend)

    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let entered = false
    const store: EventStorePort = {
      ...base,
      readSession: async (sessionId) => {
        if (!entered) {
          entered = true
          await gate
        }
        return base.readSession(sessionId)
      },
    }

    const config = makeConfig()
    const pending = createReconstructedRuntimeComposition(baseDeps(backend, store, config))
    await until(() => entered, Boolean)

    // Mutate every part of the caller's config while the preflight is held.
    config.liveSessionId = 'session-hijack'
    config.liveProfile = { profileId: 'someone-else', profileVersion: '9' }
    config.selectedSources = []
    config.catalogue.clear()
    releaseGate()

    const composition = await pending
    // The runtime and the returned selection keep the original snapshot.
    expect(composition.selection.liveSessionId).toBe('session-live')
    expect(composition.selection.sources.map((source) => source.sessionId)).toEqual(['archive-a'])
    expect((await composition.coordinator.endpoint.snapshot()).sessionId).toBe('session-live')
    // M4's composed history still sees the original archive records, so the
    // assertion is not vacuous.
    const records = await composition.history.confirmedHistory('session-live')
    expect(records.filter((record) => record.sessionId === 'archive-a')).toHaveLength(2)
    composition.dispose()
  })

  it('fails visibly before startup when the preflight read throws', async () => {
    const backend = createInMemoryBackend()
    const store: EventStorePort = {
      ...createEventStore(backend),
      readSession: async () => {
        throw new Error('store unavailable during preflight')
      },
    }
    await expect(
      createReconstructedRuntimeComposition(baseDeps(backend, store, makeConfig())),
    ).rejects.toMatchObject({ code: 'preflight_read_failed' })
  })
})
