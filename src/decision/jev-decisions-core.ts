import type { CallContext, ClockPort } from '../contracts'
import {
  isAborted,
  isNonBlank,
  isNonNegativeSafeInteger,
  isRecord,
  parseProviderBaseUrl,
  readSignal,
  supportsAbortListener,
  type DecisionCallErrorCode,
  type DecisionFetch,
} from './openai-compatible-core'

/**
 * Shared TypeSafe Jev decisions-call plumbing for the M3 selection and reaction
 * ports.
 *
 * Jev is a classifier/decision model, not an OpenAI chat model: it is called on
 * `POST /v1/decisions` with a typed `questions` array, never on
 * `/v1/chat/completions`. This module is internal to `src/decision`. It owns the
 * validation order, the single-attempt call execution and the response
 * envelope. It never reads the environment, never retries (`C-15`, `NFR-04`) and
 * never substitutes a local fallback (`C-14`).
 */

export const JEV_DECISIONS_ENDPOINT = '/decisions'
export const JEV_DEFAULT_PROVIDER_NAME = 'typesafe'

/**
 * Upper bound on a serialized Jev input state, in characters. A larger input is
 * rejected as `invalid-request` instead of being truncated.
 */
export const MAX_JEV_INPUT_CHARS = 65_536

/**
 * Upper bound on an accepted Jev response body, in characters. A declared
 * `Content-Length` greater than this value is rejected before the body is read;
 * the same bound is enforced after `response.text()` returns and before
 * `JSON.parse`.
 */
export const MAX_JEV_RESPONSE_CHARS = 65_536

/** Node's 32-bit signed `setTimeout` limit; longer delays overflow to 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647

export interface JevChoice {
  readonly value: string
  readonly description: string
}

export interface JevQuestion {
  readonly type: 'choice'
  readonly name: string
  readonly instructions: string
  readonly choices: readonly JevChoice[]
}

export interface JevRequestPayload {
  readonly input: string
  readonly questions: readonly JevQuestion[]
}

/** A caller-supplied answer inspected for a named choice question. */
export interface JevChoiceAnswer {
  readonly choice: string
  /** Raw confidence value; the calling port validates its range. */
  readonly confidence: unknown
}

/**
 * Finds the named choice answer in the response envelope. A missing answer, a
 * non-choice answer or a non-string choice returns `null` so the port fails
 * closed with its own typed proposal error.
 */
export function readJevChoiceAnswer(
  answers: readonly unknown[],
  name: string,
): JevChoiceAnswer | null {
  for (const entry of answers) {
    if (!isRecord(entry)) continue
    if (entry.name !== name) continue
    if (entry.type !== 'choice') return null
    if (typeof entry.choice !== 'string') return null
    return { choice: entry.choice, confidence: entry.confidence }
  }
  return null
}

/** Parses a provider base URL, accepting https or loopback-only plain http. */
function parseJevBaseUrl(baseUrl: unknown): URL | null {
  return parseProviderBaseUrl(baseUrl)
}

/**
 * Joins the configured base URL with `/decisions` regardless of trailing
 * slashes. Accepts either the API root (`.../v1`) or the full endpoint
 * (`.../v1/decisions`) and preserves query parameters.
 */
export function decisionsUrl(baseUrl: URL): string {
  const endpoint = JEV_DECISIONS_ENDPOINT
  const target = new URL(baseUrl.toString())
  const normalizedPath = target.pathname.replace(/\/+$/, '')
  if (normalizedPath.toLowerCase().endsWith(endpoint)) {
    target.pathname = `${normalizedPath.slice(
      0,
      normalizedPath.length - endpoint.length,
    )}${endpoint}`
  } else {
    target.pathname = `${normalizedPath}${endpoint}`
  }
  return target.toString()
}

export interface JevUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly usageMissing: boolean
}

function readJevCount(usage: Record<string, unknown> | undefined, key: string): number | null {
  if (usage === undefined) return null
  const value = usage[key]
  return isNonNegativeSafeInteger(value) ? value : null
}

/**
 * Maps Jev `usage.input_tokens` / `usage.output_tokens`. Either missing or
 * invalid count makes both null and marks usage missing; counts are never
 * derived from `total_tokens` or estimated.
 */
export function readJevUsage(body: Record<string, unknown>): JevUsage {
  const usage = isRecord(body.usage) ? body.usage : undefined
  const inputTokens = readJevCount(usage, 'input_tokens')
  const outputTokens = readJevCount(usage, 'output_tokens')
  if (inputTokens === null || outputTokens === null) {
    return { inputTokens: null, outputTokens: null, usageMissing: true }
  }
  return { inputTokens, outputTokens, usageMissing: false }
}

