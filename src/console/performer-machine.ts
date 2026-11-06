import {
  parseApplicationServerMessage,
  type InputSource,
  type PerformanceCommand,
  type PerformanceReceipt,
  type PlayerStatus,
  type ControlAck,
  type InputAck,
} from '../contracts'
import type { PlaybackController } from '../performance/browser/types'
import type { AudioResolver, MediaDriver, ReceiptTools } from '../performance/browser/types'
import { createPlaybackController } from '../performance/browser/player'

/**
 * Browser-safe performer state machine. The product console and the automated
 * Node performer client share this production module; it owns the protocol-0.2
 * client behaviour: full envelope/payload/session/epoch correlation, the
 * delayed-execution handshake, conservative local expiry, pending-resource
 * cleanup, and detach-on-socket-loss. It imports no Node, DOM or backend
 * module; the caller injects transport, media, resolver, receipt tools and a
 * monotonic `now`.
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

export interface PerformerRecoveryState {
  /** `idle` before a request; `requested` while one is outstanding. */
  status: 'idle' | 'requested' | 'applied' | 'already_applied' | 'failed'
  retiredSessionId: string | null
  successorSessionId: string | null
  recoveries: number
  remainingRecoveries: number | null
}

export interface PerformerState {
  sessionId: string
  epoch: number
  lifecycle: string
  /**
   * Explicit application retirement state owned by the server, never inferred
   * from `lifecycle`. While true the page disables Send and Resume; the session
   * is stopped and only a recovery retry or a reconnect can continue.
   */
  retiring: boolean
  /**
   * True once this machine has been disposed, for example after transport loss.
   * Every outgoing request is ignored from that point on; the console uses this
   * to withdraw controls instead of attempting a send on a closed transport.
   */
  disposed: boolean
  outputConfirmation: string
  performer: boolean
  operator: boolean
  lastStage: string | null
  display: PerformerDisplay
  error: string | null
  /** Operator-driven recovery status; never inferred from measured media. */
  recovery: PerformerRecoveryState
  /**
   * The current M1 controller's own physical status, or a truthful idle default
   * before a controller exists. It is never inferred from a delivery receipt.
   */
  playerStatus: PlayerStatus
}

export interface PerformerMachineHooks {
  onMessage?(message: unknown): void
  onSnapshot?(message: unknown): void
  onEvent?(message: unknown): void
  onReceipt?(receipt: PerformanceReceipt): void
  onRecovery?(message: unknown): void
  onServiceError?(raw: string, reason: string): void
  onStateChanged?(): void
}

export interface PerformerMachine {
  handleMessage(raw: unknown): void
  attach(): void
  bootstrapOperator(token: string): void
  input(text: string, messageId?: string, source?: InputSource): string | null
  resume(requestId?: string, messageId?: string): string | null
  stop(requestId?: string, messageId?: string): string | null
  /**
   * Explicit operator recovery: end the current session and continue in a fresh
   * successor. The acknowledgement is the operator's decision that playback was
   * ended, never a measured delivery fact.
   */
  recover(): string | null
  state(): PerformerState
  dispose(reason: string): void
}

interface PendingOffer {
  command: PerformanceCommand
  requestStartMs: number
  abort: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  /** Set once a terminal receipt for this admission has been published. */
  terminalPublished: boolean
}

const MAX_PENDING = 16
let machineSequence = 0

/**
 * A per-realm identity nonce, generated once per module evaluation. A
 * module-scoped counter alone restarts whenever the module is re-evaluated in a
 * fresh JS realm (for example a browser page reload), which would let a new
 * client reuse message and receipt identities that a retained server session
 * still remembers (its input/receipt dedup). Combining this nonce with the
 * per-module sequence keeps default client identities unique across page and
 * realm lifetimes. Tests that need deterministic identities inject `receipts`
 * and `now` instead of relying on this.
 */
const REALM_NONCE = createRealmNonce()

