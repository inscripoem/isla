import type {
  VtsTransport,
  VtsTransportEvent,
} from '../../src/performance/vts-client'
import type {
  VtsActionMapping,
  VtsRenderer,
  VtsRendererDeps,
} from '../../src/performance/vts-driver'
import { createVtsRenderer } from '../../src/performance/vts-driver'
import type { TestDeadlineGate, TestReceiptTools } from './m1-kit'
import { createTestDeadlineGate, createTestReceiptTools } from './m1-kit'

/**
 * Controlled fixture peers for the increment C VTS protocol client and driver.
 *
 * Every constant below is a fixture identifier. Nothing here connects to,
 * authenticates with or verifies a live VTube Studio instance: only the
 * external socket/device is substituted, while the tests exercise the real
 * production client and driver.
 */

export const M1_VTS_FIXTURE_MODEL_ID = 'fixture-vts-model'
export const M1_VTS_FIXTURE_RENDERER_ID = 'vts-renderer-fixture'
export const M1_VTS_FIXTURE_CHARACTER_ID = 'character-fixture'
export const M1_VTS_FIXTURE_VERSION = 'fixture-vts-1.0'
export const M1_VTS_FIXTURE_TIMESTAMP = 1_234_567_890
export const M1_VTS_FIXTURE_HOTKEY_NEUTRAL = 'fixture-hotkey-neutral'
export const M1_VTS_FIXTURE_HOTKEY_SMILE = 'fixture-hotkey-smile'

export const M1_VTS_DEFAULT_MAPPINGS: readonly VtsActionMapping[] = [
  { actionId: 'neutral', hotkeyId: M1_VTS_FIXTURE_HOTKEY_NEUTRAL },
  { actionId: 'smile', hotkeyId: M1_VTS_FIXTURE_HOTKEY_SMILE },
]

export interface FixtureVtsHotkey {
  readonly hotkeyID: string
  readonly name: string
  readonly type: string
}

export const M1_VTS_FIXTURE_HOTKEYS: readonly FixtureVtsHotkey[] = [
  {
    hotkeyID: M1_VTS_FIXTURE_HOTKEY_NEUTRAL,
    name: 'Fixture Neutral',
    type: 'TriggerAnimation',
  },
  {
    hotkeyID: M1_VTS_FIXTURE_HOTKEY_SMILE,
    name: 'Fixture Smile',
    type: 'TriggerAnimation',
  },
]

export interface FixtureVtsRequest {
  readonly apiName: unknown
  readonly apiVersion: unknown
  readonly requestID: string
  readonly messageType: string
  readonly data: unknown
}

export interface FixtureVtsPeerState {
  active: boolean
  vTubeStudioVersion: string
  currentSessionAuthenticated: boolean
  currentModelLoaded: boolean
  currentModelID: string
  hotkeysModelLoaded: boolean
  hotkeysModelID: string
  availableHotkeys: FixtureVtsHotkey[]
  /** null echoes the requested hotkey; any other value is the executed id. */
  triggerHotkeyID: string | null
  apiErrorMessageTypes: string[]
}

export interface ScriptedVtsTransport extends VtsTransport {
  sendCount(): number
  subscribeCount(): number
  unsubscribeCount(): number
  disposeCount(): number
  hasListener(): boolean
  requests(): FixtureVtsRequest[]
  pendingRequests(): FixtureVtsRequest[]
  sentRaw(): string[]
  emit(event: VtsTransportEvent): boolean
  emitRaw(data: unknown): boolean
  respondTo(request: FixtureVtsRequest, event: VtsTransportEvent): boolean
  emitClose(): boolean
  emitError(): boolean
  emitDuringSubscribe(events: readonly VtsTransportEvent[]): void
  setAutoRespond(value: boolean): void
  setHoldTypes(types: readonly string[]): void
  releaseNext(): FixtureVtsRequest | null
  setSendThrowsFor(types: readonly string[]): void
  setSubscribeThrows(value: boolean): void
  setOnSend(hook: ((request: FixtureVtsRequest) => void) | null): void
}

export interface FixtureVtsPeer {
  readonly transport: ScriptedVtsTransport
  readonly state: FixtureVtsPeerState
}

function asRequest(value: unknown): FixtureVtsRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.requestID !== 'string' || typeof record.messageType !== 'string') return null
  return {
    apiName: record.apiName,
    apiVersion: record.apiVersion,
    requestID: record.requestID,
    messageType: record.messageType,
    data: record.data,
  }
}

