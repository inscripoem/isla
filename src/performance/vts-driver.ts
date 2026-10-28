/**
 * VTube Studio hotkey driver and mapped-renderer composition (M1-02 increment C).
 *
 * A semantic capability action maps to one exact VTS hotkey. Every dispatch
 * rechecks the live API session, the currently loaded model and that model's
 * hotkey inventory before attempting one trigger. The driver reports only
 * acceptance or an honest failure/unknown outcome; it never claims an animation
 * started or completed, never retries and never replays a trigger.
 */

import type { CapabilitySnapshot, RendererPort } from '../contracts/app'
import { NO_OP_ACTION, capabilitySnapshotSchema } from '../contracts/app'
import type { DeadlineGate, ReceiptTools } from './browser/types'
import type { RendererDriver, RendererObservation } from './mapped-renderer'
import { createMappedRenderer } from './mapped-renderer'
import type { VtsCallResult, VtsClient, VtsFailureCode, VtsTransport } from './vts-client'
import { createVtsClient } from './vts-client'

/** One immutable semantic action -> exact VTS hotkey mapping. */
export interface VtsActionMapping {
  readonly actionId: string
  readonly hotkeyId: string
}

export interface VtsRendererDeps {
  readonly transport: VtsTransport
  readonly modelId: string
  readonly rendererId: string
  readonly characterId: string
  readonly capabilityRevision: number
  readonly mappings: readonly VtsActionMapping[]
  readonly timeoutMs: number
  readonly maxPending: number
  readonly deadlineGate: DeadlineGate
  readonly receipts: ReceiptTools
}

/** Lifecycle-owning driver used by the mapped renderer. */
export interface VtsHotkeyDriver extends RendererDriver {
  /** Permanently disable this instance and close its owned transport. */
  invalidate(): void
  /** Alias of {@link VtsHotkeyDriver.invalidate}; idempotent. */
  dispose(): void
  isInvalidated(): boolean
  isDisposed(): boolean
}

export interface VtsRenderer {
  readonly renderer: RendererPort
  readonly driver: VtsHotkeyDriver
  capabilities(): CapabilitySnapshot
  invalidate(): void
  dispose(): void
}

interface NormalizedMapping {
  readonly actionId: string
  readonly hotkeyId: string
}

const CAPABILITY_REASON = {
  unavailable: 'vts_unavailable',
  timeout: 'vts_timeout',
  protocol: 'vts_protocol_error',
  apiError: 'vts_api_error',
  apiInactive: 'vts_api_inactive',
  unauthorized: 'vts_session_unauthorized',
  modelUnavailable: 'vts_model_unavailable',
  modelMismatch: 'vts_model_mismatch',
  hotkeyMissing: 'vts_hotkey_missing',
  invalidated: 'vts_instance_invalidated',
  disposed: 'vts_instance_disposed',
  busy: 'vts_busy',
  unknownMapping: 'vts_unknown_mapping',
  aborted: 'aborted_before_trigger',
  triggerUnknown: 'vts_trigger_unknown',
} as const

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function normalizeMappings(mappings: readonly VtsActionMapping[]): NormalizedMapping[] {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new Error('vts-driver: at least one action mapping is required')
  }
  const seenActions = new Set<string>()
  const seenHotkeys = new Set<string>()
  const normalized: NormalizedMapping[] = []
  for (const mapping of mappings) {
    if (!isNonEmptyString(mapping.actionId) || !isNonEmptyString(mapping.hotkeyId)) {
      throw new Error('vts-driver: mapping actionId and hotkeyId must be nonempty strings')
    }
    if (mapping.actionId === NO_OP_ACTION || mapping.hotkeyId === NO_OP_ACTION) {
      throw new Error('vts-driver: no-op mappings are not dispatched')
    }
    if (seenActions.has(mapping.actionId)) {
      throw new Error(`vts-driver: duplicate mapping for action ${mapping.actionId}`)
    }
    if (seenHotkeys.has(mapping.hotkeyId)) {
      throw new Error(`vts-driver: duplicate hotkey mapping for ${mapping.hotkeyId}`)
    }
    seenActions.add(mapping.actionId)
    seenHotkeys.add(mapping.hotkeyId)
    normalized.push({ actionId: mapping.actionId, hotkeyId: mapping.hotkeyId })
  }
  return normalized
}

