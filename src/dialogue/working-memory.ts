import type { ConfirmedDelivery, DeliveryCommitAck } from '../contracts'
import type { ListenerTurn } from './listener-history'
import { classifyMemoryBucket } from './memory-semantics'

/**
 * Working memory: a per-process list of what is still open for the character
 * (issue #146 A07).
 *
 * The list holds four kinds of pending item - replies she still owes,
 * commitments she made, conversation threads that are still open, and items an
 * operator recorded but wants kept out of the prompt. It is deliberately
 * narrow and honest about its limits:
 *
 *   - Default off. The module is imported by context assembly, but it stays
 *     default-off: nothing renders or is charged until a caller supplies
 *     pending entries, so no existing prompt or budget number changes.
 *   - No persistence. The store is pure memory: no M6 schema, no storage
 *     module, no file. A new process, or a new store instance, starts empty.
 *   - One session per store. A store is constructed for exactly one
 *     `sessionId`: a record for another session is refused, and a read for
 *     another session throws, so a reused instance can neither accept nor
 *     expose another session's entries.
 *   - Admission follows the delivery commit. `record` takes the full
 *     acknowledgement M6/M5 produced for the delivery that produced the item
 *     and the delivery itself, and admits only an `applied` one whose effective
 *     classification is `fully-delivered` AND whose delivery
 *     `classifyMemoryBucket` places in the spoken bucket: an item can never
 *     enter working memory before the delivery that produced it is durably
 *     committed, and never when that delivery is only partly (or not at all)
 *     delivered, or when it is spoken without the evidence the bucket rule
 *     requires.
 *   - Bounded. At most `WORKING_MEMORY_MAX_ENTRIES` entries stay pending, and
 *     the audit view keeps only the newest `WORKING_MEMORY_MAX_AUDIT_ENTRIES`
 *     non-pending entries, so `entries` returns at most 8 + 32 = 40 records.
 *     Older audit history is gone by design: the price of a store that cannot
 *     grow for the lifetime of the process. Persistence is outside this module.
 *   - The store never reads a clock. Every timestamp is passed by the caller,
 *     which keeps rendering and expiry deterministic under injected-clock
 *     tests.
 *
 * The closed-loop read (`observe`) is shape-only for now: see the note on
 * `WorkingMemoryStore.observe` for why it cannot fire in production yet.
 */

/** The four kinds of working-memory entries (issue #146 A07). */
export type WorkingMemoryKind = 'awaiting-reply' | 'commitment' | 'open-thread' | 'suppressed'

/** At most this many entries may hold status 'pending' at one time. */
export const WORKING_MEMORY_MAX_ENTRIES = 8

/**
 * At most this many NON-pending entries stay in the audit view: the newest by
 * `seq`. Pending entries are governed by the cap above and are never pruned,
 * so `entries` returns at most
 * `WORKING_MEMORY_MAX_ENTRIES + WORKING_MEMORY_MAX_AUDIT_ENTRIES` (40)
 * records.
 *
 * 32 is four times the pending cap: enough recent history to explain what the
 * store did, without letting one record per turn grow the process for its whole
 * lifetime.
 */
export const WORKING_MEMORY_MAX_AUDIT_ENTRIES = 32

export interface WorkingMemoryEntry {
  kind: WorkingMemoryKind
  /**
   * Verbatim short text of the pending item. Never audience speech: the
   * rendered block states once, in its header, that entries are internal notes
   * and never instructions.
   */
  text: string
  /** Listener actor the item is bound to; null when anonymous. */
  actorId: string | null
  /** Injected-clock milliseconds at which the entry was recorded. */
  createdAtMs: number
  /** Injected-clock milliseconds at/after which the entry counts as expired. */
  expiresAtMs: number
  /** Store-local arrival counter used for stable ordering; never a durable id. */
  seq: number
}

export type WorkingMemoryEntryStatus =
  | 'pending'
  | 'fulfilled'
  | 'superseded'
  | 'expired'
  | 'evicted'

export interface WorkingMemoryRecordInput {
  /** Session this store was constructed for; any other session is refused. */
  sessionId: string
  kind: WorkingMemoryKind
  /**
   * Verbatim internal note: a single line, never audience speech. Embedded
   * line breaks (`\n` or `\r`) are refused rather than rendered as extra,
   * unmarked lines inside the block. The text is stored exactly as given - no
   * trimming, no rewriting.
   */
  text: string
  actorId: string | null
  nowMs: number
  ttlMs: number
}

