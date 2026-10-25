/**
 * Offline VTube Studio pairing primitive (M1-02 increment D2).
 *
 * The caller supplies one exclusive, already OPEN D1 connection handle, the
 * plugin identity, a private credential provider and one M5-owned signal that
 * combines cancellation with the finite overall acquisition deadline. This
 * module performs one token grant/authentication attempt, correlates only its
 * own `m1pair-` request namespace, bounds the protocol waits it owns, and
 * reports safe failure classifications. It never constructs a socket, performs
 * endpoint discovery, prompts outside the explicit `allow-prompt` mode, reads a
 * credential file, logs protocol text or starts a second attempt.
 *
 * On failure the same D1 handle is closed and its actual completion is reported
 * separately from the pairing subscription release fact. On success only the
 * pairing subscription, timers and abort listener are released; the unchanged
 * handle is handed back to the caller, which later composes the C client.
 */

import { VTS_API_NAME, VTS_API_VERSION } from './vts-client'
import type { VtsConnectionCompletion, VtsConnectionHandle } from './vts-connection'

const MAX_TIMER_MS = 2_147_483_647
const MAX_REQUEST_ID_LENGTH = 64
const MAX_TOKEN_LENGTH = 64
const MIN_IDENTITY_LENGTH = 3
const MAX_IDENTITY_LENGTH = 32
const PERMISSION_DENIED_ERROR_ID = 50
const INVALID_OPTIONS_MESSAGE = 'vts-pairing: invalid options'

let attemptSequence = 0

export interface VtsPairingIdentity {
  readonly pluginName: string
  readonly pluginDeveloper: string
}

export interface VtsPairingCredentialProvider {
  load(signal: AbortSignal): Promise<string | null>
  save(value: string, signal: AbortSignal): Promise<void>
}

export interface VtsPairingOptions {
  readonly handle: VtsConnectionHandle
  readonly identity: VtsPairingIdentity
  readonly credentials: VtsPairingCredentialProvider
  readonly signal: AbortSignal
  readonly mode: 'existing-only' | 'allow-prompt'
  readonly requestTimeoutMs: number
  readonly humanApprovalTimeoutMs: number
}

export type VtsPairingFailureCode =
  | 'aborted'
  | 'timeout'
  | 'credential_missing'
  | 'credential_read_failed'
  | 'credential_write_failed'
  | 'permission_denied'
  | 'authentication_rejected'
  | 'protocol_error'
  | 'transport_closed'
  | 'transport_error'
  | 'pairing_cleanup_failed'

export interface VtsPairingCleanup {
  readonly connection: VtsConnectionCompletion
  readonly pairingSubscription: 'released' | 'release_failed'
}

export type VtsPairingResult =
  | { readonly kind: 'authenticated'; readonly handle: VtsConnectionHandle }
  | {
      readonly kind: 'failed'
      readonly code: VtsPairingFailureCode
      readonly cleanup: VtsPairingCleanup
    }

interface WireEnvelope {
  readonly requestID: string
  readonly messageType: string
  readonly data: unknown
}

type ExchangeOutcome =
  | { readonly kind: 'response'; readonly data: string | boolean }
  | { readonly kind: 'failure'; readonly code: VtsPairingFailureCode }

type ProviderOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error' }
  | { readonly kind: 'failure'; readonly code: VtsPairingFailureCode }

interface PendingPairingRequest {
  readonly expectedType: string
  readonly validate: (data: unknown) => string | boolean | undefined
  settle(outcome: ExchangeOutcome): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIdentityName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_IDENTITY_LENGTH &&
    value.length <= MAX_IDENTITY_LENGTH
  )
}

function isTimerBudget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_TIMER_MS
  )
}

function isValidSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  )
}

/**
 * A credential is usable only when it is a nonempty printable ASCII string of
 * at most 64 characters. The value is never logged or returned to a caller.
 */
function isValidToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

