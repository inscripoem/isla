import type { VtsConnectionHandle } from '../../src/performance/vts-connection'
import { createVtsConnectionHandle } from '../../src/performance/vts-connection'
import type { VtsPairingIdentity } from '../../src/performance/vts-pairing'
import type {
  VtsAcquisition,
  VtsCredentialCoordinator,
  VtsCredentialRecord,
  VtsCredentialStore,
} from '../../src/runtime/vts-acquisition'
import { createVtsAcquisition, createVtsCredentialCoordinator } from '../../src/runtime/vts-acquisition'
import type { FixtureVtsSocket } from './m1-vts-connection-kit'
import {
  M1_VTS_CONNECTION_DEFAULT_CLOSE_TIMEOUT_MS,
  createFixtureVtsSocket,
} from './m1-vts-connection-kit'
import type { M1VtsPairingPeer } from './m1-vts-pairing-kit'
import {
  M1_VTS_PAIRING_FIXTURE_PLUGIN_DEVELOPER,
  M1_VTS_PAIRING_FIXTURE_PLUGIN_NAME,
  M1_VTS_PAIRING_FIXTURE_TOKEN,
  createM1VtsPairingPeer,
} from './m1-vts-pairing-kit'

/**
 * Controlled peers and a controlled multi-record credential store for the M5
 * acquisition lifecycle.
 *
 * Every attempt receives a real D1 connection handle over the fixture socket
 * and a real D2 pairing peer. The external socket, connector timing and
 * credential store are substituted; the production acquisition module, the
 * real pairing primitive and the real protocol client are exercised unchanged.
 * Nothing here connects to, authenticates with or verifies a live VTube Studio
 * instance.
 */

export const M5_VTS_ACQUISITION_FIXTURE_TARGET = 'fixture-record-target'

export type M5VtsStoreMode =
  | { readonly kind: 'stored' }
  | { readonly kind: 'value'; readonly value: string | null }
  | { readonly kind: 'reject'; readonly error?: unknown }
  | { readonly kind: 'throw'; readonly error?: unknown }
  | { readonly kind: 'hang' }

export interface M5VtsStoreOperation {
  readonly kind: 'load' | 'save'
  readonly record: VtsCredentialRecord
  /** The attempted value for a save; null for a load. */
  readonly value: string | null
  readonly signal: AbortSignal
}

export interface M5VtsControlledStore extends VtsCredentialStore {
  seed(record: VtsCredentialRecord, value: string): void
  valueOf(record: VtsCredentialRecord): string | null
  setLoad(mode: M5VtsStoreMode): void
  setSave(mode: M5VtsStoreMode): void
  setSaveFor(record: VtsCredentialRecord, mode: M5VtsStoreMode): void
  /** Runs synchronously when a save enters the store, before it returns. */
  setSaveEntryHook(hook: (() => void) | null): void
  loads(): readonly M5VtsStoreOperation[]
  saves(): readonly M5VtsStoreOperation[]
  loadCalls(): number
  saveCalls(): number
  waitForSaveEntry(): Promise<void>
  resolveLoad(value: string | null): void
  resolveSave(): void
}

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

function storeKey(record: VtsCredentialRecord): string {
  return JSON.stringify([record.pluginName, record.pluginDeveloper, record.target])
}

interface PendingSave {
  readonly deferred: Deferred<void>
  readonly key: string
  readonly value: string
}

