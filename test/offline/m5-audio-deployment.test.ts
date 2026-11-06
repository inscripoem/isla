import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PerformanceCommand } from '../../src/contracts'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createDeadlineGate } from '../../src/runtime/deadline'
import { createProductionApplication } from '../../src/runtime/production'
import type { ProductionApplication } from '../../src/runtime/production'
import { resolveStorageConfig } from '../../src/storage/config'
import type { StorageConfig } from '../../src/storage/config'
import { createCallContext } from '../support/context'
import { fixturePreparePerformance } from '../support/fixture-data'
import {
  M1_ACTUAL_SEGMENT_0_DURATION_MS,
  M1_ACTUAL_SEGMENT_0_REF,
  M1_ACTUAL_SEGMENT_1_DURATION_MS,
  M1_ACTUAL_SEGMENT_1_REF,
  M1_FIXTURE_SEGMENT_0_TEXT,
  M1_FIXTURE_SEGMENT_1_TEXT,
  createControlledMediaDriver,
  createM1ActualBlobMap,
  createRegistryResolver,
  parseM1Wav,
  readM1ActualWavAssets,
  sha256Hex,
} from '../support/m1-kit'
import { createPerformerClient } from '../support/performer-client'
import type { PerformerClient } from '../support/performer-client'
import { TEST_DEPLOYMENT_ORIGIN } from '../support/production-kit'
import { createProductionDeployment } from '../support/production-deployment'

/**
 * The default controlled test production deployment serves the prepared M1 WAV
 * catalog through the existing `POST /audio` route.
 *
 * These tests use the actual deployment module loaded by the production CLI, the
 * actual M1 audio registry, and the actual application route. The M3/M4 peers
 * remain labeled substitutes. No live provider, browser or acoustic behavior is
 * claimed.
 */

const LIVE = 'session-audio-deployment-live'

const apps: ProductionApplication[] = []
const clients: PerformerClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const app of apps.splice(0)) await app.stop().catch(() => {})
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const CATALOG = [
  {
    text: M1_FIXTURE_SEGMENT_0_TEXT,
    ref: M1_ACTUAL_SEGMENT_0_REF,
    durationMs: M1_ACTUAL_SEGMENT_0_DURATION_MS,
  },
  {
    text: M1_FIXTURE_SEGMENT_1_TEXT,
    ref: M1_ACTUAL_SEGMENT_1_REF,
    durationMs: M1_ACTUAL_SEGMENT_1_DURATION_MS,
  },
] as const

const ASSETS = new Map(readM1ActualWavAssets().map((asset) => [asset.ref, asset]))

function tempStorage(): StorageConfig {
  const dir = mkdtempSync(join(tmpdir(), 'isla-m5-audio-deployment-'))
  dirs.push(dir)
  return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(dir, 'isla.db') }, dir)
}

interface HttpResult {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: Buffer
}

function httpRequest(
  port: number,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string | undefined>
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    origin: TEST_DEPLOYMENT_ORIGIN,
    host: `127.0.0.1:${port}`,
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name]
    else headers[name] = value
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function errorCode(result: HttpResult): unknown {
  try {
    return (JSON.parse(result.body.toString('utf8')) as { error?: { code?: unknown } }).error?.code
  } catch {
    return null
  }
}

