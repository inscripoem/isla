import type { DeliveryCommitAck } from '../contracts'
import type { ListenerTurn } from './listener-history'

/**
 * Working memory: a per-process list of what is still open for the character
 * (issue #146 A07).
 *
 * The list holds four kinds of pending item - replies she still owes,
 * commitments she made, conversation threads that are still open, and items an
 * operator recorded but wants kept out of the prompt. It is deliberately
 * narrow and honest about its limits:
 *
 *   - Default off. Nothing in this step is consulted by any production caller,
 *     and no existing prompt or budget number changes. Context assembly will
 *     import this module in a later step of the same batch.
 *   - No persistence. The store is pure memory: no M6 schema, no storage
 *     module, no file. A new process, or a new store instance, starts empty.
 *   - Admission follows the delivery commit. `record` takes the
 *     acknowledgement M6/M5 produced for the delivery that produced the item
 *     and admits only an `applied` one, so an item can never enter working
 *     memory before the turn that produced it is durably committed.
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

export interface WorkingMemoryEntry {
  kind: WorkingMemoryKind
  /** Verbatim short text of the pending item. */
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
  kind: WorkingMemoryKind
  text: string
  actorId: string | null
  nowMs: number
  ttlMs: number
}

export type WorkingMemoryRecordResult =
  | { status: 'recorded'; entry: WorkingMemoryEntry }
  | { status: 'refused'; reason: 'commit-not-applied' | 'empty-text' }

export interface WorkingMemoryStore {
  /**
   * Record one pending item, but only after its producing delivery was
   * committed.
   *
   * Admission order:
   *   1. `ack.status` must be `'applied'`. Every other status - `'failed'`,
   *      `'conflict'` and also `'duplicate'` - is refused with
   *      `'commit-not-applied'` and leaves the store unchanged. A `duplicate`
   *      acknowledgement means an `applied` pass already happened for this
   *      delivery in this process, so re-recording would double-count the item.
   *   2. Empty or whitespace-only text is refused with `'empty-text'`.
   *   3. Otherwise the entry is created with `seq` from a store-local counter
   *      starting at 0, `createdAtMs = nowMs` and `expiresAtMs = nowMs + ttlMs`.
   *   4. Every still-pending entry of the same `kind` and the same `actorId`
   *      (including `null`) is marked `'superseded'`: a newer expectation
   *      replaces the older open one. Superseded entries remain in the audit
   *      view and are never returned as pending again.
   *   5. While more than `WORKING_MEMORY_MAX_ENTRIES` entries are pending, the
   *      oldest pending entry (lowest `seq`) is marked `'evicted'`. Non-pending
   *      entries do not count against the cap but stay auditable, so the loss
   *      is never silent. Lazy expiry runs first, so an entry already past its
   *      TTL at `nowMs` is never the one evicted.
   *
   * The returned entry is a copy: mutating it does not change store state.
   */
  record(
    input: WorkingMemoryRecordInput,
    ack: { status: DeliveryCommitAck['status'] },
  ): WorkingMemoryRecordResult

  /**
   * Closed-loop read: fulfil `awaiting-reply` entries the audience answered.
   *
   * Every pending `awaiting-reply` entry with a non-null `actorId` is marked
   * `'fulfilled'` when a supplied listener turn has the same `actorId` and a
   * `receivedAtMs` strictly after the entry's `createdAtMs`. Anonymous entries
   * (`actorId === null`) are never fulfilled this way, and turns at or before
   * `createdAtMs` were already known when the reply was still owed, so they do
   * not count either.
   *
   * Limitation, stated rather than hidden: production does not supply listener
   * turns yet. `ListenerHistoryPort` comes from issue #151/A01 (shape only; no
   * production caller injects it) and the data source is issue #147/X01. Until
   * that wiring exists the closed loop cannot fire, so `awaiting-reply` entries
   * age out by TTL alone.
   */
  observe(listenerTurns: readonly ListenerTurn[]): void

  /**
   * The entries still pending at `nowMs`, oldest first.
   *
   * As a side effect every pending entry with `nowMs >= expiresAtMs` is first
   * marked `'expired'` (expiry at the boundary is inclusive); expired entries
   * are then excluded and remain visible only in `entries`. The result is
   * ordered by ascending `seq` and every element is a copy.
   */
  pending(nowMs: number): readonly WorkingMemoryEntry[]

  /**
   * Full audit view at `nowMs`: every entry in insertion order, each with its
   * status, as copies. Expiry is applied first, exactly as in `pending`.
   */
  entries(nowMs: number): readonly (WorkingMemoryEntry & { status: WorkingMemoryEntryStatus })[]
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

export function createWorkingMemoryStore(): WorkingMemoryStore {
  const stored: StoredEntry[] = []
  let nextSeq = 0

  /**
   * Lazy expiry, shared by `record`, `pending` and `entries`.
   *
   * Only an entry that is still pending can expire: an entry the cap already
   * took out of `pending` keeps status 'evicted' even after its TTL passes, so
   * the audit view attributes the loss to the rule that actually caused it. The
   * pass is idempotent, and expiry at `expiresAtMs` is inclusive.
   */
  function expire(nowMs: number): void {
    for (const entry of stored) {
      if (entry.status === 'pending' && nowMs >= entry.expiresAtMs) {
        entry.status = 'expired'
      }
    }
  }

  return {
    record(input, ack) {
      if (ack.status !== 'applied') {
        return { status: 'refused', reason: 'commit-not-applied' }
      }

      if (input.text.trim() === '') {
        return { status: 'refused', reason: 'empty-text' }
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

      return { status: 'recorded', entry: copyEntry(entry) }
    },

    observe(listenerTurns) {
      for (const entry of stored) {
        if (entry.status !== 'pending' || entry.kind !== 'awaiting-reply') continue
        if (entry.actorId === null) continue
        const answered = listenerTurns.some(
          (turn) => turn.actorId === entry.actorId && turn.receivedAtMs > entry.createdAtMs,
        )
        if (answered) entry.status = 'fulfilled'
      }
    },

    pending(nowMs) {
      expire(nowMs)
      return stored
        .filter((entry) => entry.status === 'pending')
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => copyEntry(entry))
    },

    entries(nowMs) {
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

/** Section header for the rendered working-memory block. */
export const WORKING_MEMORY_BLOCK_HEADER = 'Still pending (working memory):'

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
 * `WORKING_MEMORY_BLOCK_HEADER`. The function is pure and deterministic: no
 * I/O, no clock, no randomness, no environment access, and it does not decide
 * expiry - the caller passes only entries that should render.
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
