import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/storage'
import { migrate, openDatabase } from '../../src/storage/sqlite'
import { fixtureRuntimeEvent } from '../support/fixture-data'

const directories: string[] = []
const open: ReturnType<typeof openDatabase>[] = []

function storeAt(): ReturnType<typeof createMemoryStore> {
  const dir = mkdtempSync(join(tmpdir(), 'isla-memory-'))
  directories.push(dir)
  const dbPath = join(dir, 'isla.db')
  const database = openDatabase(dbPath)
  open.push(database)
  migrate(database, { dbPath, backupDir: join(dir, 'backups') })
  return createMemoryStore(database)
}

function episode(id: string, audienceId: string | null, createdAtMs = 0) {
  return {
    id,
    sessionId: 's1',
    audienceId,
    startMs: 0,
    endMs: 100,
    topic: 'topic',
    summary: 'summary',
    importance: 0.5,
    sourceTurnIds: ['t1', 't2'],
    extractorVersion: 'v1',
    createdAtMs,
  }
}

afterEach(() => {
  for (const database of open.splice(0)) database.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('M6 memory store — schema and derived memory', () => {
  it('creates the six memory tables at schema version 3', () => {
    const store = storeAt()
    void store
    const names = (
      open[0]!
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name)
    for (const table of [
      'derived_episode',
      'derived_topic',
      'projection_state',
      'session_audience',
      'delivery_owner',
      'session_state',
    ]) {
      expect(names).toContain(table)
    }
    const version = open[0]!.prepare('SELECT version FROM schema_version').get() as {
      version: number
    }
    expect(version.version).toBe(3)
  })

  it('upserts an episode idempotently and preserves ids only', () => {
    const store = storeAt()
    store.upsertEpisode(episode('e1', 'aud-1'))
    store.upsertEpisode({ ...episode('e1', 'aud-1'), summary: 'updated' })
    const rows = store.readEpisodes({ sessionId: 's1', limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.summary).toBe('updated')
    expect(rows[0]?.sourceTurnIds).toEqual(['t1', 't2'])
  })

  it('persists the projection cursor across reopen', () => {
    const store = storeAt()
    store.writeProjection('s1', 5, 1000)
    expect(store.readProjection('s1')).toBe(5)
    open[0]!.close()
    open.pop()
    const dbPath = join(directories[0]!, 'isla.db')
    const reopened = openDatabase(dbPath)
    open.push(reopened)
    expect(createMemoryStore(reopened).readProjection('s1')).toBe(5)
  })

  it('rebuilds derived episodes and the cursor from events', () => {
    const store = storeAt()
    const events = [
      fixtureRuntimeEvent({ eventId: 'e1', seq: 1, sessionId: 's1', timestampMs: 10 }),
      fixtureRuntimeEvent({ eventId: 'e2', seq: 2, sessionId: 's1', timestampMs: 20 }),
    ]
    store.upsertEpisode(episode('stale', null))
    const result = store.rebuildDerived(events, (sessionEvents) => [
      episode(`derived-${sessionEvents[0]?.sessionId}`, null, 20),
    ])
    expect(result).toEqual({ sessions: 1, episodes: 1 })
    expect(store.readEpisodes({ sessionId: 's1', limit: 10 }).map((row) => row.id)).toEqual([
      'derived-s1',
    ])
    expect(store.readProjection('s1')).toBe(2)
  })
})

describe('M6 memory store — audience, owner and state', () => {
  it('records an owner once and refuses a different owner', () => {
    const store = storeAt()
    const key = { sessionId: 's1', turnId: 't1', segmentId: 'seg1' }
    expect(store.recordDeliveryOwner(key, 'aud-1')).toBe('recorded')
    expect(store.recordDeliveryOwner(key, 'aud-1')).toBe('recorded')
    expect(store.recordDeliveryOwner(key, 'aud-2')).toBe('conflict')
    expect(store.ownerOf(key)).toBe('aud-1')
  })

  it('reads state back after reopen and refuses a stale version', () => {
    const store = storeAt()
    const state = { mood: 1, stress: 0, energy: 2, attachment: 0.5, confidence: 1 }
    expect(store.writeState({ sessionId: 's1', audienceId: 'aud-1', state, expectedVersion: 0, nowMs: 1 })).toEqual(
      { ok: true, version: 1 },
    )
    expect(
      store.writeState({ sessionId: 's1', audienceId: 'aud-1', state, expectedVersion: 1, nowMs: 2 }),
    ).toEqual({ ok: true, version: 2 })
    expect(
      store.writeState({ sessionId: 's1', audienceId: 'aud-1', state, expectedVersion: 1, nowMs: 3 }),
    ).toEqual({ ok: false, reason: 'conflict' })
    expect(store.readState('s1')).toEqual({ state, version: 2 })
  })

  it('deletes one audience and leaves the other intact', () => {
    const store = storeAt()
    store.upsertEpisode(episode('e1', 'aud-1'))
    store.upsertEpisode(episode('e2', 'aud-2'))
    store.writeState({
      sessionId: 's1',
      audienceId: 'aud-1',
      state: { mood: 0, stress: 0, energy: 0, attachment: 0, confidence: 0 },
      expectedVersion: 0,
      nowMs: 1,
    })
    const counts = store.deleteAudience('aud-1')
    expect(counts.derived_episode).toBe(1)
    expect(store.readEpisodes({ audienceId: 'aud-1', limit: 10 })).toHaveLength(0)
    expect(store.readEpisodes({ audienceId: 'aud-2', limit: 10 })).toHaveLength(1)
  })

  it('deletes only rows older than the cutoff', () => {
    const store = storeAt()
    const day = 24 * 60 * 60 * 1000
    store.upsertEpisode(episode('old', 'aud-1', 0))
    store.upsertEpisode(episode('new', 'aud-1', 10 * day))
    const counts = store.deleteOlderThan(1, 10 * day)
    expect(counts.derived_episode).toBe(1)
    expect(store.readEpisodes({ audienceId: 'aud-1', limit: 10 }).map((row) => row.id)).toEqual([
      'new',
    ])
  })

  it('exports only the target audience', () => {
    const store = storeAt()
    store.upsertEpisode(episode('e1', 'aud-1'))
    store.upsertEpisode(episode('e2', 'aud-2'))
    store.recordDeliveryOwner({ sessionId: 's1', turnId: 't1', segmentId: 'seg1' }, 'aud-1')
    open[0]!
      .prepare(`
        INSERT INTO events
          (session_id, event_id, seq, timestamp_ms, epoch, turn_id, segment_id, output_id,
           type, source_module, versions, payload)
        VALUES ('s1', 'ev1', 1, 1000, 1, 't1', 'seg1', NULL, 'input.received', 'M5', NULL, '{"text":"hello"}')
      `)
      .run()
    const lines = store.exportAudience('aud-1').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.some((line) => line.kind === 'episode' && line.id === 'e1')).toBe(true)
    expect(lines.some((line) => line.kind === 'event' && line.eventId === 'ev1')).toBe(true)
    expect(lines.some((line) => line.id === 'e2')).toBe(false)
  })
})
