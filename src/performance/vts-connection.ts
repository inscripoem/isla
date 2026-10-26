import type { VtsTransport, VtsTransportEvent } from './vts-client'

const VTS_SOCKET_OPEN = 1
const MAX_TIMER_MS = 2_147_483_647

export interface VtsConnectionSocket {
  readonly readyState: number
  send(data: string, callback?: (error?: Error) => void): void
  close(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface VtsConnectionOptions {
  readonly socket: VtsConnectionSocket
  readonly closeTimeoutMs: number
}

export type VtsConnectionCompletion =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'failed'
      readonly code: 'close_timeout' | 'close_failed'
    }

export interface VtsConnectionHandle {
  readonly transport: VtsTransport
  readonly closed: Promise<VtsConnectionCompletion>
  close(): Promise<VtsConnectionCompletion>
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function validateOptions(options: VtsConnectionOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new Error('vts-connection: options must be an object')
  }
  const { socket, closeTimeoutMs } = options
  if (socket === null || typeof socket !== 'object') {
    throw new Error('vts-connection: socket must be an injected Node ws socket')
  }
  if (
    typeof socket.send !== 'function' ||
    typeof socket.close !== 'function' ||
    typeof socket.on !== 'function' ||
    typeof socket.off !== 'function'
  ) {
    throw new Error('vts-connection: socket must expose send, close, on and off')
  }
  if (socket.readyState !== VTS_SOCKET_OPEN) {
    throw new Error('vts-connection: socket must already be OPEN')
  }
  if (
    typeof closeTimeoutMs !== 'number' ||
    !Number.isFinite(closeTimeoutMs) ||
    closeTimeoutMs <= 0 ||
    closeTimeoutMs > MAX_TIMER_MS
  ) {
    throw new Error('vts-connection: closeTimeoutMs must be a finite positive timer value')
  }
}

function normalizeTextFrame(data: unknown, isBinary: boolean): string | undefined {
  if (isBinary) return undefined
  if (typeof data === 'string') return data

  let bytes: Uint8Array
  if (Buffer.isBuffer(data)) {
    bytes = data
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data)
  } else if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    bytes = Buffer.concat(data as Buffer[])
  } else {
    return undefined
  }

  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return undefined
  }
}

export function createVtsConnectionHandle(
  options: VtsConnectionOptions,
): VtsConnectionHandle {
  validateOptions(options)
  const socket = options.socket
  const closeTimeoutMs = options.closeTimeoutMs

  let subscriber: ((event: VtsTransportEvent) => void) | null = null
  let closeInitiated = false
  let physicalClosed = false
  let completionSettled = false
  let listenersReleased = false
  let listenerReleaseFailed = false
  let closeForwarded = false
  let errorForwarded = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  let resolveCompletion!: (completion: VtsConnectionCompletion) => void
  const closed = new Promise<VtsConnectionCompletion>((resolve) => {
    resolveCompletion = resolve
  })

  function clearCloseTimer(): void {
    if (closeTimer === null) return
    clearTimeout(closeTimer)
    closeTimer = null
  }

  function settle(completion: VtsConnectionCompletion): void {
    if (completionSettled) return
    completionSettled = true
    clearCloseTimer()
    resolveCompletion(completion)
  }

  function forward(event: VtsTransportEvent): void {
    const listener = subscriber
    if (listener === null) return
    try {
      listener(event)
    } catch {
      return
    }
  }

  function detach(event: string, listener: (...args: unknown[]) => void): void {
    try {
      socket.off(event, listener)
    } catch {
      listenerReleaseFailed = true
    }
  }

  function releaseOwnedListeners(): boolean {
    if (!listenersReleased) {
      listenersReleased = true
      detach('message', onMessage)
      detach('close', onClose)
      detach('error', onError)
    }
    return !listenerReleaseFailed
  }

  function forwardError(): void {
    if (physicalClosed || errorForwarded) return
    errorForwarded = true
    forward({ type: 'error' })
  }

  function onMessage(...args: unknown[]): void {
    if (closeInitiated || physicalClosed) return
    const text = normalizeTextFrame(args[0], args[1] === true)
    if (text === undefined) return
    forward({ type: 'message', data: text })
  }

  function onClose(): void {
    if (physicalClosed) return
    physicalClosed = true
    clearCloseTimer()
    const released = releaseOwnedListeners()
    if (!closeForwarded) {
      closeForwarded = true
      forward({ type: 'close' })
    }
    settle(released ? { kind: 'closed' } : { kind: 'failed', code: 'close_failed' })
  }

  function onError(): void {
    forwardError()
  }

  function onTimeout(): void {
    closeTimer = null
    if (completionSettled || physicalClosed) return
    settle({ kind: 'failed', code: 'close_timeout' })
  }

  function initiateClose(): void {
    if (closeInitiated) return
    closeInitiated = true
    if (physicalClosed || completionSettled) return

    try {
      closeTimer = setTimeout(onTimeout, closeTimeoutMs)
    } catch {
      settle({ kind: 'failed', code: 'close_failed' })
      return
    }

    try {
      socket.close()
    } catch {
      clearCloseTimer()
      if (!completionSettled) {
        settle({ kind: 'failed', code: 'close_failed' })
      }
    }
  }

  const transport: VtsTransport = {
    send(serialized) {
      if (closeInitiated || physicalClosed || completionSettled) return
      try {
        socket.send(serialized, (error?: Error) => {
          if (error) forwardError()
        })
      } catch {
        forwardError()
      }
    },
    subscribe(listener) {
      if (closeInitiated || physicalClosed || completionSettled) {
        throw new Error('vts-connection: connection is closed')
      }
      if (typeof listener !== 'function') {
        throw new Error('vts-connection: subscriber must be a function')
      }
      if (subscriber !== null) {
        throw new Error('vts-connection: one application subscriber is allowed')
      }
      subscriber = listener
      let active = true
      return () => {
        if (!active) return
        active = false
        if (subscriber === listener) subscriber = null
      }
    },
    dispose: initiateClose,
  }

  socket.on('message', onMessage)
  socket.on('close', onClose)
  socket.on('error', onError)

  return {
    transport,
    closed,
    close() {
      initiateClose()
      return closed
    },
  }
}
