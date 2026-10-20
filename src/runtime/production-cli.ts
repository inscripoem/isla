import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveStorageConfig } from '../storage/config'
import { createMonotonicClock } from './clock'
import { DEFAULT_PORT, LOOPBACK_HOST, normalizeRuntimeConfig, resolvePort } from './config'
import { createProductionApplication } from './production'
import type { ProductionApplication, ProductionDeployment, ProductionDeploymentFactory } from './production'

/**
 * Runnable production entry.
 *
 * The deployment is an explicit module loaded from `ISLA_DEPLOYMENT_MODULE`:
 * this process never guesses peers, never fabricates a provider and never
 * imports test code. Storage (`ISLA_STORAGE_DB_PATH`) and server
 * (`ISLA_RUNTIME_HOST`, `ISLA_RUNTIME_PORT`) configuration come from the
 * environment, are validated fail-fast, and are reported as structured JSON.
 * SIGINT/SIGTERM perform the controlled shutdown: stop the transport, settle
 * queued writes, close the SQLite handle and await the deployment's owned
 * release (for example the retained physical provider's actual worker exit), so
 * `shutdown_complete` is only reported after the owned lifecycle contract has
 * completed. A failed application creation likewise awaits that release before
 * the failure is reported, and a failed start still performs the controlled
 * shutdown: a shutdown fault is reported as `shutdown_failed`, never swallowed
 * and never reported as complete.
 */

export const DEPLOYMENT_MODULE_ENV = 'ISLA_DEPLOYMENT_MODULE'

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', service: 'isla-runtime', event, ...details })}\n`,
  )
}

function logError(event: string, error: unknown): void {
  process.stdout.write(
    `${JSON.stringify({
      level: 'error',
      service: 'isla-runtime',
      event,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
}

/**
 * Loads the deployment factory from an explicit path. The module must export a
 * function named `createProductionDeployment` or as its default export. A
 * missing, unreadable or malformed module is an explicit failure, never a
 * silent fallback to fixtures.
 */
async function loadDeploymentFactory(modulePath: string): Promise<ProductionDeploymentFactory> {
  const target = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath)
  const loaded = (await import(pathToFileURL(target).href)) as {
    default?: unknown
    createProductionDeployment?: unknown
  }
  const factory = loaded.createProductionDeployment ?? loaded.default
  if (typeof factory !== 'function') {
    throw new TypeError(
      'the deployment module must export a factory function named `createProductionDeployment` or as its default export',
    )
  }
  return factory as ProductionDeploymentFactory
}

async function main(): Promise<void> {
  const modulePath = process.env[DEPLOYMENT_MODULE_ENV]
  if (modulePath === undefined || modulePath.trim().length === 0) {
    logError(
      'deployment_module_missing',
      new Error(`${DEPLOYMENT_MODULE_ENV} is not set; the production entry requires an explicit deployment module`),
    )
    process.exitCode = 1
    return
  }

  let factory: ProductionDeploymentFactory
  try {
    factory = await loadDeploymentFactory(modulePath.trim())
  } catch (error) {
    logError('deployment_module_invalid', error)
    process.exitCode = 1
    return
  }

  let storage
  let runtimeConfig
  try {
    storage = resolveStorageConfig()
    runtimeConfig = normalizeRuntimeConfig({
      host: process.env.ISLA_RUNTIME_HOST ?? LOOPBACK_HOST,
      port: resolvePort(process.env.ISLA_RUNTIME_PORT, DEFAULT_PORT),
    })
  } catch (error) {
    logError('configuration_invalid', error)
    process.exitCode = 1
    return
  }

  const clock = createMonotonicClock()
  let deployment: ProductionDeployment
  try {
    deployment = await factory({ clock, databasePath: storage.dbPath, env: process.env })
    if (deployment === null || typeof deployment !== 'object') {
      throw new TypeError(
        'the deployment factory must return an object with peers, initialSelection and allowedOrigins',
      )
    }
    if (deployment.release !== undefined && typeof deployment.release !== 'function') {
      throw new TypeError('the deployment release must be a function when supplied')
    }
  } catch (error) {
    logError('deployment_invalid', error)
    process.exitCode = 1
    return
  }

  let application: ProductionApplication
  try {
    application = await createProductionApplication({
      storage,
      initialSelection: deployment.initialSelection,
      peers: deployment.peers,
      allowedOrigins: deployment.allowedOrigins,
      ...(deployment.allowedHosts !== undefined ? { allowedHosts: deployment.allowedHosts } : {}),
      ...(deployment.release !== undefined ? { ownedRelease: deployment.release } : {}),
      host: runtimeConfig.host,
      port: runtimeConfig.port,
      graceMs: runtimeConfig.graceMs,
      clock,
    })
  } catch (error) {
    logError('startup_failed', error)
    process.exitCode = 1
    return
  }

  // Orderly shutdown handling is installed before the server is started, so a
  // signal delivered immediately after `listening` is published is handled
  // rather than terminating the process with the default action. A signal that
  // arrives during startup is serialized behind `start()` by the application's
  // own lifecycle.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutdown_started', { signal })
    try {
      await application.stop()
      log('shutdown_complete', { signal })
    } catch (error) {
      logError('shutdown_failed', error)
      process.exitCode = 1
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // `start()` is invoked synchronously after the handlers are installed, so a
  // signal can only be observed through the application's serialized lifecycle,
  // and readiness is published only for a server that is still starting.
  const starting = application.start()
  try {
    const bound = await starting
    if (shuttingDown) return
    log('listening', {
      host: bound.host,
      port: bound.port,
      databasePath: storage.dbPath,
      sessionId: application.currentSessionId(),
    })
  } catch (error) {
    logError('listen_failed', error)
    try {
      await application.stop()
    } catch (stopError) {
      // The failed start still performs the controlled shutdown; a shutdown
      // fault (for example an incomplete physical release) is reported rather
      // than swallowed.
      logError('shutdown_failed', stopError)
    }
    process.exitCode = 1
    return
  }
}

void main()
