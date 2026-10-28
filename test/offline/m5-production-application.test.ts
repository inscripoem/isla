import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventStorePort, SelectionPort } from '../../src/contracts'
import type { DialogueTextSource } from '../../src/dialogue'
import { createMonotonicClock } from '../../src/runtime/clock'
import { ReconstructedSessionError, createRuntimeComposition } from '../../src/runtime/composition'
import type { ReconstructedRuntimeComposition } from '../../src/runtime/composition'
import { createRuntimeAuthorizer } from '../../src/runtime/control-policy'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import type { DialogueOutcomeEvent } from '../../src/runtime/dialogue-outcome'
import type { DialogueOutcomeObservation } from '../../src/runtime/dialogue-outcome'
import type { DialogueOutcomeObserver } from '../../src/runtime/dialogue-outcome'
import { createProductionApplication, validateProductionPeers } from '../../src/runtime/production'
import type {
  ProductionApplication,
  ProductionAudioResources,
  ProductionPeers,
} from '../../src/runtime/production'
import type { ArchiveSelectionConfig } from '../../src/runtime/session-archives'
import { createRecoveryView } from '../../src/storage'
import { resolveStorageConfig } from '../../src/storage/config'
import type { StorageConfig } from '../../src/storage/config'
import { createEventStore } from '../../src/storage/event-store'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import { createSqliteBackend, migrate, openDatabase } from '../../src/storage/sqlite'
import {
  createFixtureDialoguePort,
  createFixtureMemoryCommit,
  createFixtureReactionPort,
  createFixtureRendererPort,
  createFixtureSelectionPort,
} from '../support/correct-ports'
import { fixtureOperatorContext, fixtureRuntimeEvent, fixtureViewerContext } from '../support/fixture-data'
import {
  M1_FIXTURE_SEGMENT_0_TEXT,
  createControlledMediaDriver,
  createM1ActualBlobMap,
  createRegistryResolver,
} from '../support/m1-kit'
import { createCatalogDialogueTextSource } from '../support/m4-kit'
import { createPerformerClient } from '../support/performer-client'
import type { PerformerClient } from '../support/performer-client'
import {
  TEST_DEPLOYMENT_ORIGIN,
  createTestProductionPeers,
  seedProductionEvidence,
} from '../support/production-kit'

/**
 * M5 production application over the real M6 SQLite backend.
 *
 * These regressions drive the actual production composition and application
 * lifecycle: injected peers, one deadline gate per composition, controlled audio
 * resources, a durable close/reopen through the shared SQLite handle and an
 * explicit recovery into a fresh successor. Only the peer modules are
 * substitutes (the test kit); storage, reconstruction, the endpoint and the
 * coordinator are production code.
 */

const LIVE_1 = 'session-production-live-1'
const LIVE_2 = 'session-production-live-2'
const ARCHIVE = 'session-production-archive'

const apps: ProductionApplication[] = []
const clients: PerformerClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const app of apps.splice(0)) await app.stop().catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempStorage(): StorageConfig {
  const dir = mkdtempSync(join(tmpdir(), 'isla-m5-production-'))
  dirs.push(dir)
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(dir, 'isla.db') }, dir)
}

/** Opens, migrates and seeds a database, then closes it (a prior process). */
async function withSeededStore(
  storage: StorageConfig,
  seed: (store: EventStorePort) => Promise<void>,
): Promise<void> {
  const database = openDatabase(storage.dbPath)
  migrate(database, { dbPath: storage.dbPath, backupDir: storage.backupDir })
  try {
    await seed(createEventStore(createSqliteBackend(database)))
  } finally {
    database.close()
  }
}

function selectionFor(liveSessionId: string, archiveIds: readonly string[] = []): ArchiveSelectionConfig {
  const liveProfile = { profileId: 'character-fixture', profileVersion: '1' }
  return {
    liveSessionId,
    liveProfile,
    selectedSources: archiveIds.map((sessionId) => ({ sessionId })),
    catalogue: new Map(archiveIds.map((sessionId) => [sessionId, liveProfile])),
  }
}

