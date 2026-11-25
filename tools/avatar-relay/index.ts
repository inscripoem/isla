/**
 * Local avatar relay CLI.
 *
 * Serves the synthetic avatar source over WebSocket at `/avatar`. This is a
 * local Node process: it is never imported by the browser entry points and a
 * guard keeps importing this module from starting a server. The server binds
 * loopback only and rejects cross-origin browser clients so another page can
 * never pull local avatar frames off the network.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { MAX_FRAME_BYTES } from '../../src/console/avatar-viewport.ts'
import { createAvatarRelay } from './relay.ts'
import type { RelaySocket } from './relay.ts'
import {
  createNoneSource,
  createSyntheticSource,
  createUnavailableNdiSource,
} from './source.ts'
import type { AvatarSource } from './source.ts'

export const RELAY_HOST = '127.0.0.1'
export const RELAY_PATH = '/avatar'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface ParsedArgs {
  readonly port: number
  readonly source: 'synthetic' | 'none' | 'ndi'
  readonly fps: number
}

const USAGE =
  'usage: avatar-relay [--port <number>] [--source synthetic|none|ndi] [--fps <number>]'

class UsageError extends Error {}

function readFlag(args: readonly string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const prefix = `--${name}=`
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    if (arg === `--${name}`) {
      const next = args[index + 1]
      if (next === undefined) throw new UsageError(`missing value for --${name}`)
      return next
    }
  }
  return null
}

/**
 * Accept a browser Origin only when it is absent (a local CLI) or names a
 * loopback host. A cancelled document sends the literal `null`, which is not a
 * loopback hostname and is rejected.
 */
export function isAllowedRelayOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  return LOCAL_HOSTNAMES.has(hostname)
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const rawPort = readFlag(argv, 'port')
  const port = rawPort === null ? 4320 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid port: ${rawPort ?? ''}`)
  }

  const rawFps = readFlag(argv, 'fps')
  const fps = rawFps === null ? 15 : Number(rawFps)
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new UsageError(`invalid fps: ${rawFps ?? ''}`)
  }

  const rawSource = readFlag(argv, 'source') ?? 'none'
  if (rawSource !== 'synthetic' && rawSource !== 'none' && rawSource !== 'ndi') {
    throw new UsageError(`invalid source: ${rawSource}`)
  }

  return { port, source: rawSource, fps }
}

function toRelaySocket(socket: {
  readyState: number
  bufferedAmount: number
  send(data: string | Uint8Array): void
  close(): void
}): RelaySocket {
  return {
    get readyState() {
      return socket.readyState
    },
    get bufferedAmount() {
      return socket.bufferedAmount
    },
    send(data) {
      socket.send(typeof data === 'string' ? data : Buffer.from(data))
    },
    close() {
      socket.close()
    },
  }
}

function respondAndClose(socket: Duplex, code: number, reason: string): void {
  const body = reason
  const response =
    `HTTP/1.1 ${code} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body
  try {
    socket.write(response)
  } finally {
    socket.destroy()
  }
}

export interface RelayServerOptions {
  readonly port: number
  readonly source: 'synthetic' | 'none'
  readonly fps: number
  readonly host?: string
  readonly onError?: (message: string) => void
}

export interface RelayServer {
  readonly port: number
  readonly host: string
  close(): Promise<void>
}

/**
 * Start a loopback relay. The server answers ordinary HTTP with 404, checks the
 * upgrade path and Origin before handing the socket to the crypto-free fan-out,
 * and only starts the source once it is listening. Port 0 asks the OS for a
 * free port; `port` reports the actual bound value.
 */
export async function startAvatarRelayServer(
  options: RelayServerOptions,
): Promise<RelayServer> {
  const host = options.host ?? RELAY_HOST
  const onError = options.onError ?? (() => {})

  const source: AvatarSource =
    options.source === 'none' ? createNoneSource() : createSyntheticSource({ fps: options.fps })

  const relay = createAvatarRelay({ source, onError })

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 8 })

  wss.on('connection', (socket) => {
    const relaySocket = toRelaySocket(socket)
    const remove = relay.handleClient(relaySocket)
    socket.on('close', remove)
  })

  const respond404 = (_request: IncomingMessage, response: ServerResponse): void => {
    response.statusCode = 404
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.end('Not Found')
  }

  const server = createServer(respond404)

  server.on('upgrade', (request, socket, head) => {
    let pathname: string
    try {
      pathname = new URL(request.url ?? '', `http://${host}`).pathname
    } catch {
      respondAndClose(socket, 404, 'Not Found')
      return
    }
    if (pathname !== RELAY_PATH) {
      respondAndClose(socket, 404, 'Not Found')
      return
    }
    if (!isAllowedRelayOrigin(request.headers.origin)) {
      respondAndClose(socket, 403, 'Forbidden')
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      server.off('listening', onListen)
      reject(error)
    }
    const onListen = (): void => {
      server.off('error', onListenError)
      resolve()
    }
    server.once('error', onListenError)
    server.once('listening', onListen)
    server.listen(options.port, host)
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port

  relay.start()

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing !== null) return closing
    relay.stop()
    for (const client of wss.clients) {
      try {
        client.terminate()
      } catch {
        // ignore a client that already closed
      }
    }
    closing = (async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    })()
    return closing
  }

  return { port: boundPort, host, close }
}

async function main(argv: readonly string[]): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    const detail = error instanceof UsageError ? `${error.message}\n` : ''
    process.stderr.write(`${detail}${USAGE}\n`)
    process.exit(2)
  }

  if (parsed.source === 'ndi') {
    createUnavailableNdiSource('ndi capture is not implemented in this increment')
    process.stderr.write(
      'ndi capture is not implemented in this increment; no frames will be fabricated\n',
    )
    process.exit(2)
  }

  let server: RelayServer
  try {
    server = await startAvatarRelayServer({
      port: parsed.port,
      source: parsed.source,
      fps: parsed.fps,
      onError: (message) => process.stderr.write(`${message}\n`),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`avatar relay failed to listen: ${detail}\n`)
    process.exit(1)
  }

  let shuttingDown = false
  let closingServer: RelayServer | null = null
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (closingServer === null) {
      process.exit(0)
      return
    }
    void closingServer.close().then(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  closingServer = server

  const source = parsed.source
  const fpsClause = source === 'none' ? '' : `, fps ${parsed.fps}`
  process.stdout.write(
    `avatar relay listening on ws://${server.host}:${server.port}${RELAY_PATH} (source ${source}${fpsClause})\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2))
}
