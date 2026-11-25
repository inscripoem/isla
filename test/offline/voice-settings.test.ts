import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import {
  dialogueEndSchema,
  dialogueSegmentSchema,
  parseApplicationClientMessage,
  parseApplicationServerMessage,
  type DialoguePort,
  type EventStorePort,
  type SynthesisPort,
  type TrustedControlContext,
  type VoiceOption,
} from '../../src/contracts'
import type { KokoroProvider } from '../../src/performance/kokoro-types'
import { createKokoroProvider } from '../../src/performance/kokoro-provider'
import type { KokoroSdkLoader } from '../../src/performance/kokoro-provider'
import { createKokoroVoiceCatalog } from '../../src/performance/voice-catalog'
import { createApplicationEndpoint } from '../../src/runtime/application'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createRuntimeComposition } from '../../src/runtime/composition'
import { createRuntimeAuthorizer } from '../../src/runtime/control-policy'
import { createRuntimeCoordinator } from '../../src/runtime/coordinator'
import { createDeadlineGate } from '../../src/runtime/deadline'
import { DiagnosticsServer } from '../../src/runtime/server'
import {
  createJsonFileVoiceSettingsPersistence,
  createVoiceSettings,
} from '../../src/runtime/voice-settings'
import { createVoicePreview } from '../../src/runtime/voice-preview'
import { createEventStore } from '../../src/storage/event-store'
import { createInMemoryBackend } from '../../src/storage/in-memory-backend'
import {
  createFixtureDialoguePort,
  createFixtureMemoryCommit,
  createFixturePlayer,
  createFixtureReactionPort,
  createFixtureRendererPort,
  createFixtureSelectionPort,
  createFixtureSynthesisPort,
} from '../support/correct-ports'
import { fixtureUsage } from '../support/fixture-data'

/**
 * TA-004 local console Kokoro voice selection: M1/M5 units and transport.
 *
 * Planned production seams exercised here:
 * - `createKokoroVoiceCatalog(installedVoiceIds)` filters the pinned English
 *   Kokoro allowlist, deduplicates, sorts and assigns the en-US/en-GB locale.
 * - `createVoiceSettings({ voices, persistence })` defaults to af_heart and
 *   exposes `state()`, `select(voiceId)` and `currentVoiceProfile()`.
 * - `createVoicePreview({ provider, text, speed })` synthesizes the fixed text
 *   through the actual provider factory and returns the encoded WAV bytes.
 * - `createRuntimeCoordinator({ voice })` captures one voice profile per turn.
 * - `createApplicationEndpoint({ voice })` speaks voice.list/select/preview and
 *   answers an empty voice.state when the optional capability is absent.
 *
 * The installed voice files are read from the pinned kokoro-js package; no
 * model, network, credential or SQLite file is touched. The synthesis peer is
 * the actual `createKokoroProvider` with a deterministic SDK loader.
 */

const APP_ORIGIN = 'http://127.0.0.1:4173'
const PREVIEW_TEXT = 'This is the Isla voice preview.'
const SESSION_ID = 'session-voice-settings'

type JsonObject = Record<string, unknown>

interface FixedProviderCall {
  text: string
  voiceId: string
  speed: number
}

interface TestVoiceState {
  selectedVoiceId: string | null
  voices: readonly VoiceOption[]
}

interface TestVoicePersistence {
  read(): Promise<string | null>
  write(contents: string): Promise<void>
}

interface TestVoiceCapability {
  state(): TestVoiceState
  select(voiceId: string): Promise<TestVoiceState>
  preview(voiceId: string): Promise<{ voiceId: string; wav: Uint8Array }>
}

const servers: DiagnosticsServer[] = []
const clients: RawApplicationClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const server of servers.splice(0)) await server.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'isla-voice-settings-'))
  dirs.push(dir)
  return dir
}

/** The voice asset ids actually installed by the pinned kokoro-js package. */
function installedVoiceIds(): string[] {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('kokoro-js')
  const voicesDir = join(dirname(entry), '..', 'voices')
  return readdirSync(voicesDir)
    .filter((name) => name.endsWith('.bin'))
    .map((name) => name.slice(0, -4))
}

function catalog(): readonly VoiceOption[] {
  return createKokoroVoiceCatalog(installedVoiceIds())
}

