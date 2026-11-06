import {
  parseApplicationClientMessage,
  type BootstrapSnapshot,
  type SessionSnapshotMessage,
} from '../contracts'
import type { ConsoleApplicationTransport } from './app-transport'
import type { PerformerTransport } from './performer-machine'

/**
 * Pure, browser-safe adapters between the console transport and the performer
 * machine (M2).
 *
 * The performer machine emits raw JSON frames and identity-bearing envelopes of
 * its own; these helpers only translate between that surface and the shared
 * protocol-0.2 contract. They hold no React state, timers or global state, and
 * they never generate identities.
 */

/**
 * Adapt an application transport to the machine's `send(raw)` seam.
 *
 * The raw frame is parsed strictly with the shared client schema; an invalid
 * frame throws a plain `Error` and writes nothing. A valid frame is handed to
 * `sendApplication`, whose transport/closed errors propagate to the caller.
 */
export function createMachineTransport(transport: ConsoleApplicationTransport): PerformerTransport {
  return {
    send(raw: string): void {
      let decoded: unknown
      try {
        decoded = JSON.parse(raw)
      } catch {
        throw new Error('invalid application client message: not valid JSON')
      }
      const parsed = parseApplicationClientMessage(decoded)
      if (!parsed.ok) {
        throw new Error(`invalid application client message: ${parsed.message}`)
      }
      transport.sendApplication(parsed.message)
    },
  }
}

/**
 * Convert a flat bootstrap snapshot into a valid `session.snapshot` application
 * message. It reuses the bootstrap envelope identity and maps `seq` to the
 * payload's `lastSeq`; no field is invented.
 */
export function snapshotMessageFromBootstrap(bootstrap: BootstrapSnapshot): SessionSnapshotMessage {
  return {
    protocolVersion: bootstrap.protocolVersion,
    messageId: bootstrap.messageId,
    sessionId: bootstrap.sessionId,
    epoch: bootstrap.epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: bootstrap.lifecycle,
      activeTurnId: bootstrap.activeTurnId,
      performerStatus: bootstrap.performerStatus,
      outputConfirmation: bootstrap.outputConfirmation,
      capabilityRevision: bootstrap.capabilityRevision,
      lastSeq: bootstrap.seq,
    },
  }
}
