import type { VtsConnectionHandle } from '../../src/performance/vts-connection'
import { createVtsConnectionHandle } from '../../src/performance/vts-connection'
import type {
  VtsPairingCredentialProvider,
  VtsPairingIdentity,
  VtsPairingOptions,
  VtsPairingResult,
} from '../../src/performance/vts-pairing'
import { pairVtsConnection } from '../../src/performance/vts-pairing'
import type { FixtureVtsSocketOptions } from './m1-vts-connection-kit'
import {
  FixtureVtsSocket,
  M1_VTS_CONNECTION_DEFAULT_CLOSE_TIMEOUT_MS,
  createFixtureVtsSocket,
} from './m1-vts-connection-kit'

export const M1_VTS_PAIRING_FIXTURE_TOKEN = 'fixture-pairing-token'
export const M1_VTS_PAIRING_FIXTURE_PLUGIN_NAME = 'Isla Pairing Fixture'
export const M1_VTS_PAIRING_FIXTURE_PLUGIN_DEVELOPER = 'Isla Team Fixture'
export const M1_VTS_PAIRING_PROVIDER_SENTINEL =
  'fixture pairing provider detail must not escape'
export const M1_VTS_PAIRING_FIXTURE_STATE = {
  active: true,
  vTubeStudioVersion: 'fixture-vts-pairing-1.0',
  currentSessionAuthenticated: true,
} as const

/**
 * A fixture socket that can fail listener removal on demand. It still delegates
 * all other socket behavior to the existing D1 fixture, so tests exercise the
 * real connection handle rather than a mocked cleanup path.
 */
export class M1VtsPairingOffFailureSocket extends FixtureVtsSocket {
  private offFailures = 0

  constructor(options: FixtureVtsSocketOptions = {}) {
    super(options)
  }

  failOff(count = 1): void {
    this.offFailures = count
  }

  override off(event: string, listener: (...args: unknown[]) => void): this {
    if (this.offFailures > 0) {
      this.offFailures -= 1
      throw new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL)
    }
    return super.off(event, listener)
  }
}

export function createM1VtsPairingOffFailureSocket(
  options: FixtureVtsSocketOptions = {},
): M1VtsPairingOffFailureSocket {
  return new M1VtsPairingOffFailureSocket(options)
}

export interface M1VtsPairingRequest {
  readonly requestID: string
  readonly messageType: string
  readonly data: unknown
}

export type M1VtsPairingReply =
  | { readonly kind: 'token'; readonly token?: string }
  | { readonly kind: 'authenticated'; readonly value?: boolean }
  | { readonly kind: 'api-error'; readonly errorID?: number; readonly message?: string }
  | {
      readonly kind: 'wire'
      readonly messageType: string
      readonly data: unknown
      readonly overrides?: {
        readonly apiName?: string
        readonly apiVersion?: string
        readonly requestID?: string
      }
    }
  | { readonly kind: 'silent' }

export type M1VtsCredentialMode =
  | { readonly kind: 'value'; readonly value: string | null }
  | { readonly kind: 'reject'; readonly error?: unknown }
  | { readonly kind: 'throw'; readonly error?: unknown }
  | { readonly kind: 'hang' }

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export interface M1VtsControlledCredentials extends VtsPairingCredentialProvider {
  setLoad(mode: M1VtsCredentialMode): void
  setSave(mode: M1VtsCredentialMode): void
  loadCalls(): number
  saveCalls(): number
  waitForSaveEntry(): Promise<void>
  savedValues(): readonly string[]
  loadSignals(): readonly AbortSignal[]
  saveSignals(): readonly AbortSignal[]
  pendingLoads(): number
  pendingSaves(): number
  resolveLoad(value: string | null): void
  rejectLoad(error?: unknown): void
  resolveSave(): void
  rejectSave(error?: unknown): void
}

