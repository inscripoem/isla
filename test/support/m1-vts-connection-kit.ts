import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import type { VtsConnectionSocket } from '../../src/performance/vts-connection'

export const M1_VTS_CONNECTION_RAW_TEXT = 'fixture socket raw'
export const M1_VTS_CONNECTION_DEFAULT_CLOSE_TIMEOUT_MS = 50

const RAW_SEND_ERROR = `${M1_VTS_CONNECTION_RAW_TEXT} send failure must not escape`
const RAW_CLOSE_REASON = `${M1_VTS_CONNECTION_RAW_TEXT} close reason must not escape`
const RAW_SOCKET_ERROR = `${M1_VTS_CONNECTION_RAW_TEXT} error must not escape`

export type FixtureVtsSendFailure = 'none' | 'sync-throw' | 'async-callback-error'
export type FixtureVtsCloseEmission = 'manual' | 'synchronous'

export interface FixtureVtsSendContext {
  readonly serialized: string
  reply(text: string): void
  failSynchronously(): void
  failAsynchronously(): void
}

export interface FixtureVtsSocketOptions {
  readonly readyState?: number
  readonly sendFailure?: FixtureVtsSendFailure
  readonly closeThrows?: boolean
  readonly closeEmission?: FixtureVtsCloseEmission
}

type FixtureListener = (...args: unknown[]) => void

export class FixtureVtsSocket implements VtsConnectionSocket {
  readyState: number
  private readonly listeners = new Map<string, Set<FixtureListener>>()
  private sendCalls = 0
  private closeCalls = 0
  private terminateCalls = 0
  private readonly sent: string[] = []
  private sendFailure: FixtureVtsSendFailure
  private closeThrows: boolean
  private closeEmission: FixtureVtsCloseEmission
  private onSend: ((context: FixtureVtsSendContext) => void) | null = null

  constructor(options: FixtureVtsSocketOptions = {}) {
    this.readyState = options.readyState ?? 1
    this.sendFailure = options.sendFailure ?? 'none'
    this.closeThrows = options.closeThrows ?? false
    this.closeEmission = options.closeEmission ?? 'manual'
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sendCalls += 1
    this.sent.push(data)
    const context: FixtureVtsSendContext = {
      serialized: data,
      reply: (text) => this.emitMessage(text),
      failSynchronously: () => {
        throw new Error(RAW_SEND_ERROR)
      },
      failAsynchronously: () => {
        queueMicrotask(() => callback?.(new Error(RAW_SEND_ERROR)))
      },
    }
    this.onSend?.(context)
    if (this.sendFailure === 'sync-throw') throw new Error(RAW_SEND_ERROR)
    if (this.sendFailure === 'async-callback-error') {
      queueMicrotask(() => callback?.(new Error(RAW_SEND_ERROR)))
    }
  }

  close(): void {
    this.closeCalls += 1
    if (this.closeThrows) throw new Error(RAW_CLOSE_REASON)
    if (this.closeEmission === 'synchronous') {
      this.emitClose(1000, Buffer.from(RAW_CLOSE_REASON))
    }
  }

  terminate(): void {
    this.terminateCalls += 1
  }

  on(event: string, listener: FixtureListener): this {
    let listeners = this.listeners.get(event)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener)
    return this
  }

  off(event: string, listener: FixtureListener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emitMessage(data: unknown, isBinary = false): boolean {
    return this.emit('message', data, isBinary)
  }

  emitClose(code = 1006, reason: Buffer = Buffer.from(RAW_CLOSE_REASON)): boolean {
    this.readyState = 3
    return this.emit('close', code, reason)
  }

  emitError(error: Error = new Error(RAW_SOCKET_ERROR)): boolean {
    const listeners = this.listeners.get('error')
    if (listeners === undefined || listeners.size === 0) throw error
    for (const listener of [...listeners]) listener(error)
    return true
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  sendCount(): number {
    return this.sendCalls
  }

  closeCount(): number {
    return this.closeCalls
  }

  terminateCount(): number {
    return this.terminateCalls
  }

  sentRaw(): string[] {
    return this.sent.slice()
  }

  setOnSend(hook: ((context: FixtureVtsSendContext) => void) | null): void {
    this.onSend = hook
  }

  setSendFailure(value: FixtureVtsSendFailure): void {
    this.sendFailure = value
  }

  setCloseThrows(value: boolean): void {
    this.closeThrows = value
  }

  setCloseEmission(value: FixtureVtsCloseEmission): void {
    this.closeEmission = value
  }

  private emit(event: string, ...args: unknown[]): boolean {
    const listeners = this.listeners.get(event)
    if (listeners === undefined || listeners.size === 0) return false
    for (const listener of [...listeners]) listener(...args)
    return true
  }
}

export function createFixtureVtsSocket(
  options: FixtureVtsSocketOptions = {},
): FixtureVtsSocket {
  return new FixtureVtsSocket(options)
}

export interface M1VtsFixtureServer {
  readonly url: string
  readonly port: number
  waitForClient(): Promise<void>
  sendText(text: string): void
  sendBinary(data: Buffer): void
  closeClient(): void
  close(): Promise<void>
}

export async function startM1VtsFixtureServer(): Promise<M1VtsFixtureServer> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/offline-vts-fixture',
  })

  try {
    await once(server, 'listening')
  } catch (error) {
    server.close()
    throw error
  }

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('fixture server: expected an ephemeral TCP address')
  }

  const peers = new Set<WebSocket>()
  let resolvePeer!: () => void
  const peerReady = new Promise<void>((resolve) => {
    resolvePeer = resolve
  })

  server.on('connection', (socket) => {
    peers.add(socket)
    socket.on('close', () => peers.delete(socket))
    resolvePeer()
  })

  const requirePeer = (): WebSocket => {
    for (const peer of peers) {
      if (peer.readyState === WebSocket.OPEN) return peer
    }
    throw new Error('fixture server: no open client')
  }

  return {
    url: `ws://127.0.0.1:${address.port}/offline-vts-fixture`,
    port: address.port,
    waitForClient: () => peerReady,
    sendText(text) {
      requirePeer().send(text)
    },
    sendBinary(data) {
      requirePeer().send(data)
    },
    closeClient() {
      requirePeer().close(1000, 'fixture peer complete')
    },
    async close() {
      for (const peer of peers) {
        if (peer.readyState !== WebSocket.CLOSED) peer.terminate()
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

export async function openM1VtsFixtureClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url, { perMessageDeflate: false })
  try {
    await once(client, 'open')
  } catch (error) {
    client.terminate()
    throw error
  }
  return client
}

export async function closeM1VtsFixtureClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return
  if (client.readyState === WebSocket.CONNECTING) {
    client.terminate()
    return
  }
  const closed = once(client, 'close').catch(() => undefined)
  if (client.readyState === WebSocket.OPEN) client.close()
  await closed
}
