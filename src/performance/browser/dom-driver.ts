import type { PerformanceCommand } from '../../contracts/app'
import { getEnvelopeObserver } from './envelope-connection'
import type {
  MediaDriver,
  MediaEvent,
  MediaHandle,
  MouthPlaybackKey,
  MouthPlaybackObserver,
  MouthPlaybackState,
} from './types'

/** About 60 observations per second while the element is actually playing. */
const MOUTH_SAMPLE_INTERVAL_MS = 16

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Snapshot the admitted command's identity; invalid direct-call values disable the observer. */
function mouthKeyOf(command: PerformanceCommand): MouthPlaybackKey | null {
  const { audioRef, sessionId, epoch, turnId, segmentId, outputId } = command
  if (
    !nonEmpty(audioRef) ||
    !nonEmpty(sessionId) ||
    !Number.isInteger(epoch) ||
    epoch < 0 ||
    !nonEmpty(turnId) ||
    !nonEmpty(segmentId) ||
    !nonEmpty(outputId)
  ) {
    return null
  }
  return Object.freeze({ audioRef, sessionId, epoch, turnId, segmentId, outputId })
}

/**
 * Invoke the transport's agreed observer getter only for a handle that already
 * has an admitted command. A missing, throwing or malformed getter leaves the
 * normal audio path untouched.
 */
function resolveSharedObserver(): MouthPlaybackObserver | null {
  try {
    const candidate: unknown = getEnvelopeObserver()
    return typeof candidate === 'function' ? (candidate as MouthPlaybackObserver) : null
  } catch {
    return null
  }
}

/**
 * HTMLAudioElement-backed media handle. It creates and owns exactly one object
 * URL per load and releases it on the next load or on detach. `detach()` is
 * synchronous, non-throwing and idempotent; it reports a failed local
 * detachment as `false` rather than hiding it behind a successful result.
 *
 * Event-based `playing`/`ended`/`error` observations are the only playback
 * evidence; the `play()` promise settlement is not treated as a start fact.
 *
 * When a command was provided at creation and an observer is configured, the
 * handle also reports actual `currentTime` observations: once on the DOM
 * `playing` event and then every 16 ms while that state lasts. Waiting,
 * seeking, pause, terminal states and detach stop that polling before the
 * observer is called, so a late event or a failed detach cannot reopen it.
 * Volume and mute are never read or written.
 */
class DomMediaHandle implements MediaHandle {
  private readonly element: HTMLAudioElement
  private readonly listeners = new Set<(event: MediaEvent) => void>()
  private objectUrl: string | null = null
  private detached = false

  private readonly mouthObserver: MouthPlaybackObserver | null
  private readonly mouthKey: MouthPlaybackKey | null
  private readonly mouthEnabled: boolean
  private mouthPoll: ReturnType<typeof setInterval> | null = null
  private mouthPollToken = 0
  private mouthListening = false
  private mouthTerminal = false
  private mouthState: MouthPlaybackState | null = null
  private detaching = false

  private readonly handlePlaying = (): void => {
    this.emit({ type: 'playing' })
    if (!this.mouthEnabled || this.mouthTerminal) return
    // The native element may still be paused or seeking when a queued playing
    // event arrives. That is not an actual resumed position: keep the mouth
    // closed and do not re-arm polling; the legacy receipt above still flowed.
    const blocked = this.mouthBlockedState()
    if (blocked !== null) {
      this.blockMouthObservation(blocked)
      return
    }
    // Mark and schedule before the observation: an observer may pause or
    // detach synchronously, and that must win over this playing event.
    this.mouthState = 'playing'
    this.startMouthPolling()
    this.deliverMouth('playing', this.mouthPositionMs())
  }

  private readonly handleEnded = (): void => {
    // Snapshot before the mouth observation: an observer may detach, but the
    // player still receives the actual media terminal fact.
    const listeners = [...this.listeners]
    this.finishMouth('ended')
    for (const listener of listeners) listener({ type: 'ended' })
  }

  private readonly handleError = (): void => {
    const listeners = [...this.listeners]
    const code = this.element.error?.code
    this.finishMouth('error')
    const event: MediaEvent = {
      type: 'error',
      reasonCode: code === undefined || code === null ? 'media_error' : `media_error_${code}`,
    }
    for (const listener of listeners) listener(event)
  }

  private readonly handleWaiting = (): void => {
    this.observeMouth('waiting')
  }

  private readonly handleSeeking = (): void => {
    this.observeMouth('waiting')
  }

  private readonly handlePause = (): void => {
    this.observeMouth('paused')
  }

  constructor(
    explicitObserver: MouthPlaybackObserver | null,
    commandKey: MouthPlaybackKey | null,
    sharedObserver: () => MouthPlaybackObserver | null,
  ) {
    this.element = document.createElement('audio')
    this.element.preload = 'auto'
    this.mouthObserver =
      explicitObserver ?? (commandKey === null ? null : sharedObserver())
    this.mouthKey = commandKey
    this.mouthEnabled = this.mouthObserver !== null && commandKey !== null
    this.element.addEventListener('playing', this.handlePlaying)
    this.element.addEventListener('ended', this.handleEnded)
    this.element.addEventListener('error', this.handleError)
    if (this.mouthEnabled) {
      this.mouthListening = true
      this.element.addEventListener('waiting', this.handleWaiting)
      this.element.addEventListener('seeking', this.handleSeeking)
      this.element.addEventListener('pause', this.handlePause)
    }
  }