function fixtureRequestedHotkey(request: FixtureVtsRequest): string | null {
  if (request.data === null || typeof request.data !== 'object') return null
  const hotkeyID = (request.data as { hotkeyID?: unknown }).hotkeyID
  return typeof hotkeyID === 'string' ? hotkeyID : null
}

/** Build one VTS-shaped response envelope around a fixture request. */
export function fixtureVtsResponse(
  request: FixtureVtsRequest,
  messageType: string,
  data: unknown,
  overrides: { requestID?: string; apiName?: string; apiVersion?: string } = {},
): VtsTransportEvent {
  return {
    type: 'message',
    data: {
      apiName: overrides.apiName ?? 'VTubeStudioPublicAPI',
      apiVersion: overrides.apiVersion ?? '1.0',
      timestamp: M1_VTS_FIXTURE_TIMESTAMP,
      requestID: overrides.requestID ?? request.requestID,
      messageType,
      data,
    },
  }
}

export function fixtureVtsApiError(request: FixtureVtsRequest, errorID = 1): VtsTransportEvent {
  return fixtureVtsResponse(request, 'APIError', {
    errorID,
    message: 'fixture refusal; never re-emitted by production code',
  })
}

/** The default deterministic peer script for the four protocol requests. */
export function fixtureVtsResponseFor(
  request: FixtureVtsRequest,
  state: FixtureVtsPeerState,
): VtsTransportEvent {
  if (state.apiErrorMessageTypes.includes(request.messageType)) {
    return fixtureVtsApiError(request)
  }
  switch (request.messageType) {
    case 'APIStateRequest':
      return fixtureVtsResponse(request, 'APIStateResponse', {
        active: state.active,
        vTubeStudioVersion: state.vTubeStudioVersion,
        currentSessionAuthenticated: state.currentSessionAuthenticated,
      })
    case 'CurrentModelRequest':
      return fixtureVtsResponse(request, 'CurrentModelResponse', {
        modelLoaded: state.currentModelLoaded,
        modelID: state.currentModelID,
        modelName: 'Fixture descriptive name is not identity proof',
      })
    case 'HotkeysInCurrentModelRequest':
      return fixtureVtsResponse(request, 'HotkeysInCurrentModelResponse', {
        modelLoaded: state.hotkeysModelLoaded,
        modelID: state.hotkeysModelID,
        availableHotkeys: state.availableHotkeys.map((hotkey) => ({ ...hotkey })),
      })
    case 'HotkeyTriggerRequest':
      return fixtureVtsResponse(request, 'HotkeyTriggerResponse', {
        hotkeyID: state.triggerHotkeyID ?? fixtureRequestedHotkey(request),
      })
    default:
      return fixtureVtsApiError(request)
  }
}

