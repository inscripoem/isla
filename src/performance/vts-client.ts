/**
 * Deterministic VTube Studio protocol client (M1-02 increment C).
 *
 * The transport is an injected, already connected peer. This module owns no
 * endpoint discovery, authentication token, socket construction, retry or
 * replay. It validates every correlated envelope and field it uses, bounds
 * pending work and settles each request exactly once. It never treats the VTS
 * response timestamp as a local clock and never emits raw API messages or
 * transport exceptions.
 */

export const VTS_API_NAME = 'VTubeStudioPublicAPI'
export const VTS_API_VERSION = '1.0'

/** A message/close/error observation from an already connected transport. */
export type VtsTransportEvent =
  | { readonly type: 'message'; readonly data: unknown }
  | { readonly type: 'close' }
  | { readonly type: 'error' }

/**
 * An injected, already connected VTS transport. `send` is synchronous and takes
 * serialized JSON. `subscribe` returns an idempotent unsubscribe function.
 * `dispose` is the explicit ownership boundary: the client calls it once when
 * disposed and never reconnects afterwards.
 */
export interface VtsTransport {
  send(serialized: string): void
  subscribe(listener: (event: VtsTransportEvent) => void): () => void
  dispose(): void
}

/** Safe, non-protocol failure classifications. No raw transport text escapes. */
export type VtsFailureCode =
  | 'aborted'
  | 'busy'
  | 'disposed'
  | 'protocol_error'
  | 'send_failed'
  | 'timeout'
  | 'transport_closed'
  | 'transport_error'

export type VtsCallResult<T> =
  | { readonly kind: 'ok'; readonly data: T; readonly attempted: true }
  | { readonly kind: 'api_error'; readonly attempted: true }
  | {
      readonly kind: 'failed'
      readonly code: VtsFailureCode
      /** True once `send` was invoked, even when it threw. */
      readonly attempted: boolean
    }

export interface VtsApiStateData {
  readonly active: boolean
  readonly vTubeStudioVersion: string
  readonly currentSessionAuthenticated: boolean
}

export interface VtsCurrentModelData {
  readonly modelLoaded: boolean
  readonly modelID: string
}

export interface VtsAvailableHotkey {
  readonly hotkeyID: string
}

export interface VtsHotkeysData {
  readonly modelLoaded: boolean
  readonly modelID: string
  readonly availableHotkeys: readonly VtsAvailableHotkey[]
}

export interface VtsTriggerData {
  readonly hotkeyID: string
}

export interface VtsClientOptions {
  readonly transport: VtsTransport
  /** Finite positive timeout in milliseconds, bounded to the timer range. */
  readonly timeoutMs: number
  /** Positive integer bound on simultaneous in-flight requests. */
  readonly maxPending: number
}

export interface VtsClient {
  apiState(signal: AbortSignal): Promise<VtsCallResult<VtsApiStateData>>
  currentModel(signal: AbortSignal): Promise<VtsCallResult<VtsCurrentModelData>>
  hotkeysInCurrentModel(signal: AbortSignal): Promise<VtsCallResult<VtsHotkeysData>>
  triggerHotkey(hotkeyID: string, signal: AbortSignal): Promise<VtsCallResult<VtsTriggerData>>
  /** Idempotent: unsubscribes and disposes the owned transport exactly once. */
  dispose(): void
  readonly disposed: boolean
}

const MAX_TIMER_MS = 2_147_483_647
const MAX_PENDING_REQUESTS = 1_024

interface VtsEnvelope {
  readonly requestID: string
  readonly messageType: string
  readonly data: unknown
}