function memoryPersistence(): TestVoicePersistence {
  return {
    async read() {
      return null
    },
    async write() {},
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/** Assert the canonical mono IEEE-float32 WAV the production encoder emits. */
function expectWav(bytes: Uint8Array, samples: Float32Array, sampleRate: number): void {
  expect(ascii(bytes, 0, 4)).toBe('RIFF')
  expect(ascii(bytes, 8, 4)).toBe('WAVE')
  expect(ascii(bytes, 12, 4)).toBe('fmt ')
  expect(ascii(bytes, 36, 4)).toBe('data')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(bytes.byteLength).toBe(44 + samples.length * 4)
  expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
  expect(view.getUint16(20, true)).toBe(3)
  expect(view.getUint16(22, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(sampleRate)
  expect(view.getUint16(34, true)).toBe(32)
  expect(view.getUint32(40, true)).toBe(samples.length * 4)
  for (let index = 0; index < samples.length; index += 1) {
    expect(view.getFloat32(44 + index * 4, true)).toBeCloseTo(samples[index] as number, 6)
  }
}

/**
 * The real product provider factory with a controlled SDK loader: the tokenizer
 * and model are deterministic objects, and the TTS callable records the exact
 * text/voice/speed and returns fixed 24 kHz samples.
 */
async function createFixedKokoroProvider(options: {
  samples: Float32Array
  sampleRate: number
}): Promise<{ provider: KokoroProvider; calls: FixedProviderCall[] }> {
  const calls: FixedProviderCall[] = []
  const loader: KokoroSdkLoader = {
    configureEnvironment() {},
    async loadTokenizer() {
      return () => ({ input_ids: { data: [1, 2], dims: [1, 2] } })
    },
    async loadModel() {
      return {}
    },
    createTts() {
      return {
        async generate(text, config) {
          calls.push({ text, voiceId: config.voice, speed: config.speed })
          return { audio: new Float32Array(options.samples), sampling_rate: options.sampleRate }
        },
      }
    },
    ensureVoice(voiceId) {
      if (voiceId !== 'af_heart' && voiceId !== 'bf_emma') {
        throw new Error(`fixed kokoro loader has no voice ${voiceId}`)
      }
    },
  }
  const provider = await createKokoroProvider(
    {
      modelRoot: 'fixed-kokoro-model',
      revision: 'fixed-revision',
      maxTokens: 512,
      voiceId: 'af_heart',
      speed: 1,
      environment: {
        localModelPath: '/models/kokoro',
        cacheDir: '/models/cache',
      },
    },
    loader,
  )
  return { provider, calls }
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.concat(data).toString('utf8')
}

interface Waiter {
  predicate: (message: JsonObject) => boolean
  resolve: (message: JsonObject) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

class RawApplicationClient {
  private readonly ws: WebSocket
  private readonly opened: Promise<void>
  private readonly queue: JsonObject[] = []
  private readonly waiters: Waiter[] = []
  private snapshotMessage: JsonObject | null = null
  private failure: Error | null = null
  private counter = 0

  constructor(ws: WebSocket) {
    this.ws = ws
    this.opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.on('message', (data) => this.handleMessage(rawToString(data)))
    ws.on('close', () => this.fail(new Error('application socket closed')))
    ws.on('error', (error) => this.fail(error))
  }

  async ready(): Promise<void> {
    await this.opened
    await this.waitFor((message) => message.kind === 'session.snapshot')
  }

  async request(kind: string, payload: unknown): Promise<{ messageId: string; reply: JsonObject }> {
    await this.readyIfNeeded()
    const snapshot = this.snapshotMessage
    if (snapshot === null) throw new Error('application client has no session snapshot')
    this.counter += 1
    const messageId = `voice-test-${kind}-${this.counter}`
    this.ws.send(
      JSON.stringify({
        protocolVersion: '0.2',
        messageId,
        sessionId: snapshot.sessionId,
        epoch: snapshot.epoch,
        kind,
        payload,
      }),
    )
    const reply = await this.waitFor((message) => {
      const body = message.payload
      if (typeof body !== 'object' || body === null) return false
      const record = body as JsonObject
      return (
        record.requestMessageId === messageId ||
        (message.kind === 'request.error' && record.requestId === messageId)
      )
    })
    return { messageId, reply }
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve())
      this.ws.close()
    })
  }

  private async readyIfNeeded(): Promise<void> {
    if (this.snapshotMessage !== null) return
    await this.ready()
  }

  private handleMessage(raw: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      this.fail(new Error('application server sent invalid JSON'))
      return
    }
    const parsed = parseApplicationServerMessage(decoded)
    if (!parsed.ok) {
      this.fail(new Error(`invalid application server message: ${parsed.message}`))
      return
    }
    const message = parsed.message as unknown as JsonObject
    if (message.kind === 'session.snapshot') this.snapshotMessage = message
    this.deliver(message)
  }

  private deliver(message: JsonObject): void {
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index]
      if (waiter !== undefined && waiter.predicate(message)) {
        this.waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
    }
    this.queue.push(message)
  }

  private waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    if (this.failure !== null) return Promise.reject(this.failure)
    const queuedIndex = this.queue.findIndex(predicate)
    if (queuedIndex >= 0) {
      return Promise.resolve(this.queue.splice(queuedIndex, 1)[0] as JsonObject)
    }
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('timed out waiting for an application server message'))
      }, 3000)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  private fail(error: unknown): void {
    if (this.failure === null) {
      this.failure = error instanceof Error ? error : new Error(String(error))
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(this.failure)
    }
  }
}

