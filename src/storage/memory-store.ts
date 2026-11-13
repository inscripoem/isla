import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeEvent } from '../contracts'

/**
 * M6 storage — memory foundation (ADR pending reservation in #25).
 *
 * Six tables beyond `events`/`deliveries`: derived episodes and topics, the durable
 * projection cursor, the session audience binding, delivery ownership and character
 * state. The store is deliberately plain: prepared statements over one `DatabaseSync`,
 * ids only in derived rows, no copied text, and no scheduler.
 *
 * Ownership boundary: M4 owns the meaning of an episode/topic/state; this module only
 * stores and reads. `rebuildDerived` takes M4's derive callback rather than inventing
 * one, and M5 decides when an owner or state write is allowed (consent/durability).
 */

export interface DerivedEpisode {
  readonly id: string
  readonly sessionId: string
  readonly audienceId: string | null
  readonly startMs: number
  readonly endMs: number
  readonly topic: string
  readonly summary: string
  readonly importance: number
  readonly sourceTurnIds: readonly string[]
  readonly extractorVersion: string
  readonly createdAtMs: number
}

export interface DerivedTopic {
  readonly id: string
  readonly audienceId: string
  readonly topic: string
  readonly summary: string
  readonly importance: number
  readonly lastSeenMs: number
  readonly sourceEpisodeIds: readonly string[]
  readonly validFromMs: number
  readonly validToMs: number | null
  readonly updatedAtMs: number
}

export interface CharacterState {
  readonly mood: number
  readonly stress: number
  readonly energy: number
  readonly attachment: number
  readonly confidence: number
}

export interface StoredCharacterState {
  readonly state: CharacterState
  readonly version: number
}

export interface OwnerKey {
  readonly sessionId: string
  readonly turnId: string
  readonly segmentId: string
}

export type OwnerWrite = 'recorded' | 'conflict' | 'unowned' | 'refused'
export type StateWrite =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: 'conflict' }

export interface MemoryStore {
  upsertEpisode(episode: DerivedEpisode): void
  upsertTopic(topic: DerivedTopic): void
  readEpisodes(query: { sessionId?: string; audienceId?: string; limit: number }): DerivedEpisode[]
  readTopics(query: { audienceId: string; limit: number }): DerivedTopic[]
  readProjection(sessionId: string): number
  readProjectionVersion(sessionId: string): string | null
  writeProjection(
    sessionId: string,
    appliedSeq: number,
    nowMs: number,
    extractorVersion: string,
  ): 'written' | 'stale' | 'version-mismatch'
  clearDerived(): void
  rebuildDerived(
    events: readonly RuntimeEvent[],
    deriveEpisodes: (events: readonly RuntimeEvent[]) => readonly DerivedEpisode[],
    deriveTopics: (
      episodes: readonly DerivedEpisode[],
      events: readonly RuntimeEvent[],
    ) => readonly DerivedTopic[] | undefined,
    extractorVersion: string,
  ): { sessions: number; episodes: number; topics: number }
  recordSessionAudience(
    sessionId: string,
    binding: { audienceId: string | null; durable: boolean; consent: boolean },
    nowMs: number,
  ): 'recorded' | 'conflict'
  recordDeliveryOwner(key: OwnerKey, audienceId: string, nowMs: number): OwnerWrite
  ownerOf(key: OwnerKey): string | null
  readState(sessionId: string): StoredCharacterState | null
  writeState(input: {
    sessionId: string
    audienceId: string | null
    state: CharacterState
    expectedVersion: number
    nowMs: number
  }): StateWrite
  deleteAudience(audienceId: string): Record<string, number>
  deleteOlderThan(days: number, nowMs: number): Record<string, number>
  exportAudience(audienceId: string): string
}

const DAY_MS = 24 * 60 * 60 * 1000

function strings(value: string): readonly string[] {
  return JSON.parse(value) as string[]
}

