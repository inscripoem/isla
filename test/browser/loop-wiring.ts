import type { PerformerMachine } from './performer-machine'

/**
 * Browser-safe socket wiring for the I1 loop demo. It installs the JSON message
 * route that feeds the shared performer machine and the lifecycle hooks. It is
 * a separate module so the exact wiring used by the browser entry can be
 * exercised by an automated test with a fake socket.
 */

export interface SocketLike {
  readyState: number
  send(data: string): void
  onmessage: ((event: { data: unknown }) => void) | null
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface SocketWiringHooks {
  onOpen?(): void
  onClose?(): void
  onError?(): void
  onMalformed?(): void
}

/**
 * Routes inbound JSON to `machine.handleMessage`. Malformed JSON is rejected
 * safely and never thrown; the machine validates unknown/mismatched messages.
 */
export function wireSocket(
  socket: SocketLike,
  machine: PerformerMachine,
  hooks: SocketWiringHooks = {},
): void {
  socket.onmessage = (event) => {
    let parsed: unknown
    try {
      parsed = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(String(event.data))
    } catch {
      hooks.onMalformed?.()
      return
    }
    machine.handleMessage(parsed)
  }
  socket.onopen = () => hooks.onOpen?.()
  socket.onclose = () => hooks.onClose?.()
  socket.onerror = () => hooks.onError?.()
}
