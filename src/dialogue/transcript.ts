import type { AssembledTurn } from './context'
import type { ListenerTurn } from './listener-history'

/** One merged transcript row: either an audience utterance or a confirmed reply. */
export type TranscriptEntry =
  | { role: 'listener'; turn: ListenerTurn }
  | { role: 'character'; turn: AssembledTurn }

/**
 * Stable comparison of listener turns by `(receivedAtMs ascending, eventId
 * ascending)`.
 *
 * The same key is applied twice: here, when the transcript is merged, and in
 * `assembleDialogueContext`, before any turn-limit or budget decision is taken.
 * Both applications must agree, or "oldest" would mean one thing while trimming
 * and another while rendering. Equal keys return 0, so the caller's sort keeps
 * the input order (the source's own order for merged input, the port's order for
 * the assembler's defensive re-sort).
 */
export function compareListenerTurns(left: ListenerTurn, right: ListenerTurn): number {
  const byTime = left.receivedAtMs - right.receivedAtMs
  if (byTime !== 0) return byTime
  if (left.eventId < right.eventId) return -1
  if (left.eventId > right.eventId) return 1
  return 0
}

/**
 * Merge the two histories into exchange units (audience line first, then the
 * reply). Listener turns are stably ordered by `(receivedAtMs, eventId)`;
 * character turns keep their given supporting-event seq order, which is the
 * authoritative order the history source returns.
 *
 * The exchange unit is positional: position i pairs the i-th listener turn with
 * the i-th character turn. A side that is longer contributes its remainder after
 * the paired prefix, in its own order - extra listener turns mean "said, not yet
 * answered", extra character turns mean "spoken without a listener line".
 *
 * Known limitation, recorded rather than hidden (the same stance as the
 * `confirmedEventRefs` note in `context.ts`): confirmed records carry no
 * delivery timestamp and no link from a delivery to the input event it answered,
 * and `AssembledTurn` has none either. A verified two-sided temporal merge is
 * therefore impossible here. The pairing is a positional RENDERING decision: it
 * says "an audience line, then a reply" and never claims that these two rows
 * happened in that order in wall-clock time. Should a later contract expose the
 * delivery-to-event relationship, the pairing can become an exact join while the
 * signature stays the same.
 */
export function mergeTranscript(
  characterTurns: readonly AssembledTurn[],
  listenerTurns: readonly ListenerTurn[],
): readonly TranscriptEntry[] {
  const orderedListeners = [...listenerTurns].sort(compareListenerTurns)
  const entries: TranscriptEntry[] = []
  const paired = Math.min(orderedListeners.length, characterTurns.length)
  for (let index = 0; index < paired; index += 1) {
    const listener = orderedListeners[index]
    const character = characterTurns[index]
    if (listener === undefined || character === undefined) continue
    entries.push({ role: 'listener', turn: listener })
    entries.push({ role: 'character', turn: character })
  }
  for (const listener of orderedListeners.slice(paired)) {
    entries.push({ role: 'listener', turn: listener })
  }
  for (const character of characterTurns.slice(paired)) {
    entries.push({ role: 'character', turn: character })
  }
  return entries
}