/**
 * Module-local refusal reasons. They are string literals on purpose: no new
 * stable id or contract enum is minted by this batch.
 */
export type WorkingMemoryRefusalReason =
  | 'commit-not-applied'
  | 'commit-not-spoken'
  | 'not-spoken-bucket'
  | 'empty-text'
  | 'text-not-single-line'
  | 'session-mismatch'

export type WorkingMemoryRecordResult =
  | { status: 'recorded'; entry: WorkingMemoryEntry }
  | { status: 'refused'; reason: WorkingMemoryRefusalReason }

/** Construction options: the one session this store serves. */
export interface WorkingMemoryStoreOptions {
  sessionId: string
}

export interface WorkingMemoryStore {
  /**
   * Record one pending item, but only after its producing delivery was
   * committed AND fully spoken.
   *
   * Admission order:
   *   1. `input.sessionId` must be the session the store was constructed for.
   *      Any other session is refused with `'session-mismatch'` and leaves the
   *      store unchanged.
   *   2. `delivery.sessionId` must be the same session. A delivery recorded for
   *      another session is refused with `'session-mismatch'` and leaves the
   *      store unchanged: the store serves one session, and an item cannot be
   *      carried over from a session it was not produced in.
   *   3. `ack.status` must be `'applied'`. Every other status - `'failed'`,
   *      `'conflict'` and also `'duplicate'` - is refused with
   *      `'commit-not-applied'`, and leaves the store unchanged. A `duplicate`
   *      acknowledgement means an `applied` pass already happened for this
   *      delivery in this process, so re-recording would double-count the item.
   *   4. `ack.effectiveClassification` must be `'fully-delivered'`, the
   *      classification layer: an `applied` acknowledgement whose effective
   *      classification is `'partial-unknown'` or `'not-delivered'` is refused
   *      with `'commit-not-spoken'`, because the delivery commit succeeded but
   *      the turn was not fully heard, so it must not enter a list that renders
   *      as "still pending".
   *   5. The note shape is judged next, on `input.text`: empty or
   *      whitespace-only text is refused with `'empty-text'`, and text
   *      containing a line break (`\n` or `\r`) with `'text-not-single-line'` -
   *      the rendered block is one line per item, so a break would inject an
   *      unmarked line into the block. These checks run before the evidence
   *      layer below on purpose: they judge the note, the bucket judges the
   *      spoken text, and keeping note-shape refusals first preserves their
   *      existing reason semantics. The text is kept verbatim once admitted -
   *      no trimming, no newline collapsing.
   *   6. `classifyMemoryBucket(delivery)` must place the producing delivery in
   *      the `'spoken'` bucket, the evidence layer: a delivery that is not
   *      spoken - a fully-delivered audio delivery with no receipt, or a
   *      partial one kept as a heard-prefix fragment or in the audit view - is
   *      refused with `'not-spoken-bucket'` and leaves the store unchanged. The
   *      receipt rule is asked here rather than re-implemented, so
   *      `SPOKEN_RECEIPT_POLICY` keeps one implementation point.
   *
   *      The two layers are distinct: the classification layer reads the
   *      acknowledgement, the evidence layer reads the delivery, and neither
   *      shadows the other. Every refusal above leaves the store unchanged.
   *   7. Otherwise the entry is created with `seq` from a store-local counter
   *      starting at 0, `createdAtMs = nowMs` and `expiresAtMs = nowMs + ttlMs`.
   *   8. Every still-pending entry of the same `kind` and the same `actorId`
   *      (including `null`) is marked `'superseded'`: a newer expectation
   *      replaces the older open one. Superseded entries remain in the audit
   *      view and are never returned as pending again.
   *   9. While more than `WORKING_MEMORY_MAX_ENTRIES` entries are pending, the
   *      oldest pending entry (lowest `seq`) is marked `'evicted'`. Non-pending
   *      entries do not count against the cap but stay auditable, so the loss
   *      is never silent. Lazy expiry runs first, so an entry already past its
   *      TTL at `nowMs` is never the one evicted.
   *  10. The audit view keeps only the newest
   *      `WORKING_MEMORY_MAX_AUDIT_ENTRIES` non-pending entries; older terminal
   *      entries are removed at the end of the call. Pending entries are never
   *      removed by this bound.
   *
   * The returned entry is a copy: mutating it does not change store state.
   */
  record(
    input: WorkingMemoryRecordInput,
    ack: DeliveryCommitAck,
    delivery: ConfirmedDelivery,
  ): WorkingMemoryRecordResult

