import { describe, expect, it } from 'vitest'
import { collectSharedStoreViolations } from '../support/shared-store-probe'
import * as correct from '../support/correct-ports'
import * as faulty from '../support/faulty-ports'
import {
  createEventStore,
  createHistoryQuery,
  createInMemoryBackend,
  createReplayReader,
} from '../../src/storage'
import type { StorageBackend, StorageMutation } from '../../src/storage'

/**
 * Test-only fault injection (READINESS-KITS: keep fault-injection controls in
 * the test adapter). Wraps the real in-memory backend so the next batch that
 * carries a delivery mutation throws once, matching the fixture's
 * `failNextCommit`; ordinary event appends are unaffected. Production code
 * exposes no failure switch.
 */
function createFailingBackend(): { backend: StorageBackend; failNextDeliveryCommit: () => void } {
  const base = createInMemoryBackend()
  let failNextDeliveryCommit = false
  return {
    backend: {
      ...base,
      commit: (mutations: readonly StorageMutation[]) => {
        if (
          failNextDeliveryCommit &&
          mutations.some((mutation) => mutation.kind === 'delivery')
        ) {
          failNextDeliveryCommit = false
          throw new Error('simulated delivery commit failure')
        }
        base.commit(mutations)
      },
    },
    failNextDeliveryCommit: () => {
      failNextDeliveryCommit = true
    },
  }
}

/**
 * Two production M5 coordinators run side by side over one EventStorePort. The
 * probe only needs injected storage/history/replay ports, so the same coverage
 * runs against the fixture store, a deliberately faulty store, and the real M6
 * in-memory backend.
 */
describe('shared EventStorePort across two M5 coordinators', () => {
  it('preserves session isolation, delivery and export consistency on the fixture store', async () => {
    const violations = await collectSharedStoreViolations({
      createHarness: () => {
        const store = correct.createFixtureEventStore()
        return {
          store,
          history: correct.createFixtureHistoryQuery(store),
          replay: correct.createFixtureReplayReader(store),
          failNextDeliveryCommit: () => {
            store.failNextCommit = true
          },
        }
      },
    })
    expect(violations).toEqual([])
  })

  it('preserves the same invariants on the real M6 in-memory backend', async () => {
    const violations = await collectSharedStoreViolations({
      createHarness: () => {
        const { backend, failNextDeliveryCommit } = createFailingBackend()
        const store = createEventStore(backend)
        return {
          store,
          history: createHistoryQuery(backend),
          replay: createReplayReader(store),
          failNextDeliveryCommit,
        }
      },
    })
    expect(violations).toEqual([])
  })

  it('detects a session-blind shared store through the same probe', async () => {
    const violations = await collectSharedStoreViolations({
      createHarness: () => {
        const kit = faulty.createFaultySharedStorageKit()
        return {
          store: kit.store,
          history: kit.history,
          replay: kit.replay,
          failNextDeliveryCommit: kit.setFailNextCommit,
        }
      },
    })
    const codes = violations.map((violation) => violation.code)
    expect(codes).toContain('shared-both-completed')
    expect(codes).toContain('shared-session-isolated')
    expect(codes).toContain('shared-export-isolated')
  })
})