export function createMemoryStore(database: DatabaseSync): MemoryStore {
  const insertEpisode = database.prepare(`
    INSERT INTO derived_episode
      (id, session_id, audience_id, start_ms, end_ms, topic, summary, importance,
       source_turn_ids, extractor_version, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id, audience_id = excluded.audience_id,
      start_ms = excluded.start_ms, end_ms = excluded.end_ms, topic = excluded.topic,
      summary = excluded.summary, importance = excluded.importance,
      source_turn_ids = excluded.source_turn_ids,
      extractor_version = excluded.extractor_version, created_at_ms = excluded.created_at_ms
  `)
  const insertTopic = database.prepare(`
    INSERT INTO derived_topic
      (id, audience_id, topic, summary, importance, last_seen_ms, source_episode_ids,
       valid_from_ms, valid_to_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      audience_id = excluded.audience_id, topic = excluded.topic,
      summary = excluded.summary, importance = excluded.importance,
      last_seen_ms = excluded.last_seen_ms,
      source_episode_ids = excluded.source_episode_ids,
      valid_from_ms = excluded.valid_from_ms, valid_to_ms = excluded.valid_to_ms,
      updated_at_ms = excluded.updated_at_ms
  `)
  const readProjection = database.prepare(
    'SELECT applied_seq, extractor_version FROM projection_state WHERE session_id = ?',
  )
  const writeProjection = database.prepare(`
    INSERT INTO projection_state (session_id, applied_seq, updated_at_ms, extractor_version)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      applied_seq = excluded.applied_seq, updated_at_ms = excluded.updated_at_ms,
      extractor_version = excluded.extractor_version
  `)
  const readAudience = database.prepare(
    'SELECT audience_id, durable, consent FROM session_audience WHERE session_id = ?',
  )
  const insertAudience = database.prepare(`
    INSERT INTO session_audience (session_id, audience_id, durable, consent, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO NOTHING
  `)
  const readOwner = database.prepare(
    'SELECT audience_id FROM delivery_owner WHERE session_id = ? AND turn_id = ? AND segment_id = ?',
  )
  const insertOwner = database.prepare(`
    INSERT INTO delivery_owner (session_id, turn_id, segment_id, audience_id, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_id, segment_id) DO NOTHING
  `)
  const readState = database.prepare(
    'SELECT mood, stress, energy, attachment, confidence, version FROM session_state WHERE session_id = ?',
  )
  const insertState = database.prepare(`
    INSERT INTO session_state
      (session_id, audience_id, mood, stress, energy, attachment, confidence, version, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(session_id) DO NOTHING
  `)
  const updateState = database.prepare(`
    UPDATE session_state SET
      audience_id = COALESCE(audience_id, ?), mood = ?, stress = ?, energy = ?, attachment = ?, confidence = ?,
      version = version + 1, updated_at_ms = ?
    WHERE session_id = ? AND version = ?
  `)

  function episodeRow(row: Record<string, unknown>): DerivedEpisode {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      audienceId: (row.audience_id as string | null) ?? null,
      startMs: row.start_ms as number,
      endMs: row.end_ms as number,
      topic: row.topic as string,
      summary: row.summary as string,
      importance: row.importance as number,
      sourceTurnIds: strings(row.source_turn_ids as string),
      extractorVersion: row.extractor_version as string,
      createdAtMs: row.created_at_ms as number,
    }
  }

  function topicRow(row: Record<string, unknown>): DerivedTopic {
    return {
      id: row.id as string,
      audienceId: row.audience_id as string,
      topic: row.topic as string,
      summary: row.summary as string,
      importance: row.importance as number,
      lastSeenMs: row.last_seen_ms as number,
      sourceEpisodeIds: strings(row.source_episode_ids as string),
      validFromMs: row.valid_from_ms as number,
      validToMs: (row.valid_to_ms as number | null) ?? null,
      updatedAtMs: row.updated_at_ms as number,
    }
  }

  function ownerWrite(key: OwnerKey, audienceId: string, nowMs: number): OwnerWrite {
    // M6-X03-1 / M4 2026-11-13: consent is enforced at the storage boundary.
    // No binding or an anonymous binding is `unowned`; a binding that exists but
    // has not consented is `refused`; a different owner is a `conflict`. Only a
    // consenting binding can create an owner row. The caller never retries a
    // refusal into a different attribution.
    const binding = readAudience.get(key.sessionId) as
      | { audience_id: string | null; durable: number; consent: number }
      | undefined
    if (binding === undefined || binding.audience_id === null) return 'unowned'
    if (binding.consent === 0) return 'refused'
    if (binding.audience_id !== audienceId) return 'conflict'
    insertOwner.run(key.sessionId, key.turnId, key.segmentId, audienceId, nowMs)
    const existing = readOwner.get(key.sessionId, key.turnId, key.segmentId) as
      | { audience_id: string }
      | undefined
    return existing?.audience_id === audienceId ? 'recorded' : 'conflict'
  }

  return {
    upsertEpisode(episode) {
      insertEpisode.run(
        episode.id,
        episode.sessionId,
        episode.audienceId,
        episode.startMs,
        episode.endMs,
        episode.topic,
        episode.summary,
        episode.importance,
        JSON.stringify(episode.sourceTurnIds),
        episode.extractorVersion,
        episode.createdAtMs,
      )
    },

    upsertTopic(topic) {
      insertTopic.run(
        topic.id,
        topic.audienceId,
        topic.topic,
        topic.summary,
        topic.importance,
        topic.lastSeenMs,
        JSON.stringify(topic.sourceEpisodeIds),
        topic.validFromMs,
        topic.validToMs,
        topic.updatedAtMs,
      )
    },

    readEpisodes({ sessionId, audienceId, limit }) {
      const where: string[] = []
      const params: (string | number)[] = []
      if (sessionId !== undefined) {
        where.push('session_id = ?')
        params.push(sessionId)
      }
      if (audienceId !== undefined) {
        where.push('audience_id = ?')
        params.push(audienceId)
      }
      const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
      const rows = database
        .prepare(`SELECT * FROM derived_episode${clause} ORDER BY start_ms DESC LIMIT ?`)
        .all(...params, limit) as Record<string, unknown>[]
      return rows.map(episodeRow)
    },

    readTopics({ audienceId, limit }) {
      const rows = database
        .prepare(
          'SELECT * FROM derived_topic WHERE audience_id = ? ORDER BY importance DESC, last_seen_ms DESC LIMIT ?',
        )
        .all(audienceId, limit) as Record<string, unknown>[]
      return rows.map(topicRow)
    },

    readProjection(sessionId) {
      const row = readProjection.get(sessionId) as { applied_seq: number } | undefined
      return row?.applied_seq ?? 0
    },

    readProjectionVersion(sessionId) {
      const row = readProjection.get(sessionId) as { extractor_version: string } | undefined
      return row?.extractor_version ?? null
    },

    writeProjection(sessionId, appliedSeq, nowMs, extractorVersion) {
      const row = readProjection.get(sessionId) as
        | { applied_seq: number; extractor_version: string }
        | undefined
      if (row !== undefined && row.extractor_version !== extractorVersion) return 'version-mismatch'
      const current = row?.applied_seq ?? 0
      if (appliedSeq <= current) return 'stale'
      writeProjection.run(sessionId, appliedSeq, nowMs, extractorVersion)
      return 'written'
    },

    clearDerived() {
      database.exec('DELETE FROM derived_episode')
      database.exec('DELETE FROM derived_topic')
    },

    rebuildDerived(events, deriveEpisodes, deriveTopics, extractorVersion) {
      const sessions = new Map<string, RuntimeEvent[]>()
      for (const event of events) {
        const list = sessions.get(event.sessionId) ?? []
        list.push(event)
        sessions.set(event.sessionId, list)
      }
      database.exec('BEGIN')
      try {
        database.exec('DELETE FROM derived_episode')
        database.exec('DELETE FROM derived_topic')
        let episodes = 0
        let topics = 0
        for (const [sessionId, sessionEvents] of sessions) {
          const derivedEpisodes = deriveEpisodes(sessionEvents)
          for (const episode of derivedEpisodes) {
            insertEpisode.run(
              episode.id,
              episode.sessionId,
              episode.audienceId,
              episode.startMs,
              episode.endMs,
              episode.topic,
              episode.summary,
              episode.importance,
              JSON.stringify(episode.sourceTurnIds),
              episode.extractorVersion,
              episode.createdAtMs,
            )
            episodes += 1
          }
          for (const topic of deriveTopics?.(derivedEpisodes, sessionEvents) ?? []) {
            insertTopic.run(
              topic.id,
              topic.audienceId,
              topic.topic,
              topic.summary,
              topic.importance,
              topic.lastSeenMs,
              JSON.stringify(topic.sourceEpisodeIds),
              topic.validFromMs,
              topic.validToMs,
              topic.updatedAtMs,
            )
            topics += 1
          }
          let lastSeq = -1
          let lastTimestamp = 0
          for (const event of sessionEvents) {
            if (event.seq > lastSeq) {
              lastSeq = event.seq
              lastTimestamp = event.timestampMs
            }
          }
          const existing = readProjection.get(sessionId) as
            | { applied_seq: number; extractor_version: string }
            | undefined
          const nextSeq =
            existing !== undefined && existing.extractor_version === extractorVersion
              ? Math.max(existing.applied_seq, lastSeq)
              : lastSeq
          writeProjection.run(sessionId, nextSeq, lastTimestamp, extractorVersion)
        }
        database.exec('COMMIT')
        return { sessions: sessions.size, episodes, topics }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },

    recordSessionAudience(sessionId, binding, nowMs) {
      insertAudience.run(
        sessionId,
        binding.audienceId,
        binding.durable ? 1 : 0,
        binding.consent ? 1 : 0,
        nowMs,
      )
      const row = readAudience.get(sessionId) as
        | { audience_id: string | null; durable: number; consent: number }
        | undefined
      const same =
        row !== undefined &&
        row.audience_id === binding.audienceId &&
        row.durable === (binding.durable ? 1 : 0) &&
        row.consent === (binding.consent ? 1 : 0)
      return same ? 'recorded' : 'conflict'
    },

    recordDeliveryOwner: ownerWrite,

    ownerOf(key) {
      const row = readOwner.get(key.sessionId, key.turnId, key.segmentId) as
        | { audience_id: string }
        | undefined
      return row?.audience_id ?? null
    },

    readState(sessionId) {
      const row = readState.get(sessionId) as
        | {
            mood: number
            stress: number
            energy: number
            attachment: number
            confidence: number
            version: number
          }
        | undefined
      if (row === undefined) return null
      return {
        state: {
          mood: row.mood,
          stress: row.stress,
          energy: row.energy,
          attachment: row.attachment,
          confidence: row.confidence,
        },
        version: row.version,
      }
    },

    writeState({ sessionId, audienceId, state, expectedVersion, nowMs }) {
      if (expectedVersion === 0) {
        const inserted = insertState.run(
          sessionId,
          audienceId,
          state.mood,
          state.stress,
          state.energy,
          state.attachment,
          state.confidence,
          nowMs,
        )
        return Number(inserted.changes) === 1
          ? { ok: true, version: 1 }
          : { ok: false, reason: 'conflict' }
      }
      const result = updateState.run(
        audienceId,
        state.mood,
        state.stress,
        state.energy,
        state.attachment,
        state.confidence,
        nowMs,
        sessionId,
        expectedVersion,
      )
      return Number(result.changes) === 1
        ? { ok: true, version: expectedVersion + 1 }
        : { ok: false, reason: 'conflict' }
    },

    deleteAudience(audienceId) {
      database.exec('BEGIN')
      try {
        const counts: Record<string, number> = {}
        for (const table of [
          'delivery_owner',
          'derived_episode',
          'derived_topic',
          'session_state',
          'session_audience',
        ]) {
          counts[table] = Number(
            database.prepare(`DELETE FROM ${table} WHERE audience_id = ?`).run(audienceId).changes,
          )
        }
        database.exec('COMMIT')
        return counts
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },

    deleteOlderThan(days, nowMs) {
      const cutoff = nowMs - days * DAY_MS
      database.exec('BEGIN')
      try {
        const counts: Record<string, number> = {}
        counts.derived_episode = Number(
          database.prepare('DELETE FROM derived_episode WHERE created_at_ms < ?').run(cutoff).changes,
        )
        counts.derived_topic = Number(
          database.prepare('DELETE FROM derived_topic WHERE updated_at_ms < ?').run(cutoff).changes,
        )
        counts.session_state = Number(
          database.prepare('DELETE FROM session_state WHERE updated_at_ms < ?').run(cutoff).changes,
        )
        counts.delivery_owner = Number(
          database.prepare('DELETE FROM delivery_owner WHERE created_at_ms < ?').run(cutoff).changes,
        )
        counts.session_audience = Number(
          database.prepare('DELETE FROM session_audience WHERE created_at_ms < ?').run(cutoff)
            .changes,
        )
        database.exec('COMMIT')
        return counts
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },

    exportAudience(audienceId) {
      const lines: string[] = []
      const episodes = database
        .prepare('SELECT * FROM derived_episode WHERE audience_id = ? ORDER BY start_ms')
        .all(audienceId) as Record<string, unknown>[]
      for (const row of episodes) lines.push(JSON.stringify({ kind: 'episode', ...episodeRow(row) }))
      const topics = database
        .prepare('SELECT * FROM derived_topic WHERE audience_id = ? ORDER BY last_seen_ms')
        .all(audienceId) as Record<string, unknown>[]
      for (const row of topics) lines.push(JSON.stringify({ kind: 'topic', ...topicRow(row) }))
      const states = database
        .prepare('SELECT * FROM session_state WHERE audience_id = ?')
        .all(audienceId) as Record<string, unknown>[]
      for (const row of states) {
        lines.push(
          JSON.stringify({
            kind: 'state',
            audienceId,
            sessionId: row.session_id,
            version: row.version,
            mood: row.mood,
            stress: row.stress,
            energy: row.energy,
            attachment: row.attachment,
            confidence: row.confidence,
          }),
        )
      }
      const events = database
        .prepare(`
          SELECT e.* FROM events e
          JOIN delivery_owner o
            ON e.session_id = o.session_id AND e.turn_id = o.turn_id AND e.segment_id = o.segment_id
          WHERE o.audience_id = ?
          ORDER BY e.session_id, e.seq
        `)
        .all(audienceId) as Record<string, unknown>[]
      for (const row of events) {
        lines.push(
          JSON.stringify({
            kind: 'event',
            audienceId,
            sessionId: row.session_id,
            eventId: row.event_id,
            seq: row.seq,
            type: row.type,
            payload: JSON.parse(row.payload as string) as unknown,
          }),
        )
      }
      return lines.length === 0 ? '' : `${lines.join('\n')}\n`
    },
  }
}
