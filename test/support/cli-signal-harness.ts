/**
 * Test-only entry point for the runtime CLI.
 *
 * It is launched directly as the Node entry (`node --import tsx <this file>`),
 * so `process.pid` is the process that runs `src/runtime/cli.ts`; no launcher
 * sits between the spawned PID and the CLI.
 *
 * The module installs a readiness gate around the `listening` log line and then
 * loads the production entry point unchanged (`src/runtime/cli.ts`). The gate
 * turns "signal just after readiness" into a deterministic handshake: the
 * patched write flushes the readiness line synchronously, blocks the main
 * thread, and only returns after the supervisor has created the gate file.
 * Because the supervisor sends its signal before creating that file, the signal
 * is forced to land exactly at the readiness write. In the buggy ordering that
 * point is before the listeners exist, so the default action terminates the
 * process; in the fixed ordering the listeners are already installed, so the
 * same forced timing exercises the graceful shutdown. The harness assumes
 * neither ordering; it only fixes *when* the signal arrives.
 *
 * Platform note: this exercises POSIX signal delivery. On Windows `child.kill`
 * maps to TerminateProcess rather than a catchable signal, so the two
 * readiness-window regression cases that use this harness are skipped there.
 *
 * No production module imports this file; it exists only under `test/`.
 */
import { existsSync, writeSync } from 'node:fs'

const READINESS_MARKER = '"event":"listening"'
const GATE_ENV = 'ISLA_TEST_READINESS_GATE'
const POLL_SLICE_MS = 1
const GATE_TIMEOUT_MS = 15_000

const configuredGatePath = process.env[GATE_ENV]
if (configuredGatePath === undefined || configuredGatePath.length === 0) {
  throw new Error(`${GATE_ENV} must be set to a filesystem path`)
}
const gatePath: string = configuredGatePath

// Proves the tested PID owns this process; the test asserts it matches the
// spawned child. Written synchronously so it cannot be lost on early exit.
writeSync(
  1,
  `${JSON.stringify({
    level: 'info',
    service: 'isla-runtime',
    event: 'harness_pid',
    pid: process.pid,
  })}\n`,
)

const originalWrite = process.stdout.write.bind(process.stdout)
let armed = true

function asText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
}

// `writeSync` has separate overloads for strings and array views; split the
// union so each call resolves to the matching one.
function writeChunk(fd: number, chunk: string | Uint8Array): void {
  if (typeof chunk === 'string') {
    writeSync(fd, chunk)
  } else {
    writeSync(fd, chunk)
  }
}

function holdUntilSignalSent(): void {
  // Block without yielding to the event loop: the child cannot advance past the
  // readiness write until the supervisor has sent its signal and written the
  // gate file.
  const deadline = Date.now() + GATE_TIMEOUT_MS
  const idle = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(gatePath)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${GATE_ENV} at ${gatePath}`)
    }
    // A bounded wait, used as a poll interval and nothing else; the pass/fail
    // oracle remains the child's exit status and shutdown output.
    Atomics.wait(idle, 0, 0, POLL_SLICE_MS)
  }
}

process.stdout.write = ((
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean => {
  if (armed && asText(chunk).includes(READINESS_MARKER)) {
    armed = false
    // Flush synchronously so the supervisor really observes the readiness line
    // before it is asked to signal.
    writeChunk(1, chunk)
    holdUntilSignalSent()
    return true
  }
  if (typeof encoding === 'function') {
    return originalWrite(chunk as string, encoding)
  }
  return originalWrite(chunk as string, encoding as BufferEncoding, callback)
}) as typeof process.stdout.write

void import('../../src/runtime/cli.ts')