function createRealmNonce(): string {
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
      return cryptoLike.randomUUID().replace(/-/g, '').slice(0, 12)
    }
    if (typeof cryptoLike?.getRandomValues === 'function') {
      const bytes = new Uint8Array(6)
      cryptoLike.getRandomValues(bytes)
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // Fall through to the time/random nonce below.
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function createPerformerMachine(options: {
  transport: PerformerTransport
  media: MediaDriver
  resolver: AudioResolver
  /**
   * Deterministic receipt id/clock tools. Defaults to realm-unique, machine-owned
   * identities so a fresh page/realm never reuses retained server identities.
   */
  receipts?: ReceiptTools
  now?: () => number
  /** Test hook: awaited before `ready` is sent, to model delayed readiness. */
  beforeReady?: (command: PerformanceCommand) => Promise<void> | void
  hooks?: PerformerMachineHooks
}): PerformerMachine {
  const now = options.now ?? (() => globalThis.performance.now())
  const hooks = options.hooks ?? {}
  const instancePrefix = `m${REALM_NONCE}-${(machineSequence += 1)}`
  let counter = 0
  const nextId = (prefix: string): string => `${instancePrefix}-${prefix}-${(counter += 1)}`
  const receipts: ReceiptTools =
    options.receipts ?? {
      // One identity source: the same realm-unique generator serves message ids
      // and receipt ids, so a receipt never collides across page lifetimes.
      newReceiptId: () => nextId('rcpt'),
      localNowMs: () => Math.round(now()),
    }

  let sessionId = ''
  let epoch = 0
  let lifecycle = 'stopped'
  let retiring = false
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
  let lastRecoverMessageId: string | null = null
  let recovery: PerformerRecoveryState = {
    status: 'idle',
    retiredSessionId: null,
    successorSessionId: null,
    recoveries: 0,
    remainingRecoveries: null,
  }

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
        receipts,
        onReceipt: (receipt) => publishReceipt(receipt),
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

  /**
   * Reports the controller's own `PlayerStatus` (the M1 `status()` interface)
   * for an output, ahead of its receipt. The delivery fact and physical
   * occupancy travel separately so the server never treats a delivery terminal
   * as proof that local media was released.
   */
  const publishPhysicalStatus = (receipt: PerformanceReceipt): void => {
    const status = controller?.status()
    if (status === undefined) return
    options.transport.send(
      JSON.stringify({
        protocolVersion: '0.2',
        messageId: nextId('status'),
        sessionId: receipt.sessionId,
        epoch: receipt.epoch,
        kind: 'performance.status',
        payload: { outputId: receipt.outputId, status },
      }),
    )
  }

  /**
   * The single receipt publication path. The physical status is reported first,
   * then a terminal releases the pending entry, then the receipt envelope and
   * the owner hooks are published. `onGrant` reconciles a cached terminal the M1
   * controller returns without an observer callback through this same path, so
   * an output's terminal is published exactly once.
   *
   * A terminal whose local cleanup failed leaves the M1 controller non-idle
   * (quarantined media), so the pending entry is retained and local admission
   * stays closed rather than reopening over retained physical media.
   */
  const publishReceipt = (receipt: PerformanceReceipt): void => {
    lastStage = receipt.stage
    publishPhysicalStatus(receipt)
    const terminal =
      receipt.stage === 'completed' || receipt.stage === 'cancelled' || receipt.stage === 'failed'
    if (terminal) {
      const entry = pending.get(receipt.outputId)
      if (entry !== undefined) entry.terminalPublished = true
      // Only release admission when the M1 controller is actually idle. A
      // cleanup failure retains quarantined media, so the pending entry stays
      // and local admission remains closed.
      if (controller?.status().idle !== false) clearPending(receipt.outputId)
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
  }

  const expireOffer = (entry: PendingOffer, reason: string): void => {
    const command = entry.command
    if (entry.timer !== null) clearTimeout(entry.timer)
    clearPending(command.outputId)
    const receipt: PerformanceReceipt = {
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
    }
    options.transport.send(
      JSON.stringify({
        protocolVersion: '0.2',
        messageId: nextId('expired'),
        sessionId: command.sessionId,
        epoch: command.epoch,
        kind: 'performance.receipt',
        payload: receipt,
      }),
    )
    // The unknown receipt is a local observation too: without this hook the
    // console's receipt list would omit an expiry that already reached the wire.
    hooks.onReceipt?.(receipt)
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
      terminalPublished: false,
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
    const execution = ensureController().execute(command, { signal: abort.signal })
    void execution.then(
      (receipt) => {
        // The M1 controller retains a current-epoch terminal with NO count
        // quota and returns it for an identical retry without emitting an
        // observer callback, while this machine and the server bridge retire
        // their own records at 64. Reconcile such a cached terminal through the
        // single publication path, but only for the exact admission captured
        // here: if the observer already published it (entry cleared) or a later
        // admission replaced the entry, this fulfillment must not publish. This
        // frees admission after a retirement-boundary retry without duplicating
        // an ordinary terminal publication.
        if (pending.get(receipt.outputId) === entry && !entry.terminalPublished) publishReceipt(receipt)
      },
      (error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error)
        notify()
      },
    )
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
      case 'session.recovery.state': {
        // Explicit retirement state; a stale frame never overrides the current
        // epoch, and it is never inferred from lifecycle.
        if (message.epoch < epoch) break
        retiring = message.payload.retiring
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
      case 'session.recovery.ack': {
        // Correlate to an outstanding recovery request; the envelope stays on the
        // retiring session, so the session filter above already matched it.
        if (lastRecoverMessageId === null || message.payload.requestMessageId !== lastRecoverMessageId) break
        lastRecoverMessageId = null
        recovery = {
          status: message.payload.status === 'applied' ? 'applied' : 'already_applied',
          retiredSessionId: message.payload.retiredSessionId,
          successorSessionId: message.payload.successorSessionId,
          recoveries: message.payload.recoveries,
          remainingRecoveries: message.payload.remainingRecoveries,
        }
        hooks.onRecovery?.(message)
        break
      }
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
        // A failed attach/bootstrap/recovery leaves no correlation pending.
        lastAttachMessageId = null
        lastBootstrapMessageId = null
        if (lastRecoverMessageId !== null && message.payload.requestId === lastRecoverMessageId) {
          lastRecoverMessageId = null
          recovery = { ...recovery, status: 'failed' }
        }
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
      if (disposed) return
      const messageId = nextId('attach')
      const raw = buildEnvelope('session.attach', {}, messageId)
      if (raw === null) return
      lastAttachMessageId = messageId
      options.transport.send(raw)
    },
    bootstrapOperator(token: string): void {
      if (disposed) return
      const messageId = nextId('bootstrap')
      const raw = buildEnvelope('operator.bootstrap', { token }, messageId)
      if (raw === null) return
      lastBootstrapMessageId = messageId
      options.transport.send(raw)
    },
    input(text: string, messageId?: string, source: InputSource = 'local-audience'): string | null {
      if (disposed) return null
      const id = messageId ?? nextId('msg')
      const raw = buildEnvelope('input.submit', { source, text }, id)
      if (raw === null) return null
      options.transport.send(raw)
      return id
    },
    resume(requestId?: string, messageId?: string): string | null {
      if (disposed) return null
      const id = messageId ?? nextId('msg')
      const raw = buildEnvelope('control.resume', { requestId: requestId ?? nextId('resume') }, id)
      if (raw === null) return null
      options.transport.send(raw)
      return id
    },
    stop(requestId?: string, messageId?: string): string | null {
      if (disposed) return null
      const id = messageId ?? nextId('msg')
      const raw = buildEnvelope('control.stop', { requestId: requestId ?? nextId('stop') }, id)
      if (raw === null) return null
      options.transport.send(raw)
      return id
    },
    recover(): string | null {
      if (disposed) return null
      const messageId = nextId('recover')
      // The acknowledgement is the operator's explicit decision that they have
      // ended playback in the previous session. It is a required literal so it
      // cannot be omitted; it is never measured media or a delivery fact.
      const raw = buildEnvelope('session.recover', { acknowledgePlaybackEnded: true }, messageId)
      if (raw === null) return null
      // Send first: a closed transport must not leave a request looking
      // outstanding when no frame was emitted.
      options.transport.send(raw)
      lastRecoverMessageId = messageId
      recovery = { ...recovery, status: 'requested' }
      return messageId
    },
    state(): PerformerState {
      return {
        sessionId,
        epoch,
        lifecycle,
        retiring,
        disposed,
        outputConfirmation,
        performer,
        operator,
        lastStage,
        display,
        error: lastError,
        recovery: { ...recovery },
        playerStatus: controller?.status() ?? { idle: true, activeOutputId: null, lastStage: null },
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
