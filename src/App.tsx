import type { BootstrapSnapshot } from './contracts'
import type { AudioLease, AudioResolver } from './performance/browser'
import { createDomMediaDriver } from './performance/browser'
import { ConsoleApp } from './console/ConsoleApp'
import type { TransportStatusReporter } from './console/ConsoleApp'
import { createAppTransport } from './console/app-transport'
import { createPlaybackBinding } from './console/player-binding'
import type { PlaybackBinding, PlaybackCallbacks } from './console/player-binding'

/**
 * Console composition root.
 *
 * The console itself is pure view state; transport and playback reach it only
 * through injected factories. They are module-level constants so the console's
 * setup effect keeps a stable dependency list and never reconnects per render.
 *
 * The application endpoint is the runtime's v0.2 socket. No runtime serves it
 * yet, so the console honestly reports a closed transport until the M5 endpoint
 * and its dev-server proxy entry exist.
 */

const APPLICATION_PATH = '/app'

/**
 * The audio references this build can resolve. A reference is never treated as
 * a URL: it must appear in this explicit registry. Real delivery of audio bytes
 * still waits for a runtime-owned channel, so these are the prepared fixed
 * segments only.
 */
const AUDIO_REFS: ReadonlyMap<string, string> = new Map<string, string>([
  ['audio://fixture/segment-0', '/assets/segment-0.wav'],
  ['audio://fixture/segment-1', '/assets/segment-1.wav'],
])

function createConsoleResolver(): AudioResolver {
  return {
    async resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease> {
      const assetUrl = AUDIO_REFS.get(audioRef)
      if (assetUrl === undefined) throw new Error(`unregistered audio ref: ${audioRef}`)
      const response = await fetch(assetUrl, { signal })
      if (!response.ok) throw new Error(`segment fetch failed with status ${response.status}`)
      const blob = await response.blob()
      return {
        blob,
        release() {
          // The DOM driver owns its object URL; the lease owns only the Blob.
        },
      }
    },
  }
}

function createConsoleTransport(reporter: TransportStatusReporter) {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return createAppTransport({
    url: `${scheme}://${window.location.host}${APPLICATION_PATH}`,
    onStatus: reporter.onStatus,
    onProtocolViolation: reporter.onProtocolViolation,
  })
}

let receiptCounter = 0

function createConsolePlayback(bootstrap: BootstrapSnapshot, callbacks: PlaybackCallbacks): PlaybackBinding {
  return createPlaybackBinding({
    bootstrap,
    resolver: createConsoleResolver(),
    media: createDomMediaDriver(),
    newReceiptId: () => {
      receiptCounter += 1
      return `console-receipt-${receiptCounter}`
    },
    localNowMs: () => Math.round(performance.now()),
    ...callbacks,
  })
}

function App() {
  return <ConsoleApp transportFactory={createConsoleTransport} playbackFactory={createConsolePlayback} />
}

export default App