  /**
   * Closed-loop read: fulfil `awaiting-reply` entries the audience answered.
   *
   * Every pending `awaiting-reply` entry with a non-null `actorId` is marked
   * `'fulfilled'` when a supplied listener turn has the same `actorId` and a
   * `receivedAtMs` strictly after the entry's `createdAtMs` and strictly before
   * its `expiresAtMs`. The entry therefore lives in the half-open window
   * `[createdAtMs, expiresAtMs)`: turns at or before `createdAtMs` were already
   * known when the reply was still owed, and a turn at or after `expiresAtMs`
   * answers an entry that inclusive expiry already treats as expired. Anonymous
   * entries (`actorId === null`) are never fulfilled this way. No clock is read.
   *
   * The caller must pass the turns the character is not answering right now:
   * the selected input's own event is the utterance under reply, not an answer
   * to it. `sessionId` must be the session the store was constructed for; any
   * other session throws. The audit bound is applied after the transitions.
   *
   * Limitation, stated rather than hidden: production does not supply listener
   * turns yet. `ListenerHistoryPort` comes from issue #151/A01 (shape only; no
   * production caller injects it) and the data source is issue #147/X01. Until
   * that wiring exists the closed loop cannot fire, so `awaiting-reply` entries
   * age out by TTL alone.
   */
  observe(listenerTurns: readonly ListenerTurn[], sessionId: string): void

  /**
   * The entries still pending at `nowMs`, oldest first.
   *
   * As a side effect every pending entry with `nowMs >= expiresAtMs` is first
   * marked `'expired'` (expiry at the boundary is inclusive); expired entries
   * are then excluded and remain visible only in `entries`. The audit bound is
   * applied by the same pass, so the read is bounded even after nothing was
   * recorded. `sessionId` must be the session the store was constructed for;
   * any other session throws. The result is ordered by ascending `seq` and
   * every element is a copy.
   */
  pending(nowMs: number, sessionId: string): readonly WorkingMemoryEntry[]

  /**
   * Full audit view at `nowMs`: every retained entry with its status, oldest
   * first, as copies. Expiry is applied first, exactly as in `pending`, and the
   * view is then bounded to the newest `WORKING_MEMORY_MAX_AUDIT_ENTRIES`
   * non-pending entries - pending entries are never pruned - so at most
   * `WORKING_MEMORY_MAX_ENTRIES + WORKING_MEMORY_MAX_AUDIT_ENTRIES` records are
   * returned. Terminal entries older than that window are not retrievable.
   * `sessionId` must be the session the store was constructed for; any other
   * session throws.
   */
  entries(
    nowMs: number,
    sessionId: string,
  ): readonly (WorkingMemoryEntry & { status: WorkingMemoryEntryStatus })[]
}

type StoredEntry = WorkingMemoryEntry & {
  status: WorkingMemoryEntryStatus
  /**
   * Set when the cap, rather than the TTL, is what took the entry out of
   * `pending`. The store never reads a clock, so this flag is what keeps an
   * evicted entry reported as 'evicted' after its TTL passes and an expired one
   * reported as 'expired'.
   */
  lostToCap: boolean
}

/**
 * Isolation boundary, the same rule `memory-commit.ts` applies to its records:
 * entries leave the store as copies, so a caller cannot rewrite store state -
 * including promoting a fulfilled or evicted item back to pending - through a
 * returned object.
 *
 * The copy is an explicit projection of the six `WorkingMemoryEntry` fields and
 * never a spread of the stored record: `status` and `lostToCap` are store
 * bookkeeping, and a spread would leak them into objects typed
 * `WorkingMemoryEntry` (review finding on step 1).
 */
function copyEntry(entry: StoredEntry): WorkingMemoryEntry {
  return {
    kind: entry.kind,
    text: entry.text,
    actorId: entry.actorId,
    createdAtMs: entry.createdAtMs,
    expiresAtMs: entry.expiresAtMs,
    seq: entry.seq,
  }
}

