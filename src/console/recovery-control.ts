import type { ConnectionStatus } from './console-state'
import type { PerformerRecoveryState } from './performer-machine'

/**
 * Pure eligibility for the console recovery controls (M2).
 *
 * Recovery is a server decision. The first request may arrive before the
 * session reports retirement, because the runtime starts retirement only after
 * a valid `session.recover`. The console therefore never gates the request on a
 * locally fabricated `retiring` flag.
 *
 * The acknowledgement records the operator's local intent, so it is offered for
 * any connected current session whose machine has not been disposed; it no
 * longer waits for a performer or operator. Sending the request is stricter: it
 * requires an attached performer, operator authority, the acknowledgement and a
 * recovery that is not already pending.
 *
 * A request stays correlated to that machine: disposal, loss of connection,
 * missing session identity, missing performer attach or missing operator
 * authority withdraws the request control.
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
  if (input.connection !== 'open' || !input.hasSession) {
    return { available: false, requestable: false }
  }
  const machine = input.machine
  // The acknowledgement records the operator's local intent, so it is offered
  // for any connected current session whose machine has not been disposed.
  // Sending the request still requires an attached performer, operator
  // authority, the acknowledgement and a recovery that is not already pending.
  const available = machine === null || !machine.disposed
  return {
    available,
    requestable:
      available &&
      machine !== null &&
      machine.performer &&
      machine.operator &&
      input.acknowledged &&
      machine.recovery.status !== 'requested',
  }
}
