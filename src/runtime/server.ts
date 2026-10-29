import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { toErrorReply, type DiagnosticReply } from '../contracts'
import {
  DIAGNOSTICS_PATH,
  HEALTH_PATH,
  isLoopbackHost,
  normalizeRuntimeConfig,
} from './config'
import { createHealthResponse } from './health'
import { processDiagnosticMessage } from './diagnostics'
import type { MemoryInspectSource } from './memory-inspect-reply'
import type { ApplicationEndpoint } from './application'

type ServerState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped'

const URL_BASE = 'http://localhost'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function parseRequestUrl(rawUrl: string | undefined): URL | null {
  if (rawUrl === undefined) return null
  try {
    return new URL(rawUrl, URL_BASE)
  } catch {
    return null
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.concat(data)
}

function decodeMessage(data: RawData, isBinary: boolean): string | null {
  if (typeof data === 'string') return data
  const buffer = toBuffer(data)
  if (!isBinary) return buffer.toString('utf8')
  try {
    return UTF8_DECODER.decode(buffer)
  } catch {
    return null
  }
}

export class DiagnosticsServer {
  private readonly http
  private readonly wss: WebSocketServer
  private readonly appWss: WebSocketServer | undefined
  private readonly application: ApplicationEndpoint | undefined
  private readonly memoryInspect: MemoryInspectSource | undefined
  private readonly host: string
  private readonly path: string
  private readonly graceMs: number
  private readonly configuredPort: number
  private state: ServerState = 'idle'
  private startedAt = 0
  private stopPromise: Promise<void> | undefined

  constructor(options: {
    host?: string
    port?: number
    path?: string
    maxPayload?: number
    graceMs?: number
    application?: ApplicationEndpoint
    /*
     * Read-only observation source for `get_memory_inspect`. Omitted by default:
     * the composition root decides whether a dialogue observation exists, and a
     * diagnostics server that never received one answers "unavailable".
     */
    memoryInspect?: MemoryInspectSource
  } = {}) {
    const config = normalizeRuntimeConfig({
      host: options.host,
      port: options.port,
      maxPayload: options.maxPayload,
      graceMs: options.graceMs,
    })
    this.host = config.host
    this.configuredPort = config.port
    this.path = options.path ?? DIAGNOSTICS_PATH
    this.graceMs = config.graceMs
    this.application = options.application
    this.memoryInspect = options.memoryInspect
    this.http = createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload })
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    this.wss.on('connection', (ws) => this.handleConnection(ws))
    this.wss.on('error', (err) => this.logWsError('server', err))

    if (this.application !== undefined) {
      const application = this.application
      this.appWss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload })
      this.appWss.on('connection', (ws, req) => application.onConnection(ws, req))
      this.appWss.on('error', (err) => this.logWsError('application', err))
    }
  }

  get stateLabel(): ServerState {
    return this.state
  }

  get boundPort(): number | undefined {
    return this.addressInfo?.port
  }

  get addressInfo(): AddressInfo | null {
    const address = this.http.address()
    return address !== null && typeof address === 'object' ? address : null
  }

  private get uptimeSec(): number {
    return this.state === 'started' ? (Date.now() - this.startedAt) / 1000 : 0
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.state !== 'idle') {
      return Promise.reject(new Error(`diagnostics server cannot start in state "${this.state}"`))
    }
    this.state = 'starting'
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.http.off('listening', onListening)
        this.state = 'idle'
        reject(err)
      }
      const onListening = (): void => {
        this.http.off('error', onError)
        this.startedAt = Date.now()
        const port = this.addressInfo?.port
        if (port === undefined) {
          this.state = 'idle'
          reject(new Error('diagnostics server started without a bound address'))
          return
        }
        this.state = 'started'
        resolve({ host: this.host, port })
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(this.configuredPort, this.host)
    })
  }

  stop(): Promise<void> {
    if (this.state === 'stopped') return Promise.resolve()
    if (this.state === 'stopping') return this.stopPromise ?? Promise.resolve()
    if (this.state !== 'started') {
      return Promise.reject(new Error(`diagnostics server cannot stop in state "${this.state}"`))
    }
    this.state = 'stopping'
    this.stopPromise = this.performShutdown()
    return this.stopPromise
  }

  private performShutdown(): Promise<void> {
    return new Promise((resolve) => {
      let finished = false
      let forceTimer: NodeJS.Timeout | undefined

      const finish = (): void => {
        if (finished) return
        finished = true
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        void this.closeSockets().then(() => {
          this.state = 'stopped'
          resolve()
        })
      }

      const clients = [...this.wss.clients, ...(this.appWss?.clients ?? [])]
      if (clients.length === 0) {
        finish()
        return
      }

      let remaining = clients.length
      for (const client of clients) {
        client.once('close', () => {
          remaining -= 1
          if (remaining === 0) finish()
        })
      }
      for (const client of clients) {
        client.close(1001, 'diagnostics server shutting down')
      }

      forceTimer = setTimeout(() => {
        for (const client of [...this.wss.clients, ...(this.appWss?.clients ?? [])]) {
          client.terminate()
        }
        finish()
      }, this.graceMs)
      forceTimer.unref()
    })
  }

  private async closeSockets(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve())
    })
    if (this.appWss !== undefined) {
      this.application?.dispose()
      await new Promise<void>((resolve) => {
        this.appWss?.close(() => resolve())
      })
    }
    await new Promise<void>((resolve) => {
      if (!this.http.listening) {
        resolve()
        return
      }
      this.http.close(() => resolve())
      this.http.closeIdleConnections()
      this.http.closeAllConnections()
    })
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = parseRequestUrl(req.url)
    if (url === null) {
      this.writeJson(res, 400, {
        ok: false,
        error: { code: 'malformed', message: 'request URL is malformed' },
      })
      return
    }

    if (url.pathname !== HEALTH_PATH) {
      if (this.application !== undefined && this.application.handleHttp(req, res)) return
      this.writeJson(res, 404, {
        ok: false,
        error: { code: 'not_found', path: url.pathname },
      })
      return
    }

    if (req.method !== 'GET') {
      this.writeJson(res, 405, {
        ok: false,
        error: { code: 'method_not_allowed', method: req.method },
      })
      return
    }

    this.writeJson(res, 200, createHealthResponse(this.uptimeSec))
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.state !== 'started') {
      socket.destroy()
      return
    }
    const url = parseRequestUrl(req.url)
    if (url === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (this.application !== undefined && url.pathname === this.application.path) {
      const appWss = this.appWss
      if (
        appWss === undefined ||
        !this.application.allowRequest(req.headers.origin, req.headers.host)
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      appWss.handleUpgrade(req, socket, head, (ws) => {
        appWss.emit('connection', ws, req)
      })
      return
    }
    if (url.pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (!this.isPermittedOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  private isPermittedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true
    try {
      return isLoopbackHost(normalizeHostname(new URL(origin).hostname))
    } catch {
      return false
    }
  }

  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data, isBinary) => {
      const text = decodeMessage(data, isBinary)
      if (text === null) {
        this.sendReply(
          ws,
          toErrorReply({
            code: 'malformed',
            message: 'binary diagnostic message is not valid UTF-8',
          }),
        )
        return
      }
      this.sendReply(
        ws,
        processDiagnosticMessage(text, this.uptimeSec, {
          ...(this.memoryInspect !== undefined ? { memoryInspect: this.memoryInspect } : {}),
        }),
      )
    })
    ws.on('error', (err) => this.logWsError('connection', err))
  }

  private sendReply(ws: WebSocket, reply: DiagnosticReply): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(reply))
  }

  private logWsError(source: string, err: Error): void {
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        service: 'isla-runtime',
        operation: 'websocket',
        source,
        outcome: 'error',
        error: err.message,
      })}\n`,
    )
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }
}
