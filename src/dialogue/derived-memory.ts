/**
 * M4 derived-memory semantics: how admitted turns become episodes and how
 * episodes become per-audience topics.
 *
 * Division of authority:
 *   - Admission (FR-02) belongs to ./memory-semantics. This module never
 *     re-derives, upgrades or refuses an admission decision; its input is
 *     assumed already admitted spoken text.
 *   - M6 owns persistence: tables, migration, rebuild and the applied cursor
 *     store. This module only defines pure, deterministic, versioned rules
 *     and the port shape the store will satisfy.
 *
 * NFR-04: no provider is called on any path; every output is a pure function
 * of the input.
 *
 * Version and cursor rider: the applied cursor is scoped by
 * DERIVED_EXTRACTOR_VERSION. A version change rebuilds rows and cursor
 * together under the new version; old-version rows stay intact until the
 * new-version rebuild overwrites them. Same-evidence rebuilds stay identical,
 * and a rebuild from a smaller event set can never lower the cursor
 * (monotonicAppliedSeq).
 */

/** One episode derived from a contiguous window of admitted turns. */
export interface DerivedEpisode {
  id: string
  sessionId: string
  audienceId: string | null
  startMs: number
  endMs: number
  topic: string
  summary: string
  importance: number
  sourceTurnIds: readonly string[]
  extractorVersion: string
}

/**
 * One contiguous run of episodes that share a topic key inside one audience.
 * `validToMs === null` means the run is still the audience's latest activity,
 * not that it is still true.
 */
export interface DerivedTopic {
  id: string
  audienceId: string
  topic: string
  summary: string
  importance: number
  lastSeenMs: number
  sourceEpisodeIds: readonly string[]
  validFromMs: number
  validToMs: number | null
}

/**
 * Persistence port shape the M6 store will satisfy. No implementation lives
 * in M4.
 */
export interface DerivedMemoryPort {
  upsertEpisode(episode: DerivedEpisode): Promise<void>
  upsertTopic(topic: DerivedTopic): Promise<void>
  readEpisodes(q: { sessionId?: string; audienceId?: string; limit: number }): Promise<readonly DerivedEpisode[]>
  readTopics(q: { audienceId: string; limit: number }): Promise<readonly DerivedTopic[]>
}

/**
 * Narrow M4-owned input. Richer producer records satisfy it structurally by
 * adding the timestamp. `text` is confirmed spoken text only; callers must
 * not feed partial or audit-only records.
 */
export interface DeriveSourceTurn {
  turnId: string
  sessionId: string
  text: string
  atMs: number
}

/**
 * Version of the extraction rules below. Bump on any semantic change: a
 * version change rebuilds rows and cursor together under the new version.
 */
export const DERIVED_EXTRACTOR_VERSION = 'derived-memory/1'

/** A window closes when the gap to the previous turn is strictly greater. */
export const EPISODE_MAX_GAP_MS = 30 * 60 * 1000

/** A window closes when it would exceed this many turns. */
export const EPISODE_MAX_TURNS = 8

const TOPIC_MAX_CHARS = 60
const SUMMARY_MAX_CHARS = 200
const SUMMARY_MAX_SENTENCES = 3

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Trimmed text from index 0 up to and including the first `.`, `!` or `?`;
 * the whole trimmed text when none occurs.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.search(/[.!?]/)
  return end === -1 ? trimmed : trimmed.slice(0, end + 1)
}

/**
 * Unchanged when it fits; otherwise cut at the last space at or before `max`
 * and drop that trailing space. A first word longer than `max` is kept whole.
 */
function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return cut === -1 ? text : text.slice(0, cut)
}

/**
 * One episode from one caller-chosen window of admitted turns. The turns are
 * expected in conversation order; this function does not sort.
 *
 * @throws RangeError when the window is empty.
 */
