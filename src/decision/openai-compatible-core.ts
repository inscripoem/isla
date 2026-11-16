import type { CallContext, ClockPort } from '../contracts'

/**
 * Shared OpenAI-compatible chat-completions plumbing for the M3 provider-backed
 * selection and reaction ports.
 *
 * This module is internal to `src/decision`: it owns the validation order, the
 * single-attempt call execution and the duplicated helpers that both provider
 * adapters use. It never reads the environment, never retries (`C-15`,
 * `NFR-04`) and never substitutes a local fallback (`C-14`).
 */

export const DECISION_PROMPT_VERSION = 'm3-decision-prompt-v1'
export const DEFAULT_DECISION_MAX_TOKENS = 256

/**
 * Upper bound on an accepted model response body, in characters.
 *
 * A declared `Content-Length` greater than this value is rejected before the
 * body is read. When `Content-Length` is absent the same bound is enforced
 * after `response.text()` returns and before `JSON.parse`, which bounds parsing
 * work but not arbitrary streaming memory when the length is omitted.
 */
export const MAX_DECISION_RESPONSE_CHARS = 65_536

/** Node's 32-bit signed `setTimeout` limit; longer delays overflow to 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647

export type DecisionFetch = (url: string, init: RequestInit) => Promise<Response>

/** Error codes shared by every provider call boundary. */
export type DecisionCallErrorCode =
  | 'aborted'
  | 'deadline-exceeded'
  | 'invalid-deadline'
  | 'invalid-config'
  | 'invalid-request'
  | 'transport-failed'
  | 'http-error'
  | 'invalid-json'

export type DecisionCallErrorFactory = (
  code: DecisionCallErrorCode,
  message: string,
) => Error

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  )
}

export function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  )
}

export function readChoiceContent(
  body: Record<string, unknown>,
): string | null {
  const choices = body.choices
  if (!Array.isArray(choices)) return null
  const first: unknown = choices[0]
  if (!isRecord(first)) return null
  const message = first.message
  if (!isRecord(message)) return null
  return typeof message.content === 'string' ? message.content : null
}

function isUsableSignal(value: unknown): value is AbortSignal {
  if (!isRecord(value)) return false
  return typeof value.aborted === 'boolean'
}

export function readSignal(context: unknown): AbortSignal | null {
  if (!isRecord(context)) return null
  const signal = context.signal
  return isUsableSignal(signal) ? signal : null
}

export function supportsAbortListener(signal: AbortSignal): boolean {
  return (
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
  )
}

export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted === true
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

/** Parses a provider base URL, accepting https or loopback-only plain http. */
export function parseProviderBaseUrl(baseUrl: unknown): URL | null {
  if (typeof baseUrl !== 'string') return null
  const trimmed = baseUrl.trim()
  if (trimmed.length === 0) return null
  if (trimmed.includes('#')) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  if (url.hash !== '') return null
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url
  return null
}

/** Joins the configured base URL with the endpoint path regardless of trailing slashes. */
export function completionsUrl(baseUrl: URL): string {
  const endpoint = '/chat/completions'
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

/** Strips an optional surrounding markdown code fence from model content. */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const match = /^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/.exec(trimmed)
  if (match === null) return trimmed
  return (match[1] ?? '').trim()
}

export interface DecisionUsage {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly usageMissing: boolean
}

function readCount(
  usage: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (usage === undefined) return null
  const value = usage[key]
  return isNonNegativeSafeInteger(value) ? value : null
}

export function readUsage(body: Record<string, unknown>): DecisionUsage {
  const usage = isRecord(body.usage) ? body.usage : undefined
  const inputTokens = readCount(usage, 'prompt_tokens')
  const outputTokens = readCount(usage, 'completion_tokens')
  if (inputTokens === null || outputTokens === null) {
    return { inputTokens: null, outputTokens: null, usageMissing: true }
  }
  return { inputTokens, outputTokens, usageMissing: false }
}

export function validateClockPortOptions(
  options: unknown,
  label: 'selection' | 'reaction',
): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`provider ${label} port requires a ClockPort`)
  }
  const clock = (options as { readonly clock?: unknown }).clock
  if (
    clock === null ||
    typeof clock !== 'object' ||
    typeof (clock as { readonly nowMs?: unknown }).nowMs !== 'function'
  ) {
    throw new TypeError(`provider ${label} port requires a ClockPort`)
  }
}

function failureDuringCall(
  signal: AbortSignal,
  timedOut: boolean,
  clock: ClockPort,
  governingAtMs: number,
  label: 'selection' | 'reaction',
  createError: DecisionCallErrorFactory,
): Error {
  if (isAborted(signal)) {
    return createError('aborted', `${label} aborted during provider call`)
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
    `openai-compatible ${label} request failed due to transport error`,
  )
}

