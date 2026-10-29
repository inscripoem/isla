import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { DIAGNOSTICS_PROTOCOL_VERSION } from '../../src/contracts'
import { DiagnosticsServer } from '../../src/runtime/server'
import type { MemoryInspectSource } from '../../src/runtime/memory-inspect-reply'

interface HealthBody {
  ok: boolean
  service: string
  role: string
  loopbackOnly: boolean
  capabilities: string[]
  protocol: { diagnostics: number; application: number | null }
}

interface ProtocolErrorBody {
  code: string
  message?: string
  requestedVersion?: number
}

type JsonObject = Record<string, unknown>

const GRACE_MS = 500

const servers: DiagnosticsServer[] = []

async function createServer(
  options: {
    host?: string
    port?: number
    path?: string
    maxPayload?: number
    graceMs?: number
    memoryInspect?: MemoryInspectSource
  } = {},
): Promise<DiagnosticsServer> {
  const server = new DiagnosticsServer({ port: 0, graceMs: GRACE_MS, ...options })
  servers.push(server)
  await server.start()
  return server
}

afterEach(async () => {
  const pending = servers.splice(0)
  await Promise.all(
    pending.map(async (server) => {
      try {
        await server.stop()
      } catch {
        // already stopped by a lifecycle test
      }
    }),
  )
})

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.concat(data).toString('utf8')
}

function httpUrl(server: DiagnosticsServer, path: string): string {
  return `http://127.0.0.1:${server.boundPort}${path}`
}

function connect(
  server: DiagnosticsServer,
  options: { path?: string; origin?: string } = {},
): WebSocket {
  const url = `ws://127.0.0.1:${server.boundPort}${options.path ?? '/diag'}`
  return options.origin === undefined ? new WebSocket(url) : new WebSocket(url, { origin: options.origin })
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function openClient(server: DiagnosticsServer, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = connect(server, origin === undefined ? {} : { origin })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(rawToString(data)) as JsonObject)
      } catch (error) {
        reject(error)
      }
    })
    ws.once('error', reject)
  })
}

async function sendJson(ws: WebSocket, payload: unknown): Promise<JsonObject> {
  const reply = nextMessage(ws)
  ws.send(JSON.stringify(payload))
  return reply
}

function errorOf(reply: JsonObject): ProtocolErrorBody {
  return reply.error as ProtocolErrorBody
}

function expectRejected(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('error', () => resolve())
    ws.once('unexpected-response', () => resolve())
    ws.once('open', () => reject(new Error('connection unexpectedly opened')))
  })
}