function validateOptions(options: VtsPairingOptions): void {
  if (!isRecord(options)) throw new Error(INVALID_OPTIONS_MESSAGE)
  const record = options as unknown as Record<string, unknown>

  const identity = record.identity
  if (
    !isRecord(identity) ||
    !isIdentityName(identity.pluginName) ||
    !isIdentityName(identity.pluginDeveloper)
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }

  const credentials = record.credentials
  if (
    !isRecord(credentials) ||
    typeof credentials.load !== 'function' ||
    typeof credentials.save !== 'function'
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }

  const handle = record.handle
  if (!isRecord(handle) || typeof handle.close !== 'function') {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }
  const transport = handle.transport
  if (
    !isRecord(transport) ||
    typeof transport.send !== 'function' ||
    typeof transport.subscribe !== 'function'
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }

  if (!isValidSignal(record.signal)) throw new Error(INVALID_OPTIONS_MESSAGE)
  if (record.mode !== 'existing-only' && record.mode !== 'allow-prompt') {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }
  if (
    !isTimerBudget(record.requestTimeoutMs) ||
    !isTimerBudget(record.humanApprovalTimeoutMs)
  ) {
    throw new Error(INVALID_OPTIONS_MESSAGE)
  }
}

/**
 * Parse one incoming frame. A non-JSON value, a non-object value or a wrong
 * VTS envelope identity is unrelated and ignored. The timestamp is deliberately
 * not read: protocol timing never supplies a local clock.
 */
function parseEnvelope(raw: unknown): WireEnvelope | undefined {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isRecord(value)) return undefined
  if (value.apiName !== VTS_API_NAME || value.apiVersion !== VTS_API_VERSION) {
    return undefined
  }
  if (typeof value.requestID !== 'string' || value.requestID.length === 0) {
    return undefined
  }
  if (typeof value.messageType !== 'string' || value.messageType.length === 0) {
    return undefined
  }
  return {
    requestID: value.requestID,
    messageType: value.messageType,
    data: value.data,
  }
}

function normalizeCompletion(value: unknown): VtsConnectionCompletion {
  if (isRecord(value)) {
    if (value.kind === 'closed') return { kind: 'closed' }
    if (
      value.kind === 'failed' &&
      (value.code === 'close_timeout' || value.code === 'close_failed')
    ) {
      return { kind: 'failed', code: value.code }
    }
  }
  return { kind: 'failed', code: 'close_failed' }
}

/**
 * Run one pairing attempt on one exclusive D1 handle. Invalid programming
 * options reject before ownership. Operational failures close that same handle
 * and report the observed completion; success returns the identical handle.
 */
export function pairVtsConnection(options: VtsPairingOptions): Promise<VtsPairingResult> {
  try {
    validateOptions(options)
  } catch {
    return Promise.reject(new Error(INVALID_OPTIONS_MESSAGE))
  }
  return executePairing(options)
}