export interface ExecuteJevDecisionsCallOptions<TParsedRequest> {
  readonly clock: ClockPort
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly providerName?: string
  readonly pricingRef?: string | null
  readonly fetchImpl?: DecisionFetch
  readonly label: 'selection' | 'reaction'
  readonly requestTypeName: 'SelectionRequest' | 'DecisionRequest'
  readonly defaultProviderName: string
  readonly parseRequest: (rawRequest: unknown) => TParsedRequest
  readonly buildPayload: (request: TParsedRequest) => JevRequestPayload
  readonly createError: (code: DecisionCallErrorCode, message: string) => Error
}

export interface JevCallOutcome<TParsedRequest> {
  readonly parsedRequest: TParsedRequest
  readonly answers: readonly unknown[]
  readonly completedAtMs: number
  readonly providerName: string
  readonly requestedModel: string
  readonly servedModel: string
  readonly pricingRef: string | null
  readonly usage: JevUsage
  readonly elapsedMs: number
}

function failureDuringCall(
  signal: AbortSignal,
  timedOut: boolean,
  clock: ClockPort,
  governingAtMs: number,
  label: 'selection' | 'reaction',
  createError: (code: DecisionCallErrorCode, message: string) => Error,
): Error {
  if (isAborted(signal)) {
    return createError('aborted', `${label} aborted during Jev decisions call`)
  }
  if (timedOut) {
    return createError(
      'deadline-exceeded',
      `${label} deadline ${governingAtMs} has expired`,
    )
  }
  const nowMs = clock.nowMs()
  if (Number.isFinite(nowMs) && nowMs >= governingAtMs) {
    return createError(
      'deadline-exceeded',
      `${label} deadline ${governingAtMs} has expired`,
    )
  }
  return createError(
    'transport-failed',
    `Jev ${label} request failed due to transport error`,
  )
}

/**
 * Executes exactly one Jev decisions call. Validation order, error codes and
 * messages are fixed; each adapter supplies only its label, request parser,
 * questions builder and error factory.
 */