function validateIdentity(deps: VtsRendererDeps): void {
  if (!isNonEmptyString(deps.modelId)) throw new Error('vts-driver: modelId must be nonempty')
  if (!isNonEmptyString(deps.rendererId)) throw new Error('vts-driver: rendererId must be nonempty')
  if (!isNonEmptyString(deps.characterId)) throw new Error('vts-driver: characterId must be nonempty')
  if (
    typeof deps.capabilityRevision !== 'number' ||
    !Number.isInteger(deps.capabilityRevision) ||
    deps.capabilityRevision < 0
  ) {
    throw new Error('vts-driver: capabilityRevision must be a nonnegative integer')
  }
}

function buildSnapshot(
  deps: VtsRendererDeps,
  mappings: readonly NormalizedMapping[],
): CapabilitySnapshot {
  const snapshot = {
    rendererId: deps.rendererId,
    characterId: deps.characterId,
    capabilityRevision: deps.capabilityRevision,
    actions: mappings.map((mapping) => ({
      actionId: mapping.actionId,
      description: `VTube Studio hotkey action ${mapping.actionId}`,
      observability: 'acceptance-only' as const,
      parameterBounds: [],
    })),
  }
  const parsed = capabilitySnapshotSchema.safeParse(snapshot)
  if (!parsed.success) throw new Error('vts-driver: invalid capability configuration')
  return parsed.data
}

function queryFailureReason(
  code: VtsFailureCode,
  invalidated: boolean,
  disposed: boolean,
  signal: AbortSignal,
): { readonly ok: false; readonly stage: 'failed' | 'cancelled'; readonly reasonCode: string } {
  if (invalidated) {
    return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.invalidated }
  }
  if (disposed) return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.disposed }
  if (signal.aborted || code === 'aborted') {
    return { ok: false, stage: 'cancelled', reasonCode: CAPABILITY_REASON.aborted }
  }
  if (code === 'timeout') {
    return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.timeout }
  }
  if (code === 'protocol_error') {
    return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.protocol }
  }
  if (code === 'busy') return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.busy }
  if (code === 'disposed') {
    return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.disposed }
  }
  return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.unavailable }
}

type PreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: 'failed' | 'cancelled'; readonly reasonCode: string }

