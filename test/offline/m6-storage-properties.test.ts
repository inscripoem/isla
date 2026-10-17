import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommitDelivery, RuntimeEvent } from '../../src/contracts'
import { createEventStore, createHistoryQuery, createInMemoryBackend } from '../../src/storage'
import { createSqliteBackend, migrate, openDatabase } from '../../src/storage/sqlite'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery, fixtureRuntimeEvent } from '../support/fixture-data'

/**
 * M6-01 — the storage invariants over **generated** operation sequences.
 *
 * INV-04 (session-scoped identity and sequence), INV-07 (isolation) and INV-08
 * (history ordered by the supporting event seq) hold *for any sequence of
 * operations*, but the hand-written suites only test chosen cases. This file
 * generates many sequences from a **seeded** generator — no dependency — and asserts
 * the invariants after each, then replays one sequence over both backends and
 * requires identical observable state, which generalises the single cross-backend
 * case (C-45).
 *
 * A failure names its seed and reproduces exactly, because the generator is
 * deterministic.
 */

/** mulberry32: small, deterministic, dependency-free. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Step {
  readonly event: RuntimeEvent
  readonly delivery: CommitDelivery | null
}

/** A sequence of unique events, about half of them carrying a delivery. */
function generate(seed: number, length: number): Step[] {
  const next = mulberry32(seed)
  const steps: Step[] = []
  for (let index = 0; index < length; index += 1) {
    const seq = index + 1
    const turnId = `turn-${Math.floor(next() * 3)}`
    const segmentId = `seg-${index}`
    const event = fixtureRuntimeEvent({ eventId: `evt-${index}`, seq, turnId, segmentId })
    steps.push({
      event,
      delivery:
        next() < 0.5
          ? null
          : fixtureCommitDelivery({ turnId, segmentId, textHash: `hash-${index}` }),
    })
  }
  // Apply them out of sequence order. Insertion order is not the sequence: the store
  // must order by `seq` (INV-04) and by the supporting event seq (INV-08), which the
  // mutation check proved this file was not exercising while arrival happened to match.
  for (let index = steps.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[steps[index], steps[swap]] = [steps[swap]!, steps[index]!]
  }
  return steps
}

type Store = ReturnType<typeof createEventStore>

async function applySequence(store: Store, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    if (step.delivery === null) {
      expect(await store.append(step.event)).toMatchObject({ outcome: 'stored' })
    } else {
      const ack = await store.commitDeliveryWithEvent(step.delivery, step.event)
      expect(ack.delivery).toMatchObject({ status: 'applied' })
    }
  }
}

/** The segment ids the history port must return, ordered by supporting event seq. */
function expectedHistoryOrder(steps: readonly Step[]): string[] {
  // The supporting event's own seq orders the history (INV-08); it is not a field of
  // the delivery, which is why the store derives it from the committed event.
  return steps
    .filter((step): step is Step & { delivery: CommitDelivery } => step.delivery !== null)
    .slice()
    .sort((left, right) => left.event.seq - right.event.seq)
    .map((step) => step.delivery.segmentId)
}

const directories: string[] = []
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('M6-01 storage invariants over generated sequences (INV-04, INV-07, INV-08)', () => {
  for (const seed of [1, 7, 42, 1337, 99991]) {
    it(`holds for seed ${seed}`, async () => {
      const backend = createInMemoryBackend()
      const store = createEventStore(backend)
      const steps = generate(seed, 40)
      await applySequence(store, steps)

      // INV-04 — session sequence strictly increasing, identities unique.
      const events = await store.readSession(FIXTURE_SESSION_ID)
      const sequences = events.map((event) => event.seq)
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
      expect(new Set(sequences).size).toBe(sequences.length)
      expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length)

      // INV-04 — re-appending an existing event is a duplicate and changes nothing.
      const before = await store.exportJsonl(FIXTURE_SESSION_ID)
      expect(await store.append(steps[0]!.event)).toMatchObject({ outcome: 'duplicate' })
      expect(await store.exportJsonl(FIXTURE_SESSION_ID)).toBe(before)

      // INV-07 — a caller mutating a returned record cannot reach the store.
      const returned = await store.readSession(FIXTURE_SESSION_ID)
      returned[0]!.payload.mutatedByCaller = true
      returned.push(steps[0]!.event)
      expect(await store.exportJsonl(FIXTURE_SESSION_ID)).toBe(before)

      // INV-08 — confirmed history follows the supporting event seq, not arrival order.
      const history = await createHistoryQuery(backend).confirmedHistory(FIXTURE_SESSION_ID)
      expect(history.map((record) => record.segmentId)).toEqual(expectedHistoryOrder(steps))
    })
  }

  it('in-memory and SQLite agree on one generated sequence (generalises C-45)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'm6-properties-'))
    directories.push(directory)
    const steps = generate(2026, 30)

    const memoryBackend = createInMemoryBackend()
    const memoryStore = createEventStore(memoryBackend)
    await applySequence(memoryStore, steps)

    const dbPath = join(directory, 'isla.db')
    const db = openDatabase(dbPath)
    migrate(db, { dbPath, backupDir: join(directory, 'backups') })
    const sqliteBackend = createSqliteBackend(db)
    const sqliteStore = createEventStore(sqliteBackend)
    await applySequence(sqliteStore, steps)

    expect(await sqliteStore.exportJsonl(FIXTURE_SESSION_ID)).toBe(
      await memoryStore.exportJsonl(FIXTURE_SESSION_ID),
    )
    const sqliteHistory = await createHistoryQuery(sqliteBackend).confirmedHistory(FIXTURE_SESSION_ID)
    const memoryHistory = await createHistoryQuery(memoryBackend).confirmedHistory(FIXTURE_SESSION_ID)
    expect(sqliteHistory.map((record) => record.segmentId)).toEqual(
      memoryHistory.map((record) => record.segmentId),
    )
    expect(sqliteHistory.map((record) => record.segmentId)).toEqual(expectedHistoryOrder(steps))
    db.close()
  })
})
