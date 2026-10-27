import { describe, expect, it } from 'vitest'
import { createDeliveryMemoryStore, isAllowedDeliveryPair } from '../../src/dialogue'
import { FIXTURE_SESSION_ID, fixtureCommitDelivery } from '../support/fixture-data'

/**
 * M4 memory safety — the admission half of the late-evidence boundary.
 *
 * Why this file exists
 * --------------------
 * Case C-64 was reserved by M4 in issue #25 (2026-10-18) as the admission-side
 * verifier: "late evidence claiming `fully-delivered` for a `cancelled` terminal
 * is refused at admission". On 2026-10-24 M6 and M5 confirmed in #25 that C-67
 * covers the storage half only (a late claim is recorded as a conflict and the
 * original evidence is preserved durably) and that "it does not close M4's
 * admission path". The two cases are deliberately non-overlapping:
 *
 *   - C-67 (M6): the durable store keeps the original `partial-unknown` record
 *     and reports the late `fully-delivered` claim as a conflict.
 *   - C-64 (M4, this file): the in-memory admission path never lets the late
 *     claim upgrade a stored record into spoken history, and the refusal leaves
 *     the store byte-for-byte unchanged.
 *
 * Falsifiability follows the C-58 method: every assertion names the change that
 * would turn it red, so a future edit that weakens admission is caught here and
 * not by an accident in production.
 *
 * Scope note: only C-64 is verified here. C-56–C-63 remain reservations and are
 * tracked in issue #25; this file is the reserved home for that safety matrix
 * and gains cases one at a time as they are coordinated.
 */

/** One stable delivery identity; only classification/outcome vary across claims. */
function lateClaimBase() {
  return {
    sessionId: FIXTURE_SESSION_ID,
    turnId: 'turn-cancelled',
    segmentId: 'seg-cancelled-0',
    textHash: 'hash-cancelled-0',
    text: 'Let me pick that back up.',
    outputId: 'output-cancelled-0',
    receiptId: 'receipt-cancelled-0',
    segmentIndex: 0,
    personaProfileId: 'character-fixture',
    personaProfileVersion: '1',
  }
}

describe('M4 memory safety — C-64 admission path', () => {
  it('refuses a late fully-delivered claim for a cancelled terminal', async () => {
    const memory = createDeliveryMemoryStore()

    /*
     * Step 1 — the honest record arrives first: playback was cancelled, so M5
     * classifies the delivery as `partial-unknown`. This is an allowed pair and
     * is applied — but it is audit-only, so spoken history stays empty.
     */
    const initial = await memory.commit(
      fixtureCommitDelivery({
        ...lateClaimBase(),
        classification: 'partial-unknown',
        terminalOutcome: 'cancelled',
      }),
    )
    expect(initial).toEqual({
      status: 'applied',
      effectiveClassification: 'partial-unknown',
      recordId: `${FIXTURE_SESSION_ID}:turn-cancelled:seg-cancelled-0:audio`,
    })
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])

    /*
     * The audit snapshot is the falsification anchor: every later assertion in
     * this test compares against it, so any silent mutation of the stored
     * record — above all an upgrade to `fully-delivered` — turns red here.
     */
    const auditBefore = structuredClone(memory.audit())
    expect(auditBefore).toHaveLength(1)
    expect(auditBefore[0]?.delivery.classification).toBe('partial-unknown')

    /*
     * Step 2a — the late claim arrives still carrying the cancelled terminal.
     * The pair itself is a caller error (`fully-delivered` + `cancelled`), so
     * the strict pairing guard refuses it before the store even looks at the
     * existing record.
     *
     * Counterfactual (C-58 method): setting `DELIVERY_PAIR_POLICY` to 'lenient'
     * in `src/dialogue/memory-commit.ts` makes this commit fall through to the
     * key lookup and return a conflict ack instead — the status assertion below
     * is what turns red under that change.
     */
    const lateSameTerminal = await memory.commit(
      fixtureCommitDelivery({
        ...lateClaimBase(),
        classification: 'fully-delivered',
        terminalOutcome: 'cancelled',
      }),
    )
    expect(lateSameTerminal).toMatchObject({
      status: 'failed',
      reasonCode: 'invalid-delivery-pair',
    })

    /*
     * Step 2b — the subtler upgrade: the late claim swaps the terminal to
     * `completed`, so the pair itself is valid and the refusal must come from
     * the record comparison. The stored classification is `partial-unknown`;
     * the incoming one is `fully-delivered`; that is a conflict, never an
     * upgrade (M4 never changes a classification, see `memory-commit.ts`).
     *
     * Counterfactual: replacing the conflict return in `commit()` with an
     * applied overwrite would leave the audit snapshot comparison and the
     * spoken-history assertion below red.
     */
    const lateUpgrade = await memory.commit(
      fixtureCommitDelivery({
        ...lateClaimBase(),
        classification: 'fully-delivered',
        terminalOutcome: 'completed',
      }),
    )
    expect(lateUpgrade).toEqual({
      status: 'conflict',
      recordedClassification: 'partial-unknown',
      incomingClassification: 'fully-delivered',
      conflictRecordId: `${FIXTURE_SESSION_ID}:turn-cancelled:seg-cancelled-0:audio:conflict`,
    })

    /*
     * Step 3 — nothing moved. The refusal variants left no trace: the audit
     * view is unchanged, the record still says `partial-unknown`, and spoken
     * history is still empty. Admission was refused, not deferred.
     */
    expect(memory.audit()).toEqual(auditBefore)
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])
    expect(memory.records()).toHaveLength(1)
    expect(memory.records()[0]?.classification).toBe('partial-unknown')
    expect(memory.records()[0]?.terminalOutcome).toBe('cancelled')
  })

  it('rejects the fully-delivered/cancelled pair itself as a caller error', async () => {
    /*
     * The pairing table is the first gate: `fully-delivered` pairs only with
     * `completed`, so a cancelled terminal can never claim full delivery.
     *
     * Counterfactual (C-58 method): adding 'cancelled' to
     * `ALLOWED_DELIVERY_PAIRS['fully-delivered']` in
     * `src/dialogue/memory-commit.ts` turns the first assertion red.
     *
     * Layered defence note: the shared M5->M4 contract
     * (`commitDeliverySchema.superRefine` via `TERMINAL_OUTCOMES_BY_CLASSIFICATION`
     * in `src/contracts/app/storage.ts`) rejects the same pair at schema level,
     * and C-67 refuses the durable-storage half. This unit pins the M4
     * admission layer itself so the layers fail independently.
     */
    expect(isAllowedDeliveryPair('fully-delivered', 'cancelled')).toBe(false)

    const memory = createDeliveryMemoryStore()
    const refused = await memory.commit(
      fixtureCommitDelivery({
        ...lateClaimBase(),
        classification: 'fully-delivered',
        terminalOutcome: 'cancelled',
      }),
    )
    expect(refused).toMatchObject({
      status: 'failed',
      reasonCode: 'invalid-delivery-pair',
    })

    // A rejected pair is not stored at all: the store stays empty.
    expect(memory.records()).toEqual([])
    expect(memory.audit()).toEqual([])
    expect(await memory.confirmedHistory(FIXTURE_SESSION_ID)).toEqual([])
  })
})
