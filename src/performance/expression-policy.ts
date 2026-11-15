/**
 * Optional M1 metadata for one avatar action. The catalogue is ordered by the
 * caller; alternative selection scans it in that order and never reorders,
 * trims or synthesises entries.
 */
export interface ExpressionMetadata {
  readonly actionId: string
  readonly affectTag: string
  readonly intensity: number
  readonly extreme: boolean
}

/** Repetition limits that an enabled expression policy requires explicitly. */
export interface ExpressionPolicyOptions {
  readonly cooldownMs: number
  readonly windowSize: number
  readonly maxSameInWindow: number
  readonly allowExtremeBypass: boolean
}

/**
 * Per-session expression-policy input. `advertisedActionIds` must be the stable
 * set of actions that are currently both advertised and mapped; the caller has
 * already validated the requested action before dispatch. `catalogue` supplies
 * optional M1 metadata, and its array order is the alternative-search order.
 * Rows with a blank affect tag, nonfinite intensity or nonboolean extreme flag
 * are unavailable; the first usable row per advertised action is the one used
 * by both request lookup and alternative search.
 *
 * The policy reads no system clock. Omitted or false `enabled` keeps it off;
 * enabled policies require explicit, validated options. Threshold values in
 * tests are fixture inputs, not production defaults.
 */
export interface ExpressionPolicyDeps {
  readonly advertisedActionIds: readonly string[]
  readonly catalogue: readonly ExpressionMetadata[]
  readonly enabled?: boolean
  readonly options?: ExpressionPolicyOptions
}

/**
 * One session's action selector for FR-03 / INV-02. Times passed to `pick` and
 * `recordAccepted` must come from one monotonic clock domain, and accepted
 * dispatches must be reported in nondecreasing time order.
 *
 * `pick` only selects; it never records. Callers report the action actually
 * accepted through `recordAccepted`. Recording is ignored for actions outside
 * the advertised set, so retained state stays bounded by that set and by the
 * configured window.
 */
export interface ExpressionPolicy {
  pick(requestedActionId: string, nowMs: number): string
  recordAccepted(selectedActionId: string, acceptedAtMs: number): void
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isUsableMetadata(entry: ExpressionMetadata): boolean {
  return (
    typeof entry.affectTag === 'string' &&
    entry.affectTag.trim().length > 0 &&
    typeof entry.intensity === 'number' &&
    Number.isFinite(entry.intensity) &&
    typeof entry.extreme === 'boolean'
  )
}

function validateOptions(options: ExpressionPolicyOptions | undefined): ExpressionPolicyOptions {
  if (options === undefined) {
    throw new Error('expression-policy: enabling the policy requires explicit options')
  }
  if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
    throw new Error('expression-policy: cooldownMs must be a finite nonnegative number')
  }
  if (!isPositiveSafeInteger(options.windowSize)) {
    throw new Error('expression-policy: windowSize must be a positive safe integer')
  }
  if (
    !isPositiveSafeInteger(options.maxSameInWindow) ||
    options.maxSameInWindow > options.windowSize
  ) {
    throw new Error(
      'expression-policy: maxSameInWindow must be a positive safe integer within windowSize',
    )
  }
  if (typeof options.allowExtremeBypass !== 'boolean') {
    throw new Error('expression-policy: allowExtremeBypass must be a boolean')
  }
  return {
    cooldownMs: options.cooldownMs,
    windowSize: options.windowSize,
    maxSameInWindow: options.maxSameInWindow,
    allowExtremeBypass: options.allowExtremeBypass,
  }
}

/**
 * Create the expression policy for one session. The default is off: picking
 * returns the requested action and recording has no effect. Once enabled, the
 * policy applies a strict cooldown (elapsed time below `cooldownMs`) and a
 * per-action cap over the most recent `windowSize` accepted dispatches. The
 * per-action last-accepted time is tracked independently of that window.
 *
 * At the cap it looks for the first safe same-affectTag, strictly lower
 * intensity advertised alternative in catalogue order, including when the
 * action is also cooling down. With only a cooldown it looks for the first safe
 * same-affectTag advertised alternative without an intensity constraint. An
 * alternative must satisfy its own cooldown and window cap. An enabled extreme
 * request bypasses both checks for that request only; alternatives never
 * inherit the bypass. Without limits, request metadata, or a safe alternative,
 * the original requested action is returned.
 */
export function createExpressionPolicy(deps: ExpressionPolicyDeps): ExpressionPolicy {
  if (deps.enabled !== true) {
    return {
      pick: (requestedActionId) => requestedActionId,
      recordAccepted: () => {},
    }
  }

  const options = validateOptions(deps.options)
  const advertised = new Set(deps.advertisedActionIds)
  const catalogue: ExpressionMetadata[] = []
  const cataloguedActions = new Set<string>()
  for (const entry of deps.catalogue) {
    if (!advertised.has(entry.actionId) || cataloguedActions.has(entry.actionId)) continue
    if (!isUsableMetadata(entry)) continue
    cataloguedActions.add(entry.actionId)
    catalogue.push({ ...entry })
  }
  const metadataByAction = new Map(catalogue.map((entry) => [entry.actionId, entry]))
  const lastAcceptedAt = new Map<string, number>()
  const window: string[] = []

  const isCoolingDown = (actionId: string, nowMs: number): boolean => {
    const acceptedAt = lastAcceptedAt.get(actionId)
    return acceptedAt !== undefined && nowMs - acceptedAt < options.cooldownMs
  }

  const countInWindow = (actionId: string): number => {
    let count = 0
    for (const accepted of window) {
      if (accepted === actionId) count += 1
    }
    return count
  }

  const isAtWindowCap = (actionId: string): boolean =>
    countInWindow(actionId) >= options.maxSameInWindow

  const isSafeAlternative = (
    candidate: ExpressionMetadata,
    requested: ExpressionMetadata,
    atCap: boolean,
    nowMs: number,
  ): boolean => {
    if (candidate.actionId === requested.actionId) return false
    if (!advertised.has(candidate.actionId)) return false
    if (candidate.affectTag !== requested.affectTag) return false
    if (atCap && candidate.intensity >= requested.intensity) return false
    if (isCoolingDown(candidate.actionId, nowMs)) return false
    if (isAtWindowCap(candidate.actionId)) return false
    return true
  }

  return {
    pick(requestedActionId, nowMs) {
      const requested = metadataByAction.get(requestedActionId)
      if (requested === undefined) return requestedActionId
      if (options.allowExtremeBypass && requested.extreme) return requestedActionId

      const atCap = isAtWindowCap(requestedActionId)
      if (!atCap && !isCoolingDown(requestedActionId, nowMs)) return requestedActionId

      for (const candidate of catalogue) {
        if (isSafeAlternative(candidate, requested, atCap, nowMs)) {
          return candidate.actionId
        }
      }
      return requestedActionId
    },
    recordAccepted(selectedActionId, acceptedAtMs) {
      if (!advertised.has(selectedActionId)) return
      lastAcceptedAt.set(selectedActionId, acceptedAtMs)
      window.push(selectedActionId)
      if (window.length > options.windowSize) window.shift()
    },
  }
}
