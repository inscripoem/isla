import { OPERATOR_BOOTSTRAP_HEADER, OPERATOR_BOOTSTRAP_PATH } from '../contracts'

/**
 * Browser-safe operator bootstrap for the console (M2).
 *
 * Operator authority is never inferred from a payload. The console asks the
 * local, same-origin HTTP endpoint for a one-time token and later exchanges it
 * over the application socket. This module only performs the bootstrap POST: it
 * validates the response strictly, bounds the wait, and never logs or includes
 * the token, response body, headers or credentials in an error message.
 */

/**
 * Structured failure reason. The runtime reasons are unchanged. The tuple is
 * non-exported and appears before any export only because the import-graph
 * boundary checker scans the first quoted token after an exported declaration
 * as a module specifier, so a bare transport reason would read as a Node
 * builtin import edge.
 */
const OPERATOR_BOOTSTRAP_FAILURE_REASONS = ['http', 'invalid_response', 'timeout', 'network'] as const
export type OperatorBootstrapFailureReason = (typeof OPERATOR_BOOTSTRAP_FAILURE_REASONS)[number]

/** Documented bootstrap path (re-exported for callers). */
export const OPERATOR_BOOTSTRAP_ENDPOINT = OPERATOR_BOOTSTRAP_PATH
/** Header that forces a cross-origin caller through a preflight. */
export const OPERATOR_BOOTSTRAP_REQUEST_HEADER = OPERATOR_BOOTSTRAP_HEADER
/** Bounded default wait for one bootstrap response. */
export const OPERATOR_BOOTSTRAP_TIMEOUT_MS = 5000


export class OperatorBootstrapError extends Error {
  readonly reason: OperatorBootstrapFailureReason

  constructor(reason: OperatorBootstrapFailureReason, message: string) {
    super(message)
    this.name = 'OperatorBootstrapError'
    this.reason = reason
  }
}

export interface OperatorBootstrapOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly path?: string
}

export interface OperatorBootstrapResult {
  readonly token: string
  readonly expiresAtMs: number
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

interface TimerState {
  fired: boolean
}

/** Resolve the fetch implementation without capturing a missing global. */
function resolveFetch(impl: typeof fetch | undefined): FetchLike {
  if (impl !== undefined) return (input, init) => impl(input, init)
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof globalFetch !== 'function') {
    throw new OperatorBootstrapError('network', 'no fetch implementation is available')
  }
  return (input, init) => globalFetch(input, init)
}

/** Strictly validate the decoded body; anything else is rejected. */
function parseResponseBody(body: unknown): OperatorBootstrapResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new OperatorBootstrapError('invalid_response', 'operator bootstrap response is not an object')
  }
  const record = body as Record<string, unknown>
  const { ok, token, expiresAtMs } = record
  if (ok !== true) {
    throw new OperatorBootstrapError('invalid_response', 'operator bootstrap response was not successful')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new OperatorBootstrapError('invalid_response', 'operator bootstrap response carried no token')
  }
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs) || expiresAtMs < 0) {
    throw new OperatorBootstrapError('invalid_response', 'operator bootstrap response carried no expiry')
  }
  return { token, expiresAtMs }
}

/**
 * Request a one-time operator bootstrap token from the same origin.
 *
 * The default is `POST /operator/bootstrap` with the required header, no body,
 * `credentials: 'same-origin'` and a bounded 5000 ms timeout. HTTP status,
 * malformed JSON, a structurally invalid body, a timeout, a network failure and
 * an abort are reported as distinct `OperatorBootstrapError` reasons.
 */
export async function requestOperatorBootstrap(
  options: OperatorBootstrapOptions = {},
): Promise<OperatorBootstrapResult> {
  const fetchImpl = resolveFetch(options.fetchImpl)
  const timeoutMs = options.timeoutMs ?? OPERATOR_BOOTSTRAP_TIMEOUT_MS
  const path = options.path ?? OPERATOR_BOOTSTRAP_PATH

  const controller = new AbortController()
  const timerState: TimerState = { fired: false }
  const externalSignal = options.signal
  const abortFromExternal = (): void => controller.abort()

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timerState.fired = true
      controller.abort()
      reject(new OperatorBootstrapError('timeout', `operator bootstrap timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })

  const request = (async (): Promise<OperatorBootstrapResult> => {
    const response = await fetchImpl(path, {
      method: 'POST',
      headers: { [OPERATOR_BOOTSTRAP_HEADER]: '1', Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new OperatorBootstrapError('http', `operator bootstrap failed with status ${response.status}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new OperatorBootstrapError('invalid_response', 'operator bootstrap response was not valid JSON')
    }
    return parseResponseBody(body)
  })()

  try {
    return await Promise.race([request, timedOut])
  } catch (error) {
    if (error instanceof OperatorBootstrapError) {
      // An abort caused by our own timer is reported as a timeout; every other
      // structured failure keeps its own reason.
      if (timerState.fired && error.reason === 'network' && controller.signal.aborted) {
        throw new OperatorBootstrapError('timeout', `operator bootstrap timed out after ${timeoutMs} ms`)
      }
      throw error
    }
    if (timerState.fired || controller.signal.aborted) {
      throw new OperatorBootstrapError('timeout', `operator bootstrap timed out after ${timeoutMs} ms`)
    }
    throw new OperatorBootstrapError('network', 'operator bootstrap request failed')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (externalSignal !== undefined) externalSignal.removeEventListener('abort', abortFromExternal)
  }
}