describe('HTTP health boundary', () => {
  it('serves an honest loopback health response', async () => {
    const server = await createServer()
    const res = await fetch(httpUrl(server, '/health'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await readJson<HealthBody>(res)
    expect(body).toMatchObject({
      ok: true,
      service: 'isla-runtime',
      role: 'diagnostics-foundation',
      loopbackOnly: true,
    })
    expect(body.capabilities).toEqual(['health', 'diagnostics'])
    expect(body.protocol.diagnostics).toBe(DIAGNOSTICS_PROTOCOL_VERSION)
    expect(body.protocol.application).toBeNull()
  })

  it('rejects non-GET health requests', async () => {
    const server = await createServer()
    const res = await fetch(httpUrl(server, '/health'), { method: 'POST' })
    expect(res.status).toBe(405)
    const body = await readJson<JsonObject>(res)
    expect(errorOf(body).code).toBe('method_not_allowed')
  })

  it('returns 404 for unknown paths', async () => {
    const server = await createServer()
    const res = await fetch(httpUrl(server, '/nope'))
    expect(res.status).toBe(404)
    const body = await readJson<JsonObject>(res)
    expect(errorOf(body).code).toBe('not_found')
  })
})

describe('WebSocket diagnostics boundary', () => {
  it('answers a ping', async () => {
    const server = await createServer()
    const ws = await openClient(server)
    const reply = await sendJson(ws, { v: 1, id: 'p1', kind: 'ping' })
    expect(reply).toMatchObject({ v: 1, id: 'p1', ok: true, kind: 'ping' })
    expect((reply.payload as { pong: boolean }).pong).toBe(true)
    ws.close()
  })

  it('answers get_health with the shared health payload', async () => {
    const server = await createServer()
    const ws = await openClient(server)
    const reply = await sendJson(ws, { v: 1, kind: 'get_health' })
    expect(reply).toMatchObject({ ok: true, kind: 'get_health' })
    expect((reply.payload as HealthBody).loopbackOnly).toBe(true)
    ws.close()
  })

  it('rejects malformed JSON without succeeding', async () => {
    const server = await createServer()
    const ws = await openClient(server)
    const pending = nextMessage(ws)
    ws.send('not json')
    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(errorOf(reply).code).toBe('malformed')
    ws.close()
  })

  it('rejects an unsupported version without echoing it as the reply version', async () => {
    const server = await createServer()
    const ws = await openClient(server)
    const reply = await sendJson(ws, { v: 99, kind: 'ping' })
    expect(reply.v).toBe(DIAGNOSTICS_PROTOCOL_VERSION)
    expect(reply.ok).toBe(false)
    expect(errorOf(reply).code).toBe('unsupported_version')
    expect(errorOf(reply).requestedVersion).toBe(99)
    ws.close()
  })

  it('answers get_memory_inspect with an explicit unavailable outcome when it holds no observation', async () => {
    /*
     * Over the real socket, not only the handler: a runtime with no dialogue
     * observation must answer "nothing observed", and the reply must stay a
     * protocol-1 success so a consumer can tell it apart from an error.
     */
    const server = await createServer()
    const ws = await openClient(server)
    const reply = await sendJson(ws, {
      v: 1,
      id: 'm1',
      kind: 'get_memory_inspect',
      payload: { sessionId: 'session-a', turnId: 'turn-a' },
    })
    expect(reply).toMatchObject({
      v: DIAGNOSTICS_PROTOCOL_VERSION,
      id: 'm1',
      ok: true,
      kind: 'get_memory_inspect',
      payload: {
        section: 'memory.inspect',
        outcome: 'unavailable',
        reason: 'diag-plane-unavailable',
      },
    })
    ws.close()
  })

  it('serves an observation when the composition root injected one', async () => {
    const observation = {
      sessionId: 'session-a',
      turnId: 'turn-a',
      payload: {
        schemaVersion: 1 as const,
        sessionId: 'session-a',
        turnId: 'turn-a',
        replyIntent: 'ack',
        admission: { admitted: 2, exclusions: {}, noteM6Confirmed: 'audit-only' as const },
        recall: { persona: { used: 0, dropped: 0 }, delivery: { used: 0, dropped: 0 }, results: [] },
        budget: {
          estimatedCharacters: 0,
          truncatedByTurnLimit: false,
          truncatedByCharacterLimit: false,
        },
        consistency: {
          findings: 0,
          incomplete: true,
          statementsOffered: 200,
          statementsVisited: 128,
          statementsExamined: 128,
          textUnits: 4000,
          claims: 130,
          comparisons: 1000,
        },
        historySource: 'history-port' as const,
        warnings: ['consistency audit is incomplete'],
      },
    }
    const source: MemoryInspectSource = {
      latest: (sessionId, turnId) =>
        sessionId === observation.sessionId && turnId === observation.turnId ? observation : null,
    }
    const server = await createServer({ memoryInspect: source })
    const ws = await openClient(server)
    const reply = await sendJson(ws, {
      v: 1,
      id: 'm2',
      kind: 'get_memory_inspect',
      payload: { sessionId: 'session-a', turnId: 'turn-a' },
    })
    const payload = reply.payload as { section: string; inspect: { consistency: { incomplete: boolean; findings: number } } }
    expect(payload.section).toBe('memory.inspect')
    expect(payload.inspect.consistency).toMatchObject({ findings: 0, incomplete: true })

    const other = await sendJson(ws, {
      v: 1,
      id: 'm3',
      kind: 'get_memory_inspect',
      payload: { sessionId: 'session-a', turnId: 'unknown-turn' },
    })
    expect(other.payload).toMatchObject({ outcome: 'unavailable', reason: 'no-observation' })
    ws.close()
  })

  it('rejects an unimplemented application action', async () => {    const server = await createServer()
    const ws = await openClient(server)
    const reply = await sendJson(ws, { v: 1, kind: 'app.chat', id: 'a1' })
    expect(reply.ok).toBe(false)
    expect(errorOf(reply).code).toBe('unsupported_action')
    ws.close()
  })

  it('rejects binary messages that are not valid UTF-8', async () => {
    const server = await createServer()
    const ws = await openClient(server)
    const pending = nextMessage(ws)
    ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: true })
    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(errorOf(reply).code).toBe('malformed')
    expect(errorOf(reply).message).toContain('UTF-8')
    ws.close()
  })

  it('rejects a non-loopback origin during upgrade', async () => {
    const server = await createServer()
    await expect(expectRejected(connect(server, { origin: 'http://evil.example' }))).resolves.toBeUndefined()
    await expect(expectRejected(connect(server, { origin: 'http://192.168.1.10' }))).resolves.toBeUndefined()
  })

  it('accepts loopback origins including bracketed IPv6', async () => {
    const server = await createServer()
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173']) {
      const ws = await openClient(server, origin)
      const reply = await sendJson(ws, { v: 1, kind: 'ping' })
      expect(reply).toMatchObject({ ok: true, kind: 'ping' })
      ws.close()
    }
  })

  it('rejects an upgrade to an unknown path', async () => {
    const server = await createServer()
    await expect(expectRejected(connect(server, { path: '/other' }))).resolves.toBeUndefined()
  })
})