export function createVtsRenderer(deps: VtsRendererDeps): VtsRenderer {
  validateIdentity(deps)
  // Immutable configuration is captured once. Later reads must never consult
  // caller-owned objects, or a mutation could retarget this capability revision.
  const modelId = deps.modelId
  const mappings = normalizeMappings(deps.mappings)
  const snapshot = buildSnapshot(deps, mappings)
  const bindings = mappings.map((mapping) => ({
    actionId: mapping.actionId,
    driverAction: mapping.hotkeyId,
  }))
  const allowedHotkeys = new Set(mappings.map((mapping) => mapping.hotkeyId))

  const client: VtsClient = createVtsClient({
    transport: deps.transport,
    timeoutMs: deps.timeoutMs,
    maxPending: deps.maxPending,
  })

  let invalidated = false
  let disposed = false
  let active = false

  const observe = (
    stage: RendererObservation['stage'],
    reasonCode: string | null,
  ): RendererObservation => ({
    stage,
    reasonCode,
    localTimeMs: deps.receipts.localNowMs(),
  })

  const invalidate = (): void => {
    if (disposed) return
    invalidated = true
    disposed = true
    client.dispose()
  }

  const preflight = async (hotkeyId: string, signal: AbortSignal): Promise<PreflightResult> => {
    const stopped = (): PreflightResult | null => {
      if (invalidated) {
        return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.invalidated }
      }
      if (disposed) {
        return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.invalidated }
      }
      if (signal.aborted) {
        return { ok: false, stage: 'cancelled', reasonCode: CAPABILITY_REASON.aborted }
      }
      return null
    }

    const handleFailure = (result: VtsCallResult<unknown>): PreflightResult => {
      if (result.kind === 'ok') return { ok: true }
      if (result.kind === 'api_error') {
        const state = stopped()
        return state ?? { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.apiError }
      }
      const state = stopped()
      return (
        state ??
        queryFailureReason(result.code, invalidated, disposed, signal)
      )
    }

    let state = stopped()
    if (state !== null) return state

    const apiState = await client.apiState(signal)
    if (apiState.kind !== 'ok') return handleFailure(apiState)
    state = stopped()
    if (state !== null) return state
    if (!apiState.data.active) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.apiInactive }
    }
    if (!apiState.data.currentSessionAuthenticated) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.unauthorized }
    }

    const current = await client.currentModel(signal)
    if (current.kind !== 'ok') return handleFailure(current)
    state = stopped()
    if (state !== null) return state
    if (!current.data.modelLoaded) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.modelUnavailable }
    }
    if (current.data.modelID !== modelId) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.modelMismatch }
    }

    const hotkeys = await client.hotkeysInCurrentModel(signal)
    if (hotkeys.kind !== 'ok') return handleFailure(hotkeys)
    state = stopped()
    if (state !== null) return state
    if (!hotkeys.data.modelLoaded) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.modelUnavailable }
    }
    if (hotkeys.data.modelID !== modelId) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.modelMismatch }
    }
    if (!hotkeys.data.availableHotkeys.some((hotkey) => hotkey.hotkeyID === hotkeyId)) {
      return { ok: false, stage: 'failed', reasonCode: CAPABILITY_REASON.hotkeyMissing }
    }
    return { ok: true }
  }

  const trigger = async (
    hotkeyId: string,
    signal: AbortSignal,
  ): Promise<RendererObservation> => {
    const result = await client.triggerHotkey(hotkeyId, signal)
    if (result.kind === 'ok') {
      if (result.data.hotkeyID !== hotkeyId) {
        return observe('unknown', CAPABILITY_REASON.triggerUnknown)
      }
      return observe('accepted', null)
    }
    if (result.kind === 'api_error') {
      return observe('failed', CAPABILITY_REASON.apiError)
    }
    if (result.code === 'aborted' && !result.attempted) {
      return observe('cancelled', CAPABILITY_REASON.aborted)
    }
    if (!result.attempted) {
      if (result.code === 'disposed') {
        return observe('failed', CAPABILITY_REASON.disposed)
      }
      if (result.code === 'busy') return observe('failed', CAPABILITY_REASON.busy)
      if (result.code === 'timeout') return observe('failed', CAPABILITY_REASON.timeout)
      if (result.code === 'protocol_error') {
        return observe('failed', CAPABILITY_REASON.protocol)
      }
      return observe('failed', CAPABILITY_REASON.unavailable)
    }
    // Once send was attempted, no later abort/close/error/timeout/malformed
    // frame proves the trigger had no effect. Report an honest unknown.
    return observe('unknown', CAPABILITY_REASON.triggerUnknown)
  }

  const driver: VtsHotkeyDriver = {
    async dispatch(driverAction, signal) {
      if (invalidated) return observe('failed', CAPABILITY_REASON.invalidated)
      if (disposed) return observe('failed', CAPABILITY_REASON.disposed)
      if (signal.aborted) return observe('cancelled', CAPABILITY_REASON.aborted)
      if (!allowedHotkeys.has(driverAction)) {
        return observe('failed', CAPABILITY_REASON.unknownMapping)
      }
      if (active) return observe('failed', CAPABILITY_REASON.busy)
      active = true
      try {
        const checked = await preflight(driverAction, signal)
        if (!checked.ok) return observe(checked.stage, checked.reasonCode)
        if (invalidated) return observe('failed', CAPABILITY_REASON.invalidated)
        if (disposed) return observe('failed', CAPABILITY_REASON.disposed)
        if (signal.aborted) return observe('cancelled', CAPABILITY_REASON.aborted)
        return await trigger(driverAction, signal)
      } finally {
        active = false
      }
    },
    invalidate,
    dispose: invalidate,
    isInvalidated: () => invalidated,
    isDisposed: () => disposed,
  }

  let renderer: RendererPort
  try {
    renderer = createMappedRenderer({
      snapshot,
      bindings,
      driver,
      deadlineGate: deps.deadlineGate,
      receipts: deps.receipts,
    })
  } catch (error) {
    invalidate()
    throw error
  }

  return {
    renderer,
    driver,
    capabilities: () => renderer.capabilities(),
    invalidate,
    dispose: invalidate,
  }
}