async function executePairing(options: VtsPairingOptions): Promise<VtsPairingResult> {
  const handle = options.handle
  const transport = handle.transport
  const credentials = options.credentials
  const signal = options.signal
  const identity: VtsPairingIdentity = {
    pluginName: options.identity.pluginName,
    pluginDeveloper: options.identity.pluginDeveloper,
  }
  const allowPrompt = options.mode === 'allow-prompt'
  const requestTimeoutMs = options.requestTimeoutMs
  const humanApprovalTimeoutMs = options.humanApprovalTimeoutMs
  attemptSequence += 1
  const attempt = attemptSequence
  let requestIndex = 0

  let failureCode: VtsPairingFailureCode | null = null
  let wakeResolve: (() => void) | null = null
  const wake = new Promise<void>((resolve) => {
    wakeResolve = resolve
  })
  let subscription: (() => void) | null = null
  let pairingSubscription: 'released' | 'release_failed' = 'released'
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Map<string, PendingPairingRequest>()
  let abortAttached = false
  let cleaned = false
  let terminal: Promise<VtsPairingResult> | null = null

  const signalAborted = (): boolean => {
    try {
      return signal.aborted === true
    } catch {
      return true
    }
  }

  const signalFailure = (code: VtsPairingFailureCode): void => {
    if (failureCode !== null) return
    failureCode = code
    wakeResolve?.()
  }

  const onAbort = (): void => {
    signalFailure('aborted')
  }

  const removeAbortListener = (): void => {
    if (!abortAttached) return
    abortAttached = false
    try {
      signal.removeEventListener('abort', onAbort)
    } catch {
      // Listener removal is best effort; the terminal outcome is unchanged.
    }
  }

  const clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    if (!timers.delete(timer)) return
    clearTimeout(timer)
  }

  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  const addTimer = (
    delayMs: number,
    callback: () => void,
  ): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, delayMs)
    timers.add(timer)
    return timer
  }

  const releasePairingSubscription = (): void => {
    const release = subscription
    subscription = null
    if (release === null) return
    try {
      release()
    } catch {
      pairingSubscription = 'release_failed'
    }
  }

  const handleEvent = (event: unknown): void => {
    if (cleaned || !isRecord(event)) return
    if (event.type === 'close') {
      signalFailure('transport_closed')
      return
    }
    if (event.type === 'error') {
      signalFailure('transport_error')
      return
    }
    if (event.type !== 'message') return

    const envelope = parseEnvelope(event.data)
    if (envelope === undefined) return
    const request = pending.get(envelope.requestID)
    if (request === undefined) return

    if (envelope.messageType === 'APIError') {
      if (
        !isRecord(envelope.data) ||
        typeof envelope.data.errorID !== 'number' ||
        !Number.isFinite(envelope.data.errorID)
      ) {
        request.settle({ kind: 'failure', code: 'protocol_error' })
        return
      }
      request.settle({
        kind: 'failure',
        code:
          envelope.data.errorID === PERMISSION_DENIED_ERROR_ID
            ? 'permission_denied'
            : 'protocol_error',
      })
      return
    }

    if (envelope.messageType !== request.expectedType) {
      request.settle({ kind: 'failure', code: 'protocol_error' })
      return
    }

    const data = request.validate(envelope.data)
    if (data === undefined) {
      request.settle({ kind: 'failure', code: 'protocol_error' })
      return
    }
    request.settle({ kind: 'response', data })
  }

  const awaitStep = async (step: Promise<ExchangeOutcome>): Promise<ExchangeOutcome> => {
    const outcome = await Promise.race([
      step,
      wake.then(
        (): ExchangeOutcome => ({
          kind: 'failure',
          code: failureCode ?? 'aborted',
        }),
      ),
    ])
    if (failureCode !== null) return { kind: 'failure', code: failureCode }
    return outcome
  }

  const exchange = async (
    messageType: string,
    expectedType: string,
    data: unknown,
    timeoutMs: number,
    validate: (value: unknown) => string | boolean | undefined,
  ): Promise<ExchangeOutcome> => {
    if (failureCode !== null) return { kind: 'failure', code: failureCode }
    if (signalAborted()) {
      signalFailure('aborted')
      return { kind: 'failure', code: 'aborted' }
    }

    requestIndex += 1
    const requestID = `m1pair-${attempt}-${requestIndex}`
    if (requestID.length > MAX_REQUEST_ID_LENGTH) {
      return { kind: 'failure', code: 'protocol_error' }
    }

    let resolveStep!: (outcome: ExchangeOutcome) => void
    const step = new Promise<ExchangeOutcome>((resolve) => {
      resolveStep = resolve
    })
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false

    const settle = (outcome: ExchangeOutcome): void => {
      if (settled) return
      settled = true
      pending.delete(requestID)
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      resolveStep(outcome)
    }

    pending.set(requestID, { expectedType, validate, settle })
    timer = addTimer(timeoutMs, () => {
      settle({ kind: 'failure', code: 'timeout' })
    })

    let serialized: string
    try {
      serialized = JSON.stringify({
        apiName: VTS_API_NAME,
        apiVersion: VTS_API_VERSION,
        requestID,
        messageType,
        data,
      })
    } catch {
      settle({ kind: 'failure', code: 'protocol_error' })
      return awaitStep(step)
    }

    // Pending state and the expected response exist before the send so a peer
    // may answer synchronously without losing the correlation.
    try {
      transport.send(serialized)
    } catch {
      if (!settled) settle({ kind: 'failure', code: 'transport_error' })
      else signalFailure('transport_error')
    }

    return awaitStep(step)
  }

  const awaitProvider = async <T>(promise: Promise<T>): Promise<ProviderOutcome<T>> => {
    const settled = promise.then(
      (value): ProviderOutcome<T> => ({ kind: 'value', value }),
      (): ProviderOutcome<T> => ({ kind: 'error' }),
    )
    const outcome = await Promise.race([
      settled,
      wake.then(
        (): ProviderOutcome<T> => ({
          kind: 'failure',
          code: failureCode ?? 'aborted',
        }),
      ),
    ])
    if (failureCode !== null) return { kind: 'failure', code: failureCode }
    return outcome
  }

  const loadCredential = async (): Promise<ProviderOutcome<string | null>> => {
    if (failureCode !== null) return { kind: 'failure', code: failureCode }
    if (signalAborted()) {
      signalFailure('aborted')
      return { kind: 'failure', code: 'aborted' }
    }

    let promise: Promise<string | null>
    try {
      promise = Promise.resolve(credentials.load(signal))
    } catch {
      if (failureCode !== null) return { kind: 'failure', code: failureCode }
      if (signalAborted()) {
        signalFailure('aborted')
        return { kind: 'failure', code: 'aborted' }
      }
      return { kind: 'error' }
    }

    const outcome = await awaitProvider(promise)
    if (outcome.kind === 'value' && outcome.value !== null && !isValidToken(outcome.value)) {
      return { kind: 'error' }
    }
    return outcome
  }

  const saveCredential = async (token: string): Promise<ProviderOutcome<void>> => {
    if (failureCode !== null) return { kind: 'failure', code: failureCode }
    if (signalAborted()) {
      signalFailure('aborted')
      return { kind: 'failure', code: 'aborted' }
    }

    let promise: Promise<void>
    try {
      promise = Promise.resolve(credentials.save(token, signal))
    } catch {
      if (failureCode !== null) return { kind: 'failure', code: failureCode }
      if (signalAborted()) {
        signalFailure('aborted')
        return { kind: 'failure', code: 'aborted' }
      }
      return { kind: 'error' }
    }
    return awaitProvider(promise)
  }

  const validateToken = (data: unknown): string | undefined => {
    if (!isRecord(data) || !isValidToken(data.authenticationToken)) return undefined
    return data.authenticationToken
  }

  const validateAuthentication = (data: unknown): boolean | undefined => {
    if (!isRecord(data) || typeof data.authenticated !== 'boolean') return undefined
    return data.authenticated
  }

  const finishFailure = (code: VtsPairingFailureCode): Promise<VtsPairingResult> => {
    if (terminal !== null) return terminal
    terminal = (async (): Promise<VtsPairingResult> => {
      cleaned = true
      clearTimers()
      pending.clear()
      removeAbortListener()
      releasePairingSubscription()

      let connection: VtsConnectionCompletion
      try {
        connection = normalizeCompletion(await handle.close())
      } catch {
        connection = { kind: 'failed', code: 'close_failed' }
      }

      return {
        kind: 'failed',
        code,
        cleanup: { connection, pairingSubscription },
      }
    })()
    return terminal
  }

  const finishSuccess = async (): Promise<VtsPairingResult> => {
    if (terminal !== null) return terminal
    clearTimers()
    pending.clear()
    removeAbortListener()

    // Observe the real D1 completion before releasing the pairing subscriber.
    // A test-only unsubscribe or another synchronous handoff boundary may make
    // the physical connection complete after the subscriber is gone, so the
    // transport event alone is not sufficient evidence of liveness.
    let connectionCompleted = false
    const observeConnection = (): void => {
      connectionCompleted = true
    }
    try {
      handle.closed.then(observeConnection, observeConnection)
    } catch {
      connectionCompleted = true
    }

    releasePairingSubscription()

    // Let the already-queued completion reaction run before committing the
    // handoff. This observes completion recorded during release, not a future
    // connection state after the linearization point.
    await Promise.resolve()

    // A release that throws, a D1 completion recorded during release, a
    // close/error observed synchronously during release, or cancellation
    // observed after it all prevent a successful handoff.
    if (pairingSubscription === 'release_failed') {
      return finishFailure('pairing_cleanup_failed')
    }
    if (failureCode !== null) return finishFailure(failureCode)
    if (signalAborted()) return finishFailure('aborted')
    if (connectionCompleted) return finishFailure('transport_closed')

    cleaned = true
    terminal = Promise.resolve({ kind: 'authenticated', handle })
    return terminal
  }

  try {
    // The caller's signal is the M5-owned cancellation/overall-deadline signal.
    // This module adds only this listener and never a production total timer.
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      abortAttached = true
    } catch {
      signalFailure('aborted')
    }
    if (signalAborted()) signalFailure('aborted')

    if (failureCode === null) {
      try {
        const release = transport.subscribe(handleEvent)
        if (typeof release !== 'function') {
          signalFailure('transport_error')
        } else {
          subscription = release
          // A close/error emitted synchronously inside subscribe must not leave
          // a late-returned pairing subscription attached.
          if (failureCode !== null) releasePairingSubscription()
        }
      } catch {
        signalFailure('transport_error')
      }
    }

    if (failureCode !== null) return await finishFailure(failureCode)

    const loaded = await loadCredential()
    if (loaded.kind === 'failure') return await finishFailure(loaded.code)
    if (loaded.kind === 'error') return await finishFailure('credential_read_failed')

    let token = loaded.value
    let grantedByPrompt = false

    if (token === null) {
      if (!allowPrompt) return await finishFailure('credential_missing')
      const granted = await exchange(
        'AuthenticationTokenRequest',
        'AuthenticationTokenResponse',
        {
          pluginName: identity.pluginName,
          pluginDeveloper: identity.pluginDeveloper,
        },
        humanApprovalTimeoutMs,
        validateToken,
      )
      if (granted.kind === 'failure') return await finishFailure(granted.code)
      if (typeof granted.data !== 'string') {
        return await finishFailure('protocol_error')
      }
      token = granted.data
      grantedByPrompt = true
    }

    if (failureCode !== null) return await finishFailure(failureCode)
    if (!isValidToken(token)) {
      return await finishFailure(
        grantedByPrompt ? 'protocol_error' : 'credential_read_failed',
      )
    }

    // Token issuance alone is never authentication. Only a correlated
    // AuthenticationResponse with authenticated === true may proceed.
    const authenticated = await exchange(
      'AuthenticationRequest',
      'AuthenticationResponse',
      {
        pluginName: identity.pluginName,
        pluginDeveloper: identity.pluginDeveloper,
        authenticationToken: token,
      },
      requestTimeoutMs,
      validateAuthentication,
    )
    if (authenticated.kind === 'failure') {
      return await finishFailure(authenticated.code)
    }
    if (authenticated.data !== true) {
      // A rejected existing credential never falls back to prompting or retry.
      return await finishFailure('authentication_rejected')
    }

    if (failureCode !== null) return await finishFailure(failureCode)

    // A newly granted token is saved only after successful authentication. An
    // already admitted save is not rolled back if cancellation wins later; M5
    // owns persistent storage and same-record save serialization.
    if (grantedByPrompt) {
      const saved = await saveCredential(token)
      if (saved.kind === 'failure') return await finishFailure(saved.code)
      if (saved.kind === 'error') return await finishFailure('credential_write_failed')
    }

    if (failureCode !== null) return await finishFailure(failureCode)
    if (signalAborted()) return await finishFailure('aborted')
    return await finishSuccess()
  } catch {
    return await finishFailure('protocol_error')
  }
}