interface RecordingAudioResources extends ProductionAudioResources {
  readonly retireBeforeCalls: Array<{ sessionId: string; newEpoch: number }>
  readonly retireSessionCalls: string[]
}

function createRecordingAudioResources(options: { throwOnRetire?: boolean } = {}): RecordingAudioResources {
  const retireBeforeCalls: Array<{ sessionId: string; newEpoch: number }> = []
  const retireSessionCalls: string[] = []
  return {
    retireBeforeCalls,
    retireSessionCalls,
    retireBefore(sessionId, newEpoch) {
      retireBeforeCalls.push({ sessionId, newEpoch })
      if (options.throwOnRetire === true) throw new Error('injected audio registry fault')
      return 1
    },
    retireSession(sessionId) {
      retireSessionCalls.push(sessionId)
      if (options.throwOnRetire === true) throw new Error('injected audio registry fault')
      return 1
    },
    // This fake records retirement only; it serves no bytes and admits no
    // reference, so the audio route refuses every fetch in these tests.
    admission() {
      return 'unknown_ref'
    },
    resolve() {
      return Promise.reject(
        Object.assign(new Error('recording audio resources do not serve bytes'), {
          code: 'unknown_ref',
        }),
      )
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly body: unknown
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          origin: TEST_DEPLOYMENT_ORIGIN,
          host: `127.0.0.1:${port}`,
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as unknown })
          } catch {
            resolve({ status: res.statusCode ?? 0, body })
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface ApplicationFixture {
  readonly app: ProductionApplication
  readonly storage: StorageConfig
  readonly port: number
  readonly gates: Array<{ gate: RuntimeDeadlineGate; role: 'renderer' | 'synthesis' }>
  readonly media: ReturnType<typeof createControlledMediaDriver>
  newClient(sessionId: string): PerformerClient
  bootstrapOperator(): Promise<string>
  boot(client: PerformerClient): Promise<void>
}

interface StartApplicationOptions {
  storage?: StorageConfig
  liveSessionId?: string
  archives?: readonly string[]
  peers?: ProductionPeers
  textSource?: DialogueTextSource
  audioResources?: ProductionAudioResources
  onDialogueOutcome?: DialogueOutcomeObserver
  recovery?: { nextSessionId?: () => string; maxSources?: number }
}

async function startApplication(options: StartApplicationOptions = {}): Promise<ApplicationFixture> {
  const storage = options.storage ?? tempStorage()
  const clock = createMonotonicClock()
  const gates: Array<{ gate: RuntimeDeadlineGate; role: 'renderer' | 'synthesis' }> = []
  const peers =
    options.peers ??
    createTestProductionPeers({
      clock,
      ...(options.textSource !== undefined ? { textSource: options.textSource } : {}),
      ...(options.audioResources !== undefined ? { audioResources: options.audioResources } : {}),
      ...(options.onDialogueOutcome !== undefined
        ? { onDialogueOutcome: options.onDialogueOutcome }
        : {}),
      onGate: (gate, role) => {
        gates.push({ gate, role })
      },
    })
  const app = await createProductionApplication({
    storage,
    initialSelection: selectionFor(options.liveSessionId ?? LIVE_1, options.archives ?? []),
    peers,
    allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
    port: 0,
    graceMs: 200,
    clock,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  })
  apps.push(app)
  const bound = await app.start()

  const media = createControlledMediaDriver({ autoEvents: true })
  const resolver = createRegistryResolver(createM1ActualBlobMap())
  let receiptCounter = 0
  let clientCounter = 0

  const bootstrapOperator = async (): Promise<string> => {
    const result = await httpRequest(bound.port, '/operator/bootstrap', {
      method: 'POST',
      headers: { 'x-isla-operator-bootstrap': '1', 'content-length': '0' },
    })
    const parsed = result.body as { ok?: boolean; token?: string }
    if (result.status !== 200 || parsed.ok !== true || typeof parsed.token !== 'string') {
      throw new Error(`operator bootstrap failed with status ${result.status}`)
    }
    return parsed.token
  }

  return {
    app,
    storage,
    port: bound.port,
    gates,
    media,
    newClient(sessionId: string): PerformerClient {
      clientCounter += 1
      const client = createPerformerClient({
        url: `ws://127.0.0.1:${bound.port}/app`,
        origin: TEST_DEPLOYMENT_ORIGIN,
        sessionId,
        resolver,
        media,
        receipts: {
          newReceiptId: () => `production-${clientCounter}-receipt-${(receiptCounter += 1)}`,
          localNowMs: () => null,
        },
      })
      clients.push(client)
      return client
    },
    bootstrapOperator,
    async boot(client: PerformerClient) {
      // The performer machine refuses to build an envelope until it has received
      // the runtime's session snapshot, so wait for it before the first message.
      await client.snapshot
      const ack = await client.bootstrapOperator(await bootstrapOperator())
      expect(ack.kind).toBe('operator.ack')
      expect((await client.attach()).kind).toBe('session.attach.ack')
      expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
    },
  }
}

describe('production peer configuration', () => {
  it('names the missing peer for every incomplete deployment', () => {
    const clock = createMonotonicClock()
    const complete = createTestProductionPeers({ clock })
    expect(() => validateProductionPeers(complete)).not.toThrow()

    const incomplete: Array<[Partial<ProductionPeers>, string]> = [
      [{ selection: {} as ProductionPeers['selection'] }, 'peers.selection.select'],
      [{ reaction: {} as ProductionPeers['reaction'] }, 'peers.reaction.decide'],
      [{ textSource: {} as ProductionPeers['textSource'] }, 'peers.textSource.compose'],
      [{ createRenderer: undefined as unknown as ProductionPeers['createRenderer'] }, 'peers.createRenderer(gate)'],
      [{ createSynthesis: undefined as unknown as ProductionPeers['createSynthesis'] }, 'peers.createSynthesis(gate)'],
    ]
    for (const [override, field] of incomplete) {
      expect(() => validateProductionPeers({ ...complete, ...override })).toThrowError(field)
    }
    expect(() => validateProductionPeers(null as unknown as ProductionPeers)).toThrowError('peers')
  })

  it('rejects an incomplete deployment before opening storage', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    const peers = {
      ...createTestProductionPeers({ clock }),
      createSynthesis: undefined,
    } as unknown as ProductionPeers
    await expect(
      createProductionApplication({
        storage,
        initialSelection: selectionFor(LIVE_1),
        peers,
        allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      }),
    ).rejects.toThrowError('peers.createSynthesis(gate)')
    // Peer validation happens before the database handle is opened.
    expect(existsSync(storage.dbPath)).toBe(false)
  })

  it('fails visibly when a composition has neither a synthesis port nor a catalog', () => {
    const clock = createMonotonicClock()
    const gate = createDeadlineGate(clock)
    expect(() =>
      createRuntimeComposition({
        clock,
        authorizer: createRuntimeAuthorizer(),
        selection: createFixtureSelectionPort(),
        reaction: createFixtureReactionPort(),
        dialogue: createFixtureDialoguePort(),
        commit: createFixtureMemoryCommit(),
        store: createEventStore(createInMemoryBackend()),
        renderer: createFixtureRendererPort(),
        gate,
      }),
    ).toThrowError('runtime composition requires a synthesis port')
    gate.dispose()
  })
})

