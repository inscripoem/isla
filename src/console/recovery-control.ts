import type { ConnectionStatus } from './console-state'
import type { PerformerRecoveryState } from './performer-machine'

/**
 * Pure eligibility for the console recovery controls (M2).
 *
 * Recovery is a server decision. The first request may arrive before the
 * session reports retirement, because the runtime starts retirement only after
 * a valid `session.recover`. The console therefore gates the controls on a
 * connected, current-session performer with operator authority and an explicit
 * acknowledgement, never on a locally fabricated `retiring` flag.
 *
 * A request stays correlated to that machine: disposal, loss of connection,
 * missing session identity, missing performer attach or missing operator
 * authority withdraws both the acknowledgement and the request control.
 */
export interface RecoveryControlInput {
  readonly connection: ConnectionStatus
  readonly hasSession: boolean
  readonly machine: {
    readonly disposed: boolean
    readonly performer: boolean
    readonly operator: boolean
    readonly recovery: Pick<PerformerRecoveryState, 'status'>
  } | null
  readonly acknowledged: boolean
}

export interface RecoveryControlView {
  /** The connected current session may show the acknowledgement control. */
  readonly available: boolean
  /** The operator may send one explicitly acknowledged recovery request now. */
  readonly requestable: boolean
}

export function recoveryControlView(input: RecoveryControlInput): RecoveryControlView {
  if (input.connection !== 'open' || !input.hasSession || input.machine === null) {
    return { available: false, requestable: false }
  }
  const { disposed, performer, operator, recovery } = input.machine
  const available = !disposed && performer && operator
  return {
    available,
    requestable: available && input.acknowledged && recovery.status !== 'requested',
  }
}