export function createM5VtsControlledStore(): M5VtsControlledStore {
  const values = new Map<string, string>()
  const saveModes = new Map<string, M5VtsStoreMode>()
  const operationsLog: M5VtsStoreOperation[] = []
  const saved: string[] = []
  const loadDeferreds: Array<Deferred<string | null>> = []
  const saveDeferreds: PendingSave[] = []
  const saveEntryWaiters: Array<() => void> = []
  let defaultLoad: M5VtsStoreMode = { kind: 'stored' }
  let defaultSave: M5VtsStoreMode = { kind: 'stored' }
  let saveEntryHook: (() => void) | null = null

  const notifySaveEntry = (): void => {
    for (const resolve of saveEntryWaiters) resolve()
    saveEntryWaiters.length = 0
  }

  const record = (
    kind: 'load' | 'save',
    target: VtsCredentialRecord,
    value: string | null,
    signal: AbortSignal,
  ): void => {
    operationsLog.push({ kind, record: target, value, signal })
  }

  const runSaveMode = (
    mode: M5VtsStoreMode,
    key: string,
    value: string,
  ): Promise<void> => {
    switch (mode.kind) {
      case 'stored':
      case 'value':
        values.set(key, value)
        return Promise.resolve()
      case 'throw':
        throw mode.error ?? new Error('fixture store failure')
      case 'reject':
        return Promise.reject(mode.error ?? new Error('fixture store failure'))
      case 'hang': {
        const deferred = createDeferred<void>()
        saveDeferreds.push({ deferred, key, value })
        return deferred.promise
      }
    }
  }

  return {
    load(target, signal) {
      record('load', target, null, signal)
      const mode = defaultLoad
      switch (mode.kind) {
        case 'stored':
          return Promise.resolve(values.get(storeKey(target)) ?? null)
        case 'value':
          return Promise.resolve(mode.value)
        case 'throw':
          throw mode.error ?? new Error('fixture store failure')
        case 'reject':
          return Promise.reject(mode.error ?? new Error('fixture store failure'))
        case 'hang': {
          const deferred = createDeferred<string | null>()
          loadDeferreds.push(deferred)
          return deferred.promise
        }
      }
    },
    save(target, value, signal) {
      record('save', target, value, signal)
      saved.push(value)
      notifySaveEntry()
      const hook = saveEntryHook
      if (hook !== null) hook()
      const key = storeKey(target)
      return runSaveMode(saveModes.get(key) ?? defaultSave, key, value)
    },
    seed(target, value) {
      values.set(storeKey(target), value)
    },
    valueOf(target) {
      return values.get(storeKey(target)) ?? null
    },
    setLoad(mode) {
      defaultLoad = mode
    },
    setSave(mode) {
      defaultSave = mode
    },
    setSaveFor(target, mode) {
      saveModes.set(storeKey(target), mode)
    },
    setSaveEntryHook(hook) {
      saveEntryHook = hook
    },
    loads: () => operationsLog.filter((operation) => operation.kind === 'load'),
    saves: () => operationsLog.filter((operation) => operation.kind === 'save'),
    loadCalls: () => operationsLog.filter((operation) => operation.kind === 'load').length,
    saveCalls: () => operationsLog.filter((operation) => operation.kind === 'save').length,
    waitForSaveEntry() {
      if (saved.length > 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        saveEntryWaiters.push(resolve)
      })
    },
    resolveLoad(value) {
      loadDeferreds.shift()?.resolve(value)
    },
    resolveSave() {
      const pending = saveDeferreds.shift()
      if (pending === undefined) return
      // A delayed successful write stores the value that was admitted to the
      // store; a rejection path never mutates the stored record.
      values.set(pending.key, pending.value)
      pending.deferred.resolve(undefined)
    },
  }
}

/**
 * Wrap a real D1 handle so D2's pairing subscription release throws while the
 * connection, transport and close behavior remain the real fixture path.
 */
export function createM5VtsReleasingFailureHandle(
  handle: VtsConnectionHandle,
): VtsConnectionHandle {
  let releaseThrown = false
  return {
    transport: {
      send: (serialized) => handle.transport.send(serialized),
      subscribe: (listener) => {
        const release = handle.transport.subscribe(listener)
        return () => {
          release()
          if (!releaseThrown) {
            releaseThrown = true
            throw new Error('fixture pairing unsubscribe failure')
          }
        }
      },
      dispose: () => handle.transport.dispose(),
    },
    closed: handle.closed,
    close: () => handle.close(),
  }
}

export interface M5VtsAcquisitionAttempt {
  readonly index: number
  readonly socket: FixtureVtsSocket
  readonly handle: VtsConnectionHandle
  readonly peer: M1VtsPairingPeer
}

export type M5VtsConnectHook = (
  attempt: M5VtsAcquisitionAttempt,
  signal: AbortSignal,
) => void | Promise<void>

export interface M5VtsAcquisitionKitOptions {
  readonly store?: M5VtsControlledStore
  readonly coordinator?: VtsCredentialCoordinator
  readonly identity?: VtsPairingIdentity
  readonly target?: string
  readonly mode?: 'existing-only' | 'allow-prompt'
  readonly acquisitionTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly humanApprovalTimeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly socket?: (index: number) => FixtureVtsSocket
  readonly wrapHandle?: (handle: VtsConnectionHandle) => VtsConnectionHandle
}