describe('production application audio resources', () => {
  it('retires the revoked epoch on Stop and the session on dispose', async () => {
    const audio = createRecordingAudioResources()
    const fixture = await startApplication({ liveSessionId: LIVE_1, audioResources: audio })
    const client = fixture.newClient(LIVE_1)
    await fixture.boot(client)
    await client.input('a turn before stop')
    await until(async () => (await fixture.app.history.confirmedHistory(LIVE_1)).length, (n) => n >= 1)
    expect(audio.retireBeforeCalls).toEqual([])

    const stopAck = await client.stop()
    expect((stopAck.payload as { status?: string }).status).toBe('applied')
    // Resume advanced the live epoch to 1, so the Stop revokes epoch 1 into 2.
    expect(audio.retireBeforeCalls).toEqual([{ sessionId: LIVE_1, newEpoch: 2 }])
    expect(audio.retireSessionCalls).toEqual([])

    await fixture.app.stop()
    expect(audio.retireSessionCalls).toEqual([LIVE_1])
  })

  it('keeps Stop and disposal working when the audio registry throws', async () => {
    const audio = createRecordingAudioResources({ throwOnRetire: true })
    const fixture = await startApplication({ liveSessionId: LIVE_1, audioResources: audio })
    const client = fixture.newClient(LIVE_1)
    await fixture.boot(client)

    const stopAck = await client.stop()
    expect((stopAck.payload as { status?: string }).status).toBe('applied')
    expect(audio.retireBeforeCalls).toHaveLength(1)

    await fixture.app.stop()
    expect(audio.retireSessionCalls).toEqual([LIVE_1])
  })
})