export function createFixtureVtsPeer(
  overrides: Partial<FixtureVtsPeerState> = {},
): FixtureVtsPeer {
  const state: FixtureVtsPeerState = {
    active: true,
    vTubeStudioVersion: M1_VTS_FIXTURE_VERSION,
    currentSessionAuthenticated: true,
    currentModelLoaded: true,
    currentModelID: M1_VTS_FIXTURE_MODEL_ID,
    hotkeysModelLoaded: true,
    hotkeysModelID: M1_VTS_FIXTURE_MODEL_ID,
    availableHotkeys: M1_VTS_FIXTURE_HOTKEYS.map((hotkey) => ({ ...hotkey })),
    triggerHotkeyID: null,
    apiErrorMessageTypes: [],
    ...overrides,
  }

  let listener: ((event: VtsTransportEvent) => void) | null = null
  let sends = 0
  let subscriptions = 0
  let unsubscriptions = 0
  let disposals = 0
  let autoRespond = true
  let subscribeThrows = false
  const holdTypes = new Set<string>()
  const sendThrowsFor = new Set<string>()
  const records: FixtureVtsRequest[] = []
  const raw: string[] = []
  const waiting: FixtureVtsRequest[] = []
  let onSend: ((request: FixtureVtsRequest) => void) | null = null
  let duringSubscribe: VtsTransportEvent[] = []

  const removeWaiting = (request: FixtureVtsRequest): void => {
    const index = waiting.findIndex((entry) => entry.requestID === request.requestID)
    if (index >= 0) waiting.splice(index, 1)
  }

  const emit = (event: VtsTransportEvent): boolean => {
    const active = listener
    if (active === null) return false
    active(event)
    return true
  }

  const deliver = (request: FixtureVtsRequest): void => {
    removeWaiting(request)
    emit(fixtureVtsResponseFor(request, state))
  }

  const transport: ScriptedVtsTransport = {
    send(serialized) {
      sends += 1
      raw.push(serialized)
      const parsed = asRequest(JSON.parse(serialized))
      if (parsed === null) throw new Error('fixture transport: malformed serialized request')
      records.push(parsed)
      if (onSend !== null) onSend(parsed)
      if (sendThrowsFor.has(parsed.messageType)) {
        throw new Error('fixture transport: scripted send fault')
      }
      waiting.push(parsed)
      if (autoRespond && !holdTypes.has(parsed.messageType)) {
        queueMicrotask(() => {
          if (waiting.some((entry) => entry.requestID === parsed.requestID)) deliver(parsed)
        })
      }
    },
    subscribe(next) {
      subscriptions += 1
      if (subscribeThrows) throw new Error('fixture transport: scripted subscribe fault')
      listener = next
      for (const event of duringSubscribe) next(event)
      duringSubscribe = []
      return () => {
        unsubscriptions += 1
        if (listener === next) listener = null
      }
    },
    dispose() {
      if (disposals > 0) return
      disposals += 1
      listener = null
      waiting.length = 0
    },
    sendCount: () => sends,
    subscribeCount: () => subscriptions,
    unsubscribeCount: () => unsubscriptions,
    disposeCount: () => disposals,
    hasListener: () => listener !== null,
    requests: () => records.slice(),
    pendingRequests: () => waiting.slice(),
    sentRaw: () => raw.slice(),
    emit,
    emitRaw(data) {
      return emit({ type: 'message', data })
    },
    respondTo(request, event) {
      removeWaiting(request)
      return emit(event)
    },
    emitClose: () => emit({ type: 'close' }),
    emitError: () => emit({ type: 'error' }),
    emitDuringSubscribe(events) {
      duringSubscribe = [...events]
    },
    setAutoRespond(value) {
      autoRespond = value
    },
    setHoldTypes(types) {
      holdTypes.clear()
      for (const type of types) holdTypes.add(type)
    },
    releaseNext() {
      const next = waiting.shift()
      if (next === undefined) return null
      emit(fixtureVtsResponseFor(next, state))
      return next
    },
    setSendThrowsFor(types) {
      sendThrowsFor.clear()
      for (const type of types) sendThrowsFor.add(type)
    },
    setSubscribeThrows(value) {
      subscribeThrows = value
    },
    setOnSend(hook) {
      onSend = hook
    },
  }

  return { transport, state }
}

export interface M1VtsRendererKit {
  readonly peer: FixtureVtsPeer
  readonly renderer: VtsRenderer
  readonly gate: TestDeadlineGate
  readonly receipts: TestReceiptTools
}

export function createM1VtsRendererKit(
  overrides: {
    peer?: FixtureVtsPeer
    mappings?: readonly VtsActionMapping[]
    modelId?: string
    rendererId?: string
    characterId?: string
    capabilityRevision?: number
    timeoutMs?: number
    maxPending?: number
    gate?: TestDeadlineGate
    receipts?: TestReceiptTools
  } = {},
): M1VtsRendererKit {
  const peer = overrides.peer ?? createFixtureVtsPeer()
  const gate = overrides.gate ?? createTestDeadlineGate()
  const receipts = overrides.receipts ?? createTestReceiptTools('vts')
  const deps: VtsRendererDeps = {
    transport: peer.transport,
    modelId: overrides.modelId ?? M1_VTS_FIXTURE_MODEL_ID,
    rendererId: overrides.rendererId ?? M1_VTS_FIXTURE_RENDERER_ID,
    characterId: overrides.characterId ?? M1_VTS_FIXTURE_CHARACTER_ID,
    capabilityRevision: overrides.capabilityRevision ?? 1,
    mappings: overrides.mappings ?? M1_VTS_DEFAULT_MAPPINGS,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    maxPending: overrides.maxPending ?? 4,
    deadlineGate: gate,
    receipts,
  }
  return { peer, renderer: createVtsRenderer(deps), gate, receipts }
}