export interface M5VtsAcquisitionKit {
  readonly acquisition: VtsAcquisition
  readonly store: M5VtsControlledStore
  readonly coordinator: VtsCredentialCoordinator
  readonly identity: VtsPairingIdentity
  readonly target: string
  readonly record: VtsCredentialRecord
  attempts(): readonly M5VtsAcquisitionAttempt[]
  connectCount(): number
  holdConnections(value: boolean): void
  releaseConnections(): void
  failNextConnect(error?: unknown): void
  setSocketFactory(factory: (index: number) => FixtureVtsSocket): void
  setOnConnect(hook: M5VtsConnectHook | null): void
}

interface Gate {
  readonly promise: Promise<void>
  resolve(): void
}

function createGate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

export function createM5VtsAcquisitionKit(
  options: M5VtsAcquisitionKitOptions = {},
): M5VtsAcquisitionKit {
  const store = options.store ?? createM5VtsControlledStore()
  const coordinator = options.coordinator ?? createVtsCredentialCoordinator(store)
  const identity: VtsPairingIdentity =
    options.identity ?? {
      pluginName: M1_VTS_PAIRING_FIXTURE_PLUGIN_NAME,
      pluginDeveloper: M1_VTS_PAIRING_FIXTURE_PLUGIN_DEVELOPER,
    }
  const target = options.target ?? M5_VTS_ACQUISITION_FIXTURE_TARGET
  const record: VtsCredentialRecord = Object.freeze({
    pluginName: identity.pluginName,
    pluginDeveloper: identity.pluginDeveloper,
    target,
  })
  if (options.store === undefined) {
    // The default fixture store behaves like the pre-existing pairing kit: one
    // valid token is already stored for the fixture record.
    store.seed(record, M1_VTS_PAIRING_FIXTURE_TOKEN)
  }
  const closeTimeoutMs =
    options.closeTimeoutMs ?? M1_VTS_CONNECTION_DEFAULT_CLOSE_TIMEOUT_MS

  const attempts: M5VtsAcquisitionAttempt[] = []
  let connectCalls = 0
  let hold = false
  let gate = createGate()
  let pendingFailure: unknown = null
  let onConnect: M5VtsConnectHook | null = null
  let socketFactory: (index: number) => FixtureVtsSocket =
    options.socket ?? (() => createFixtureVtsSocket({ closeEmission: 'synchronous' }))
  const wrapHandle =
    options.wrapHandle ?? ((handle: VtsConnectionHandle): VtsConnectionHandle => handle)

  const releaseConnections = (): void => {
    hold = false
    const resolving = gate
    gate = createGate()
    resolving.resolve()
  }

  const connect = async (signal: AbortSignal): Promise<VtsConnectionHandle> => {
    const index = connectCalls
    connectCalls += 1
    if (pendingFailure !== null) {
      const error = pendingFailure
      pendingFailure = null
      throw error
    }
    if (hold) await gate.promise

    const socket = socketFactory(index)
    const handle = wrapHandle(createVtsConnectionHandle({ socket, closeTimeoutMs }))
    const peer = createM1VtsPairingPeer({ socket })
    const attempt: M5VtsAcquisitionAttempt = { index, socket, handle, peer }
    attempts.push(attempt)

    const hook = onConnect
    if (hook !== null) await hook(attempt, signal)
    return handle
  }

  const acquisition = createVtsAcquisition({
    connect,
    credentials: coordinator,
    identity,
    target,
    mode: options.mode ?? 'existing-only',
    acquisitionTimeoutMs: options.acquisitionTimeoutMs ?? 5_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    humanApprovalTimeoutMs: options.humanApprovalTimeoutMs ?? 1_000,
  })

  return {
    acquisition,
    store,
    coordinator,
    identity,
    target,
    record,
    attempts: () => attempts.slice(),
    connectCount: () => connectCalls,
    holdConnections(value) {
      hold = value
      if (value) gate = createGate()
      else releaseConnections()
    },
    releaseConnections,
    failNextConnect(error) {
      pendingFailure = error ?? new Error('fixture connector failure')
    },
    setSocketFactory(factory) {
      socketFactory = factory
    },
    setOnConnect(hook) {
      onConnect = hook
    },
  }
}