export function deriveEpisode(
  turns: readonly DeriveSourceTurn[],
  opts: { audienceId: string | null },
): DerivedEpisode {
  const first = turns[0]
  const last = turns[turns.length - 1]
  if (!first) throw new RangeError('deriveEpisode requires at least one turn')
  const totalChars = turns.reduce((sum, turn) => sum + turn.text.length, 0)
  return {
    id: `episode:${first.sessionId}:${first.atMs}:${first.turnId}`,
    sessionId: first.sessionId,
    audienceId: opts.audienceId,
    startMs: first.atMs,
    endMs: last.atMs,
    topic: truncateAtWordBoundary(firstSentence(first.text), TOPIC_MAX_CHARS),
    summary: truncateAtWordBoundary(
      turns.slice(0, SUMMARY_MAX_SENTENCES).map((turn) => firstSentence(turn.text)).join(' '),
      SUMMARY_MAX_CHARS,
    ),
    importance: round3(Math.min(1, 0.25 * turns.length + totalChars / 4000)),
    sourceTurnIds: turns.map((turn) => turn.turnId),
    extractorVersion: DERIVED_EXTRACTOR_VERSION,
  }
}

/**
 * Derive episodes over the caller's ordered record set. A new window starts
 * when the gap to the previous turn exceeds EPISODE_MAX_GAP_MS or the current
 * window reaches EPISODE_MAX_TURNS turns. The input is not sorted.
 */
export function deriveEpisodes(
  turns: readonly DeriveSourceTurn[],
  opts: { audienceId: string | null },
): DerivedEpisode[] {
  const episodes: DerivedEpisode[] = []
  let window: DeriveSourceTurn[] = []
  for (const turn of turns) {
    const previous = window[window.length - 1]
    const opensNewWindow = previous !== undefined
      && (turn.atMs - previous.atMs > EPISODE_MAX_GAP_MS || window.length >= EPISODE_MAX_TURNS)
    if (opensNewWindow) {
      episodes.push(deriveEpisode(window, opts))
      window = []
    }
    window.push(turn)
  }
  if (window.length > 0) episodes.push(deriveEpisode(window, opts))
  return episodes
}

/** The topic key is a lexical proxy (trim + lowercase), not entity resolution. */
function topicKey(topic: string): string {
  return topic.trim().toLowerCase()
}

function compareKey(aMs: number, aId: string, bMs: number, bId: string): number {
  return aMs - bMs || (aId < bId ? -1 : aId > bId ? 1 : 0)
}

function runToTopic(audienceId: string, run: readonly DerivedEpisode[], closed: boolean): DerivedTopic {
  const head = run[0]!
  const tail = run[run.length - 1]!
  return {
    id: `topic:${audienceId}:${head.id}`,
    audienceId,
    topic: head.topic,
    summary: head.summary,
    importance: round3(run.reduce((sum, episode) => sum + episode.importance, 0) / run.length),
    lastSeenMs: tail.endMs,
    sourceEpisodeIds: run.map((episode) => episode.id),
    validFromMs: head.startMs,
    validToMs: closed ? tail.endMs : null,
  }
}

/**
 * Contiguous topic runs per (audienceId, topicKey). Episodes with a null
 * audience are excluded. Each audience's episodes are ordered by
 * (startMs, id); output is ordered by (validFromMs, id).
 */
export function deriveTopics(episodes: readonly DerivedEpisode[]): DerivedTopic[] {
  const byAudience = new Map<string, DerivedEpisode[]>()
  for (const episode of episodes) {
    if (episode.audienceId === null) continue
    const group = byAudience.get(episode.audienceId)
    if (group) group.push(episode)
    else byAudience.set(episode.audienceId, [episode])
  }
  const topics: DerivedTopic[] = []
  for (const [audienceId, group] of byAudience) {
    const ordered = [...group].sort((a, b) => compareKey(a.startMs, a.id, b.startMs, b.id))
    const runs: DerivedEpisode[][] = []
    for (const episode of ordered) {
      const current = runs[runs.length - 1]
      if (current && topicKey(current[0]!.topic) === topicKey(episode.topic)) current.push(episode)
      else runs.push([episode])
    }
    runs.forEach((run, index) => topics.push(runToTopic(audienceId, run, index < runs.length - 1)))
  }
  return topics.sort((a, b) => compareKey(a.validFromMs, a.id, b.validFromMs, b.id))
}

/**
 * The applied cursor is max(persisted, rebuild): a rebuild from a smaller
 * event set must never lower it.
 */
export function monotonicAppliedSeq(persisted: number, rebuild: number): number {
  return Math.max(persisted, rebuild)
}
