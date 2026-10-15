import {
  parseApplicationServerMessage,
  type PerformanceCommand,
  type PerformanceReceipt,
  type ControlAck,
  type InputAck,
} from '../../src/contracts'
import type { PlaybackController } from '../../src/performance/browser/types'
import { createPlaybackController } from '../../src/performance/browser/player'
import type { AudioResolver, MediaDriver, ReceiptTools } from '../../src/performance/browser/types'

/**
 * Browser-safe performer state machine, shared by the automated Node performer
 * client and the manual browser demo. It owns the protocol-0.2 client behaviour:
 * full envelope/payload/session/epoch correlation, the delayed-execution
 * handshake, conservative local expiry, pending-resource cleanup, and
 * detach-on-socket-loss. It imports no Node, DOM or backend module; the caller
 * injects transport, media, resolver, receipt tools and a monotonic `now`.
 *
 * Deadline math (no cross-domain clock comparison):
 *   at grant receipt,  remainingLocal = serverRemaining - (now - requestStart)
 *   therefore          localExpiry    = requestStart + serverRemaining
 * and remainingLocal is the budget from now until that expiry.
 */

type JsonObject = Record<string, unknown>

export interface PerformerTransport {
  send(raw: string): void
}

export interface PerformerDisplay {
  subtitle: string | null
  reaction: string | null
}

export interface PerformerState {
  sessionId: string
  epoch: number
  lifecycle: string
  outputConfirmation: string
  performer: boolean
  operator: boolean
  lastStage: string | null
  display: PerformerDisplay
  error: string | null
}

export interface PerformerMachineHooks {
  onMessage?(message: unknown): void
  onSnapshot?(message: unknown): void
  onEvent?(message: unknown): void
  onReceipt?(receipt: PerformanceReceipt): void
  onServiceError?(raw: string, reason: string): void
  onStateChanged?(): void
}

export interface PerformerMachine {
  handleMessage(raw: unknown): void
  attach(): void
  bootstrapOperator(token: string): void
  input(text: string, messageId?: string): string | null
  resume(): string | null
  stop(): string | null
  state(): PerformerState
  dispose(reason: string): void
}

interface PendingOffer {
  command: PerformanceCommand
  requestStartMs: number
  abort: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
}

const MAX_PENDING = 16
let machineSequence = 0

