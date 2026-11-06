import type { AudioLease, AudioResolver } from '../performance/browser/types'

/**
 * Browser-safe runtime audio resolver for the console (M2).
 *
 * It implements the unchanged `AudioResolver.resolve(audioRef, signal)` seam by
 * performing the M5 dynamic audio acquisition: an explicit, non-cacheable
 * `POST /audio?ref=<encoded>` carrying the audio-fetch header. The reference is
 * an opaque string and is only ever placed in the `ref` query parameter; it is
 * never interpreted as a URL, a path segment or a filename.
 *
 * No response bytes are cached, no retries are added, and nothing is logged. A
 * non-2xx response is reported with its status alone, never its body. A network
 * failure or an abort propagates unchanged so an aborted acquisition stays an
 * abort rather than becoming a success.
 */

/**
 * Path of the runtime audio route. These constants mirror the M5 definitions in
 * `src/runtime/config.ts`; this module deliberately does not import that module
 * so the console import graph stays free of the Node runtime graph.
 */
export const RUNTIME_AUDIO_PATH = '/audio'
export const RUNTIME_AUDIO_FETCH_HEADER = 'x-isla-audio-fetch'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface RuntimeAudioResolverOptions {
  readonly fetchImpl?: typeof fetch
  readonly path?: string
}

/** Resolve the fetch implementation lazily, without capturing a missing global. */
function resolveFetch(impl: typeof fetch | undefined): FetchLike {
  if (impl !== undefined) return (input, init) => impl(input, init)
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof globalFetch !== 'function') {
    throw new Error('no fetch implementation is available')
  }
  return (input, init) => globalFetch(input, init)
}

export function createRuntimeAudioResolver(options: RuntimeAudioResolverOptions = {}): AudioResolver {
  const path = options.path ?? RUNTIME_AUDIO_PATH

  return {
    async resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease> {
      if (audioRef.length === 0) {
        throw new Error('audio reference must not be empty')
      }
      const fetchImpl = resolveFetch(options.fetchImpl)
      // The reference is opaque: it is only ever a single encoded query value.
      const url = `${path}?ref=${encodeURIComponent(audioRef)}`
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          [RUNTIME_AUDIO_FETCH_HEADER]: '1',
          accept: 'audio/*',
        },
        credentials: 'same-origin',
        signal,
      })
      if (!response.ok) {
        // Only the status is reported; the response body is never inspected.
        throw new Error(`audio request failed with status ${response.status}`)
      }
      const blob = await response.blob()
      return {
        blob,
        release() {
          // The DOM media driver owns its object URL; the lease owns only the Blob.
        },
      }
    },
  }
}
