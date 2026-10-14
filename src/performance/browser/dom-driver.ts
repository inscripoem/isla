import type { MediaDriver, MediaEvent, MediaHandle } from './types'

/**
 * HTMLAudioElement-backed media handle. It creates and owns exactly one object
 * URL per load and releases it on the next load or on detach. `detach()` is
 * synchronous, non-throwing and idempotent; it reports a failed local
 * detachment as `false` rather than hiding it behind a successful result.
 *
 * Event-based `playing`/`ended`/`error` observations are the only playback
 * evidence; the `play()` promise settlement is not treated as a start fact.
 */
class DomMediaHandle implements MediaHandle {
  private readonly element: HTMLAudioElement
  private readonly listeners = new Set<(event: MediaEvent) => void>()
  private objectUrl: string | null = null
  private detached = false

  private readonly handlePlaying = (): void => {
    this.emit({ type: 'playing' })
  }

  private readonly handleEnded = (): void => {
    this.emit({ type: 'ended' })
  }

  private readonly handleError = (): void => {
    const code = this.element.error?.code
    this.emit({
      type: 'error',
      reasonCode: code === undefined || code === null ? 'media_error' : `media_error_${code}`,
    })
  }

  constructor() {
    this.element = document.createElement('audio')
    this.element.preload = 'auto'
    this.element.addEventListener('playing', this.handlePlaying)
    this.element.addEventListener('ended', this.handleEnded)
    this.element.addEventListener('error', this.handleError)
  }

  private emit(event: MediaEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
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
    try {
      this.element.pause()
      this.element.removeAttribute('src')
      this.element.load()
      this.revokeObjectUrl()
      this.detached = true
      return true
    } catch {
      return false
    }
  }
}

/** Creates real HTMLAudioElement-backed media handles for the browser player. */
export function createDomMediaDriver(): MediaDriver {
  return {
    create: (): MediaHandle => new DomMediaHandle(),
  }
}