export function createPerformerMachine(options: {
  transport: PerformerTransport
  media: MediaDriver
  resolver: AudioResolver
  receipts: ReceiptTools
  now?: () => number
  /** Test hook: awaited before `ready` is sent, to model delayed readiness. */
  beforeReady?: (command: PerformanceCommand) => Promise<void> | void
  hooks?: PerformerMachineHooks
}): PerformerMachine {
  const now = options.now ?? (() => globalThis.performance.now())
  const hooks = options.hooks ?? {}
  const instancePrefix = `m${(machineSequence += 1)}`
  let counter = 0
  const nextId = (prefix: string): string => `${instancePrefix}-${prefix}-${(counter += 1)}`

  let sessionId = ''
  let epoch = 0
  let lifecycle = 'stopped'
  let outputConfirmation = 'confirmed'
  let performer = false
  let operator = false
  let lastStage: string | null = null
  let lastError: string | null = null
  let display: PerformerDisplay = { subtitle: null, reaction: null }
  let controller: PlaybackController | null = null
  let activeOutputId: string | null = null
  let disposed = false

  const pending = new Map<string, PendingOffer>()
  const completedOutputs = new Set<string>()
  let lastAttachMessageId: string | null = null
  let lastBootstrapMessageId: string | null = null

  const notify = (): void => hooks.onStateChanged?.()

  const rememberOutput = (outputId: string): void => {
    completedOutputs.add(outputId)
    while (completedOutputs.size > 64) {
      const oldest = completedOutputs.values().next().value
      if (oldest === undefined) break
      completedOutputs.delete(oldest)
    }
  }

  /** Invalidate pending work whose epoch is older than the reconciled epoch. */
  const invalidateBelowEpoch = (bound: number): void => {
    for (const [outputId, entry] of [...pending]) {
      if (entry.command.epoch >= bound) continue
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.abort?.abort()
      pending.delete(outputId)
      rememberOutput(outputId)
      if (activeOutputId === outputId) activeOutputId = null
    }
  }

  /**
   * Monotonic epoch reconciliation. Returns false when the incoming epoch is
   * stale (older than the current epoch); stale messages must not regress the
   * epoch or roll back lifecycle/confirmation state.
   */
  const reconcileEpoch = (next: number): boolean => {
    if (!Number.isFinite(next) || next < epoch) return false
    if (next > epoch) {
      epoch = next
      invalidateBelowEpoch(epoch)
    }
    return true
  }

  const ensureController = (): PlaybackController => {
    if (controller === null) {
      controller = createPlaybackController({
        sessionId: sessionId.length > 0 ? sessionId : 'unknown',
        initialEpoch: 0,
        resolver: options.resolver,
        media: options.media,
        receipts: options.receipts,
        onReceipt: (receipt) => {
          lastStage = receipt.stage
          if (receipt.stage === 'completed' || receipt.stage === 'cancelled' || receipt.stage === 'failed') {
            clearPending(receipt.outputId)
          }
          options.transport.send(
            JSON.stringify({
              protocolVersion: '0.2',
              messageId: nextId('receipt'),
              sessionId: receipt.sessionId,
              epoch: receipt.epoch,
              kind: 'performance.receipt',
              payload: receipt,
            }),
          )
          hooks.onReceipt?.(receipt)
          notify()
        },
        reportFault: (error) => {
          lastError = error instanceof Error ? error.message : String(error)
          notify()
        },
      })
    }
    return controller
  }

  const clearPending = (outputId: string): void => {
    const entry = pending.get(outputId)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    entry.abort = null
    pending.delete(outputId)
    rememberOutput(outputId)
    if (activeOutputId === outputId) activeOutputId = null
  }

  const expireOffer = (entry: PendingOffer, reason: string): void => {
    const command = entry.command
    if (entry.timer !== null) clearTimeout(entry.timer)
    clearPending(command.outputId)
    options.transport.send(
      JSON.stringify({
        protocolVersion: '0.2',
        messageId: nextId('expired'),
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.receipt',
        payload: {
          receiptId: nextId('receipt-expired'),
          outputId: command.outputId,
          sessionId: command.sessionId,
          epoch: command.epoch,
          turnId: command.turnId,
          segmentId: command.segmentId,
          modality: 'audio',
          stage: 'unknown',
          localTimeMs: null,
          chunkIds: null,
          reasonCode: reason,
          source: 'performer-machine',
        },
      }),
    )
    notify()
  }

  const identityMatches = (
    entry: PendingOffer,
    message: { sessionId: string; epoch: number; payload: { outputId: string; turnId: string; segmentId: string } },
  ): boolean =>
    entry.command.sessionId === message.sessionId &&
    entry.command.epoch === message.epoch &&
    entry.command.outputId === message.payload.outputId &&
    entry.command.turnId === message.payload.turnId &&
    entry.command.segmentId === message.payload.segmentId

  const onOffer = (message: {
    sessionId: string
    epoch: number
    payload: PerformanceCommand
  }): void => {
    const command = message.payload
    if (command.sessionId !== message.sessionId || command.epoch !== message.epoch) return
    if (sessionId.length > 0 && message.sessionId !== sessionId) return
    // Only the current epoch may introduce work; a stale offer must not change
    // the displayed subtitle/reaction or be answered.
    if (message.epoch !== epoch) return
    // A repeated offer for an output we already finished must not create a new
    // pending entry.
    if (completedOutputs.has(command.outputId)) return
    if (pending.has(command.outputId)) return
    if (activeOutputId !== null) return
    if (pending.size >= MAX_PENDING) return
    pending.set(command.outputId, {
      command,
      requestStartMs: now(),
      abort: null,
      timer: null,
    })
    activeOutputId = command.outputId
    lastStage = 'offered'
    display = { subtitle: command.subtitleText, reaction: command.actionId }
    notify()
    void (async () => {
      if (options.beforeReady !== undefined) {
        try {
          await options.beforeReady(command)
        } catch {
          // A hook failure must not send a ready for work we cannot accept.
          return
        }
      }
      if (disposed || !pending.has(command.outputId)) return
      options.transport.send(
        JSON.stringify({
          protocolVersion: '0.2',
          messageId: nextId('ready'),
          sessionId: command.sessionId,
          epoch: command.epoch,
          kind: 'performance.ready',
          payload: { outputId: command.outputId, turnId: command.turnId, segmentId: command.segmentId },
        }),
      )
    })()
  }

  const onGrant = (message: {
    sessionId: string
    epoch: number
    payload: {
      outputId: string
      sessionId: string
      epoch: number
      turnId: string
      segmentId: string
      remainingLifetimeMs: number
    }
  }): void => {
    if (message.payload.sessionId !== message.sessionId || message.payload.epoch !== message.epoch) return
    if (sessionId.length > 0 && message.sessionId !== sessionId) return
    // Only a grant for the current epoch may authorize playback.
    if (message.epoch !== epoch) return
    const entry = pending.get(message.payload.outputId)
    if (entry === undefined) return
    if (entry.command.epoch !== epoch) return
    if (!identityMatches(entry, message)) return
    // A duplicate grant must not replace the existing abort ownership.
    if (entry.abort !== null) return
    const remaining = message.payload.remainingLifetimeMs
    if (!Number.isFinite(remaining) || remaining < 0) {
      expireOffer(entry, 'invalid_grant_lifetime')
      return
    }
    const elapsed = Math.max(0, now() - entry.requestStartMs)
    const remainingLocal = remaining - elapsed
    const localExpiry = entry.requestStartMs + remaining
    if (!Number.isFinite(remainingLocal) || remainingLocal <= 0 || now() >= localExpiry) {
      expireOffer(entry, 'offer_expired')
      return
    }
    const abort = new AbortController()
    entry.abort = abort
    lastStage = 'granted'
    entry.timer = setTimeout(() => {
      if (!abort.signal.aborted) abort.abort()
    }, remainingLocal)
    const timer = entry.timer as { unref?: () => void }
    timer.unref?.()
    const command = entry.command
    void ensureController()
      .execute(command, { signal: abort.signal })
      .catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error)
        notify()
      })
  }

  const onCancel = (message: { payload: { requestId: string; revokedEpoch: number; newEpoch: number } }): void => {
    const { revokedEpoch, newEpoch } = message.payload
    if (!Number.isFinite(revokedEpoch) || !Number.isFinite(newEpoch)) return
    // A cancel for a superseded epoch must not revoke newer work.
    if (revokedEpoch >= epoch) {
      let revoked = false
      for (const [outputId, entry] of [...pending]) {
        if (entry.command.epoch > revokedEpoch) continue
        if (entry.timer !== null) clearTimeout(entry.timer)
        entry.abort?.abort()
        pending.delete(outputId)
        rememberOutput(outputId)
        if (activeOutputId === outputId) activeOutputId = null
        revoked = true
      }
      reconcileEpoch(newEpoch)
      if (revoked) void ensureController().cancel(message.payload)
      return
    }
    reconcileEpoch(newEpoch)
  }

  const handleMessage = (raw: unknown): void => {
    if (disposed) return
    hooks.onMessage?.(raw)
    const parsed = parseApplicationServerMessage(raw)
    if (!parsed.ok) {
      // A malformed or unknown server message is ignored, not cast.
      return
    }
    const message = parsed.message
    // Every state-bearing message must belong to this session and epoch. A
    // mismatched message is never applied.
    if (
      'sessionId' in message &&
      typeof message.sessionId === 'string' &&
      sessionId.length > 0 &&
      message.sessionId !== sessionId
    ) {
      return
    }
    switch (message.kind) {
      case 'session.snapshot': {
        // A stale snapshot never regresses the epoch or lifecycle/confirmation.
        if (message.epoch < epoch) break
        sessionId = message.sessionId
        reconcileEpoch(message.epoch)
        lifecycle = message.payload.lifecycle
        outputConfirmation = message.payload.outputConfirmation
        hooks.onSnapshot?.(message)
        break
      }
      case 'session.event':
        hooks.onEvent?.(message)
        break
      case 'session.attach.ack':
        // Correlate to an outstanding attach request.
        if (lastAttachMessageId === null) break
        lastAttachMessageId = null
        performer = true
        break
      case 'operator.ack':
        if (lastBootstrapMessageId === null || message.payload.requestMessageId !== lastBootstrapMessageId) {
          break
        }
        lastBootstrapMessageId = null
        operator = true
        break
      case 'input.ack':
      case 'control.ack': {
        const ack = message.payload as ControlAck | InputAck
        const ackEpoch = 'epoch' in ack && typeof ack.epoch === 'number' ? ack.epoch : null
        // A stale acknowledgement must not roll the epoch or state backwards.
        if (ackEpoch === null || !reconcileEpoch(ackEpoch)) break
        if ('lifecycle' in ack && typeof ack.lifecycle === 'string') lifecycle = ack.lifecycle
        if ('outputConfirmation' in ack && typeof ack.outputConfirmation === 'string') {
          outputConfirmation = ack.outputConfirmation
        }
        break
      }
      case 'request.error': {
        lastError = `${message.payload.code}: ${message.payload.message}`
        // A failed attach/bootstrap leaves no correlation pending.
        lastAttachMessageId = null
        lastBootstrapMessageId = null
        break
      }
      case 'performance.offer':
        onOffer(message)
        break
      case 'performance.grant':
        onGrant(message)
        break
      case 'performance.cancel':
        onCancel(message)
        break
      case 'performance.execute':
        // Legacy execute is an offer without the delayed handshake.
        onOffer({ sessionId: message.sessionId, epoch: message.epoch, payload: message.payload })
        break
    }
    notify()
  }

  const buildEnvelope = (
    kind: string,
    payload: JsonObject,
    messageId: string,
  ): string | null => {
    if (sessionId.length === 0) {
      lastError = 'no session snapshot received yet'
      notify()
      return null
    }
    return JSON.stringify({
      protocolVersion: '0.2',
      messageId,
      sessionId,
      epoch,
      kind,
      payload,
    })
  }

  return {
    handleMessage,
    attach(): void {
      const messageId = nextId('attach')
      const raw = buildEnvelope('session.attach', {}, messageId)
      if (raw === null) return
      lastAttachMessageId = messageId
      options.transport.send(raw)
    },
    bootstrapOperator(token: string): void {
      const messageId = nextId('bootstrap')
      const raw = buildEnvelope('operator.bootstrap', { token }, messageId)
      if (raw === null) return
      lastBootstrapMessageId = messageId
      options.transport.send(raw)
    },
    input(text: string, messageId?: string): string | null {
      const id = messageId ?? nextId('msg')
      const raw = buildEnvelope('input.submit', { source: 'local-audience', text }, id)
      if (raw === null) return null
      options.transport.send(raw)
      return id
    },
    resume(): string | null {
      const messageId = nextId('msg')
      const raw = buildEnvelope('control.resume', { requestId: nextId('resume') }, messageId)
      if (raw === null) return null
      options.transport.send(raw)
      return messageId
    },
    stop(): string | null {
      const messageId = nextId('msg')
      const raw = buildEnvelope('control.stop', { requestId: nextId('stop') }, messageId)
      if (raw === null) return null
      options.transport.send(raw)
      return messageId
    },
    state(): PerformerState {
      return {
        sessionId,
        epoch,
        lifecycle,
        outputConfirmation,
        performer,
        operator,
        lastStage,
        display,
        error: lastError,
      }
    },
    dispose(reason: string): void {
      if (disposed) return
      disposed = true
      for (const entry of pending.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer)
        entry.abort?.abort()
      }
      pending.clear()
      activeOutputId = null
      controller?.dispose()
      controller = null
      lastError = reason
      notify()
    },
  }
}

export { createPlaybackController }
