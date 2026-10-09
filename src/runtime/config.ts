import { isIPv4, isIPv6 } from 'node:net'

export const LOOPBACK_HOST = '127.0.0.1'

export const DEFAULT_PORT = 4317

export const HEALTH_PATH = '/health'

export const DIAGNOSTICS_PATH = '/diag'

export const DEFAULT_MAX_PAYLOAD = 16 * 1024

export const SHUTDOWN_GRACE_MS = 2000

export interface RuntimeOptions {
  host?: string
  port?: number
  maxPayload?: number
  graceMs?: number
}

export interface NormalizedRuntimeConfig {
  host: string
  port: number
  maxPayload: number
  graceMs: number
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

const MAX_INT32 = 2147483647

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(host)) return true
  if (isIPv4(host)) return host.startsWith('127.')
  if (isIPv6(host)) return host === '::1'
  return false
}

export function resolvePort(envValue: string | undefined, fallback = DEFAULT_PORT): number {
  if (envValue === undefined) return fallback
  const trimmed = envValue.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new RangeError(`invalid port "${envValue}": expected a decimal integer`)
  }
  const parsed = Number(trimmed)
  if (parsed > 65535) {
    throw new RangeError(`invalid port "${envValue}": expected a value between 0 and 65535`)
  }
  return parsed
}

function assertIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, got ${value}`)
  }
}

export function normalizeRuntimeConfig(options: RuntimeOptions = {}): NormalizedRuntimeConfig {
  const host = options.host ?? LOOPBACK_HOST
  if (!isLoopbackHost(host)) {
    throw new RangeError(`host "${host}" is not a loopback address; this boundary is loopback-only`)
  }

  const port = options.port ?? DEFAULT_PORT
  assertIntegerInRange('port', port, 0, 65535)

  const maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD
  assertIntegerInRange('maxPayload', maxPayload, 1, MAX_INT32)

  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS
  assertIntegerInRange('graceMs', graceMs, 1, MAX_INT32)

  return { host, port, maxPayload, graceMs }
}
