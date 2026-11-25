/**
 * Local avatar relay CLI.
 *
 * Serves the synthetic avatar source over WebSocket at `/avatar`. This is a
 * local Node process: it is never imported by the browser entry points and a
 * guard keeps importing this module from starting a server.
 */

import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { createAvatarRelay } from './relay.ts'
import type { RelaySocket } from './relay.ts'
import {
  createNoneSource,
  createSyntheticSource,
  createUnavailableNdiSource,
} from './source.ts'
import type { AvatarSource } from './source.ts'

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

  const rawSource = readFlag(argv, 'source') ?? 'synthetic'
  if (rawSource !== 'synthetic' && rawSource !== 'none' && rawSource !== 'ndi') {
    throw new UsageError(`invalid source: ${rawSource}`)
  }

  return { port, source: rawSource, fps }
}

function toRelaySocket(socket: {
  readyState: number
  send(data: string | Uint8Array): void
  close(): void
}): RelaySocket {
  return {
    get readyState() {
      return socket.readyState
    },
    send(data) {
      socket.send(typeof data === 'string' ? data : Buffer.from(data))
    },
    close() {
      socket.close()
    },
  }
}

export function main(argv: readonly string[]): void {
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

  const source: AvatarSource =
    parsed.source === 'none' ? createNoneSource() : createSyntheticSource({ fps: parsed.fps })

  const relay = createAvatarRelay({
    source,
    onError: (message) => process.stderr.write(`${message}\n`),
  })

  const server = new WebSocketServer({ port: parsed.port, path: '/avatar' })

  server.on('connection', (socket) => {
    const relaySocket = toRelaySocket(socket)
    const remove = relay.handleClient(relaySocket)
    socket.on('close', remove)
  })

  relay.start()
  process.stdout.write(
    `avatar relay listening on ws://localhost:${parsed.port}/avatar (source ${parsed.source}, fps ${parsed.fps})\n`,
  )

  const shutdown = (): void => {
    relay.stop()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
}
