import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { EventStorePort } from '../../src/contracts'
import { resolveStorageConfig } from '../../src/storage/config'
import { createEventStore } from '../../src/storage/event-store'
import { createSqliteBackend, migrate, openDatabase } from '../../src/storage/sqlite'
import { TEST_DEPLOYMENT_ORIGIN } from './production-kit'

/**
 * Real child-process harness for the production CLI.
 *
 * The CLI is launched directly through the tsx loader
 * (`node --import tsx src/runtime/production-cli.ts`), so the spawned PID *is*
 * the production runtime. The `tsx` bin wrapper re-executes the entry in a
 * child process; killing the wrapper then leaves the actual runtime — and its
 * SQLite handle and listening port — orphaned, which is why this harness never
 * uses it. Storage is a real temporary SQLite database, and the deployment
 * module is loaded by path through the same `ISLA_DEPLOYMENT_MODULE` seam a
 * deployment would use.
 *
 * Cleanup is deterministic on failure paths too: tracked disposers (performer
 * clients) close first, then every spawned CLI receives SIGTERM with a bounded
 * wait, SIGKILL as the fallback with another bounded wait, and the temporary
 * directories are removed only after every tracked process has exited. If exit
 * cannot be confirmed even after SIGKILL, the directories are preserved, the
 * failure is reported, and the survivors stay tracked for a later retry. Only
 * PIDs spawned by this harness are signalled. Test-only: the production entry
 * never imports this module, and the operator bootstrap token is returned to
 * the caller without ever being logged.
 */

export type CliProcess = ChildProcessByStdio<null, Readable, Readable>

export const CLI_ENTRY = 'src/runtime/production-cli.ts'
export const DEPLOYMENT_MODULE = resolve(process.cwd(), 'test/support/production-deployment.ts')

const DISPOSE_GRACE_MS = 5000
const SHUTDOWN_GRACE_MS = 5000

export interface CliHarness {
  /** Spawns the production CLI with the given environment additions. */
  start(env: Record<string, string>): CliProcess
  /** A fresh temporary directory, removed by `cleanup()`. */
  tempDir(): string
  /** A fresh temporary SQLite path, removed by `cleanup()`. */
  tempDatabasePath(): string
  /** Registers a disposer (for example closing a performer client). */
  track(dispose: () => Promise<void> | void): void
  /**
   * Awaits tracked disposers, terminates every spawned CLI process and waits
   * for it to exit, then removes the temporary directories. If exit cannot be
   * confirmed even after SIGKILL, the temporary directories are preserved, the
   * failure is reported, and the surviving processes stay tracked so a later
   * cleanup attempt can retry them. Safe to call more than once.
   */
  cleanup(): Promise<void>
}

function waitForExit(child: CliProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    void operation
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer)
        resolve()
      })
  })
}

export function createCliHarness(prefix = 'isla-production-cli-'): CliHarness {
  const children: CliProcess[] = []
  const dirs: string[] = []
  const disposers: Array<() => Promise<void> | void> = []

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  return {
    start(env) {
      const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    },
    tempDir,
    tempDatabasePath() {
      return resolveStorageConfig({ ISLA_STORAGE_DB_PATH: join(tempDir(), 'isla.db') }, process.cwd())
        .dbPath
    },
    track(dispose) {
      disposers.push(dispose)
    },
    async cleanup() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await settleWithin(Promise.resolve(dispose()), DISPOSE_GRACE_MS)
        } catch {
          // A failing disposer must not block process termination.
        }
      }
      const live = children.filter(
        (child) => child.exitCode === null && child.signalCode === null,
      )
      for (const child of live) child.kill('SIGTERM')
      const graceful = await Promise.all(live.map((child) => waitForExit(child, SHUTDOWN_GRACE_MS)))
      const stubborn = live.filter((_, index) => graceful[index] !== true)
      for (const child of stubborn) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      const killed = await Promise.all(
        stubborn.map((child) => waitForExit(child, SHUTDOWN_GRACE_MS)),
      )
      const survivors = stubborn.filter((_, index) => killed[index] !== true)
      // A later cleanup attempt retries survivors; their temporary directories
      // stay in place so the runtime database is preserved.
      children.splice(0, children.length, ...survivors)
      if (survivors.length > 0) {
        throw new Error(
          `cleanup could not confirm exit for CLI process(es) ${survivors
            .map((child) => String(child.pid ?? 'unknown'))
            .join(', ')}; temporary directories were preserved for a later cleanup attempt`,
        )
      }
      while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
    },
  }
}

/** Collects stdout and stderr until the child exits. */
export function collectUntilExit(child: CliProcess): Promise<{ code: number; output: string }> {
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

/** Live stdout/stderr of a running child, for assertions before exit. */
export interface CliOutput {
  text(): string
}

export function collectOutput(child: CliProcess): CliOutput {
  let output = ''
  const onData = (chunk: Buffer): void => {
    output += chunk.toString('utf8')
  }
  const detach = (): void => {
    child.stdout.off('data', onData)
    child.stderr.off('data', onData)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.once('exit', detach)
  return { text: () => output }
}

/** Waits for the structured `listening` record and reads the bound port. */
export function waitForListening(child: CliProcess): Promise<{ port: number; sessionId: string }> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n')) {
        if (!line.includes('"event":"listening"')) continue
        try {
          const parsed = JSON.parse(line) as { port?: unknown; sessionId?: unknown }
          if (typeof parsed.port === 'number' && typeof parsed.sessionId === 'string') {
            child.stdout.off('data', onData)
            child.off('exit', onExit)
            resolve({ port: parsed.port, sessionId: parsed.sessionId })
            return
          }
        } catch {
          // The line is incomplete; keep buffering.
        }
      }
    }
    const onExit = (code: number | null): void => {
      child.stdout.off('data', onData)
      reject(new Error(`CLI exited with code ${code} before "listening": ${buffer}`))
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

export function getHealth(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: { origin: TEST_DEPLOYMENT_ORIGIN, host: `127.0.0.1:${port}` },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as unknown })
          } catch {
            resolve({ status: res.statusCode ?? 0, body })
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/**
 * Requests a one-time operator bootstrap token. The token is returned to the
 * caller; it is never logged, and a refusal reports only the HTTP status.
 */
export function bootstrapOperatorToken(
  port: number,
  origin: string = TEST_DEPLOYMENT_ORIGIN,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/operator/bootstrap',
        method: 'POST',
        headers: {
          origin,
          host: `127.0.0.1:${port}`,
          'x-isla-operator-bootstrap': '1',
          'content-length': '0',
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { ok?: boolean; token?: string }
            if (res.statusCode === 200 && parsed.ok === true && typeof parsed.token === 'string') {
              resolve(parsed.token)
            } else {
              reject(new Error(`operator bootstrap refused with status ${res.statusCode ?? 0}`))
            }
          } catch {
            reject(new Error(`operator bootstrap refused with status ${res.statusCode ?? 0}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Opens, migrates and seeds a database, then closes it (a prior process). */
export async function seedDatabase(
  dbPath: string,
  seed: (store: EventStorePort) => Promise<void>,
): Promise<void> {
  const storage = resolveStorageConfig({ ISLA_STORAGE_DB_PATH: dbPath }, process.cwd())
  const database = openDatabase(storage.dbPath)
  migrate(database, { dbPath: storage.dbPath, backupDir: storage.backupDir })
  try {
    await seed(createEventStore(createSqliteBackend(database)))
  } finally {
    database.close()
  }
}
