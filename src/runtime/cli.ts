import {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  normalizeRuntimeConfig,
  resolvePort,
} from './config'
import { DiagnosticsServer } from './server'

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

async function main(): Promise<void> {
  let server: DiagnosticsServer
  try {
    const config = normalizeRuntimeConfig({
      host: process.env.ISLA_RUNTIME_HOST ?? LOOPBACK_HOST,
      port: resolvePort(process.env.ISLA_RUNTIME_PORT, DEFAULT_PORT),
    })
    server = new DiagnosticsServer(config)
  } catch (error) {
    logError('configuration_invalid', error)
    process.exitCode = 1
    return
  }

  let bound: { host: string; port: number }
  try {
    bound = await server.start()
  } catch (error) {
    logError('listen_failed', error)
    process.exitCode = 1
    return
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutdown_started', { signal })
    try {
      await server.stop()
      log('shutdown_complete', { signal })
    } catch (error) {
      logError('shutdown_failed', error)
      process.exitCode = 1
    }
  }

  // Installed before readiness becomes observable. A supervisor may treat the
  // listening line as permission to signal; a signal delivered while no
  // listener exists takes the default action and terminates the process with
  // exit 130/143 instead of running the graceful shutdown above.
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  log('listening', { host: bound.host, port: bound.port })
}

void main()