export interface ExecuteOpenAiCompatibleCallOptions<TParsedRequest> {
  readonly clock: ClockPort
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly providerName?: string
  readonly modelVersion?: string
  readonly pricingRef?: string | null
  readonly maxTokens?: number
  readonly fetchImpl?: DecisionFetch
  readonly label: 'selection' | 'reaction'
  readonly requestTypeName: 'SelectionRequest' | 'DecisionRequest'
  readonly defaultProviderName: string
  readonly defaultModelVersion: string
  readonly systemPrompt: string
  readonly renderUserPrompt: (request: TParsedRequest) => string
  readonly parseRequest: (rawRequest: unknown) => TParsedRequest
  readonly createError: DecisionCallErrorFactory
}

export interface OpenAiCompatibleCallOutcome<TParsedRequest> {
  readonly parsedRequest: TParsedRequest
  readonly proposal: Record<string, unknown>
  readonly completedAtMs: number
  readonly providerName: string
  readonly modelVersion: string
  readonly pricingRef: string | null
  readonly requestedModel: string
  readonly servedModel: string | null
  readonly usage: DecisionUsage
  readonly elapsedMs: number
}

/**
 * Executes exactly one OpenAI-compatible chat-completions call. Validation
 * order, error codes and messages are fixed; each adapter supplies only its
 * label, prompt renderers, request parser and error factory.
 */
export async function executeOpenAiCompatibleCall<TParsedRequest>(
  options: ExecuteOpenAiCompatibleCallOptions<TParsedRequest>,
  rawRequest: unknown,
  context: CallContext,
): Promise<OpenAiCompatibleCallOutcome<TParsedRequest>> {
  const { clock, label, requestTypeName, createError } = options

  const signal = readSignal(context)
  if (signal === null) {
    throw createError(
      'invalid-request',
      `${label} requires a valid CallContext signal`,
    )
  }

  if (isAborted(signal)) {
    throw createError('aborted', `${label} aborted before provider call`)
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
  const parsedBaseUrl = parseProviderBaseUrl(options.baseUrl)
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
  const modelVersion = options.modelVersion ?? options.defaultModelVersion
  if (!isNonBlank(modelVersion)) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a non-blank modelVersion`,
    )
  }
  const pricingRef = options.pricingRef ?? null
  if (pricingRef !== null && !isNonBlank(pricingRef)) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a non-blank pricingRef when supplied`,
    )
  }
  const maxTokens = options.maxTokens ?? DEFAULT_DECISION_MAX_TOKENS
  if (
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0
  ) {
    throw createError(
      'invalid-config',
      `provider ${label} requires a positive integer maxTokens`,
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
      throw createError('aborted', `${label} aborted before provider call`)
    }

    const fetchImpl: DecisionFetch = options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(completionsUrl(parsedBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: options.model.trim(),
          temperature: 0,
          stream: false,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: options.systemPrompt },
            {
              role: 'user',
              content: options.renderUserPrompt(parsedRequest),
            },
          ],
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
      throw createError('aborted', `${label} aborted during provider call`)
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
        `openai-compatible ${label} request failed: HTTP ${response.status}`,
      )
    }

    if (typeof response.headers?.get === 'function') {
      const contentLength = Number(response.headers.get('content-length'))
      if (
        Number.isFinite(contentLength) &&
        Number.isInteger(contentLength) &&
        contentLength > MAX_DECISION_RESPONSE_CHARS
      ) {
        throw createError(
          'invalid-json',
          `openai-compatible ${label} response exceeds maximum size`,
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
      throw createError('aborted', `${label} aborted during provider call`)
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
    if (text.length > MAX_DECISION_RESPONSE_CHARS) {
      throw createError(
        'invalid-json',
        `openai-compatible ${label} response exceeds maximum size`,
      )
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw createError(
        'invalid-json',
        `openai-compatible ${label} response is not valid JSON`,
      )
    }
    if (!isRecord(body)) {
      throw createError(
        'invalid-json',
        `openai-compatible ${label} response is not a JSON object`,
      )
    }

    const content = readChoiceContent(body)
    if (content === null) {
      throw createError(
        'invalid-json',
        `openai-compatible ${label} response has no choices[0].message.content string`,
      )
    }

    let proposal: unknown
    try {
      proposal = JSON.parse(stripCodeFence(content))
    } catch {
      throw createError(
        'invalid-json',
        `openai-compatible ${label} proposal is not valid JSON`,
      )
    }
    if (!isRecord(proposal)) {
      throw createError(
        'invalid-json',
        `openai-compatible ${label} proposal is not a JSON object`,
      )
    }

    const servedModel =
      typeof body.model === 'string' && body.model.trim().length > 0
        ? body.model.trim()
        : null
    const usage = readUsage(body)
    const elapsedMs = Math.max(0, completedAtMs - startedAtMs)

    return {
      parsedRequest,
      proposal,
      completedAtMs,
      providerName,
      modelVersion,
      pricingRef,
      requestedModel: options.model.trim(),
      servedModel,
      usage,
      elapsedMs,
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    signal.removeEventListener('abort', handleAbort)
  }
}
