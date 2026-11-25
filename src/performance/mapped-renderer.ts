import type {
  CapabilitySnapshot,
  PerformanceCommand,
  PerformanceReceipt,
  RendererPort,
} from '../contracts/app'
import {
  NO_OP_ACTION,
  capabilitySnapshotSchema,
  performanceCommandSchema,
  performanceReceiptSchema,
} from '../contracts/app'
import type { DeadlineGate, ReceiptTools } from './browser/types'

/** Execution stages a low-level driver may report. */
export type RendererStage =
  | 'accepted'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unknown'

const VALID_STAGES: ReadonlySet<string> = new Set([
  'accepted',
  'started',
  'completed',
  'cancelled',
  'failed',
  'unknown',
])

/** Capability observability labels must never be reported as execution stages. */
const OBSERVABILITY_LABELS: ReadonlySet<string> = new Set(['observable', 'acceptance-only'])

export const MAPPED_RENDERER_SOURCE = 'm1-mapped-renderer'

/** Monotonic suffix for exceptional identifiers within this module realm. */
let fallbackReceiptSequence = 0
let fallbackRealmId: string | null = null

/**
 * Lazily allocate a realm-discriminating token for exceptional receipt ids.
 * A module-local counter alone restarts in a fresh realm, so the token keeps
 * exceptional identities distinct across page reloads and separate realms.
 */
function fallbackRealmDiscriminator(): string {
  if (fallbackRealmId !== null) return fallbackRealmId
  const cryptoLike = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string
        getRandomValues?: (array: Uint8Array) => Uint8Array
      }
    }
  ).crypto
  try {
    if (typeof cryptoLike?.randomUUID === 'function') {
      const uuid = cryptoLike.randomUUID()
      if (typeof uuid === 'string' && uuid.trim().length > 0) {
        fallbackRealmId = uuid
        return fallbackRealmId
      }
    }
    if (typeof cryptoLike?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16)
      cryptoLike.getRandomValues(bytes)
      fallbackRealmId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return fallbackRealmId
    }
  } catch {
    // Fall through to the time/random discriminator below.
  }
  fallbackRealmId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return fallbackRealmId
}

/** What the low-level driver observed, expressed only as an execution stage. */
export interface RendererObservation {
  readonly stage: RendererStage
  readonly reasonCode: string | null
  readonly localTimeMs: number | null
}

/** The low-level driver performs the mapped renderer dispatch. */
export interface RendererDriver {
  dispatch(driverAction: string, signal: AbortSignal): Promise<RendererObservation>
}

/** Maps one advertised capability action to its low-level driver action. */
export interface ActionBinding {
  readonly actionId: string
  readonly driverAction: string
}

export interface MappedRendererDeps {
  readonly snapshot: CapabilitySnapshot
  readonly bindings: readonly ActionBinding[]
  readonly driver: RendererDriver
  readonly deadlineGate: DeadlineGate
  readonly receipts: ReceiptTools
}

function copySnapshot(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  return {
    rendererId: snapshot.rendererId,
    characterId: snapshot.characterId,
    capabilityRevision: snapshot.capabilityRevision,
    actions: snapshot.actions.map((action) => ({
      ...action,
      parameterBounds: action.parameterBounds.map((bound) => ({ ...bound })),
    })),
  }
}

function validateSnapshot(snapshot: CapabilitySnapshot): void {
  const parsed = capabilitySnapshotSchema.safeParse(snapshot)
  if (!parsed.success) {
    throw new Error('mapped-renderer: invalid capability snapshot')
  }
}