describe('production application durable lifecycle', () => {
  it('closes and reopens the SQLite handle, carries confirmed archives, and continues output in a fresh session', async () => {
    const storage = tempStorage()
    // A seeded prior run produced one confirmed and one unresolved turn in the
    // archive session; the unresolved record carries null persona attribution.
    await withSeededStore(storage, (store) => seedProductionEvidence(store, ARCHIVE))

    const first = await startApplication({
      storage,
      liveSessionId: LIVE_1,
      archives: [ARCHIVE],
      textSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
    })
    const firstClient = first.newClient(LIVE_1)
    await first.boot(firstClient)
    await firstClient.input('a turn in the first application instance')
    await until(async () => (await first.app.history.confirmedHistory(LIVE_1)).length, (n) => n >= 1)
    expect(await first.app.history.confirmedHistory(LIVE_1)).toHaveLength(1)

    await first.app.stop()
    expect(first.app.state()).toBe('stopped')

    // Independent read over the same file: only confirmed history is restored;
    // the unresolved turn stays unknown with its null attribution and is never
    // promoted to speech or replayed.
    {
      const database = openDatabase(storage.dbPath)
      try {
        const recoveryView = createRecoveryView(createSqliteBackend(database))
        expect(recoveryView.confirmed(ARCHIVE).map((record) => record.text)).toEqual(['confirmed words'])
        expect(
          recoveryView.unresolved(ARCHIVE).map((entry) => ({
            text: entry.record.text,
            outcome: entry.terminalOutcome,
            persona: entry.record.personaProfileId,
          })),
        ).toEqual([{ text: 'unresolved words', outcome: 'unknown', persona: null }])
        expect(recoveryView.confirmed(LIVE_1)).toHaveLength(1)
      } finally {
        database.close()
      }
    }

    // After the controlled shutdown the shared handle is closed: a later write
    // fails visibly instead of silently succeeding.
    await expect(
      first.app.store.append(
        fixtureRuntimeEvent({ eventId: 'event-after-stop', seq: 9, sessionId: LIVE_1 }),
      ),
    ).rejects.toThrow()

    // A second application instance in the same process reopens the same
    // database under a new fresh live id and explicitly selects the previous
    // live session and the archive. (Child-process startup is separate CLI
    // evidence; this regression isolates the durable handle and composition.)
    const second = await startApplication({
      storage,
      liveSessionId: LIVE_2,
      archives: [LIVE_1, ARCHIVE],
      textSource: createCatalogDialogueTextSource([M1_FIXTURE_SEGMENT_0_TEXT]),
    })
    expect(second.app.currentSessionId()).toBe(LIVE_2)
    const composition = second.app.currentComposition() as ReconstructedRuntimeComposition
    expect((await composition.coordinator.endpoint.snapshot()).lifecycle).toBe('stopped')
    const carried = await composition.history.confirmedHistory(LIVE_2)
    expect(carried.map((record) => record.sessionId)).toEqual([LIVE_1, ARCHIVE])
    expect(carried[1]?.text).toBe('confirmed words')

    // Output continues: a real turn in the reopened application commits new
    // confirmed history in the fresh live session, and the composed history
    // carries the two archives ahead of it.
    const secondClient = second.newClient(LIVE_2)
    await second.boot(secondClient)
    await secondClient.input('a turn after restart')
    await until(async () => (await second.app.history.confirmedHistory(LIVE_2)).length, (n) => n >= 1)
    const continued = await composition.history.confirmedHistory(LIVE_2)
    expect(continued).toHaveLength(3)
    expect(continued.at(-1)?.sessionId).toBe(LIVE_2)

    await second.app.stop()
  })

  it('refuses to reopen a live id that already has durable evidence and leaves no open handle', async () => {
    const storage = tempStorage()
    await withSeededStore(storage, (store) => seedProductionEvidence(store, LIVE_1))
    const clock = createMonotonicClock()

    const failure = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ReconstructedSessionError)
    expect((failure as ReconstructedSessionError).code).toBe('live_session_not_fresh')
    // The failed creation closed its handle: no WAL side files remain.
    expect(existsSync(`${storage.dbPath}-wal`)).toBe(false)
  })

  it('stops cleanly when start was never called and closes the handle', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
    })
    apps.push(app)
    expect(app.state()).toBe('created')

    await app.stop()
    expect(app.state()).toBe('stopped')
    await expect(
      app.store.append(fixtureRuntimeEvent({ eventId: 'event-after-stop', seq: 1, sessionId: LIVE_1 })),
    ).rejects.toThrow()
  })

  it('completes a controlled shutdown while a turn is in flight', async () => {
    const fixture = await startApplication({ liveSessionId: LIVE_1 })
    const client = fixture.newClient(LIVE_1)
    await fixture.boot(client)
    // Hold the media `ended` event so the turn stays in flight.
    fixture.media.holdEndedFrom(0)
    await client.input('a turn held open')
    await until(
      () => client.receipts().some((receipt) => receipt.stage === 'started'),
      (started) => started,
    )

    await fixture.app.stop()
    expect(fixture.app.state()).toBe('stopped')
    await expect(
      fixture.app.store.append(
        fixtureRuntimeEvent({ eventId: 'event-after-stop', seq: 9, sessionId: LIVE_1 }),
      ),
    ).rejects.toThrow()
  })
})

