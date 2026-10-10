import type { ConsoleTransportPort } from '../../src/contracts'
import { bootstrapSnapshotSchema, controlAckSchema, inputAckSchema } from '../../src/contracts'
import { createChecker } from '../support/violations'
import type { Violation } from '../support/violations'

/**
 * M2 conformance: a complete bootstrap usable for the first request, and no
 * automatic replay of history. Replaceable transport implementations only.
 */
export async function collectConsoleViolations(
  create: () => ConsoleTransportPort,
): Promise<Violation[]> {
  const { check, violations } = createChecker()
  const transport = create()

  const bootstrap = bootstrapSnapshotSchema.safeParse(await transport.bootstrap())
  check('bootstrap-valid', bootstrap.success, 'bootstrap snapshot must validate')
  let sessionId = 'session-fixture'
  let epoch = 0
  if (bootstrap.success) {
    sessionId = bootstrap.data.sessionId
    epoch = bootstrap.data.epoch
    check('bootstrap-identities', bootstrap.data.sessionId.length > 0 && Number.isInteger(bootstrap.data.epoch), 'bootstrap must carry the session id and epoch for the first request')
    check('bootstrap-version', bootstrap.data.protocolVersion === '0.2', 'bootstrap must carry the application contract version')
    check('bootstrap-output-confirmation', ['pending', 'confirmed', 'unknown'].includes(bootstrap.data.outputConfirmation), 'bootstrap must state output confirmation')
  }

  const received: number[] = []
  const unsubscribe = transport.onServerMessage((message) => {
    if (message.kind === 'session.event') received.push(message.payload.seq)
  })
  await Promise.resolve()
  const lastSeq = bootstrap.success ? bootstrap.data.seq : 0
  check('no-history-autoplay', received.every((value) => value > lastSeq), 'console must not be handed replayed history at or below the bootstrap sequence')
  unsubscribe()

  const inputAck = inputAckSchema.safeParse(
    await transport.sendInput({
      protocolVersion: '0.2',
      messageId: 'm-console-1',
      sessionId,
      epoch,
      kind: 'input.submit',
      payload: { source: 'local-audience', text: 'hello' },
    }),
  )
  check('input-ack-valid', inputAck.success, 'input acknowledgement must validate')
  if (inputAck.success && inputAck.data.status !== 'rejected') {
    check('input-ack-identity', inputAck.data.sessionId === sessionId && inputAck.data.epoch === epoch, 'input acknowledgement must echo the session and epoch')
  }

  const controlAck = controlAckSchema.safeParse(
    await transport.sendControl({
      protocolVersion: '0.2',
      messageId: 'm-console-2',
      sessionId,
      epoch,
      kind: 'control.stop',
      payload: { requestId: 'r-console-1' },
    }),
  )
  check('control-ack-valid', controlAck.success, 'control acknowledgement must validate')

  transport.close()
  return violations()
}
