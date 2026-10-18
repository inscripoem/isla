import { afterEach, describe, expect, it } from 'vitest'
import { createLoopHarness } from '../support/i1-harness'
import type { LoopHarness } from '../support/i1-harness'
import { connectApplication, payloadOf } from '../support/app-socket'
import type { RawApplicationSocket } from '../support/app-socket'
import type { RuntimeCoordinator } from '../../src/runtime/coordinator'
import type { ApplicationDiagnostic } from '../../src/runtime/application'

/**
 * M5 application diagnostic boundary (DELIVERY-PLAN 2026-10-16.5, item 1).
 *
 * Scheduler, request-processing and snapshot faults are observable through a
 * bounded local record. These tests drive the real failure routes (scheduler
 * drain, inbound message handling, connection snapshot) over a genuine loopback
 * socket, with a fault injected through the coordinator seam, and prove that
 * hostile sinks and unbounded identifiers cannot leak or break the runtime.
 */

interface Faults {
  runTurn: boolean
  snapshot: boolean
  submitInput: boolean
}

const INJECTED_MARKER = 'INJECTED-SECRET-MARKER'
const REF_PATTERN = /^[0-9a-f]{16}$/

function wrapWithFaults(faults: Faults): (coordinator: RuntimeCoordinator) => RuntimeCoordinator {
  return (coordinator) => ({
    ...coordinator,
    runTurn: () =>
      faults.runTurn
        ? Promise.reject(new Error(`${INJECTED_MARKER}: scheduler`))
        : coordinator.runTurn(),
    endpoint: {
      ...coordinator.endpoint,
      snapshot: () =>
        faults.snapshot
          ? Promise.reject(new Error(`${INJECTED_MARKER}: snapshot`))
          : coordinator.endpoint.snapshot(),
      submitInput: (message, context) =>
        faults.submitInput
          ? Promise.reject(new Error(`${INJECTED_MARKER}: request`))
          : coordinator.endpoint.submitInput(message, context),
    },
  })
}

const harnesses: LoopHarness[] = []
const sockets: RawApplicationSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close().catch(() => {})
  for (const harness of harnesses.splice(0)) await harness.close()
})

function track(socket: RawApplicationSocket): RawApplicationSocket {
  sockets.push(socket)
  return socket
}

const ALLOWED_DIAGNOSTIC_KEYS = new Set([
  'level',
  'service',
  'operation',
  'outcome',
  'sessionRef',
  'epoch',
  'connectionId',
  'messageKind',
  'requestRef',
])

function assertBounded(diagnostic: ApplicationDiagnostic): void {
  expect(diagnostic.level).toBe('warn')
  expect(diagnostic.service).toBe('isla-runtime')
  expect(diagnostic.outcome).toBe('error')
  expect(['application.scheduler', 'application.request', 'application.snapshot']).toContain(
    diagnostic.operation,
  )
  expect(diagnostic.sessionRef).toMatch(REF_PATTERN)
  for (const key of Object.keys(diagnostic)) {
    expect(ALLOWED_DIAGNOSTIC_KEYS.has(key)).toBe(true)
  }
  expect(JSON.stringify(diagnostic)).not.toContain(INJECTED_MARKER)
  expect(JSON.stringify(diagnostic)).not.toContain('input content')
}

