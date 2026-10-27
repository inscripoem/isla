import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RELEASE_FAIL_ENV,
  RELEASE_HOLD_ENV,
  RELEASE_MARKER_ENV,
  seedProductionEvidence,
} from '../support/production-kit'
import {
  CLI_IPC_SHUTDOWN_MESSAGE,
  DEPLOYMENT_MODULE,
  collectOutput,
  collectUntilExit,
  createCliHarness,
  getHealth,
  seedDatabase,
  waitForListening,
} from '../support/production-cli-kit'
import type { CliProcess } from '../support/production-cli-kit'

/**
 * Production entry smoke tests.
 *
 * The CLI is spawned as a real child process with an explicit deployment module
 * loaded by path. Storage is a real temporary SQLite database; the peers come
 * from the test deployment module, which is loaded through the same
 * `ISLA_DEPLOYMENT_MODULE` seam a deployment would use. No test code is imported
 * by the production entry itself. The two-process continuation acceptance lives
 * in `m5-process-restart.test.ts` and shares this harness.
 */

const INVALID_DEPLOYMENT_MODULE = resolve(
  process.cwd(),
  'test/support/production-deployment-invalid.ts',
)
const CLI_LIVE = 'session-cli-live'
const CLI_ARCHIVE = 'session-cli-archive'

const harness = createCliHarness()

/** Counts deployment-owned release calls recorded in the marker file. */
function releaseCalls(markerPath: string): number {
  if (!existsSync(markerPath)) return 0
  return readFileSync(markerPath, 'utf8')
    .split('\n')
    .filter((line) => line === 'release').length
}

/** Counts occurrences of one lifecycle event in collected JSON-line output. */
function countEvents(output: string, event: string): number {
  return output.split(`"event":"${event}"`).length - 1
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await harness.cleanup()
})