function buildBindings(
  snapshot: CapabilitySnapshot,
  bindings: readonly ActionBinding[],
): Map<string, string> {
  const advertised = new Set(snapshot.actions.map((action) => action.actionId))
  const byAction = new Map<string, string>()
  const seen = new Set<string>()
  for (const binding of bindings) {
    if (binding.actionId.length === 0 || binding.driverAction.length === 0) {
      throw new Error('mapped-renderer: binding actionId and driverAction must be nonempty')
    }
    if (seen.has(binding.actionId)) {
      throw new Error(`mapped-renderer: duplicate binding for action ${binding.actionId}`)
    }
    seen.add(binding.actionId)
    if (!advertised.has(binding.actionId)) {
      throw new Error(`mapped-renderer: binding for unadvertised action ${binding.actionId}`)
    }
    if (binding.actionId === NO_OP_ACTION) {
      throw new Error('mapped-renderer: a no-op must not be a bound action')
    }
    if (binding.driverAction === NO_OP_ACTION) {
      throw new Error('mapped-renderer: a no-op must not be a mapped dispatch')
    }
    byAction.set(binding.actionId, binding.driverAction)
  }
  for (const actionId of advertised) {
    if (!byAction.has(actionId)) {
      throw new Error(`mapped-renderer: missing binding for advertised action ${actionId}`)
    }
  }
  return byAction
}

/**
 * A renderer adapter that maps verified capability actions to low-level driver
 * commands and reports only what the driver actually observed. Construction
 * validates and copies the capability snapshot and bindings; the instance's
 * mapping and revision are immutable for its lifetime. Only valid commands
 * dispatch; unsupported, no-op or stale-revision commands return a schema-valid
 * failed avatar receipt and make zero driver calls. The command is parsed into an
 * independent validated snapshot before any asynchronous work, so later mutation
 * of the caller-owned object cannot alter dispatch identity or receipt
 * observability. It never adds global deduplication, scheduling or epoch
 * authorization.
 */