describe('production application endpoint and lifecycle', () => {
  it('serves health, issues one-time operator bootstrap tokens, and enforces the lifecycle', async () => {
    const fixture = await startApplication({ liveSessionId: LIVE_1 })

    const health = await httpRequest(fixture.port, '/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({
      ok: true,
      loopbackOnly: true,
      capabilities: ['health', 'diagnostics'],
    })

    // Bootstrap requires the explicit header and an allowed origin.
    const denied = await httpRequest(fixture.port, '/operator/bootstrap', {
      method: 'POST',
      headers: { 'x-isla-operator-bootstrap': '1', origin: 'http://evil.example' },
    })
    expect(denied.status).toBe(403)
    const token = await fixture.bootstrapOperator()
    expect(token.length).toBeGreaterThan(0)

    expect(fixture.app.endpoint.path).toBe('/app')
    expect(fixture.app.endpoint.allowRequest(TEST_DEPLOYMENT_ORIGIN, `127.0.0.1:${fixture.port}`)).toBe(true)
    expect(fixture.app.endpoint.allowRequest('http://evil.example', `127.0.0.1:${fixture.port}`)).toBe(false)

    await expect(fixture.app.start()).rejects.toThrowError('cannot start in state "started"')
    await fixture.app.stop()
    expect(fixture.app.state()).toBe('stopped')
    await fixture.app.stop()
    await expect(fixture.app.start()).rejects.toThrowError('cannot start in state "stopped"')
  })
})