async function boot(harness: LoopHarness): Promise<void> {
  const token = await harness.bootstrapOperator()
  await harness.client.bootstrapOperator(token)
  await harness.client.attach()
  await harness.client.resume()
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('M5 application diagnostic boundary', () => {
  it('reports a scheduler fault boundedly and still processes a later valid input', async () => {
    const diagnostics: ApplicationDiagnostic[] = []
    const faults: Faults = { runTurn: false, snapshot: false, submitInput: false }
    const harness = await createLoopHarness({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      wrapCoordinator: wrapWithFaults(faults),
    })
    harnesses.push(harness)
    await boot(harness)

    faults.runTurn = true
    const ack = await harness.client.input('input content that must not leak', 'scheduler-input')
    expect((ack.payload as { status: string }).status).toBe('accepted')
    const record = await until(
      () => diagnostics.find((diagnostic) => diagnostic.operation === 'application.scheduler'),
      (value) => value !== undefined,
    )
    assertBounded(record!)
    expect(record!.epoch).toBeTypeOf('number')
    expect(record!.messageKind).toBeUndefined()

    faults.runTurn = false
    await harness.client.input('a later valid turn', 'scheduler-recovery')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect((await harness.confirmedHistory()).length).toBeGreaterThanOrEqual(1)
  })

  it('reports a snapshot fault boundedly and a later connection snapshots normally', async () => {
    const diagnostics: ApplicationDiagnostic[] = []
    const faults: Faults = { runTurn: false, snapshot: false, submitInput: false }
    const harness = await createLoopHarness({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      wrapCoordinator: wrapWithFaults(faults),
    })
    harnesses.push(harness)
    await boot(harness)

    faults.snapshot = true
    const broken = track(await connectApplication(harness.port, harness.origin))
    const record = await until(
      () => diagnostics.find((diagnostic) => diagnostic.operation === 'application.snapshot'),
      (value) => value !== undefined,
    )
    assertBounded(record!)
    expect(record!.connectionId).toBeTypeOf('string')
    await broken.close()

    faults.snapshot = false
    const healthy = track(await connectApplication(harness.port, harness.origin))
    expect((await healthy.snapshot()).kind).toBe('session.snapshot')
  })

  it('reports a request fault with a generic client error and opaque correlation', async () => {
    const diagnostics: ApplicationDiagnostic[] = []
    const faults: Faults = { runTurn: false, snapshot: false, submitInput: false }
    const harness = await createLoopHarness({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      wrapCoordinator: wrapWithFaults(faults),
    })
    harnesses.push(harness)
    await boot(harness)

    const socket = track(await connectApplication(harness.port, harness.origin))
    const epoch = (await socket.snapshot()).epoch as number

    faults.submitInput = true
    socket.send({
      protocolVersion: '0.2',
      messageId: 'safe-request-1',
      sessionId: harness.sessionId,
      epoch,
      kind: 'input.submit',
      payload: { source: 'local-audience', text: 'input content that must not leak' },
    })
    const error = await socket.waitFor((message) => message.kind === 'request.error')
    expect(payloadOf(error).code).toBe('internal')
    expect(payloadOf(error).message).toBe('request failed while processing')

    const record = await until(
      () => diagnostics.find((diagnostic) => diagnostic.operation === 'application.request'),
      (value) => value !== undefined,
    )
    assertBounded(record!)
    expect(record!.connectionId).toBeTypeOf('string')
    expect(record!.messageKind).toBe('input.submit')
    expect(record!.requestRef).toMatch(REF_PATTERN)
    expect(record!.epoch).toBe(epoch)

    // A long hostile id is never emitted verbatim; only its opaque digest is.
    const hostileId = `${'x'.repeat(4096)}\n\u0000\u001b[31m`
    socket.send({
      protocolVersion: '0.2',
      messageId: hostileId,
      sessionId: harness.sessionId,
      epoch,
      kind: 'input.submit',
      payload: { source: 'local-audience', text: 'input content that must not leak' },
    })
    await until(
      () => diagnostics.filter((diagnostic) => diagnostic.operation === 'application.request').length,
      (count) => count >= 2,
    )
    const hostile = diagnostics.filter((diagnostic) => diagnostic.operation === 'application.request')[1]!
    assertBounded(hostile)
    expect(hostile.requestRef).toMatch(REF_PATTERN)
    const serialized = JSON.stringify(hostile)
    expect(serialized).not.toContain('x'.repeat(100))
    expect(serialized).not.toContain('\n')
  })

  it('isolates throwing, rejecting, hostile-thenable, nonsettling and reentrant sinks', async () => {
    const captured: ApplicationDiagnostic[] = []
    let calls = 0
    const faults: Faults = { runTurn: false, snapshot: false, submitInput: false }
    const harness = await createLoopHarness({
      onDiagnostic: (diagnostic) => {
        // Capture a detached copy, then mutate the caller's record: a mutated
        // record must not persist into a later diagnostic.
        captured.push({ ...diagnostic })
        ;(diagnostic as { operation: string }).operation = 'mutated'
        // Synchronous reentry: a reentrant fault or read must not break reporting.
        void harness.composition.coordinator.epoch()
        if (faults.runTurn) void harness.composition.coordinator.runTurn().catch(() => {})
        calls += 1
        const mode = calls % 5
        if (mode === 1) throw new Error('synchronous sink failure')
        if (mode === 2) return Promise.reject(new Error('asynchronous sink failure'))
        if (mode === 3) {
          return {
            get then(): never {
              throw new Error('throwing then accessor')
            },
          }
        }
        if (mode === 4) {
          const functionThenable = () => {}
          Object.defineProperty(functionThenable, 'then', {
            value: () => undefined,
          })
          return functionThenable
        }
        return new Promise<never>(() => {}) // nonsettling
      },
      wrapCoordinator: wrapWithFaults(faults),
    })
    harnesses.push(harness)
    await boot(harness)

    faults.runTurn = true
    for (let index = 0; index < 5; index += 1) {
      await harness.client.input(`scheduler fault ${index}`, `sink-input-${index}`)
      await until(() => captured.length, (count) => count >= index + 1)
    }

    // Every captured record is a fresh, bounded object; the mutation never
    // propagated and no recursive report was amplified.
    for (const record of captured) assertBounded(record)
    expect(captured.every((record) => (record.operation as string) !== 'mutated')).toBe(true)
    expect(calls).toBe(5)

    // Stop remains responsive while a nonsettling sink is outstanding.
    const stop = await harness.client.stop()
    expect((stop.payload as { status: string }).status).toBe('applied')
    await harness.close()
  })

  it('never reads a thrown object property when classifying a fault', async () => {
    const diagnostics: ApplicationDiagnostic[] = []
    let read = false
    const hostile: Record<string, unknown> = {}
    for (const key of ['message', 'name', 'stack', 'cause', 'usage']) {
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get() {
          read = true
          return `${INJECTED_MARKER}: ${key}`
        },
      })
    }
    const harness = await createLoopHarness({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      wrapCoordinator: (coordinator) => ({
        ...coordinator,
        runTurn: () => Promise.reject(hostile),
      }),
    })
    harnesses.push(harness)
    await boot(harness)

    await harness.client.input('throwing object', 'throw-object')
    await until(() => diagnostics.length, (count) => count >= 1)
    expect(read).toBe(false)
    assertBounded(diagnostics[0]!)
  })

  it('emits no diagnostic on the happy path', async () => {
    const diagnostics: ApplicationDiagnostic[] = []
    const harness = await createLoopHarness({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) })
    harnesses.push(harness)
    await boot(harness)
    await harness.client.input('a normal turn')
    await until(
      async () => (await harness.confirmedHistory()).length,
      (count) => count >= 1,
    )
    expect(diagnostics).toEqual([])
  })
})