  private emit(event: MediaEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  /**
   * Read the actual media clock. `null` means the element has no usable
   * position; callers must not substitute a wall clock or an active zero.
   */
  private mouthPositionMs(): number | null {
    const current = this.element.currentTime
    return typeof current === 'number' && Number.isFinite(current) && current >= 0
      ? current * 1000
      : null
  }

  /** Deliver one observation; callers own the terminal/state guard. */
  private deliverMouth(state: MouthPlaybackState, positionMs: number | null): void {
    const observer = this.mouthObserver
    const key = this.mouthKey
    if (!this.mouthEnabled || observer === null || key === null || positionMs === null) return
    try {
      observer({ key, state, positionMs })
    } catch {
      // A mouth observer is optional and must never disturb audio playback.
    }
  }

  /** The mouth-only native state that prevents actual playback sampling. */
  private mouthBlockedState(): 'paused' | 'waiting' | null {
    if (this.element.paused) return 'paused'
    if (this.element.seeking) return 'waiting'
    return null
  }

  /**
   * Publish one neutral when polling discovers a blocked native state after a
   * real playing mouth. With no open mouth this stays silent, preserving the
   * initial stray-playing/seek behavior.
   */
  private blockMouthObservation(state: 'paused' | 'waiting'): void {
    this.stopMouthPolling()
    if (this.mouthState !== 'playing') return
    this.mouthState = state
    this.deliverMouth(state, this.mouthPositionMs() ?? 0)
  }

  private observeMouth(state: 'waiting' | 'paused'): void {
    if (!this.mouthEnabled || this.mouthTerminal) return
    const changed = this.mouthState !== state
    this.mouthState = state
    this.stopMouthPolling()
    // A native seeking/pause after polling already discovered the same blocked
    // state must not publish a second neutral.
    if (!changed) return
    this.deliverMouth(state, this.mouthPositionMs() ?? 0)
  }

  private finishMouth(state: 'ended' | 'error' | 'stopped'): void {
    if (!this.mouthEnabled || this.mouthTerminal) return
    // Terminal is committed before any external observer runs. A reentrant
    // detach then observes a closed mouth and cannot produce a second Stop.
    this.mouthTerminal = true
    this.mouthState = state
    this.stopMouthPolling()
    this.removeMouthListeners()
    this.deliverMouth(state, this.mouthPositionMs() ?? 0)
  }

  private startMouthPolling(): void {
    if (!this.mouthEnabled || this.mouthTerminal) return
    if (this.mouthState !== 'playing' || this.mouthPoll !== null) return
    this.mouthPollToken += 1
    const token = this.mouthPollToken
    this.mouthPoll = setInterval(() => {
      // A callback cancelled by pause/wait/seek/terminal may still be queued.
      // Its old token can never speak over a newer playing interval.
      if (token !== this.mouthPollToken) return
      if (!this.mouthEnabled || this.mouthTerminal || this.mouthState !== 'playing') {
        this.stopMouthPolling()
        return
      }
      const blocked = this.mouthBlockedState()
      if (blocked !== null) {
        this.blockMouthObservation(blocked)
        return
      }
      this.deliverMouth('playing', this.mouthPositionMs())
    }, MOUTH_SAMPLE_INTERVAL_MS)
  }

  private stopMouthPolling(): void {
    this.mouthPollToken += 1
    if (this.mouthPoll === null) return
    clearInterval(this.mouthPoll)
    this.mouthPoll = null
  }

  private removeMouthListeners(): void {
    if (!this.mouthListening) return
    this.element.removeEventListener('waiting', this.handleWaiting)
    this.element.removeEventListener('seeking', this.handleSeeking)
    this.element.removeEventListener('pause', this.handlePause)
    this.mouthListening = false
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
  }

  private removeOwnedListeners(): void {
    this.element.removeEventListener('playing', this.handlePlaying)
    this.element.removeEventListener('ended', this.handleEnded)
    this.element.removeEventListener('error', this.handleError)
    this.removeMouthListeners()
    this.listeners.clear()
  }

  subscribe(listener: (event: MediaEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  load(blob: Blob): void {
    this.revokeObjectUrl()
    this.objectUrl = URL.createObjectURL(blob)
    this.element.src = this.objectUrl
    this.element.load()
  }

  play(): Promise<void> {
    return this.element.play()
  }

  detach(): boolean {
    if (this.detached) return true
    // A reentrant detach from the Stop observer must not run cleanup twice.
    if (this.detaching) return false
    this.detaching = true
    // Invalidate the mouth before any element operation: a failed detach still
    // reports exactly one Stop and cannot be reopened by a later event.
    this.finishMouth('stopped')
    this.stopMouthPolling()
    try {
      this.element.pause()
      this.element.removeAttribute('src')
      this.element.load()
      this.removeOwnedListeners()
      this.revokeObjectUrl()
      this.detached = true
      return true
    } catch {
      return false
    } finally {
      this.detaching = false
    }
  }
}

/**
 * Creates real HTMLAudioElement-backed media handles for the browser player.
 *
 * `onMouthPlayback` is optional. Without it, a handle created with an admitted
 * command lazily consults the transport's `getEnvelopeObserver()`; a handle
 * created without a command is a voice preview and never resolves or invokes a
 * mouth observer. When no observer is available, no mouth timer or listener is
 * added and normal audio still plays.
 */
export function createDomMediaDriver(
  options: { readonly onMouthPlayback?: MouthPlaybackObserver } = {},
): MediaDriver {
  const explicitObserver =
    typeof options.onMouthPlayback === 'function' ? options.onMouthPlayback : null
  return {
    create: (command?: PerformanceCommand): MediaHandle =>
      new DomMediaHandle(
        explicitObserver,
        command === undefined ? null : mouthKeyOf(command),
        resolveSharedObserver,
      ),
  }
}