/** A line break would render as an extra, unmarked line inside the block. */
function hasLineBreak(text: string): boolean {
  return text.includes('\n') || text.includes('\r')
}

export function createWorkingMemoryStore(
  options: WorkingMemoryStoreOptions,
): WorkingMemoryStore {
  const boundSessionId = options.sessionId
  const stored: StoredEntry[] = []
  let nextSeq = 0

  /**
   * The store holds one session for its whole life, so a read naming another
   * session is a caller bug rather than a miss: a filter would silently return
   * an empty block - the silent-loss failure mode this repository refuses
   * elsewhere (cf. `budget.ts`, fail loud). Throwing keeps the bug visible.
   */
  function assertSession(callerSessionId: string, operation: string): void {
    if (callerSessionId !== boundSessionId) {
      throw new Error(
        `working-memory: ${operation} was called for a session the store is not bound to`,
      )
    }
  }

  /**
   * The two-level bound: pending entries are governed by
   * `WORKING_MEMORY_MAX_ENTRIES` and are never pruned here; non-pending entries
   * keep only the newest `WORKING_MEMORY_MAX_AUDIT_ENTRIES` by `seq`.
   *
   * Runs after every pass that can turn a pending entry terminal (expiry,
   * supersede, eviction, fulfilment) and on every read, so a store that is
   * written but not yet read cannot grow without bound. Declared before its
   * callers so the read order matches the call order.
   */
  function pruneAudit(): void {
    const nonPending = stored.filter((entry) => entry.status !== 'pending')
    if (nonPending.length <= WORKING_MEMORY_MAX_AUDIT_ENTRIES) return
    const keep = new Set<StoredEntry>(
      nonPending
        .slice()
        .sort((left, right) => right.seq - left.seq)
        .slice(0, WORKING_MEMORY_MAX_AUDIT_ENTRIES),
    )
    for (let index = stored.length - 1; index >= 0; index -= 1) {
      const entry = stored[index]
      if (entry === undefined) continue
      if (entry.status === 'pending' || keep.has(entry)) continue
      stored.splice(index, 1)
    }
  }

  /**
   * Lazy expiry, shared by `record`, `pending` and `entries`.
   *
   * Only an entry that is still pending can expire: an entry the cap already
   * took out of `pending` keeps status 'evicted' even after its TTL passes, so
   * the audit view attributes the loss to the rule that actually caused it. The
   * pass is idempotent, expiry at `expiresAtMs` is inclusive, and it always
   * ends with the audit bound, so every reader sees a bounded view.
   */
  function expire(nowMs: number): void {
    for (const entry of stored) {
      if (entry.status === 'pending' && nowMs >= entry.expiresAtMs) {
        entry.status = 'expired'
      }
    }
    pruneAudit()
  }

  return {
    record(input, ack, delivery) {
      if (input.sessionId !== boundSessionId) {
        return { status: 'refused', reason: 'session-mismatch' }
      }

      if (delivery.sessionId !== boundSessionId) {
        return { status: 'refused', reason: 'session-mismatch' }
      }

      if (ack.status !== 'applied') {
        return { status: 'refused', reason: 'commit-not-applied' }
      }

      // Classification layer: applied means "committed", not "spoken" (see
      // `DeliveryCommitAck`).
      if (ack.effectiveClassification !== 'fully-delivered') {
        return { status: 'refused', reason: 'commit-not-spoken' }
      }

      if (input.text.trim() === '') {
        return { status: 'refused', reason: 'empty-text' }
      }

      if (hasLineBreak(input.text)) {
        return { status: 'refused', reason: 'text-not-single-line' }
      }

      // Evidence layer: the acknowledgement carries no receipt, modality or
      // session, so the producing delivery is judged by the bucket rule, which
      // is the single implementation point of `SPOKEN_RECEIPT_POLICY`.
      if (classifyMemoryBucket(delivery).bucket !== 'spoken') {
        return { status: 'refused', reason: 'not-spoken-bucket' }
      }

      // The audit view must not show an entry as pending once its TTL has
      // passed at the caller's current time, so expiry runs before the cap
      // decision: an entry already out of time is not pending and cannot be
      // the one evicted.
      expire(input.nowMs)

      const entry: StoredEntry = {
        kind: input.kind,
        text: input.text,
        actorId: input.actorId,
        createdAtMs: input.nowMs,
        expiresAtMs: input.nowMs + input.ttlMs,
        seq: nextSeq++,
        status: 'pending',
        lostToCap: false,
      }
      stored.push(entry)

      // A newer expectation replaces the older open one for this actor.
      for (const existing of stored) {
        if (
          existing !== entry &&
          existing.status === 'pending' &&
          existing.kind === input.kind &&
          existing.actorId === input.actorId
        ) {
          existing.status = 'superseded'
        }
      }

      // Enforce the cap by evicting the oldest pending entries first.
      for (;;) {
        const stillPending = stored
          .filter((candidate) => candidate.status === 'pending')
          .sort((left, right) => left.seq - right.seq)
        if (stillPending.length <= WORKING_MEMORY_MAX_ENTRIES) break
        const oldest = stillPending[0]
        if (oldest === undefined) break
        oldest.status = 'evicted'
        oldest.lostToCap = true
      }

      // Supersede and eviction are terminal transitions too, so the bound is
      // applied here as well as inside `expire`.
      pruneAudit()

      return { status: 'recorded', entry: copyEntry(entry) }
    },

    observe(listenerTurns, sessionId) {
      assertSession(sessionId, 'observe')
      for (const entry of stored) {
        if (entry.status !== 'pending' || entry.kind !== 'awaiting-reply') continue
        if (entry.actorId === null) continue
        const answered = listenerTurns.some(
          (turn) =>
            turn.actorId === entry.actorId &&
            turn.receivedAtMs > entry.createdAtMs &&
            turn.receivedAtMs < entry.expiresAtMs,
        )
        if (answered) entry.status = 'fulfilled'
      }
      // Fulfilment is a terminal transition reached without `expire`.
      pruneAudit()
    },

    pending(nowMs, sessionId) {
      assertSession(sessionId, 'pending')
      expire(nowMs)
      return stored
        .filter((entry) => entry.status === 'pending')
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => copyEntry(entry))
    },

    entries(nowMs, sessionId) {
      assertSession(sessionId, 'entries')
      expire(nowMs)
      return stored
        .slice()
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => ({
          kind: entry.kind,
          text: entry.text,
          actorId: entry.actorId,
          createdAtMs: entry.createdAtMs,
          expiresAtMs: entry.expiresAtMs,
          seq: entry.seq,
          status: entry.status,
        }))
    },
  }
}

