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

function topic(id: string, audienceId: string, updatedAtMs = 0) {
  return {
    id,
    audienceId,
    topic: 'topic',
    summary: 'summary',
    importance: 0.5,
    lastSeenMs: 0,
    sourceEpisodeIds: ['e1'],
    validFromMs: 0,
    validToMs: null,
    updatedAtMs,
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
    expect(store.writeProjection('s1', 5, 1000)).toBe('written')
    expect(store.writeProjection('s1', 3, 2000)).toBe('stale')
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
    store.upsertTopic(topic('stale-topic', 'aud-1'))
    const result = store.rebuildDerived(
      events,
      (sessionEvents) => [episode(`derived-${sessionEvents[0]?.sessionId}`, null, 20)],
      () => [topic('derived-topic', 'aud-1')],
    )
    expect(result).toEqual({ sessions: 1, episodes: 1, topics: 1 })
    expect(store.readEpisodes({ sessionId: 's1', limit: 10 }).map((row) => row.id)).toEqual([
      'derived-s1',
    ])
    expect(store.readTopics({ audienceId: 'aud-1', limit: 10 }).map((row) => row.id)).toEqual([
      'derived-topic',
    ])
    expect(store.readProjection('s1')).toBe(2)
  })

  it('upserts topics idempotently and clears derived rows', () => {
    const store = storeAt()
    store.upsertTopic(topic('t1', 'aud-1'))
    store.upsertTopic({ ...topic('t1', 'aud-1'), summary: 'updated' })
    expect(store.readTopics({ audienceId: 'aud-1', limit: 10 })).toHaveLength(1)
    expect(store.readTopics({ audienceId: 'aud-1', limit: 10 })[0]?.summary).toBe('updated')
    store.clearDerived()
    expect(store.readTopics({ audienceId: 'aud-1', limit: 10 })).toHaveLength(0)
  })
})

