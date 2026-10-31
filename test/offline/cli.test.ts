import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticsServer } from '../../src/runtime/server'

type CliProcess = ChildProcessByStdio<null, Readable, Readable>

const TSX_BIN = 'node_modules/.bin/tsx'
const CLI_ENTRY = 'src/runtime/cli.ts'
const SIGNAL_HARNESS_ENTRY = 'test/support/cli-signal-harness.ts'
const READINESS_GATE_ENV = 'ISLA_TEST_READINESS_GATE'
const GRACE_MS = 500

const children: CliProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

function startCli(env: Record<string, string>): CliProcess {
  const child = spawn(TSX_BIN, [CLI_ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

// Runs the entry in the spawned Node process itself. `--import tsx` installs
// the TypeScript hooks in-process, so there is no launcher between this PID and
// the CLI: `child.kill()` delivers the real signal to the process under test.
function spawnNodeEntry(env: Record<string, string>, entry: string): CliProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

interface CliExit {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
}

function collectUntilExit(child: CliProcess): Promise<CliExit> {
  return new Promise((resolve) => {
    let output = ''
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code, signal) => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      resolve({ code, signal, output })
    })
  })
}

function waitForOutput(child: CliProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.includes(marker)) {
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        resolve()
      }
    }
    const onExit = (code: number | null): void => {
      child.stdout.off('data', onData)
      reject(new Error(`CLI exited with code ${code} before "${marker}": ${buffer}`))
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

interface ListeningLine {
  host: string
  port: number
}

function isListeningLine(value: unknown): value is ListeningLine {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.host === 'string' && typeof record.port === 'number'
}

function parseListeningLine(output: string): ListeningLine {
  const line = output
    .split('\n')
    .find((entry) => entry.includes('"event":"listening"'))
  if (line === undefined) throw new Error('listening line not found in output')
  const parsed: unknown = JSON.parse(line)
  if (!isListeningLine(parsed)) {
    throw new Error(`listening line is malformed: ${line}`)
  }
  return parsed
}

describe('runtime CLI', () => {
  it('reports an honest listen error when the port is occupied', async () => {
    const server = new DiagnosticsServer({ port: 0, graceMs: GRACE_MS })
    await server.start()
    try {
      const port = server.boundPort
      if (port === undefined) throw new Error('first server did not bind a port')
      const child = startCli({ ISLA_RUNTIME_PORT: String(port) })
      const exit = collectUntilExit(child)
      await waitForOutput(child, '"event":"listen_failed"')
      const { code, output } = await exit
      expect(output).toContain('"event":"listen_failed"')
      expect(code).toBe(1)
    } finally {
      await server.stop()
    }
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`shuts down cleanly on ${signal}`, async () => {
      const child = startCli({ ISLA_RUNTIME_PORT: '0' })
      await waitForOutput(child, '"event":"listening"')
      const exit = collectUntilExit(child)
      child.kill(signal)
      const { code, output } = await exit
      expect(code).toBe(0)
      expect(output).toContain('"event":"shutdown_complete"')
    })
  }
})

describe('runtime CLI readiness window', () => {
  // POSIX-only: Node's child_process.kill() on Windows calls TerminateProcess,
  // which force-stops the child instead of delivering a catchable SIGINT or
  // SIGTERM. The readiness-window behaviour below therefore cannot be observed
  // on Windows, so every case in this block is skipped there rather than
  // asserted falsely.
  const windows = process.platform === 'win32'
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it.skipIf(windows)(`shuts down cleanly when ${signal} arrives as readiness is observed`, async () => {
      const gate = join(tmpdir(), `isla-cli-signal-${process.pid}-${randomUUID()}`)
      try {
        const child = spawnNodeEntry(
          { ISLA_RUNTIME_PORT: '0', [READINESS_GATE_ENV]: gate },
          SIGNAL_HARNESS_ENTRY,
        )
        const pid = child.pid
        if (pid === undefined) throw new Error('child process did not start')
        const exit = collectUntilExit(child)
        await waitForOutput(child, '"event":"listening"')
        // The harness blocks inside the readiness write until this file exists,
        // so the signal lands at that exact point whether or not handlers are
        // installed yet. Order matters: signal first, gate second.
        child.kill(signal)
        writeFileSync(gate, signal)
        const { code, signal: killedBy, output } = await exit
        // Guards the topology: if a launcher ever re-executes the entry, this
        // mismatch fails instead of letting the race pass unnoticed.
        expect(output).toContain(`"event":"harness_pid","pid":${pid}`)
        expect(output).toContain('"event":"listening"')
        expect(killedBy).toBeNull()
        expect(code).toBe(0)
        expect(output).toContain('"event":"shutdown_started"')
        expect(output).toContain(`"signal":"${signal}"`)
        expect(output).toContain('"event":"shutdown_complete"')
      } finally {
        if (existsSync(gate)) unlinkSync(gate)
      }
    })
  }

  it.skipIf(windows)(
    'starts and completes shutdown once for repeated signals held at readiness',
    async () => {
      const gate = join(tmpdir(), `isla-cli-signal-${process.pid}-${randomUUID()}`)
      try {
        const child = spawnNodeEntry(
          { ISLA_RUNTIME_PORT: '0', [READINESS_GATE_ENV]: gate },
          SIGNAL_HARNESS_ENTRY,
        )
        const pid = child.pid
        if (pid === undefined) throw new Error('child process did not start')
        const exit = collectUntilExit(child)
        await waitForOutput(child, '"event":"listening"')
        // The child is blocked inside the readiness write, so SIGINT and
        // SIGTERM stay pending until the gate opens. Both handlers then run and
        // the shuttingDown guard must keep the shutdown single.
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGINT', 'SIGTERM'] as const) {
          child.kill(signal)
        }
        writeFileSync(gate, 'repeated')
        const { code, signal: killedBy, output } = await exit
        expect(output).toContain(`"event":"harness_pid","pid":${pid}`)
        expect(killedBy).toBeNull()
        expect(code).toBe(0)
        expect(countOccurrences(output, '"event":"shutdown_started"')).toBe(1)
        expect(countOccurrences(output, '"event":"shutdown_complete"')).toBe(1)

        // Resource release: the port printed by the real server must be
        // bindable once the process has exited. This proves the socket is gone,
        // not that it closed before exit; shutdown_complete (emitted after
        // `await server.stop()`) is what evidences the graceful close.
        const bound = parseListeningLine(output)
        const rebound = new DiagnosticsServer({
          host: bound.host,
          port: bound.port,
          graceMs: GRACE_MS,
        })
        await rebound.start()
        await rebound.stop()
      } finally {
        if (existsSync(gate)) unlinkSync(gate)
      }
    },
  )
})