describe('payload bounds', () => {
  it('closes a connection whose message exceeds maxPayload', async () => {
    const server = await createServer({ maxPayload: 256 })
    const ws = await openClient(server)
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    ws.on('error', () => {})
    ws.send('x'.repeat(1024))
    await expect(closed).resolves.toBe(1009)
  })
})

describe('lifecycle', () => {
  it('rejects a second start while running', async () => {
    const server = await createServer()
    await expect(server.start()).rejects.toThrow(/cannot start/)
  })

  it('rejects stop before the server has started', async () => {
    const server = new DiagnosticsServer({ port: 0, graceMs: GRACE_MS })
    await expect(server.stop()).rejects.toThrow(/cannot stop/)
  })

  it('fails honestly when the configured port is already occupied', async () => {
    const first = await createServer()
    const port = first.boundPort
    if (port === undefined) throw new Error('first server did not bind a port')
    const second = new DiagnosticsServer({ port, graceMs: GRACE_MS })
    await expect(second.start()).rejects.toThrow(/EADDRINUSE/)
    expect(second.stateLabel).toBe('idle')
    const res = await fetch(httpUrl(first, '/health'))
    expect(res.status).toBe(200)
  })

  it('closes active websocket clients, releases the port, and allows rebinding', async () => {
    const server = await createServer()
    const ws = await openClient(server)
    const port = server.boundPort
    if (port === undefined) throw new Error('server did not bind a port')
    const healthUrl = httpUrl(server, '/health')
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    await server.stop()
    await expect(closed).resolves.toBe(1001)
    expect(server.stateLabel).toBe('stopped')
    expect(server.boundPort).toBeUndefined()
    await expect(fetch(healthUrl)).rejects.toThrow()

    const rebind = await createServer({ port })
    expect(rebind.boundPort).toBe(port)
  })

  it('resolves repeated stop calls after shutdown', async () => {
    const server = await createServer()
    await server.stop()
    await expect(server.stop()).resolves.toBeUndefined()
  })

  it('shares a single shutdown across concurrent stop calls', async () => {
    const server = await createServer()
    const first = server.stop()
    const second = server.stop()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })
})