async function connectRaw(port: number): Promise<RawApplicationClient> {
  const client = new RawApplicationClient(
    new WebSocket(`ws://127.0.0.1:${port}/app`, { origin: APP_ORIGIN }),
  )
  clients.push(client)
  await client.ready()
  return client
}

function issueOperatorToken(port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/operator/bootstrap',
        method: 'POST',
        headers: {
          origin: APP_ORIGIN,
          host: `127.0.0.1:${port}`,
          'x-isla-operator-bootstrap': '1',
          'content-length': '0',
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
            const parsed = JSON.parse(body) as { ok?: boolean; token?: string }
            if (parsed.ok === true && typeof parsed.token === 'string') resolve(parsed.token)
            else reject(new Error(`operator bootstrap was refused: ${body}`))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

interface EndpointHarness {
  readonly port: number
  readonly store: EventStorePort
  connect(): Promise<RawApplicationClient>
  issueToken(): Promise<string>
}

async function startEndpoint(options: { voice?: TestVoiceCapability } = {}): Promise<EndpointHarness> {
  const clock = createMonotonicClock()
  const gate = createDeadlineGate(clock)
  const store = createEventStore(createInMemoryBackend())
  const composition = createRuntimeComposition({
    clock,
    authorizer: createRuntimeAuthorizer(),
    selection: createFixtureSelectionPort(),
    reaction: createFixtureReactionPort(),
    dialogue: createFixtureDialoguePort(),
    commit: createFixtureMemoryCommit(),
    store,
    renderer: createFixtureRendererPort(),
    gate,
    synthesis: createFixtureSynthesisPort(),
    sessionId: SESSION_ID,
  })
  const endpoint = createApplicationEndpoint({
    composition,
    clock,
    allowedOrigins: [APP_ORIGIN],
    ...(options.voice !== undefined ? { voice: options.voice } : {}),
  })
  const server = new DiagnosticsServer({ port: 0, graceMs: 200, application: endpoint })
  servers.push(server)
  await server.start()
  const port = server.boundPort
  if (port === undefined) throw new Error('application server did not bind a port')
  return {
    port,
    store,
    connect: () => connectRaw(port),
    issueToken: () => issueOperatorToken(port),
  }
}

describe('installed Kokoro voice catalog', () => {
  it('lists the accepted English assets once, sorted, with their locale', () => {
    const installed = installedVoiceIds()
    const voices = createKokoroVoiceCatalog([
      ...installed,
      ...installed,
      'ef_dora',
      'not_a_voice',
      '../af_heart',
    ])
    const ids = voices.map((voice) => voice.id)

    expect(ids).toHaveLength(28)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('af_heart')
    expect(ids).toContain('bf_emma')
    expect(ids).not.toContain('ef_dora')
    expect(voices.every((voice) => voice.name.trim().length > 0)).toBe(true)
    expect(voices.find((voice) => voice.id === 'af_heart')?.locale).toBe('en-US')
    expect(voices.find((voice) => voice.id === 'bf_emma')?.locale).toBe('en-GB')
  })
})

describe('voice settings persistence', () => {
  it('defaults to af_heart and carries an adopted bf_emma through a fresh construction', async () => {
    const filePath = join(tempDir(), 'voice-settings.json')
    const first = await createVoiceSettings({
      voices: catalog(),
      persistence: createJsonFileVoiceSettingsPersistence(filePath),
    })

    expect(first.state().selectedVoiceId).toBe('af_heart')
    expect(first.currentVoiceProfile().voiceProfileId).toBe('af_heart')

    await first.select('bf_emma')
    // An identical repeat is a safe no-op, not a conflict or a lost selection.
    await first.select('bf_emma')
    expect(first.state().selectedVoiceId).toBe('bf_emma')
    expect(existsSync(filePath)).toBe(true)

    const reconstructed = await createVoiceSettings({
      voices: catalog(),
      persistence: createJsonFileVoiceSettingsPersistence(filePath),
    })
    expect(reconstructed.state().selectedVoiceId).toBe('bf_emma')
    expect(reconstructed.currentVoiceProfile().voiceProfileId).toBe('bf_emma')
    expect(reconstructed.currentVoiceProfile().voiceProfileVersion.length).toBeGreaterThan(0)
  })

  it('refuses an unknown or unavailable voice and a failed save without changing the active voice', async () => {
    const settings = await createVoiceSettings({
      voices: catalog(),
      persistence: memoryPersistence(),
    })

    await expect(settings.select('ef_dora')).rejects.toMatchObject({ code: 'unknown_voice' })
    await expect(settings.select('../af_heart')).rejects.toMatchObject({ code: 'unknown_voice' })
    expect(settings.state().selectedVoiceId).toBe('af_heart')

    // bf_emma is a valid English voice but is not installed in this catalog.
    const availableOnly = await createVoiceSettings({
      voices: catalog().filter((voice) => voice.id === 'af_heart'),
      persistence: memoryPersistence(),
    })
    await expect(availableOnly.select('bf_emma')).rejects.toMatchObject({ code: 'unknown_voice' })
    expect(availableOnly.state().selectedVoiceId).toBe('af_heart')

    let saveAttempted = false
    const failingSave = await createVoiceSettings({
      voices: catalog(),
      persistence: {
        async read() {
          return null
        },
        async write() {
          saveAttempted = true
          throw new Error('injected disk failure')
        },
      },
    })
    await expect(failingSave.select('bf_emma')).rejects.toMatchObject({
      code: 'persistence_failed',
    })
    expect(saveAttempted).toBe(true)
    expect(failingSave.state().selectedVoiceId).toBe('af_heart')
  })
})

describe('voice preview synthesis', () => {
  it('synthesizes the fixed text as the requested voice through the actual provider factory', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25])
    const fixed = await createFixedKokoroProvider({ samples, sampleRate: 24_000 })
    const preview = createVoicePreview({
      provider: fixed.provider,
      text: PREVIEW_TEXT,
      speed: 1,
    })

    const result = await preview.synthesize('bf_emma')

    expect(fixed.calls).toEqual([{ text: PREVIEW_TEXT, voiceId: 'bf_emma', speed: 1 }])
    expect(result.voiceId).toBe('bf_emma')
    expectWav(result.wav, samples, 24_000)
  })
})