describe('M6 memory store — audience, owner and state', () => {
  it('records a session audience once and refuses a different binding', () => {
    const store = storeAt()
    expect(
      store.recordSessionAudience('s1', { audienceId: 'aud-1', durable: true, consent: true }, 1),
    ).toBe('recorded')
    expect(
      store.recordSessionAudience('s1', { audienceId: 'aud-1', durable: true, consent: true }, 2),
    ).toBe('recorded')
    expect(
      store.recordSessionAudience('s1', { audienceId: 'aud-2', durable: true, consent: true }, 3),
    ).toBe('conflict')
    const row = open[0]!
      .prepare('SELECT audience_id, created_at_ms FROM session_audience WHERE session_id = ?')
      .get('s1') as { audience_id: string; created_at_ms: number }
    expect(row.audience_id).toBe('aud-1')
    expect(row.created_at_ms).toBe(1)
  })

  it('records an owner once and refuses a different owner', () => {
    const store = storeAt()
    store.recordSessionAudience('s1', { audienceId: 'aud-1', durable: true, consent: true }, 1)
    const key = { sessionId: 's1', turnId: 't1', segmentId: 'seg1' }
    expect(store.recordDeliveryOwner(key, 'aud-1', 2)).toBe('recorded')
    expect(store.recordDeliveryOwner(key, 'aud-1', 3)).toBe('recorded')
    expect(store.recordDeliveryOwner(key, 'aud-2', 4)).toBe('conflict')
    expect(store.ownerOf(key)).toBe('aud-1')
    const row = open[0]!
      .prepare('SELECT created_at_ms FROM delivery_owner WHERE session_id = ? AND turn_id = ? AND segment_id = ?')
      .get('s1', 't1', 'seg1') as { created_at_ms: number }
    expect(row.created_at_ms).toBe(2)
  })

  it('returns unowned without a binding and does not write an owner', () => {
    const store = storeAt()
    const key = { sessionId: 's1', turnId: 't1', segmentId: 'seg1' }
    expect(store.recordDeliveryOwner(key, 'aud-1', 1)).toBe('unowned')
    expect(store.ownerOf(key)).toBeNull()
  })

  it('returns unowned for an anonymous binding', () => {
    const store = storeAt()
    store.recordSessionAudience('s1', { audienceId: null, durable: false, consent: false }, 1)
    const key = { sessionId: 's1', turnId: 't1', segmentId: 'seg1' }
    expect(store.recordDeliveryOwner(key, 'aud-1', 2)).toBe('unowned')
    expect(store.ownerOf(key)).toBeNull()
  })

  it('returns refused when the binding has not consented and writes no owner', () => {
    const store = storeAt()
    store.recordSessionAudience('s1', { audienceId: 'aud-1', durable: true, consent: false }, 1)
    const key = { sessionId: 's1', turnId: 't1', segmentId: 'seg1' }
    expect(store.recordDeliveryOwner(key, 'aud-1', 2)).toBe('refused')
    expect(store.ownerOf(key)).toBeNull()
  })

  it('reads state back after reopen and refuses a stale version', () => {
    const store = storeAt()
    const state = { mood: 1, stress: 0, energy: 2, attachment: 0.5, confidence: 1 }
    expect(store.writeState({ sessionId: 's1', audienceId: 'aud-1', state, expectedVersion: 0, nowMs: 1 })).toEqual(
      { ok: true, version: 1 },
    )
    expect(
      store.writeState({ sessionId: 's1', audienceId: 'aud-2', state, expectedVersion: 1, nowMs: 2 }),
    ).toEqual({ ok: true, version: 2 })
    expect(
      store.writeState({ sessionId: 's1', audienceId: 'aud-1', state, expectedVersion: 1, nowMs: 3 }),
    ).toEqual({ ok: false, reason: 'conflict' })
    expect(store.readState('s1')).toEqual({ state, version: 2 })
    const row = open[0]!
      .prepare('SELECT audience_id FROM session_state WHERE session_id = ?')
      .get('s1') as { audience_id: string | null }
    expect(row.audience_id).toBe('aud-1')
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
    store.recordSessionAudience('old-s', { audienceId: 'aud-1', durable: true, consent: true }, 0)
    store.recordSessionAudience('new-s', { audienceId: 'aud-1', durable: true, consent: true }, 10 * day)
    store.recordDeliveryOwner({ sessionId: 'old-s', turnId: 't', segmentId: 's' }, 'aud-1', 0)
    store.recordDeliveryOwner({ sessionId: 'new-s', turnId: 't', segmentId: 's' }, 'aud-1', 10 * day)
    const counts = store.deleteOlderThan(1, 10 * day)
    expect(counts.derived_episode).toBe(1)
    expect(counts.session_audience).toBe(1)
    expect(counts.delivery_owner).toBe(1)
    expect(store.ownerOf({ sessionId: 'old-s', turnId: 't', segmentId: 's' })).toBeNull()
    expect(store.ownerOf({ sessionId: 'new-s', turnId: 't', segmentId: 's' })).toBe('aud-1')
    expect(store.readEpisodes({ audienceId: 'aud-1', limit: 10 }).map((row) => row.id)).toEqual([
      'new',
    ])
  })

  it('exports only the target audience', () => {
    const store = storeAt()
    store.upsertEpisode(episode('e1', 'aud-1'))
    store.upsertEpisode(episode('e2', 'aud-2'))
    store.upsertTopic(topic('t1', 'aud-1'))
    store.writeState({
      sessionId: 's1',
      audienceId: 'aud-1',
      state: { mood: 0, stress: 0, energy: 0, attachment: 0, confidence: 0 },
      expectedVersion: 0,
      nowMs: 1,
    })
    store.recordSessionAudience('s1', { audienceId: 'aud-1', durable: true, consent: true }, 1)
    store.recordDeliveryOwner({ sessionId: 's1', turnId: 't1', segmentId: 'seg1' }, 'aud-1', 2)
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
    expect(lines.some((line) => line.kind === 'topic' && line.id === 't1')).toBe(true)
    expect(
      lines.filter((line) => line.kind === 'event' || line.kind === 'state').every(
        (line) => line.audienceId === 'aud-1',
      ),
    ).toBe(true)
    expect(lines.some((line) => line.id === 'e2')).toBe(false)
  })
})
