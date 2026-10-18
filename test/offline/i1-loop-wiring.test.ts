import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { wireSocket } from '../browser/loop-wiring'
import type { SocketLike } from '../browser/loop-wiring'
import { createPerformerMachine } from '../browser/performer-machine'
import {
  createControlledMediaDriver,
  createControlledResolver,
  createTestReceiptTools,
} from '../support/m1-kit'
import { FIXTURE_SESSION_ID, fixturePerformanceCommand } from '../support/fixture-data'

/**
 * Exercises the exact socket wiring the browser entry (`test/browser/loop.ts`)
 * installs, using a fake socket and the shared performer machine. This is the
 * regression guard for the missing `onmessage` route.
 */
function fakeSocket(): SocketLike & { sent: string[] } {
  return {
    readyState: 1,
    sent: [],
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      this.sent.push(data)
    },
  }
}

function buildMachine(sink?: string[]): ReturnType<typeof createPerformerMachine> {
  const resolver = createControlledResolver()
  resolver.setAutoResolve()
  return createPerformerMachine({
    transport: {
      send: (raw) => {
        sink?.push(raw)
      },
    },
    media: createControlledMediaDriver({ autoEvents: true }),
    resolver,
    receipts: createTestReceiptTools('wiring'),
    now: () => 0,
  })
}

function snapshot(epoch: number): unknown {
  return {
    protocolVersion: '0.2',
    messageId: 'snap-1',
    sessionId: FIXTURE_SESSION_ID,
    epoch,
    kind: 'session.snapshot',
    payload: {
      lifecycle: 'stopped',
      activeTurnId: null,
      performerStatus: 'idle',
      outputConfirmation: 'confirmed',
      capabilityRevision: 1,
      lastSeq: 0,
    },
  }
}

describe('I1 loop socket wiring', () => {
  it('routes snapshots and offers to the machine and rejects malformed JSON safely', () => {
    const onMalformed = vi.fn()
    const onOpen = vi.fn()
    const socket = fakeSocket()
    const machine = buildMachine()
    wireSocket(socket, machine, { onMalformed, onOpen })

    expect(socket.onmessage).not.toBeNull()
    socket.onopen?.()
    expect(onOpen).toHaveBeenCalledTimes(1)

    // Snapshot JSON reaches the machine.
    socket.onmessage?.({ data: JSON.stringify(snapshot(1)) })
    expect(machine.state().sessionId).toBe(FIXTURE_SESSION_ID)
    expect(machine.state().epoch).toBe(1)

    // Malformed JSON is rejected without throwing.
    expect(() => socket.onmessage?.({ data: 'not json' })).not.toThrow()
    expect(onMalformed).toHaveBeenCalledTimes(1)

    // Valid JSON that fails the schema is ignored.
    expect(() => socket.onmessage?.({ data: JSON.stringify({ kind: 'nope' }) })).not.toThrow()
  })

  it('sends a ready when an offer is routed through the wiring', () => {
    const socket = fakeSocket()
    const machine = buildMachine(socket.sent)
    wireSocket(socket, machine)
    socket.onmessage?.({ data: JSON.stringify(snapshot(1)) })
    const command = fixturePerformanceCommand()
    socket.onmessage?.({
      data: JSON.stringify({
        protocolVersion: '0.2',
        messageId: 'offer-1',
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.offer',
        payload: command,
      }),
    })
    expect(
      socket.sent.some((raw) => (JSON.parse(raw) as { kind: string }).kind === 'performance.ready'),
    ).toBe(true)
  })

  it('the browser entry actually installs the wiring', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../browser/loop.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('wireSocket(')
    // The old bug: no socket message route at all.
    expect(source).not.toMatch(/socket\.onmessage\s*=/)
  })
})