describe('turn voice binding', () => {
  it('keeps both segments of a begun turn in its starting voice and uses the adopted voice next turn', async () => {
    const settings = await createVoiceSettings({
      voices: catalog(),
      persistence: createJsonFileVoiceSettingsPersistence(
        join(tempDir(), 'voice-settings.json'),
      ),
    })
    const baseSynthesis = createFixtureSynthesisPort()
    const preparedVoices: string[] = []
    const synthesis: SynthesisPort = {
      async prepare(request, context) {
        preparedVoices.push(request.voiceProfileId)
        return baseSynthesis.prepare(request, context)
      },
    }
    const dialogue: DialoguePort = {
      async generate(request, _context, sink) {
        for (let index = 0; index < 2; index += 1) {
          // The operator adopts bf_emma after the first segment is fully
          // dispatched. The already-started turn must keep its first voice.
          if (index === 1) await settings.select('bf_emma')
          await sink.segment(
            dialogueSegmentSchema.parse({
              requestId: request.requestId,
              sessionId: request.sessionId,
              epoch: request.epoch,
              turnId: request.turnId,
              segmentId: `${request.turnId}-voice-segment-${index}`,
              index,
              text: `voice segment ${index + 1}`,
              model: 'fixture',
              modelVersion: 'fixture-v1',
            }),
          )
        }
        return dialogueEndSchema.parse({
          requestId: request.requestId,
          sessionId: request.sessionId,
          epoch: request.epoch,
          turnId: request.turnId,
          status: 'completed',
          segmentCount: 2,
          usage: fixtureUsage({ requestId: request.requestId }),
        })
      },
    }
    const coordinator = createRuntimeCoordinator({
      clock: createMonotonicClock(),
      authorizer: createRuntimeAuthorizer(),
      selection: createFixtureSelectionPort(),
      reaction: createFixtureReactionPort(),
      dialogue,
      synthesis,
      renderer: createFixtureRendererPort(),
      player: createFixturePlayer(),
      commit: createFixtureMemoryCommit(),
      store: createEventStore(createInMemoryBackend()),
      sessionId: SESSION_ID,
      profile: {
        characterProfileId: 'character-voice',
        characterProfileVersion: '1',
        voiceProfileId: 'voice-default',
        voiceProfileVersion: '1',
      },
      voice: settings,
    })
    const operator: TrustedControlContext = {
      connectionId: 'operator-voice-test',
      role: 'operator',
      actorId: 'operator-voice-test',
      authenticated: true,
    }
    const viewer: TrustedControlContext = {
      connectionId: 'viewer-voice-test',
      role: 'viewer',
      actorId: 'viewer-voice-test',
      authenticated: true,
    }
    const resume = await coordinator.endpoint.control(
      {
        protocolVersion: '0.2',
        kind: 'control.resume',
        messageId: 'message-resume',
        sessionId: SESSION_ID,
        epoch: coordinator.epoch(),
        payload: { requestId: 'request-resume' },
      },
      operator,
    )
    expect(resume.status).toBe('applied')

    expect(
      (
        await coordinator.endpoint.submitInput(
          {
            protocolVersion: '0.2',
            kind: 'input.submit',
            messageId: 'message-input-1',
            sessionId: SESSION_ID,
            epoch: coordinator.epoch(),
            payload: { source: 'local-audience', text: 'first turn' },
          },
          viewer,
        )
      ).status,
    ).toBe('accepted')
    expect((await coordinator.runTurn()).status).toBe('completed')
    expect(preparedVoices).toEqual(['af_heart', 'af_heart'])
    expect(settings.state().selectedVoiceId).toBe('bf_emma')

    expect(
      (
        await coordinator.endpoint.submitInput(
          {
            protocolVersion: '0.2',
            kind: 'input.submit',
            messageId: 'message-input-2',
            sessionId: SESSION_ID,
            epoch: coordinator.epoch(),
            payload: { source: 'local-audience', text: 'second turn' },
          },
          viewer,
        )
      ).status,
    ).toBe('accepted')
    expect((await coordinator.runTurn()).status).toBe('completed')
    expect(preparedVoices).toEqual(['af_heart', 'af_heart', 'bf_emma', 'bf_emma'])
  })
})