export function createM1VtsControlledCredentials(
  initial: { readonly load?: M1VtsCredentialMode; readonly save?: M1VtsCredentialMode } = {},
): M1VtsControlledCredentials {
  let loadMode: M1VtsCredentialMode =
    initial.load ?? { kind: 'value', value: M1_VTS_PAIRING_FIXTURE_TOKEN }
  let saveMode: M1VtsCredentialMode = initial.save ?? { kind: 'value', value: null }
  let loadCount = 0
  let saveCount = 0
  const saved: string[] = []
  const loadSignalList: AbortSignal[] = []
  const saveSignalList: AbortSignal[] = []
  const loadDeferreds: Deferred<string | null>[] = []
  const saveDeferreds: Deferred<void>[] = []
  const saveEntryWaiters: Array<() => void> = []

  const notifySaveEntry = (): void => {
    for (const resolve of saveEntryWaiters) resolve()
    saveEntryWaiters.length = 0
  }

  return {
    load(signal) {
      loadCount += 1
      loadSignalList.push(signal)
      if (loadMode.kind === 'value') return Promise.resolve(loadMode.value)
      if (loadMode.kind === 'throw') {
        throw loadMode.error ?? new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL)
      }
      if (loadMode.kind === 'reject') {
        return Promise.reject(loadMode.error ?? new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL))
      }
      const deferred = createDeferred<string | null>()
      loadDeferreds.push(deferred)
      return deferred.promise
    },
    save(value, signal) {
      saveCount += 1
      saved.push(value)
      saveSignalList.push(signal)
      notifySaveEntry()
      if (saveMode.kind === 'value') return Promise.resolve()
      if (saveMode.kind === 'throw') {
        throw saveMode.error ?? new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL)
      }
      if (saveMode.kind === 'reject') {
        return Promise.reject(saveMode.error ?? new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL))
      }
      const deferred = createDeferred<void>()
      saveDeferreds.push(deferred)
      return deferred.promise
    },
    setLoad(mode) {
      loadMode = mode
    },
    setSave(mode) {
      saveMode = mode
    },
    loadCalls: () => loadCount,
    saveCalls: () => saveCount,
    waitForSaveEntry() {
      if (saveCount > 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        saveEntryWaiters.push(resolve)
      })
    },
    savedValues: () => saved.slice(),
    loadSignals: () => loadSignalList.slice(),
    saveSignals: () => saveSignalList.slice(),
    pendingLoads: () => loadDeferreds.length,
    pendingSaves: () => saveDeferreds.length,
    resolveLoad(value) {
      loadDeferreds.shift()?.resolve(value)
    },
    rejectLoad(error) {
      loadDeferreds
        .shift()
        ?.reject(error ?? new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL))
    },
    resolveSave() {
      saveDeferreds.shift()?.resolve(undefined)
    },
    rejectSave(error) {
      saveDeferreds
        .shift()
        ?.reject(error ?? new Error(M1_VTS_PAIRING_PROVIDER_SENTINEL))
    },
  }
}

export interface M1VtsPairingPeer {
  readonly socket: FixtureVtsSocket
  requests(): readonly M1VtsPairingRequest[]
  requestFor(messageType: string): M1VtsPairingRequest | undefined
  replyWith(
    request: M1VtsPairingRequest,
    messageType: string,
    data: unknown,
    overrides?: {
      readonly apiName?: string
      readonly apiVersion?: string
      readonly requestID?: string
    },
  ): string
  respondToken(request: M1VtsPairingRequest, token?: string): string
  respondAuthenticated(request: M1VtsPairingRequest, value?: boolean): string
  respondApiError(request: M1VtsPairingRequest, errorID?: number, message?: string): string
  respondApiState(request: M1VtsPairingRequest): string
  replies(): readonly string[]
  lastReplyFor(messageType: string): string | undefined
  emitRaw(text: string): void
  emitClose(): void
  emitError(): void
  setAutoRespond(value: boolean): void
  setTokenReply(value: M1VtsPairingReply): void
  setAuthReply(value: M1VtsPairingReply): void
  setApiStateAuto(value: boolean): void
}

export interface M1VtsPairingPeerOptions {
  readonly socket: FixtureVtsSocket
}

export function createM1VtsPairingPeer(
  options: M1VtsPairingPeerOptions,
): M1VtsPairingPeer {
  const socket = options.socket
  const requestRecords: M1VtsPairingRequest[] = []
  const replyRecords: string[] = []
  const replyTypes: string[] = []
  let autoRespond = true
  let apiStateAuto = false
  let tokenReply: M1VtsPairingReply = {
    kind: 'token',
    token: M1_VTS_PAIRING_FIXTURE_TOKEN,
  }
  let authReply: M1VtsPairingReply = { kind: 'authenticated', value: true }

  const replyWith = (
    request: M1VtsPairingRequest,
    messageType: string,
    data: unknown,
    overrides: {
      readonly apiName?: string
      readonly apiVersion?: string
      readonly requestID?: string
    } = {},
  ): string => {
    const text = JSON.stringify({
      apiName: overrides.apiName ?? 'VTubeStudioPublicAPI',
      apiVersion: overrides.apiVersion ?? '1.0',
      timestamp: 1,
      requestID: overrides.requestID ?? request.requestID,
      messageType,
      data,
    })
    replyRecords.push(text)
    replyTypes.push(messageType)
    socket.emitMessage(text)
    return text
  }

  const respondApiError = (
    request: M1VtsPairingRequest,
    errorID = 1,
    message = M1_VTS_PAIRING_PROVIDER_SENTINEL,
  ): string => replyWith(request, 'APIError', { errorID, message })

  const respondToken = (
    request: M1VtsPairingRequest,
    token = M1_VTS_PAIRING_FIXTURE_TOKEN,
  ): string => replyWith(request, 'AuthenticationTokenResponse', { authenticationToken: token })

  const respondAuthenticated = (
    request: M1VtsPairingRequest,
    value = true,
  ): string => replyWith(request, 'AuthenticationResponse', { authenticated: value })

  const respondApiState = (request: M1VtsPairingRequest): string =>
    replyWith(request, 'APIStateResponse', { ...M1_VTS_PAIRING_FIXTURE_STATE })

  const applyReply = (request: M1VtsPairingRequest, reply: M1VtsPairingReply): void => {
    switch (reply.kind) {
      case 'token':
        respondToken(request, reply.token)
        return
      case 'authenticated':
        respondAuthenticated(request, reply.value)
        return
      case 'api-error':
        respondApiError(request, reply.errorID, reply.message)
        return
      case 'wire':
        replyWith(request, reply.messageType, reply.data, reply.overrides)
        return
      case 'silent':
        return
    }
  }

  socket.setOnSend((context) => {
    const request = JSON.parse(context.serialized) as M1VtsPairingRequest
    requestRecords.push(request)
    if (!autoRespond) return
    if (request.messageType === 'AuthenticationTokenRequest') {
      applyReply(request, tokenReply)
    } else if (request.messageType === 'AuthenticationRequest') {
      applyReply(request, authReply)
    } else if (request.messageType === 'APIStateRequest' && apiStateAuto) {
      respondApiState(request)
    }
  })

  return {
    socket,
    requests: () => requestRecords.slice(),
    requestFor: (messageType) =>
      requestRecords.find((request) => request.messageType === messageType),
    replyWith,
    respondToken,
    respondAuthenticated,
    respondApiError,
    respondApiState,
    replies: () => replyRecords.slice(),
    lastReplyFor(messageType) {
      for (let index = replyTypes.length - 1; index >= 0; index -= 1) {
        if (replyTypes[index] === messageType) return replyRecords[index]
      }
      return undefined
    },
    emitRaw: (text) => {
      socket.emitMessage(text)
    },
    emitClose: () => {
      socket.emitClose()
    },
    emitError: () => {
      socket.emitError()
    },
    setAutoRespond(value) {
      autoRespond = value
    },
    setTokenReply(value) {
      tokenReply = value
    },
    setAuthReply(value) {
      authReply = value
    },
    setApiStateAuto(value) {
      apiStateAuto = value
    },
  }
}