interface PendingRequest {
  readonly requestId: string
  readonly expectedType: string
  readonly validate: (data: unknown) => unknown | undefined
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly resolve: (result: VtsCallResult<unknown>) => void
  settled: boolean
  attempted: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validateOptions(options: VtsClientOptions): void {
  if (
    typeof options.timeoutMs !== 'number' ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_TIMER_MS
  ) {
    throw new Error('vts-client: timeoutMs must be a finite positive timer value')
  }
  if (
    typeof options.maxPending !== 'number' ||
    !Number.isInteger(options.maxPending) ||
    options.maxPending <= 0 ||
    options.maxPending > MAX_PENDING_REQUESTS
  ) {
    throw new Error('vts-client: maxPending must be a positive bounded integer')
  }
}

function validateApiState(data: unknown): VtsApiStateData | undefined {
  if (!isRecord(data)) return undefined
  if (typeof data.active !== 'boolean') return undefined
  if (!nonEmptyString(data.vTubeStudioVersion)) return undefined
  if (typeof data.currentSessionAuthenticated !== 'boolean') return undefined
  return {
    active: data.active,
    vTubeStudioVersion: data.vTubeStudioVersion,
    currentSessionAuthenticated: data.currentSessionAuthenticated,
  }
}

function validateCurrentModel(data: unknown): VtsCurrentModelData | undefined {
  if (!isRecord(data)) return undefined
  if (typeof data.modelLoaded !== 'boolean') return undefined
  if (typeof data.modelID !== 'string') return undefined
  return { modelLoaded: data.modelLoaded, modelID: data.modelID }
}

function validateHotkeys(data: unknown): VtsHotkeysData | undefined {
  if (!isRecord(data)) return undefined
  if (typeof data.modelLoaded !== 'boolean') return undefined
  if (typeof data.modelID !== 'string') return undefined
  if (!Array.isArray(data.availableHotkeys)) return undefined
  const availableHotkeys: VtsAvailableHotkey[] = []
  for (const hotkey of data.availableHotkeys) {
    if (!isRecord(hotkey) || !nonEmptyString(hotkey.hotkeyID)) return undefined
    availableHotkeys.push({ hotkeyID: hotkey.hotkeyID })
  }
  return {
    modelLoaded: data.modelLoaded,
    modelID: data.modelID,
    availableHotkeys,
  }
}

function validateTrigger(data: unknown): VtsTriggerData | undefined {
  if (!isRecord(data)) return undefined
  if (!nonEmptyString(data.hotkeyID)) return undefined
  return { hotkeyID: data.hotkeyID }
}

function validateApiError(data: unknown): boolean {
  return isRecord(data) && typeof data.errorID === 'number' && Number.isFinite(data.errorID)
}

/**
 * Parse one incoming frame. A non-JSON string, a non-object value or a wrong
 * VTS identity is an unrelated frame and is ignored. The timestamp is
 * deliberately not read: local observations use the injected receipt clock.
 */
function parseEnvelope(raw: unknown): VtsEnvelope | undefined {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  if (value.apiName !== VTS_API_NAME) return undefined
  if (value.apiVersion !== VTS_API_VERSION) return undefined
  if (!nonEmptyString(value.requestID)) return undefined
  if (!nonEmptyString(value.messageType)) return undefined
  return {
    requestID: value.requestID,
    messageType: value.messageType,
    data: value.data,
  }
}

export function createVtsClient(options: VtsClientOptions): VtsClient {
  validateOptions(options)
  const { transport, timeoutMs, maxPending } = options

  const pending = new Map<string, PendingRequest>()
  let sequence = 0
  let disposed = false
  let unusable: VtsFailureCode | null = null
  let unsubscribe: (() => void) | null = null

  const failure = (
    code: VtsFailureCode,
    attempted: boolean,
  ): VtsCallResult<never> => ({ kind: 'failed', code, attempted })

  const releaseSubscription = (): void => {
    const release = unsubscribe
    unsubscribe = null
    if (release === null) return
    try {
      release()
    } catch {
      // A cleanup failure cannot resurrect the instance.
    }
  }

  const settle = (request: PendingRequest, result: VtsCallResult<unknown>): void => {
    if (request.settled) return
    request.settled = true
    if (pending.get(request.requestId) === request) pending.delete(request.requestId)
    if (request.timer !== null) {
      clearTimeout(request.timer)
      request.timer = null
    }
    try {
      request.signal.removeEventListener('abort', request.onAbort)
    } catch {
      // Listener removal is best effort; settlement is still exactly once.
    }
    request.resolve(result)
  }

  const failPending = (code: VtsFailureCode): void => {
    for (const request of [...pending.values()]) {
      settle(request, failure(code, request.attempted))
    }
  }

  const markUnusable = (code: VtsFailureCode): void => {
    if (disposed) return
    if (unusable === null) unusable = code
    failPending(code)
    releaseSubscription()
  }

  const handleMessage = (raw: unknown): void => {
    const envelope = parseEnvelope(raw)
    if (envelope === undefined) return
    const request = pending.get(envelope.requestID)
    if (request === undefined) return

    if (envelope.messageType === 'APIError') {
      if (!validateApiError(envelope.data)) {
        settle(request, failure('protocol_error', true))
        return
      }
      settle(request, { kind: 'api_error', attempted: true })
      return
    }

    if (envelope.messageType !== request.expectedType) {
      settle(request, failure('protocol_error', true))
      return
    }

    const data = request.validate(envelope.data)
    if (data === undefined) {
      settle(request, failure('protocol_error', true))
      return
    }
    settle(request, { kind: 'ok', data, attempted: true })
  }

  const handleEvent = (event: unknown): void => {
    try {
      if (!isRecord(event)) return
      if (event.type === 'message') {
        handleMessage(event.data)
      } else if (event.type === 'close') {
        markUnusable('transport_closed')
      } else if (event.type === 'error') {
        markUnusable('transport_error')
      }
    } catch {
      // A malformed event is unrelated and cannot settle a request.
    }
  }

  try {
    const release = transport.subscribe(handleEvent)
    if (typeof release !== 'function') {
      unusable = unusable ?? 'transport_error'
    } else {
      unsubscribe = release
      // A close/error emitted synchronously inside subscribe must not leave a
      // late-returned subscription attached.
      if (unusable !== null) releaseSubscription()
    }
  } catch {
    unusable = unusable ?? 'transport_error'
  }

  const request = <T>(
    messageType: string,
    expectedType: string,
    data: unknown,
    signal: AbortSignal,
    validate: (value: unknown) => T | undefined,
  ): Promise<VtsCallResult<T>> => {
    if (disposed) return Promise.resolve(failure('disposed', false))
    if (unusable !== null) return Promise.resolve(failure(unusable, false))
    if (signal.aborted) return Promise.resolve(failure('aborted', false))
    if (pending.size >= maxPending) return Promise.resolve(failure('busy', false))

    sequence += 1
    const requestId = `vts-${sequence}`
    let serialized: string
    try {
      serialized = JSON.stringify({
        apiName: VTS_API_NAME,
        apiVersion: VTS_API_VERSION,
        requestID: requestId,
        messageType,
        data,
      })
    } catch {
      return Promise.resolve(failure('send_failed', false))
    }

    let resolveRequest!: (result: VtsCallResult<T>) => void
    const promise = new Promise<VtsCallResult<T>>((resolve) => {
      resolveRequest = resolve
    })

    const record: PendingRequest = {
      requestId,
      expectedType,
      validate: validate as (value: unknown) => unknown | undefined,
      signal,
      onAbort: () => {
        settle(record, failure('aborted', record.attempted))
      },
      resolve: resolveRequest as (result: VtsCallResult<unknown>) => void,
      settled: false,
      attempted: false,
      timer: null,
    }

    pending.set(requestId, record)
    record.timer = setTimeout(() => {
      settle(record, failure('timeout', record.attempted))
    }, timeoutMs)

    try {
      signal.addEventListener('abort', record.onAbort, { once: true })
    } catch {
      settle(record, failure('transport_error', false))
      return promise
    }

    if (signal.aborted) {
      settle(record, failure('aborted', false))
      return promise
    }
    if (disposed) {
      settle(record, failure('disposed', false))
      return promise
    }
    if (unusable !== null) {
      settle(record, failure(unusable, false))
      return promise
    }
    if (record.settled) return promise

    record.attempted = true
    try {
      transport.send(serialized)
    } catch {
      // The send may already have had an effect; never report it as unsent.
      settle(record, failure('send_failed', true))
    }
    return promise
  }

  return {
    apiState: (signal) =>
      request('APIStateRequest', 'APIStateResponse', {}, signal, validateApiState),
    currentModel: (signal) =>
      request('CurrentModelRequest', 'CurrentModelResponse', {}, signal, validateCurrentModel),
    hotkeysInCurrentModel: (signal) =>
      request(
        'HotkeysInCurrentModelRequest',
        'HotkeysInCurrentModelResponse',
        {},
        signal,
        validateHotkeys,
      ),
    triggerHotkey: (hotkeyID, signal) =>
      request('HotkeyTriggerRequest', 'HotkeyTriggerResponse', { hotkeyID }, signal, validateTrigger),
    dispose() {
      if (disposed) return
      disposed = true
      failPending('disposed')
      releaseSubscription()
      try {
        transport.dispose()
      } catch {
        // Owned transport disposal is best effort and never retried.
      }
    },
    get disposed() {
      return disposed
    },
  }
}