async function until<T>(
  read: () => T,
  done: (value: T) => boolean,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface DeploymentFixture {
  readonly app: ProductionApplication
  readonly port: number
  readonly clock: ReturnType<typeof createMonotonicClock>
  readonly deployment: ReturnType<typeof createProductionDeployment>
  newClient(): PerformerClient
  bootstrap(): Promise<string>
  boot(client: PerformerClient, resume?: boolean): Promise<void>
}

async function startDeployment(): Promise<DeploymentFixture> {
  const storage = tempStorage()
  const clock = createMonotonicClock()
  const deployment = createProductionDeployment({
    clock,
    databasePath: storage.dbPath,
    env: { ISLA_TEST_LIVE_SESSION_ID: LIVE },
  })
  const app = await createProductionApplication({
    storage,
    initialSelection: deployment.initialSelection,
    peers: deployment.peers,
    allowedOrigins: deployment.allowedOrigins,
    ...(deployment.allowedHosts !== undefined ? { allowedHosts: deployment.allowedHosts } : {}),
    port: 0,
    graceMs: 200,
    clock,
    ...(deployment.release !== undefined ? { ownedRelease: deployment.release } : {}),
  })
  apps.push(app)
  const bound = await app.start()
  let clientCounter = 0
  let receiptCounter = 0
  const media = createControlledMediaDriver({ autoEvents: true })
  const resolver = createRegistryResolver(createM1ActualBlobMap())

  const bootstrap = async (): Promise<string> => {
    const result = await httpRequest(bound.port, '/operator/bootstrap', {
      headers: { 'x-isla-operator-bootstrap': '1', 'content-length': '0' },
    })
    const parsed = JSON.parse(result.body.toString('utf8')) as { ok?: boolean; token?: string }
    if (result.status !== 200 || parsed.ok !== true || typeof parsed.token !== 'string') {
      throw new Error(`operator bootstrap failed with status ${result.status}`)
    }
    return parsed.token
  }

  return {
    app,
    port: bound.port,
    clock,
    deployment,
    newClient(): PerformerClient {
      clientCounter += 1
      const client = createPerformerClient({
        url: `ws://127.0.0.1:${bound.port}/app`,
        origin: TEST_DEPLOYMENT_ORIGIN,
        sessionId: LIVE,
        resolver,
        media,
        receipts: {
          newReceiptId: () => `audio-deployment-${clientCounter}-${(receiptCounter += 1)}`,
          localNowMs: () => null,
        },
      })
      clients.push(client)
      return client
    },
    bootstrap,
    async boot(client: PerformerClient, resume = true): Promise<void> {
      await client.snapshot
      const ack = await client.bootstrapOperator(await bootstrap())
      expect(ack.kind).toBe('operator.ack')
      expect((await client.attach()).kind).toBe('session.attach.ack')
      if (resume) {
        expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
      }
    },
  }
}

function offers(client: PerformerClient): PerformanceCommand[] {
  return client
    .messages()
    .filter((message) => message.kind === 'performance.offer')
    .map((message) => message.payload as PerformanceCommand)
}

function catalogForText(text: string): (typeof CATALOG)[number] | undefined {
  return CATALOG.find((entry) => entry.text === text)
}

function audioPath(ref: string): string {
  return `/audio?ref=${encodeURIComponent(ref)}`
}

function positiveAudioHeaders(): Record<string, string> {
  return { 'x-isla-audio-fetch': '1' }
}

describe('controlled deployment prepared WAV catalog', () => {
  it('maps the exact catalog text/ref/duration and serves real registry bytes with lease reclamation', async () => {
    const clock = createMonotonicClock()
    const deployment = createProductionDeployment({
      clock,
      databasePath: 'unused.db',
      env: { ISLA_TEST_LIVE_SESSION_ID: LIVE },
    })
    const gate = createDeadlineGate(clock)
    const synthesis = deployment.peers.createSynthesis(gate)
    const resources = deployment.peers.audioResources
    expect(resources).toBeDefined()
    if (resources === undefined) throw new Error('deployment did not provide audio resources')

    const prepare = (overrides: Record<string, unknown> = {}) =>
      synthesis.prepare(
        fixturePreparePerformance({
          sessionId: LIVE,
          epoch: 1,
          requestId: 'prepare-a',
          turnId: 'turn-a',
          segmentId: 'segment-0',
          text: M1_FIXTURE_SEGMENT_0_TEXT,
          ...overrides,
        }),
        createCallContext(),
      )

    const first = await prepare()
    expect(first).toEqual({
      ok: true,
      requestId: 'prepare-a',
      sessionId: LIVE,
      epoch: 1,
      turnId: 'turn-a',
      segmentId: 'segment-0',
      audioRef: M1_ACTUAL_SEGMENT_0_REF,
      format: 'audio/wav',
      durationMs: M1_ACTUAL_SEGMENT_0_DURATION_MS,
      timing: { startMs: 0, endMs: M1_ACTUAL_SEGMENT_0_DURATION_MS },
    })
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBeNull()

    const firstAsset = ASSETS.get(M1_ACTUAL_SEGMENT_0_REF)
    if (firstAsset === undefined) throw new Error('missing prepared asset')
    const firstLease = await resources.resolve(M1_ACTUAL_SEGMENT_0_REF, new AbortController().signal)
    expect(firstLease.blob.type).toBe('audio/wav')
    const firstBytes = new Uint8Array(await firstLease.blob.arrayBuffer())
    expect(sha256Hex(firstBytes)).toBe(firstAsset.sha256)
    firstLease.release()
    // The real registry reclaims a released, unretired entry: the catalog binding
    // is no longer servable until another preparation registers it again.
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBe('unknown_ref')

    // A repeated preparation for the same session/epoch is accepted and maps to
    // the exact same catalog reference again; it does not create a second
    // authoritative registry or retain the reclaimed bytes.
    const repeated = await prepare({ requestId: 'prepare-b', turnId: 'turn-b', segmentId: 'segment-1' })
    expect(repeated.ok).toBe(true)
    if (!repeated.ok) throw new Error('repeated preparation failed')
    expect(repeated.audioRef).toBe(M1_ACTUAL_SEGMENT_0_REF)
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBeNull()
    const repeatedLease = await resources.resolve(M1_ACTUAL_SEGMENT_0_REF, new AbortController().signal)
    expect(sha256Hex(new Uint8Array(await repeatedLease.blob.arrayBuffer()))).toBe(firstAsset.sha256)
    repeatedLease.release()

    const second = await prepare({
      requestId: 'prepare-c',
      turnId: 'turn-c',
      segmentId: 'segment-1',
      text: M1_FIXTURE_SEGMENT_1_TEXT,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('second preparation failed')
    expect(second.audioRef).toBe(M1_ACTUAL_SEGMENT_1_REF)
    expect(second.durationMs).toBe(M1_ACTUAL_SEGMENT_1_DURATION_MS)
    expect(resources.admission(M1_ACTUAL_SEGMENT_1_REF, LIVE, 1)).toBeNull()
    const secondAsset = ASSETS.get(M1_ACTUAL_SEGMENT_1_REF)
    if (secondAsset === undefined) throw new Error('missing prepared asset')
    const secondLease = await resources.resolve(M1_ACTUAL_SEGMENT_1_REF, new AbortController().signal)
    expect(sha256Hex(new Uint8Array(await secondLease.blob.arrayBuffer()))).toBe(secondAsset.sha256)
    secondLease.release()

    // Unknown text and a wrong voice identity are catalog misses, not audio.
    const missing = await prepare({ requestId: 'prepare-d', text: 'no such catalogued phrase' })
    expect(missing).toMatchObject({ ok: false, reasonCode: 'fixed_audio_missing' })
    const wrongVoice = await prepare({ requestId: 'prepare-e', voiceProfileVersion: '2' })
    expect(wrongVoice).toMatchObject({ ok: false, reasonCode: 'fixed_audio_missing' })

    // Retirement is authoritative: an old epoch can neither publish nor prepare
    // over the surviving binding, and a late admission for the old epoch fails
    // closed rather than guessing an output identity.
    await prepare({ requestId: 'prepare-f', turnId: 'turn-f', segmentId: 'segment-0' })
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBeNull()
    resources.retireBefore(LIVE, 2)
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBe('unknown_ref')
    const stale = await prepare({ requestId: 'prepare-g', turnId: 'turn-g' })
    expect(stale).toMatchObject({ ok: false, reasonCode: 'audio_resource_unavailable' })
    const nextEpoch = await prepare({ requestId: 'prepare-h', epoch: 2, turnId: 'turn-h' })
    expect(nextEpoch.ok).toBe(true)
    if (!nextEpoch.ok) throw new Error('next epoch preparation failed')
    expect(nextEpoch.audioRef).toBe(M1_ACTUAL_SEGMENT_0_REF)
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBe('unknown_ref')
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 2)).toBeNull()

    resources.retireSession(LIVE)
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 2)).toBe('unknown_ref')
    gate.dispose()
  })
})