export interface M1VtsPairingKitOptions {
  readonly socket?: FixtureVtsSocket
  readonly closeTimeoutMs?: number
  readonly credentials?: M1VtsControlledCredentials
  readonly identity?: VtsPairingIdentity
  readonly mode?: VtsPairingOptions['mode']
  readonly requestTimeoutMs?: number
  readonly humanApprovalTimeoutMs?: number
}

export interface M1VtsPairingKit {
  readonly socket: FixtureVtsSocket
  readonly handle: VtsConnectionHandle
  readonly peer: M1VtsPairingPeer
  readonly credentials: M1VtsControlledCredentials
  readonly identity: VtsPairingIdentity
  readonly controller: AbortController
  readonly signal: AbortSignal
  pair(overrides?: Partial<VtsPairingOptions>): Promise<VtsPairingResult>
  options(overrides?: Partial<VtsPairingOptions>): VtsPairingOptions
}

export function createM1VtsPairingKit(
  options: M1VtsPairingKitOptions = {},
): M1VtsPairingKit {
  const socket =
    options.socket ??
    createFixtureVtsSocket({ closeEmission: 'synchronous' })
  const handle = createVtsConnectionHandle({
    socket,
    closeTimeoutMs:
      options.closeTimeoutMs ?? M1_VTS_CONNECTION_DEFAULT_CLOSE_TIMEOUT_MS,
  })
  const peer = createM1VtsPairingPeer({ socket })
  const credentials =
    options.credentials ?? createM1VtsControlledCredentials()
  const identity: VtsPairingIdentity =
    options.identity ?? {
      pluginName: M1_VTS_PAIRING_FIXTURE_PLUGIN_NAME,
      pluginDeveloper: M1_VTS_PAIRING_FIXTURE_PLUGIN_DEVELOPER,
    }
  const controller = new AbortController()
  const signal = controller.signal

  const buildOptions = (overrides: Partial<VtsPairingOptions> = {}): VtsPairingOptions => ({
    handle,
    identity,
    credentials,
    signal,
    mode: options.mode ?? 'existing-only',
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    humanApprovalTimeoutMs: options.humanApprovalTimeoutMs ?? 1000,
    ...overrides,
  })

  return {
    socket,
    handle,
    peer,
    credentials,
    identity,
    controller,
    signal,
    options: buildOptions,
    pair: (overrides = {}) => pairVtsConnection(buildOptions(overrides)),
  }
}

export interface M1VtsPairingCountingSignal {
  readonly signal: AbortSignal
  readonly controller: AbortController
  addCount(): number
  removeCount(): number
}

/** Counts abort listeners added to and removed from the M5-owned signal. */
export function createM1VtsPairingCountingSignal(): M1VtsPairingCountingSignal {
  const controller = new AbortController()
  let adds = 0
  let removes = 0
  const signal = {
    get aborted() {
      return controller.signal.aborted
    },
    get reason() {
      return controller.signal.reason
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      adds += 1
      controller.signal.addEventListener(type, listener as EventListener, options)
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      removes += 1
      controller.signal.removeEventListener(type, listener as EventListener, options)
    },
    dispatchEvent(event: Event): boolean {
      return controller.signal.dispatchEvent(event)
    },
    throwIfAborted() {
      controller.signal.throwIfAborted()
    },
  } as unknown as AbortSignal

  return {
    signal,
    controller,
    addCount: () => adds,
    removeCount: () => removes,
  }
}