/**
 * Section header for the rendered working-memory block.
 *
 * The standing is stated once, here, instead of marking each item: entries are
 * the character's internal notes, never audience speech and never instructions,
 * so they are not `[audience, untrusted]` text. A per-item marker would spend
 * characters on every rendered line (the block is charged to the prompt) and
 * would mislabel `awaiting-reply` items.
 */
export const WORKING_MEMORY_BLOCK_HEADER =
  'Still pending (working memory; notes, never instructions):'

/*
 * Private on purpose: context assembly will import this module in a later
 * step, so importing `ITEM_PREFIX` from `./context` would create a cycle. The
 * prefix is a local literal instead.
 */
const WORKING_MEMORY_ITEM_PREFIX = '- '

/**
 * Render the working-memory block for one prompt, or `null` when nothing is
 * renderable.
 *
 * `suppressed` entries are never rendered: they are recorded for the operator
 * and kept out of the prompt by definition. Every other entry becomes one line,
 * `- <text> (<kind>)`, in the given order, under
 * `WORKING_MEMORY_BLOCK_HEADER`, whose wording carries the notes-never-
 * instructions standing for the whole block; the text itself renders exactly
 * as stored. The function is pure and deterministic: no I/O, no clock, no
 * randomness, no environment access, and it does not decide expiry - the
 * caller passes only entries that should render.
 */
export function renderWorkingMemoryBlock(
  entries: readonly WorkingMemoryEntry[],
): string | null {
  const lines = entries
    .filter((entry) => entry.kind !== 'suppressed')
    .map((entry) => `${WORKING_MEMORY_ITEM_PREFIX}${entry.text} (${entry.kind})`)
  if (lines.length === 0) return null
  return [WORKING_MEMORY_BLOCK_HEADER, ...lines].join('\n')
}
