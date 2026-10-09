import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticsServer } from '../../src/runtime/server'

type CliProcess = ChildProcessByStdio<null, Readable, Readable>

const TSX_BIN = 'node_modules/.bin/tsx'
const CLI_ENTRY = 'src/runtime/cli.ts'
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

function collectUntilExit(child: CliProcess): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      resolve({ code: code ?? -1, output })
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