describe('controlled deployment audio route', () => {
  it('serves both prepared catalog segments with exact bytes and the existing refusal order', async () => {
    const fixture = await startDeployment()
    const client = fixture.newClient()
    await fixture.boot(client)

    await client.input('the deployment audio check')
    const preparedOffers = await until(() => offers(client), (value) => value.length >= 2)
    expect(preparedOffers).toHaveLength(2)

    for (const offer of preparedOffers) {
      const catalog = catalogForText(offer.subtitleText)
      expect(catalog).toBeDefined()
      if (catalog === undefined) throw new Error('offer text is not in the WAV catalog')
      expect(offer.audioRef).toBe(catalog.ref)
      const asset = ASSETS.get(catalog.ref)
      if (asset === undefined) throw new Error('missing prepared asset')

      const response = await httpRequest(
        fixture.port,
        audioPath(catalog.ref),
        { headers: positiveAudioHeaders() },
      )
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe('audio/wav')
      expect(response.headers['content-length']).toBe(String(asset.bytes.byteLength))
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(sha256Hex(new Uint8Array(response.body))).toBe(asset.sha256)
      // The served media is the prepared file for this exact text/ref, and its
      // frame-derived duration equals the catalog metadata.
      expect(parseM1Wav(new Uint8Array(response.body)).durationMs).toBe(catalog.durationMs)
    }

    const resources = fixture.deployment.peers.audioResources
    if (resources === undefined) throw new Error('deployment did not provide audio resources')
    // Each response held a real registry lease; finish released it and the
    // registry reclaimed the entry. No binding still claims to own these bytes.
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, 1)).toBe('unknown_ref')
    expect(resources.admission(M1_ACTUAL_SEGMENT_1_REF, LIVE, 1)).toBe('unknown_ref')

    const refetched = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF), {
      headers: positiveAudioHeaders(),
    })
    expect(refetched.status).toBe(404)
    expect(errorCode(refetched)).toBe('not_found')

    const wrongMethod = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF), {
      method: 'GET',
      headers: positiveAudioHeaders(),
    })
    expect(wrongMethod.status).toBe(405)
    expect(errorCode(wrongMethod)).toBe('method_not_allowed')

    const missingHeader = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF))
    expect(missingHeader.status).toBe(403)
    expect(errorCode(missingHeader)).toBe('forbidden')

    const missingOrigin = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF), {
      headers: { ...positiveAudioHeaders(), origin: undefined },
    })
    expect(missingOrigin.status).toBe(403)
    expect(errorCode(missingOrigin)).toBe('forbidden')

    const foreignHost = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF), {
      headers: { ...positiveAudioHeaders(), host: 'example.invalid' },
    })
    expect(foreignHost.status).toBe(403)
    expect(errorCode(foreignHost)).toBe('forbidden')

    const missingRef = await httpRequest(fixture.port, '/audio', {
      headers: positiveAudioHeaders(),
    })
    expect(missingRef.status).toBe(400)
    expect(errorCode(missingRef)).toBe('malformed')

    const duplicateRef = await httpRequest(
      fixture.port,
      `/audio?ref=${encodeURIComponent(M1_ACTUAL_SEGMENT_0_REF)}&ref=${encodeURIComponent(M1_ACTUAL_SEGMENT_1_REF)}`,
      { headers: positiveAudioHeaders() },
    )
    expect(duplicateRef.status).toBe(400)
    expect(errorCode(duplicateRef)).toBe('malformed')

    const unknownRef = await httpRequest(fixture.port, audioPath('audio://fixture/unknown'), {
      headers: positiveAudioHeaders(),
    })
    expect(unknownRef.status).toBe(404)
    expect(errorCode(unknownRef)).toBe('not_found')
  })

  it('preserves stopped, Stop-retired epoch and session-retired lifecycle refusals', async () => {
    const fixture = await startDeployment()
    const client = fixture.newClient()
    // No Resume yet: the initial composition is stopped and must refuse new
    // audio even though the catalog is prepared later.
    await fixture.boot(client, false)

    const stopped = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF), {
      headers: positiveAudioHeaders(),
    })
    expect(stopped.status).toBe(409)
    expect(errorCode(stopped)).toBe('conflict')

    expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
    await client.input('first deployment turn')
    const firstTurn = await until(() => offers(client), (value) => value.length >= 1)
    const firstOffer = firstTurn[0]
    if (firstOffer === undefined) throw new Error('no first offer')
    expect(firstOffer.subtitleText).toBe(M1_FIXTURE_SEGMENT_0_TEXT)
    expect(firstOffer.audioRef).toBe(M1_ACTUAL_SEGMENT_0_REF)
    const served = await httpRequest(fixture.port, audioPath(firstOffer.audioRef), {
      headers: positiveAudioHeaders(),
    })
    expect(served.status).toBe(200)

    const stopAck = await client.stop()
    expect((stopAck.payload as { status?: string }).status).toBe('applied')
    const afterStop = await httpRequest(fixture.port, audioPath(M1_ACTUAL_SEGMENT_0_REF), {
      headers: positiveAudioHeaders(),
    })
    expect(afterStop.status).toBe(409)
    expect(errorCode(afterStop)).toBe('conflict')

    expect(((await client.resume()).payload as { status?: string }).status).toBe('applied')
    // The resume establishes a fresh epoch. The previous epoch's binding was
    // retired by Stop and must not be served to the new epoch; the catalog
    // reference is still the same stable string, so this is the fail-closed case.
    const retiredEpoch = await httpRequest(
      fixture.port,
      audioPath(M1_ACTUAL_SEGMENT_0_REF),
      { headers: positiveAudioHeaders() },
    )
    expect(retiredEpoch.status).toBe(404)
    expect(errorCode(retiredEpoch)).toBe('not_found')

    const beforeSecondTurn = offers(client).length
    await client.input('second deployment turn')
    const secondTurn = await until(() => offers(client), (value) => value.length > beforeSecondTurn)
    const secondOffer = secondTurn[beforeSecondTurn]
    if (secondOffer === undefined) throw new Error('no second-turn offer')
    expect(secondOffer.epoch).toBeGreaterThan(firstOffer.epoch)
    const nextEpochServed = await httpRequest(
      fixture.port,
      audioPath(M1_ACTUAL_SEGMENT_0_REF),
      { headers: positiveAudioHeaders() },
    )
    expect(nextEpochServed.status).toBe(200)

    const resources = fixture.deployment.peers.audioResources
    if (resources === undefined) throw new Error('deployment did not provide audio resources')
    await fixture.app.stop()
    expect(resources.admission(M1_ACTUAL_SEGMENT_0_REF, LIVE, secondOffer.epoch)).toBe('unknown_ref')
  })
})
