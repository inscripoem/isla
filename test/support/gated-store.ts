import type { AppendAck, AtomicCommitAck, CommitDelivery, EventStorePort, RuntimeEvent } from '../../src/contracts'
import { createEventStore } from '../../src/storage/event-store'
import type { StorageBackend } from '../../src/storage/backend'

/**
 * Test-only store wrapper that can hold the next append or the next atomic
 * delivery commit, so a regression can drive concurrent inbound evidence and a
 * Stop while a write is delayed. Production code never imports this module.
 */
export interface GatedStore {
  store: EventStorePort
  holdNextAppend(): void
  holdNextCommit(): void
  releaseAppend(): void
  releaseCommit(): void
  holdingAppend(): boolean
  holdingCommit(): boolean
  commitCalls(): number
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    promise,
    release: () => release?.(),
  }
}

export function createGatedStore(backend: StorageBackend): GatedStore {
  const inner = createEventStore(backend)
  let appendArmed = false
  let appendBlocked = false
  let appendRelease: (() => void) | null = null
  let commitArmed = false
  let commitBlocked = false
  let commitRelease: (() => void) | null = null
  let commits = 0

  const store: EventStorePort = {
    async append(event: RuntimeEvent): Promise<AppendAck> {
      if (appendArmed) {
        appendArmed = false
        const held = makeGate()
        appendRelease = held.release
        appendBlocked = true
        await held.promise
        appendBlocked = false
        appendRelease = null
      }
      return inner.append(event)
    },
    async commitDeliveryWithEvent(delivery: CommitDelivery, event: RuntimeEvent): Promise<AtomicCommitAck> {
      commits += 1
      if (commitArmed) {
        commitArmed = false
        const held = makeGate()
        commitRelease = held.release
        commitBlocked = true
        await held.promise
        commitBlocked = false
        commitRelease = null
      }
      return inner.commitDeliveryWithEvent(delivery, event)
    },
    readSession: (sessionId: string) => inner.readSession(sessionId),
    exportJsonl: (sessionId: string) => inner.exportJsonl(sessionId),
  }

  return {
    store,
    holdNextAppend: () => {
      appendArmed = true
    },
    holdNextCommit: () => {
      commitArmed = true
    },
    releaseAppend: () => appendRelease?.(),
    releaseCommit: () => commitRelease?.(),
    holdingAppend: () => appendBlocked,
    holdingCommit: () => commitBlocked,
    commitCalls: () => commits,
  }
}