describe('production application explicit recovery', () => {
  it('builds one deadline gate per composition and a fresh gate for a recovered successor', async () => {
    const successorIds: string[] = []
    const audio = createRecordingAudioResources()
    const fixture = await startApplication({
      liveSessionId: LIVE_1,
      audioResources: audio,
      recovery: {
        nextSessionId: () => {
          const id = `session-successor-${successorIds.length + 1}`
          successorIds.push(id)
          return id
        },
      },
    })
    // One gate per composition: the initial renderer and synthesis share it.
    expect(fixture.gates).toHaveLength(2)
    expect(fixture.gates[0]?.gate).toBe(fixture.gates[1]?.gate)

    const performer = fixture.newClient(LIVE_1)
    await fixture.boot(performer)
    await performer.input('a turn before recovery')
    await until(async () => (await fixture.app.history.confirmedHistory(LIVE_1)).length, (n) => n >= 1)

    const operator = fixture.newClient(LIVE_1)
    await operator.snapshot
    await operator.bootstrapOperator(await fixture.bootstrapOperator())
    const ack = await operator.recover()
    expect(ack.kind).toBe('session.recovery.ack')
    const successor = 'session-successor-1'
    expect(ack.payload).toMatchObject({
      status: 'applied',
      retiredSessionId: LIVE_1,
      successorSessionId: successor,
    })
    expect(fixture.app.currentSessionId()).toBe(successor)
    expect(successorIds).toEqual([successor])

    // The successor's renderer and synthesis share a fresh gate, never the
    // retired composition's gate.
    expect(fixture.gates).toHaveLength(4)
    expect(fixture.gates[2]?.gate).toBe(fixture.gates[3]?.gate)
    expect(fixture.gates[2]?.gate).not.toBe(fixture.gates[0]?.gate)

    // The successor starts stopped, carries only confirmed history, and the
    // retired composition's audio resources were retired on disposal.
    const successorComposition = fixture.app.currentComposition() as ReconstructedRuntimeComposition
    expect((await successorComposition.coordinator.endpoint.snapshot()).lifecycle).toBe('stopped')
    const carried = await successorComposition.history.confirmedHistory(successor)
    expect(carried.length).toBeGreaterThanOrEqual(1)
    expect(carried.every((record) => record.sessionId === LIVE_1)).toBe(true)
    expect(audio.retireSessionCalls).toEqual([LIVE_1])

    await fixture.app.stop()
    expect(audio.retireSessionCalls).toEqual([LIVE_1, successor])
  })

  it('reports dialogue outcomes for the initial session and each recovery successor', async () => {
    const observed: DialogueOutcomeEvent[] = []
    const successorIds: string[] = []
    const observationsOf = (sessionId: string) =>
      observed
        .filter(
          (event): event is Extract<DialogueOutcomeEvent, { kind: 'observed' }> =>
            event.kind === 'observed',
        )
        .map((event) => event.observation)
        .filter((observation) => observation.sessionId === sessionId)

    const fixture = await startApplication({
      liveSessionId: LIVE_1,
      onDialogueOutcome: (event) => observed.push(event),
      recovery: {
        nextSessionId: () => {
          const id = `session-successor-${successorIds.length + 1}`
          successorIds.push(id)
          return id
        },
      },
    })

    const performer = fixture.newClient(LIVE_1)
    await fixture.boot(performer)
    await performer.input('a turn before recovery')
    await until(() => observationsOf(LIVE_1).length, (n) => n >= 1)
    const initialObservations = observationsOf(LIVE_1)
    expect(initialObservations).toHaveLength(1)
    expect(initialObservations[0]).toMatchObject({ sessionId: LIVE_1, endStatus: 'completed' })
    // The retired session's exact report identity and counts, as evidence that a
    // later successor turn does not rewrite what was already reported.
    const initialSnapshot = structuredClone(initialObservations)

    const operator = fixture.newClient(LIVE_1)
    await operator.snapshot
    await operator.bootstrapOperator(await fixture.bootstrapOperator())
    const ack = await operator.recover()
    expect(ack.kind).toBe('session.recovery.ack')
    const successor = 'session-successor-1'
    expect(ack.payload).toMatchObject({ status: 'applied', successorSessionId: successor })

    // The successor composition reports on the same channel with the successor's
    // own live-session identity, and the retired session's report is unchanged.
    const successorPerformer = fixture.newClient(successor)
    await fixture.boot(successorPerformer)
    await successorPerformer.input('a turn after recovery')
    await until(() => observationsOf(successor).length, (n) => n >= 1)
    const successorObservations = observationsOf(successor)
    expect(successorObservations).toHaveLength(1)
    expect(successorObservations[0]).toMatchObject({ sessionId: successor, endStatus: 'completed' })
    /*
     * Compare the full identity, not the request id alone: the request id can be a
     * session-local counter, so two compositions may both report `dialogue-13`.
     * Session, request, epoch and turn together are what identify a report; the
     * successor's quadruple differs from the retired one, and the retired
     * session's already-reported identity and counts are unchanged.
     */
    const identityOf = (observation: DialogueOutcomeObservation | undefined) => [
      observation?.sessionId,
      observation?.requestId,
      observation?.epoch,
      observation?.turnId,
    ]
    expect(identityOf(successorObservations[0])).not.toEqual(identityOf(initialSnapshot[0]))
    expect(observationsOf(LIVE_1)).toHaveLength(initialSnapshot.length)
    expect(observationsOf(LIVE_1)).toEqual(initialSnapshot)

    await fixture.app.stop()
  })
})

