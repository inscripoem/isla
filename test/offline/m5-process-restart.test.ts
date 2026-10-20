import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRecoveryView } from '../../src/storage'
import type { RecoveryView } from '../../src/storage'
import { createSqliteBackend, openDatabase } from '../../src/storage/sqlite'
import {
  M1_FIXTURE_SEGMENT_0_TEXT,
  M1_FIXTURE_SEGMENT_1_TEXT,
  createControlledMediaDriver,
  createM1ActualBlobMap,
  createRegistryResolver,
} from '../support/m1-kit'
import { createPerformerClient } from '../support/performer-client'
import type { PerformerClient } from '../support/performer-client'
import {
  DEPLOYMENT_MODULE,
  bootstrapOperatorToken,
  collectUntilExit,
  createCliHarness,
  seedDatabase,
  waitForListening,
} from '../support/production-cli-kit'
import type { CliHarness } from '../support/production-cli-kit'
import { TEST_DEPLOYMENT_ORIGIN, seedProductionEvidence } from '../support/production-kit'

/**
 * Cross-process production restart acceptance.
 *
 * Two separately spawned production CLI processes run over one real SQLite
 * database. The first produces a confirmed turn through the actual application
 * transport (WebSocket `/app`) and exits under SIGTERM. The second starts under
 * a fresh live id, explicitly selects the previous live session and the seeded
 * archive, continues output through the same transport, and never replays old
 * audio or promotes the archive's partial-unknown, null-attribution record. The
 * assembled dialogue context is observed through the test-only capture hook in
 * the deployment module.
 *
 * Scope: real child processes, real SQLite, real application transport. The peer
 * modules are the labeled test substitutes, so this establishes process
 * continuation and evidence preservation — not live providers, acoustic output
 * or uncommitted-tail crash recovery.
 */

const LIVE_A = 'session-restart-a'
const LIVE_B = 'session-restart-b'
const ARCHIVE = 'session-restart-archive'
const INPUT_A = 'a question before the restart'
const INPUT_B = 'a question after the restart'
const SEGMENTS = [M1_FIXTURE_SEGMENT_0_TEXT, M1_FIXTURE_SEGMENT_1_TEXT] as const
const PERFORMANCE_KINDS = new Set([
  'performance.offer',
  'performance.grant',
  'performance.cancel',
  'performance.execute',
])

interface CapturedContext {
  selectedInputText: string
  historySource: string
  history: Array<{
    sessionId: string
    turnId: string
    segmentId: string
    text: string
    classification: string
    personaProfileId: string | null
  }>
  turns: Array<{ sessionId: string; turnId: string; text: string; interrupted: boolean }>
  exclusions: Array<{ sessionId: string; turnId: string; reason: string }>
}

const harness = createCliHarness('isla-m5-process-restart-')

afterEach(async () => {
  await harness.cleanup()
})

async function until<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 20000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function sessionEvents(client: PerformerClient, type: string): Array<Record<string, unknown>> {
  return client.messages().filter((message) => {
    if (message.kind !== 'session.event') return false
    const payload = message.payload
    return (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { type?: unknown }).type === type
    )
  })
}

/** Boots one performer connection: snapshot, operator authority, attach, resume. */
async function connectPerformer(
  cli: CliHarness,
  port: number,
  sessionId: string,
): Promise<PerformerClient> {
  let counter = 0
  const client = createPerformerClient({
    url: `ws://127.0.0.1:${port}/app`,
    origin: TEST_DEPLOYMENT_ORIGIN,
    sessionId,
    resolver: createRegistryResolver(createM1ActualBlobMap()),
    media: createControlledMediaDriver({ autoEvents: true }),
    receipts: {
      newReceiptId: () => `${sessionId}-receipt-${(counter += 1)}`,
      localNowMs: () => null,
    },
  })
  // Tracked before the handshake: a failed boot must not leak the socket.
  cli.track(() => client.close())
  await client.snapshot
  const token = await bootstrapOperatorToken(port)
  expect((await client.bootstrapOperator(token)).kind).toBe('operator.ack')
  expect((await client.attach()).kind).toBe('session.attach.ack')
  expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
  return client
}