describe('application voice transport', () => {
  it('lets only an operator adopt a voice and previews without changing the adopted voice or records', async () => {
    const envelope = {
      protocolVersion: '0.2',
      sessionId: SESSION_ID,
      epoch: 0,
      messageId: 'message-schema',
    }
    expect(
      parseApplicationClientMessage({ ...envelope, kind: 'voice.list', payload: {} }),
    ).toMatchObject({ ok: true })
    expect(
      parseApplicationClientMessage({
        ...envelope,
        kind: 'voice.select',
        payload: { voiceId: 'bf_emma' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      parseApplicationClientMessage({
        ...envelope,
        kind: 'voice.preview',
        payload: { voiceId: 'bf_emma' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      parseApplicationClientMessage({
        ...envelope,
        kind: 'voice.select',
        payload: { voiceId: 'bf_emma', role: 'operator' },
      }),
    ).toMatchObject({ ok: false, code: 'malformed' })

    const file = createJsonFileVoiceSettingsPersistence(
      join(tempDir(), 'voice-settings.json'),
    )
    let writes = 0
    const settings = await createVoiceSettings({
      voices: catalog(),
      persistence: {
        read: () => file.read(),
        async write(contents) {
          writes += 1
          await file.write(contents)
        },
      },
    })
    const samples = new Float32Array([0, 0.25, -0.25])
    const fixed = await createFixedKokoroProvider({ samples, sampleRate: 24_000 })
    const preview = createVoicePreview({
      provider: fixed.provider,
      text: PREVIEW_TEXT,
      speed: 1,
    })
    const voice: TestVoiceCapability = {
      state: () => settings.state(),
      select: (voiceId) => settings.select(voiceId),
      preview: (voiceId) => preview.synthesize(voiceId),
    }
    const harness = await startEndpoint({ voice })
    const client = await harness.connect()
    const writesBefore = writes

    const listed = await client.request('voice.list', {})
    expect(listed.reply.kind).toBe('voice.state')
    expect(listed.reply.payload).toMatchObject({
      requestMessageId: listed.messageId,
      selectedVoiceId: 'af_heart',
    })
    const listedVoices = (listed.reply.payload as { voices: VoiceOption[] }).voices
    expect(listedVoices.map((entry) => entry.id)).toEqual(
      [...listedVoices.map((entry) => entry.id)].sort(),
    )
    expect(listedVoices.some((entry) => entry.id === 'bf_emma')).toBe(true)

    const denied = await client.request('voice.select', { voiceId: 'bf_emma' })
    expect(denied.reply.kind).toBe('request.error')
    expect(denied.reply.payload).toMatchObject({
      requestId: denied.messageId,
      code: 'unauthorized',
    })
    expect(writes).toBe(writesBefore)
    const afterDenial = await client.request('voice.list', {})
    expect(afterDenial.reply.payload).toMatchObject({ selectedVoiceId: 'af_heart' })

    const token = await harness.issueToken()
    const bootstrapped = await client.request('operator.bootstrap', { token })
    expect(bootstrapped.reply.kind).toBe('operator.ack')

    const adopted = await client.request('voice.select', { voiceId: 'bf_emma' })
    expect(adopted.reply.kind).toBe('voice.state')
    expect(adopted.reply.payload).toMatchObject({
      requestMessageId: adopted.messageId,
      selectedVoiceId: 'bf_emma',
    })
    expect(writes).toBe(writesBefore + 1)
    const recordsAfterAdoption = await harness.store.readSession(SESSION_ID)

    const sampled = await client.request('voice.preview', { voiceId: 'bf_emma' })
    expect(sampled.reply.kind).toBe('voice.sample')
    expect(sampled.reply.payload).toMatchObject({
      requestMessageId: sampled.messageId,
      voiceId: 'bf_emma',
    })
    const samplePayload = sampled.reply.payload as { wavBase64: string }
    expectWav(Uint8Array.from(Buffer.from(samplePayload.wavBase64, 'base64')), samples, 24_000)
    expect(fixed.calls).toEqual([{ text: PREVIEW_TEXT, voiceId: 'bf_emma', speed: 1 }])

    const afterPreview = await client.request('voice.list', {})
    expect(afterPreview.reply.payload).toMatchObject({ selectedVoiceId: 'bf_emma' })
    expect(writes).toBe(writesBefore + 1)
    expect(await harness.store.readSession(SESSION_ID)).toEqual(recordsAfterAdoption)
  })

  it('answers an empty voice state without the optional capability and keeps base input usable', async () => {
    const harness = await startEndpoint()
    const client = await harness.connect()

    const listed = await client.request('voice.list', {})
    expect(listed.reply.kind).toBe('voice.state')
    expect(listed.reply.payload).toEqual({
      requestMessageId: listed.messageId,
      selectedVoiceId: null,
      voices: [],
    })

    const input = await client.request('input.submit', {
      source: 'local-audience',
      text: 'existing clients still submit input',
    })
    expect(input.reply.kind).toBe('input.ack')
    expect(input.reply.payload).toMatchObject({
      requestMessageId: input.messageId,
      status: 'accepted',
    })
  })
})