export async function executeJevDecisionsCall<TParsedRequest>(
  options: ExecuteJevDecisionsCallOptions<TParsedRequest>,
  rawRequest: unknown,
  context: CallContext,
): Promise<JevCallOutcome<TParsedRequest>> {
  const { clock, label, requestTypeName, createError } = options

  const signal = readSignal(context)
  if (signal === null) {
    throw createError(
      'invalid-request',
      `${label} requires a valid CallContext signal`,
    )
  }

  if (isAborted(signal)) {
    throw createError('aborted', `${label} aborted before Jev decisions call`)
  }
  if (!supportsAbortListener(signal)) {
    throw createError(
      'invalid-request',
      `${label} requires a valid CallContext signal`,
    )
  }

  if (!isNonBlank(options.apiKey)) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a non-blank apiKey`,
    )
  }
  const parsedBaseUrl = parseJevBaseUrl(options.baseUrl)
  if (parsedBaseUrl === null) {
    throw createError(
      'invalid-config',
      `provider ${label} requires an https baseUrl or loopback http`,
    )
  }
  if (!isNonBlank(options.model)) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a non-blank model`,
    )
  }
  const providerName = options.providerName ?? options.defaultProviderName
  if (!isNonBlank(providerName)) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a non-blank providerName`,
    )
  }
  const pricingRef = options.pricingRef ?? null
  if (pricingRef !== null && !isNonBlank(pricingRef)) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a non-blank pricingRef when supplied`,
    )
  }

  if (!isRecord(rawRequest)) {
    throw createError(
      'invalid-request',
      `${label} requires a valid ${requestTypeName}`,
    )
  }

  const startedAtMs = clock.nowMs()
  const requestDeadline = rawRequest.deadline
  const requestAtMs = isRecord(requestDeadline)
    ? requestDeadline.atMs
    : undefined
  const contextAtMs = context.deadline?.atMs
  if (
    typeof startedAtMs !== 'number' ||
    !Number.isFinite(startedAtMs) ||
    startedAtMs < 0 ||
    typeof requestAtMs !== 'number' ||
    !Number.isFinite(requestAtMs) ||
    typeof contextAtMs !== 'number' ||
    !Number.isFinite(contextAtMs)
  ) {
    throw createError(
      'invalid-deadline',
      `${label} requires finite request, call and clock deadlines`,
    )
  }
  const governingAtMs = Math.min(requestAtMs, contextAtMs)
  if (startedAtMs >= governingAtMs) {
    throw createError(
      'deadline-exceeded',
      `${label} deadline ${governingAtMs} has expired`,
    )
  }

  const parsedRequest = options.parseRequest(rawRequest)
  const payload = options.buildPayload(parsedRequest)
  if (payload.input.length > MAX_JEV_INPUT_CHARS) {
    throw createError(
      'invalid-request',
      `Jev ${label} input exceeds maximum size`,
    )
  }

  const callController = new AbortController()
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const armDeadline = (remainingMs: number): void => {
    if (remainingMs > MAX_TIMEOUT_MS) {
      timeoutHandle = setTimeout(() => {
        armDeadline(governingAtMs - clock.nowMs())
      }, MAX_TIMEOUT_MS)
      return
    }
    if (remainingMs <= 0) {
      timedOut = true
      callController.abort()
      return
    }
    timeoutHandle = setTimeout(() => {
      timedOut = true
      callController.abort()
    }, remainingMs)
  }
  const handleAbort = (): void => {
    callController.abort()
  }
  signal.addEventListener('abort', handleAbort, { once: true })
  armDeadline(governingAtMs - startedAtMs)

  try {
    if (isAborted(signal)) {
      throw createError('aborted', `${label} aborted before Jev decisions call`)
    }

    const fetchImpl: DecisionFetch = options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(decisionsUrl(parsedBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: options.model.trim(),
          input: payload.input,
          questions: payload.questions,
        }),
        signal: callController.signal,
      })
    } catch {
      throw failureDuringCall(
        signal,
        timedOut,
        clock,
        governingAtMs,
        label,
        createError,
      )
    }

    const afterFetchAtMs = clock.nowMs()
    if (isAborted(signal)) {
      throw createError('aborted', `${label} aborted during Jev decisions call`)
    }
    if (!Number.isFinite(afterFetchAtMs)) {
      throw createError(
        'invalid-deadline',
        `${label} requires a finite clock deadline`,
      )
    }
    if (timedOut || afterFetchAtMs >= governingAtMs) {
      throw createError(
        'deadline-exceeded',
        `${label} deadline ${governingAtMs} has expired`,
      )
    }
    if (response.status < 200 || response.status > 299) {
      throw createError(
        'http-error',
        `Jev ${label} request failed: HTTP ${response.status}`,
      )
    }

    if (typeof response.headers?.get === 'function') {
      const contentLength = Number(response.headers.get('content-length'))
      if (
        Number.isFinite(contentLength) &&
        Number.isInteger(contentLength) &&
        contentLength > MAX_JEV_RESPONSE_CHARS
      ) {
        throw createError(
          'invalid-json',
          `Jev ${label} response exceeds maximum size`,
        )
      }
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      throw failureDuringCall(
        signal,
        timedOut,
        clock,
        governingAtMs,
        label,
        createError,
      )
    }

    const completedAtMs = clock.nowMs()
    if (isAborted(signal)) {
      throw createError('aborted', `${label} aborted during Jev decisions call`)
    }
    if (!Number.isFinite(completedAtMs)) {
      throw createError(
        'invalid-deadline',
        `${label} requires a finite clock deadline`,
      )
    }
    if (timedOut || completedAtMs >= governingAtMs) {
      throw createError(
        'deadline-exceeded',
        `${label} deadline ${governingAtMs} has expired`,
      )
    }
    if (text.length > MAX_JEV_RESPONSE_CHARS) {
      throw createError(
        'invalid-json',
        `Jev ${label} response exceeds maximum size`,
      )
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw createError(
        'invalid-json',
        `Jev ${label} response is not valid JSON`,
      )
    }
    if (!isRecord(body)) {
      throw createError(
        'invalid-json',
        `Jev ${label} response is not a JSON object`,
      )
    }

    if (!isNonBlank(body.model)) {
      throw createError(
        'invalid-json',
        `Jev ${label} response has no served model string`,
      )
    }
    const servedModel = body.model.trim()

    const answers = body.answers
    if (!Array.isArray(answers)) {
      throw createError(
        'invalid-json',
        `Jev ${label} response has no answers array`,
      )
    }

    const finalAtMs = clock.nowMs()
    if (isAborted(signal)) {
      throw createError('aborted', `${label} aborted during Jev decisions call`)
    }
    if (!Number.isFinite(finalAtMs)) {
      throw createError(
        'invalid-deadline',
        `${label} requires a finite clock deadline`,
      )
    }
    if (timedOut || finalAtMs >= governingAtMs) {
      throw createError(
        'deadline-exceeded',
        `${label} deadline ${governingAtMs} has expired`,
      )
    }

    return {
      parsedRequest,
      answers,
      completedAtMs,
      providerName,
      requestedModel: options.model.trim(),
      servedModel,
      pricingRef,
      usage: readJevUsage(body),
      elapsedMs: Math.max(0, completedAtMs - startedAtMs),
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    signal.removeEventListener('abort', handleAbort)
  }
}