/** Waits until the turn's segments are observed and durably committed. */
async function waitForCompletedTurn(client: PerformerClient): Promise<void> {
  await until(
    () => ({
      completed: client.receipts().filter((receipt) => receipt.stage === 'completed').length,
      committed: sessionEvents(client, 'delivery.committed').length,
      ended: sessionEvents(client, 'turn.ended').length,
    }),
    (state) =>
      state.completed >= SEGMENTS.length && state.committed >= SEGMENTS.length && state.ended >= 1,
  )
}

function withRecoveryView<T>(dbPath: string, read: (view: RecoveryView) => T): T {
  const database = openDatabase(dbPath)
  try {
    return read(createRecoveryView(createSqliteBackend(database)))
  } finally {
    database.close()
  }
}

function unresolvedRecords(view: RecoveryView, sessionId: string) {
  return view.unresolved(sessionId).map((entry) => ({
    text: entry.record.text,
    outcome: entry.terminalOutcome,
    persona: entry.record.personaProfileId,
  }))
}

describe('production process restart acceptance', () => {
  it(
    'continues one durable database across two spawned CLI processes without replay or promotion',
    async () => {
      const dbPath = harness.tempDatabasePath()
      const captureFile = join(harness.tempDir(), 'dialogue-context.jsonl')
      // A prior run's evidence: one confirmed turn and one partial-unknown turn
      // with unknown terminal outcome and null persona attribution.
      await seedDatabase(dbPath, (store) => seedProductionEvidence(store, ARCHIVE))

      // ---- first process: confirmed output through the actual transport ----
      const first = harness.start({
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: LIVE_A,
      })
      const firstListening = await waitForListening(first)
      expect(firstListening.sessionId).toBe(LIVE_A)
      const firstClient = await connectPerformer(harness, firstListening.port, LIVE_A)
      expect(((await firstClient.input(INPUT_A)).payload as { status?: string }).status).toBe(
        'accepted',
      )
      await waitForCompletedTurn(firstClient)
      expect(sessionEvents(firstClient, 'delivery.committed')).toHaveLength(SEGMENTS.length)
      const firstOutputIds = [...new Set(firstClient.receipts().map((receipt) => receipt.outputId))]
      expect(firstOutputIds).toHaveLength(SEGMENTS.length)
      await firstClient.close()
      const firstExit = collectUntilExit(first)
      first.kill('SIGTERM')
      const firstResult = await firstExit
      expect(firstResult.code).toBe(0)
      expect(firstResult.output).toContain('"event":"shutdown_complete"')

      // The transport-confirmed turn is durable, and the archive's unknown
      // evidence is unchanged, read independently after the process exited.
      // The complete session-scoped identities of every old record are captured
      // here, while only the test process holds the database.
      const oldIdentities = withRecoveryView(dbPath, (view) => {
        expect(view.confirmed(LIVE_A).map((record) => record.text)).toEqual([...SEGMENTS])
        expect(view.confirmed(ARCHIVE).map((record) => record.text)).toEqual(['confirmed words'])
        expect(unresolvedRecords(view, ARCHIVE)).toEqual([
          { text: 'unresolved words', outcome: 'unknown', persona: null },
        ])
        return [
          ...view.confirmed(LIVE_A),
          ...view.confirmed(ARCHIVE),
          ...view.unresolved(ARCHIVE).map((entry) => entry.record),
        ].map((record) => `${record.sessionId}:${record.turnId}:${record.segmentId}`)
      })
      expect(oldIdentities).toHaveLength(SEGMENTS.length + 2)

      // ---- second process: fresh live id, explicit selected history ----
      const second = harness.start({
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: LIVE_B,
        ISLA_TEST_ARCHIVE_SESSIONS: `${LIVE_A},${ARCHIVE}`,
        ISLA_TEST_DIALOGUE_CAPTURE_FILE: captureFile,
      })
      const secondListening = await waitForListening(second)
      expect(secondListening.sessionId).toBe(LIVE_B)
      const secondClient = await connectPerformer(harness, secondListening.port, LIVE_B)
      const messagesBeforeInput = secondClient.messages().length
      expect(((await secondClient.input(INPUT_B)).payload as { status?: string }).status).toBe(
        'accepted',
      )
      await waitForCompletedTurn(secondClient)

      // No replay. Output ids and turn ids are per-process counters, so two
      // processes legitimately produce the same `output-20`/`turn-1`; the
      // durable delivery identity is session-scoped
      // (`sessionId:turnId:segmentId`, key `sessionId:turnId:segmentId:modality`,
      // M6 event-store contract). The evidence is therefore the complete old
      // identities plus fresh-session authority: every performance message is
      // issued under the new live session, no message carries an old record's
      // identity, and nothing is dispatched before this process's own input.
      const performanceMessages = secondClient
        .messages()
        .filter(
          (message) => typeof message.kind === 'string' && PERFORMANCE_KINDS.has(message.kind),
        )
      expect(performanceMessages.length).toBeGreaterThanOrEqual(SEGMENTS.length)
      for (const message of performanceMessages) {
        const payload = message.payload as { sessionId?: unknown }
        expect(payload.sessionId).toBe(LIVE_B)
        const raw = JSON.stringify(message)
        for (const identity of oldIdentities) expect(raw).not.toContain(identity)
      }
      const secondReceipts = secondClient.receipts()
      for (const receipt of secondReceipts) {
        expect(receipt.sessionId).toBe(LIVE_B)
        expect(receipt.segmentId.startsWith(`${LIVE_B}:`)).toBe(true)
      }
      const secondOutputIds = [...new Set(secondReceipts.map((receipt) => receipt.outputId))]
      expect(secondOutputIds).toHaveLength(SEGMENTS.length)
      const beforeInput = secondClient.messages().slice(0, messagesBeforeInput)
      expect(
        beforeInput.some(
          (message) => typeof message.kind === 'string' && PERFORMANCE_KINDS.has(message.kind),
        ),
      ).toBe(false)
      // Only the new turn's deliveries are committed; no old delivery is re-committed.
      expect(sessionEvents(secondClient, 'delivery.committed')).toHaveLength(SEGMENTS.length)

      await secondClient.close()
      const secondExit = collectUntilExit(second)
      second.kill('SIGTERM')
      const secondResult = await secondExit
      expect(secondResult.code).toBe(0)
      expect(secondResult.output).toContain('"event":"shutdown_complete"')

      // The assembled dialogue context proves the carried confirmed history
      // reached the provider and the unresolved record did not.
      const captured = readFileSync(captureFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CapturedContext)
      expect(captured).toHaveLength(1)
      const context = captured[0]!
      expect(context.selectedInputText).toBe(INPUT_B)
      expect(context.historySource).toBe('history-port')
      expect(context.history.map((entry) => entry.sessionId)).toEqual([LIVE_A, LIVE_A, ARCHIVE])
      expect(context.history.map((entry) => entry.text)).toEqual([...SEGMENTS, 'confirmed words'])
      expect(context.history.every((entry) => entry.classification === 'fully-delivered')).toBe(
        true,
      )
      expect(context.turns.map((turn) => turn.sessionId)).toEqual([LIVE_A, ARCHIVE])
      // A's carried turn ends with sentence punctuation, so it is presented as
      // complete. The seeded archive text ('confirmed words') is fully delivered
      // but ends mid-sentence, so M4 marks it interrupted rather than presenting
      // it as complete — a guard, not a promotion of the unresolved record.
      expect(context.turns.map((turn) => turn.interrupted)).toEqual([false, true])
      expect(context.exclusions).toEqual([])
      expect(JSON.stringify(context)).not.toContain('unresolved words')

      // Durable outcome: the new session's confirmed history is its own two
      // segments, every earlier session keeps exactly its own evidence, and the
      // unknown/null-attribution record is preserved, never promoted.
      withRecoveryView(dbPath, (view) => {
        expect(view.confirmed(LIVE_A).map((record) => record.text)).toEqual([...SEGMENTS])
        expect(view.confirmed(ARCHIVE).map((record) => record.text)).toEqual(['confirmed words'])
        expect(view.confirmed(LIVE_B).map((record) => record.text)).toEqual([...SEGMENTS])
        expect(unresolvedRecords(view, ARCHIVE)).toEqual([
          { text: 'unresolved words', outcome: 'unknown', persona: null },
        ])
        expect(unresolvedRecords(view, LIVE_A)).toEqual([])
        expect(unresolvedRecords(view, LIVE_B)).toEqual([])
      })
    },
    60000,
  )
})
