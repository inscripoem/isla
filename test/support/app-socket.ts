import { WebSocket } from 'ws'

/**
 * A raw protocol-0.2 application socket for focused regressions.
 *
 * The performer client wraps the real M1 state machine, which is ideal for the
 * end-to-end loop but gives a test no control over exact inbound framing or
 * timing. This helper speaks the application protocol directly over a genuine
 * loopback socket so a test can drive the real server-side endpoint, bridge and
 * coordinator with precise messages and observe the exact frames returned.
 */

export type JsonObject = Record<string, unknown>

export interface RawApplicationSocket {
  readonly ws: WebSocket
  messages(): JsonObject[]
  errors(): JsonObject[]
  send(message: JsonObject): void
  sendRaw(raw: string): void
  waitFor(predicate: (message: JsonObject) => boolean, timeoutMs?: number): Promise<JsonObject>
  snapshot(timeoutMs?: number): Promise<JsonObject>
  close(): Promise<void>
}

function payloadOf(message: JsonObject): JsonObject {
  const payload = message.payload
  return typeof payload === 'object' && payload !== null ? (payload as JsonObject) : {}
}

export async function connectApplication(port: number, origin: string): Promise<RawApplicationSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app`, { origin })
  const messages: JsonObject[] = []
  const errors: JsonObject[] = []
  const waiters: Array<{ predicate: (message: JsonObject) => boolean; resolve: (message: JsonObject) => void }> = []

  const settle = (message: JsonObject): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter !== undefined && waiter.predicate(message)) {
        waiters.splice(index, 1)
        waiter.resolve(message)
      }
    }
  }

  ws.on('message', (data: Buffer) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const message = parsed as JsonObject
    messages.push(message)
    if (message.kind === 'request.error') errors.push(message)
    settle(message)
  })

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  const waitFor = (predicate: (message: JsonObject) => boolean, timeoutMs = 5000): Promise<JsonObject> =>
    new Promise<JsonObject>((resolve, reject) => {
      const existing = messages.find((message) => predicate(message))
      if (existing !== undefined) {
        resolve(existing)
        return
      }
      const waiter = { predicate, resolve }
      waiters.push(waiter)
      setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) {
          waiters.splice(index, 1)
          reject(new Error('application socket wait timed out'))
        }
      }, timeoutMs).unref?.()
    })

  const send = (message: JsonObject): void => {
    ws.send(JSON.stringify(message))
  }

  return {
    ws,
    messages: () => messages.slice(),
    errors: () => errors.slice(),
    send,
    sendRaw: (raw: string) => {
      ws.send(raw)
    },
    waitFor,
    snapshot: (timeoutMs?: number) =>
      waitFor((message) => message.kind === 'session.snapshot', timeoutMs),
    close: async () => {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.once('close', () => resolve())
        ws.close()
      })
    },
  }
}

export { payloadOf }