describe('production CLI', () => {
  it('fails visibly when no deployment module is configured', async () => {
    const child = harness.start({ ISLA_DEPLOYMENT_MODULE: '', ISLA_RUNTIME_PORT: '0' })
    const { code, output } = await collectUntilExit(child)
    expect(code).toBe(1)
    expect(output).toContain('"event":"deployment_module_missing"')
  })

  it('fails visibly when the deployment module cannot be loaded', async () => {
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: resolve(process.cwd(), 'test/support/does-not-exist.ts'),
      ISLA_RUNTIME_PORT: '0',
    })
    const { code, output } = await collectUntilExit(child)
    expect(code).toBe(1)
    expect(output).toContain('"event":"deployment_module_invalid"')
  })

  it('fails visibly when the deployment module exports no factory', async () => {
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: INVALID_DEPLOYMENT_MODULE,
      ISLA_RUNTIME_PORT: '0',
    })
    const { code, output } = await collectUntilExit(child)
    expect(code).toBe(1)
    expect(output).toContain('"event":"deployment_module_invalid"')
  })

  it('fails startup over a seeded live id and exits naturally with an IPC channel attached', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_LIVE))
    const child = harness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
      },
      { ipc: true },
    )
    const { code, signal, output } = await collectUntilExit(child)
    expect(code).toBe(1)
    expect(signal).toBeNull()
    expect(output).toContain('"event":"startup_failed"')
    expect(output).toContain('already has stored evidence')
    // The failure precedes the control listener: the channel is unreferenced,
    // so the process exits on its own with the raw code preserved.
  })

  it('starts over a durable database, serves health, and shuts down on SIGTERM', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
      ISLA_STORAGE_DB_PATH: dbPath,
      ISLA_RUNTIME_PORT: '0',
      ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
      ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
    })

    const listening = await waitForListening(child)
    expect(listening.sessionId).toBe(CLI_LIVE)
    const health = await getHealth(listening.port)
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ ok: true, loopbackOnly: true })

    const exit = collectUntilExit(child)
    child.kill('SIGTERM')
    const { code, signal, output } = await exit
    // Raw reporting: a cooperative SIGTERM exit has code 0 and no signal, and
    // the lifecycle record names the real signal as the trigger.
    expect(code).toBe(0)
    expect(signal).toBeNull()
    expect(output).toContain('"trigger":"signal"')
    expect(output).toContain('"signal":"SIGTERM"')
    expect(output).toContain('"event":"shutdown_complete"')
  })

  it('shuts down cooperatively through the IPC control message', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const child = harness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
        ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
      },
      { ipc: true },
    )

    const listening = await waitForListening(child)
    expect(listening.sessionId).toBe(CLI_LIVE)
    const exit = collectUntilExit(child)
    // The portable trigger does not depend on a POSIX signal; the record names
    // `ipc` as the trigger, never a signal that was not received.
    expect(child.send({ type: CLI_IPC_SHUTDOWN_MESSAGE })).toBe(true)
    const { code, signal, output } = await exit
    expect(code).toBe(0)
    expect(signal).toBeNull()
    expect(output).toContain('"event":"shutdown_started"')
    expect(output).toContain('"trigger":"ipc"')
    expect(output).not.toContain('"signal":"ipc"')
    expect(output).toContain('"event":"shutdown_complete"')
    // Terminal diagnostics: the last line written before the natural exit is
    // the completion record (the child released its control channel itself).
    expect(output.trim().split('\n').at(-1)).toContain('"event":"shutdown_complete"')
  })

  it('awaits a genuinely pending owned release before reporting IPC shutdown completion', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const hold = join(harness.tempDir(), 'release.hold')
    const child = harness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
        ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
        [RELEASE_MARKER_ENV]: marker,
        [RELEASE_HOLD_ENV]: hold,
      },
      { ipc: true },
    )

    await waitForListening(child)
    const live = collectOutput(child)
    const exit = collectUntilExit(child)
    expect(child.send({ type: CLI_IPC_SHUTDOWN_MESSAGE })).toBe(true)

    // The release has started but is held by the test: the process must stay
    // alive with its control channel open and must not report completion.
    await until(() => releaseCalls(marker) === 1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(child.exitCode, live.text()).toBeNull()
    expect(child.signalCode, live.text()).toBeNull()
    expect(child.connected).toBe(true)
    expect(live.text()).toContain('"event":"shutdown_started"')
    expect(live.text()).toContain('"trigger":"ipc"')
    expect(live.text()).not.toContain('"event":"shutdown_complete"')

    // Unblocking the release lets the shutdown settle; the child then releases
    // its own control channel and exits naturally.
    writeFileSync(hold, 'go\n')
    const { code, signal, output } = await exit
    expect(code).toBe(0)
    expect(signal).toBeNull()
    expect(output).toContain('"event":"shutdown_complete"')
    expect(releaseCalls(marker)).toBe(1)
  })

  it('reports an incomplete shutdown and still exits naturally when the owned release fails over IPC', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const child = harness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
        ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
        [RELEASE_MARKER_ENV]: marker,
        [RELEASE_FAIL_ENV]: '1',
      },
      { ipc: true },
    )

    await waitForListening(child)
    const exit = collectUntilExit(child)
    expect(child.send({ type: CLI_IPC_SHUTDOWN_MESSAGE })).toBe(true)
    const { code, signal, output } = await exit
    // The failed shutdown still releases the control channel in its finally
    // path, so the process exits by itself with the failure code.
    expect(code).toBe(1)
    expect(signal).toBeNull()
    expect(output).toContain('"event":"shutdown_failed"')
    expect(output).toContain('owned release failed')
    expect(output).not.toContain('"event":"shutdown_complete"')
    expect(releaseCalls(marker)).toBe(1)
  })

  it('ignores unrelated and duplicate IPC control messages', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const hold = join(harness.tempDir(), 'release.hold')
    const child = harness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: dbPath,
        ISLA_RUNTIME_PORT: '0',
        ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
        ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
        [RELEASE_MARKER_ENV]: marker,
        [RELEASE_HOLD_ENV]: hold,
      },
      { ipc: true },
    )

    await waitForListening(child)
    const live = collectOutput(child)
    // Unrelated messages trigger nothing: the runtime keeps running.
    expect(child.send({ type: 'isla.runtime.unrelated' })).toBe(true)
    expect(child.send('not-a-control-message')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(child.exitCode, live.text()).toBeNull()
    expect(live.text()).not.toContain('"event":"shutdown_started"')

    const exit = collectUntilExit(child)
    // The first shutdown request starts the controlled shutdown; the duplicate
    // arrives while the held release keeps it in flight and is ignored.
    expect(child.send({ type: CLI_IPC_SHUTDOWN_MESSAGE })).toBe(true)
    await until(() => releaseCalls(marker) === 1)
    expect(child.send({ type: CLI_IPC_SHUTDOWN_MESSAGE })).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(countEvents(live.text(), 'shutdown_started')).toBe(1)
    expect(live.text()).not.toContain('"event":"shutdown_complete"')

    writeFileSync(hold, 'go\n')
    const { code, signal, output } = await exit
    expect(code).toBe(0)
    expect(signal).toBeNull()
    expect(countEvents(output, 'shutdown_started')).toBe(1)
    expect(countEvents(output, 'shutdown_complete')).toBe(1)
    expect(releaseCalls(marker)).toBe(1)
  })

  it('awaits the owned release once when startup fails over a seeded live id', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_LIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
      ISLA_STORAGE_DB_PATH: dbPath,
      ISLA_RUNTIME_PORT: '0',
      ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
      [RELEASE_MARKER_ENV]: marker,
    })
    const { code, output } = await collectUntilExit(child)
    expect(code).toBe(1)
    expect(output).toContain('"event":"startup_failed"')
    expect(output).toContain('already has stored evidence')
    // The failed creation awaited the deployment-owned release before reporting.
    expect(releaseCalls(marker)).toBe(1)
  })

  it('awaits the owned release once on SIGTERM shutdown', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
      ISLA_STORAGE_DB_PATH: dbPath,
      ISLA_RUNTIME_PORT: '0',
      ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
      ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
      [RELEASE_MARKER_ENV]: marker,
    })

    await waitForListening(child)
    const exit = collectUntilExit(child)
    child.kill('SIGTERM')
    const { code, output } = await exit
    expect(code).toBe(0)
    expect(output).toContain('"event":"shutdown_complete"')
    // `shutdown_complete` is reported only after the owned release completed.
    expect(releaseCalls(marker)).toBe(1)
  })

  it('awaits a genuinely pending owned release before reporting shutdown completion', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const hold = join(harness.tempDir(), 'release.hold')
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
      ISLA_STORAGE_DB_PATH: dbPath,
      ISLA_RUNTIME_PORT: '0',
      ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
      ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
      [RELEASE_MARKER_ENV]: marker,
      [RELEASE_HOLD_ENV]: hold,
    })

    await waitForListening(child)
    const live = collectOutput(child)
    const exit = collectUntilExit(child)
    child.kill('SIGTERM')

    // The release has started (recorded in the marker) but is held by the test:
    // the process must stay alive and must not report shutdown completion.
    await until(() => releaseCalls(marker) === 1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(child.exitCode, live.text()).toBeNull()
    expect(child.signalCode, live.text()).toBeNull()
    expect(live.text()).toContain('"event":"shutdown_started"')
    expect(live.text()).not.toContain('"event":"shutdown_complete"')

    // Explicitly unblocking the release lets the shutdown complete and the real
    // process exit.
    writeFileSync(hold, 'go\n')
    const { code, output } = await exit
    expect(code).toBe(0)
    expect(output).toContain('"event":"shutdown_complete"')
    expect(releaseCalls(marker)).toBe(1)
  })

  it('reports an incomplete shutdown when the owned release fails', async () => {
    const dbPath = harness.tempDatabasePath()
    await seedDatabase(dbPath, (store) => seedProductionEvidence(store, CLI_ARCHIVE))
    const marker = join(harness.tempDir(), 'release.log')
    const child = harness.start({
      ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
      ISLA_STORAGE_DB_PATH: dbPath,
      ISLA_RUNTIME_PORT: '0',
      ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
      ISLA_TEST_ARCHIVE_SESSIONS: CLI_ARCHIVE,
      [RELEASE_MARKER_ENV]: marker,
      [RELEASE_FAIL_ENV]: '1',
    })

    await waitForListening(child)
    const exit = collectUntilExit(child)
    child.kill('SIGTERM')
    const { code, output } = await exit
    expect(code).toBe(1)
    expect(output).toContain('"event":"shutdown_failed"')
    expect(output).toContain('owned release failed')
    expect(output).not.toContain('"event":"shutdown_complete"')
    expect(releaseCalls(marker)).toBe(1)
  })

  it('reports a shutdown fault after a listen failure instead of swallowing it', async () => {
    const first = harness.start({
      ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
      ISLA_STORAGE_DB_PATH: harness.tempDatabasePath(),
      ISLA_RUNTIME_PORT: '0',
      ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
    })
    const listening = await waitForListening(first)

    const marker = join(harness.tempDir(), 'release.log')
    const second = harness.start(
      {
        ISLA_DEPLOYMENT_MODULE: DEPLOYMENT_MODULE,
        ISLA_STORAGE_DB_PATH: harness.tempDatabasePath(),
        ISLA_RUNTIME_PORT: String(listening.port),
        ISLA_TEST_LIVE_SESSION_ID: CLI_LIVE,
        [RELEASE_MARKER_ENV]: marker,
        [RELEASE_FAIL_ENV]: '1',
      },
      { ipc: true },
    )
    const { code, signal, output } = await collectUntilExit(second)
    expect(code).toBe(1)
    expect(signal).toBeNull()
    expect(output).toContain('"event":"listen_failed"')
    // The failed start still performed the controlled shutdown, and its fault
    // was reported rather than swallowed.
    expect(output).toContain('"event":"shutdown_failed"')
    expect(output).toContain('owned release failed')
    // The control listener was installed before `start()`, so the failed-start
    // path must release the channel explicitly to exit naturally.
    expect(releaseCalls(marker)).toBe(1)
  })
})

describe('collectUntilExit output drain', () => {
  it('retains output that arrives after the exit event until both streams end', async () => {
    // `exit` can be observed before the final stdout/stderr bytes are read, so
    // the collector must resolve only after both pipes end. A synthetic child
    // pins that contract deterministically, and the raw code/signal are
    // preserved exactly as the exit event reported them.
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as unknown as CliProcess
    Object.assign(child, { stdout, stderr })
    const exit = collectUntilExit(child)
    child.emit('exit', 3, null)
    stdout.write('late-stdout\n')
    stderr.write('late-stderr\n')
    stdout.end()
    stderr.end()
    await expect(exit).resolves.toEqual({
      code: 3,
      signal: null,
      output: 'late-stdout\nlate-stderr\n',
    })
  })
})