describe('production application shutdown boundary', () => {
  it('preserves the invoked selection provider call and refuses a late callback after stop', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let invocations = 0
    const delegate = createFixtureSelectionPort()
    // A selection provider that ignores cancellation: it is invoked exactly
    // once and only resolves when the test releases it, after shutdown has
    // already resolved.
    const selection: SelectionPort = {
      select: async (request, context) => {
        invocations += 1
        entered()
        await held
        return delegate.select(request, context)
      },
    }
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock, selection }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock,
    })
    apps.push(app)
    let stopped = false
    const writesAfterStop: string[] = []
    const originalAppend = app.store.append.bind(app.store)
    app.store.append = async (event) => {
      if (stopped) writesAfterStop.push(event.type)
      return originalAppend(event)
    }

    const coordinator = app.currentComposition().coordinator
    const sessionId = app.currentSessionId()
    const resume = await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'msg-resume',
        sessionId,
        epoch: coordinator.epoch(),
        payload: { requestId: 'request-resume' },
      },
      fixtureOperatorContext(),
    )
    expect(resume.status).toBe('applied')
    const input = await coordinator.endpoint.submitInput(
      {
        protocolVersion: '0.2',
        kind: 'input.submit',
        messageId: 'msg-input',
        sessionId,
        epoch: coordinator.epoch(),
        payload: { source: 'local-audience', text: 'a turn held at selection' },
      },
      fixtureViewerContext(),
    )
    expect(input.status).toBe('accepted')

    const turn = coordinator.runTurn()
    await enteredPromise
    // Shutdown resolves while the provider is still held: it never waits for a
    // cancellation-ignoring provider.
    await app.stop()
    expect(app.state()).toBe('stopped')
    stopped = true
    release()
    const outcome = await turn
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The late callback never reached the closed handle, no delivery was
    // admitted and the session never degraded.
    expect(writesAfterStop).toEqual([])
    expect(coordinator.metrics().storageFailure).toBe(false)
    expect(coordinator.metrics().selectionAttempts).toBe(1)
    expect(invocations).toBe(1)
    expect(outcome.status).toBe('stale')
    expect(outcome.deliveries).toEqual([])
    expect(coordinator.deliveries()).toEqual([])

    // The already-invoked attempt and its bounded cancellation bookkeeping
    // survived stop and a real SQLite reopen; the late provider completion left
    // no usage record and no delivery.
    const database = openDatabase(storage.dbPath)
    try {
      const events = await createEventStore(createSqliteBackend(database)).readSession(sessionId)
      const types = events.map((event) => event.type)
      expect(types).toContain('provider.call')
      expect(types).toContain('result.stale')
      expect(types).not.toContain('delivery.committed')
      expect(types).not.toContain('provider.usage.late')
      const call = events.find((event) => event.type === 'provider.call')
      expect(call?.payload).toMatchObject({
        call: 'selection',
        disposition: 'aborted',
        turnId: null,
      })
      const stale = events.find((event) => event.type === 'result.stale')
      expect(stale?.payload).toMatchObject({ stage: 'selection' })
    } finally {
      database.close()
    }
  })

  it('drains admitted receipt and delivery bookkeeping before closing the handle', async () => {
    const fixture = await startApplication({ liveSessionId: LIVE_1 })
    const client = fixture.newClient(LIVE_1)
    await fixture.boot(client)
    // Hold the first output.receipt append so the receipt bookkeeping is
    // admitted but not yet durable when shutdown begins.
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let heldOnce = false
    const originalAppend = fixture.app.store.append.bind(fixture.app.store)
    fixture.app.store.append = async (event) => {
      if (event.type === 'output.receipt' && !heldOnce) {
        heldOnce = true
        entered()
        await held
      }
      return originalAppend(event)
    }

    await client.input('a turn whose receipt is held at the store')
    await enteredPromise
    const stopping = fixture.app.stop()
    let stopResolved = false
    void stopping.then(() => {
      stopResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The admitted receipt bookkeeping is still in the chain: shutdown must not
    // close under it.
    expect(stopResolved).toBe(false)
    release()
    await stopping
    expect(stopResolved).toBe(true)

    // The admitted receipt and its delivery commit drained durably.
    const database = openDatabase(fixture.storage.dbPath)
    try {
      const events = await createEventStore(createSqliteBackend(database)).readSession(LIVE_1)
      const types = events.map((event) => event.type)
      expect(types).toContain('output.receipt')
      expect(types).toContain('delivery.committed')
    } finally {
      database.close()
    }
  })

  it('drains an in-flight recovery build, disposes the late successor and refuses later builds', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    const audio = createRecordingAudioResources()
    const successor = 'session-production-successor'
    const app = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock, audioResources: audio }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      clock,
      recovery: { nextSessionId: () => successor },
    })
    apps.push(app)
    // Hold the successor's fresh-session preflight so its construction is in
    // flight when shutdown begins.
    let releaseRead!: () => void
    let readEntered!: () => void
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const readEnteredPromise = new Promise<void>((resolve) => {
      readEntered = resolve
    })
    let successorReads = 0
    const originalRead = app.store.readSession.bind(app.store)
    app.store.readSession = async (sessionId) => {
      if (sessionId === successor) {
        successorReads += 1
        if (successorReads === 1) {
          readEntered()
          await readHeld
        }
      }
      return originalRead(sessionId)
    }

    const recovering = app.recovery.recover(LIVE_1)
    await readEnteredPromise
    const stopping = app.stop()
    let stopResolved = false
    void stopping.then(() => {
      stopResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Shutdown waits for the build over the still-open handle instead of
    // closing under its store reads.
    expect(stopResolved).toBe(false)
    releaseRead()
    const recovered = await recovering
    await stopping
    expect(stopResolved).toBe(true)
    expect(recovered.status).toBe('applied')
    // The late successor was released while the handle was still open: its
    // session resources were retired before close.
    expect(audio.retireSessionCalls).toContain(successor)
    expect(existsSync(`${storage.dbPath}-wal`)).toBe(false)
    // A recovery requested after shutdown is refused visibly and never touches
    // the closed handle.
    const readsAfterBuild = successorReads
    await expect(app.recovery.recover(successor)).rejects.toMatchObject({
      code: 'construction_failed',
    })
    expect(successorReads).toBe(readsAfterBuild)
  })

  it('releases the initial composition and closes the handle when endpoint construction fails', async () => {
    const storage = tempStorage()
    const clock = createMonotonicClock()
    const audio = createRecordingAudioResources()
    const failure = await createProductionApplication({
      storage,
      initialSelection: selectionFor(LIVE_1),
      peers: createTestProductionPeers({ clock, audioResources: audio }),
      allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
      allowedHosts: ['not a valid host'],
      clock,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RangeError)
    // The composition built before the endpoint failure was released and the
    // handle closed: nothing is left holding the database open.
    expect(audio.retireSessionCalls).toEqual([LIVE_1])
    expect(existsSync(`${storage.dbPath}-wal`)).toBe(false)
  })
})