export function createMappedRenderer(deps: MappedRendererDeps): RendererPort {
  validateSnapshot(deps.snapshot)
  const capabilities = copySnapshot(deps.snapshot)
  const bindings = buildBindings(capabilities, deps.bindings)
  const actionById = new Map(capabilities.actions.map((action) => [action.actionId, action]))

  /** Read an honest local observation time, or null when the injected clock is unusable. */
  const safeLocalNowMs = (): number | null => {
    try {
      const localTimeMs = deps.receipts.localNowMs()
      return typeof localTimeMs === 'number' && Number.isFinite(localTimeMs) && localTimeMs >= 0
        ? localTimeMs
        : null
    } catch {
      return null
    }
  }

  /**
   * Keep a usable injected receipt identifier and fall back to a locally unique
   * browser-safe one when the supplied factory throws or yields a blank value.
   */
  const nextReceiptId = (): string => {
    try {
      const supplied = deps.receipts.newReceiptId()
      if (typeof supplied === 'string' && supplied.trim().length > 0) return supplied
    } catch {
      // Fall through to the local identifier.
    }
    fallbackReceiptSequence += 1
    return `m1-mapped-receipt-${fallbackRealmDiscriminator()}-${fallbackReceiptSequence}`
  }

  const receipt = (
    command: PerformanceCommand,
    stage: RendererStage,
    reasonCode: string | null,
    localTimeMs: number | null,
  ): PerformanceReceipt => {
    const built = performanceReceiptSchema.parse({
      receiptId: nextReceiptId(),
      outputId: command.outputId,
      sessionId: command.sessionId,
      epoch: command.epoch,
      turnId: command.turnId,
      segmentId: command.segmentId,
      modality: 'avatar',
      stage,
      localTimeMs,
      chunkIds: null,
      reasonCode,
      source: MAPPED_RENDERER_SOURCE,
    })
    return Object.freeze(built) as PerformanceReceipt
  }

  const defensiveFailure = (command: PerformanceCommand, reasonCode: string): PerformanceReceipt =>
    receipt(command, 'failed', reasonCode, safeLocalNowMs())

  /**
   * Validate the complete driver observation and produce a schema-valid receipt.
   * Any unusable field settles to `unknown` with a diagnostic reason and a null
   * local time; this never throws and never leaves a receipt with malformed
   * driver data.
   */
  const observationReceipt = (
    command: PerformanceCommand,
    observation: unknown,
  ): PerformanceReceipt => {
    if (observation === null || typeof observation !== 'object') {
      return receipt(command, 'unknown', 'invalid_observation', null)
    }
    const rawStage = (observation as { stage?: unknown }).stage
    const rawReason = (observation as { reasonCode?: unknown }).reasonCode
    const rawTime = (observation as { localTimeMs?: unknown }).localTimeMs

    let diagnostic: string | null = null
    if (typeof rawStage !== 'string' || !VALID_STAGES.has(rawStage)) {
      diagnostic = 'invalid_stage'
    } else if (OBSERVABILITY_LABELS.has(rawStage)) {
      diagnostic = 'invalid_stage'
    } else if (
      rawStage === 'completed' &&
      actionById.get(command.actionId)?.observability === 'acceptance-only'
    ) {
      diagnostic = 'acceptance_only_cannot_complete'
    } else if (!(rawReason === null || (typeof rawReason === 'string' && rawReason.length > 0))) {
      diagnostic = 'invalid_reason_code'
    } else if (
      !(rawTime === null || (typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime >= 0))
    ) {
      diagnostic = 'invalid_local_time'
    }

    if (diagnostic !== null) {
      return receipt(command, 'unknown', diagnostic, null)
    }
    return receipt(
      command,
      rawStage as RendererStage,
      rawReason as string | null,
      rawTime as number | null,
    )
  }

  const settleDispatch = (
    command: PerformanceCommand,
    dispatched: Promise<RendererObservation>,
    signal: AbortSignal,
  ): Promise<PerformanceReceipt> =>
    new Promise((resolve) => {
      let observed = false
      let done = false
      const finish = (value: PerformanceReceipt): void => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => {
        if (!observed) {
          finish(receipt(command, 'unknown', 'aborted_without_outcome', safeLocalNowMs()))
        }
      }
      try {
        dispatched.then(
          (observation) => {
            if (observed || done) return
            observed = true
            finish(observationReceipt(command, observation))
          },
          () => {
            if (observed || done) return
            observed = true
            finish(receipt(command, 'failed', 'driver_error', safeLocalNowMs()))
          },
        )
      } catch {
        if (!observed && !done) {
          observed = true
          finish(receipt(command, 'failed', 'driver_error', safeLocalNowMs()))
        }
      }
      if (signal.aborted) onAbort()
      else if (!done) signal.addEventListener('abort', onAbort, { once: true })
    })

  return {
    capabilities: () => copySnapshot(capabilities),
    async execute(command, context) {
      let commandSnapshot: PerformanceCommand
      try {
        commandSnapshot = performanceCommandSchema.parse(command)
      } catch {
        throw new Error('mapped-renderer: malformed performance command')
      }
      if (commandSnapshot.capabilityRevision !== capabilities.capabilityRevision) {
        return defensiveFailure(commandSnapshot, 'stale_capability')
      }
      if (commandSnapshot.actionId === NO_OP_ACTION) {
        return defensiveFailure(commandSnapshot, 'no_op_not_dispatched')
      }
      const driverAction = bindings.get(commandSnapshot.actionId)
      if (driverAction === undefined) {
        return defensiveFailure(commandSnapshot, 'unsupported_action')
      }
      const binding = deps.deadlineGate.bind(context)
      try {
        if (binding.signal.aborted) {
          return receipt(commandSnapshot, 'cancelled', null, safeLocalNowMs())
        }
        let dispatched: Promise<RendererObservation>
        try {
          dispatched = deps.driver.dispatch(driverAction, binding.signal)
        } catch {
          return receipt(commandSnapshot, 'failed', 'driver_error', safeLocalNowMs())
        }
        return await settleDispatch(commandSnapshot, dispatched, binding.signal)
      } finally {
        binding.release()
      }
    },
  }
}