import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AudioLease } from '../performance/browser/types'
import { AUDIO_FETCH_HEADER, AUDIO_PATH } from './config'

/**
 * M5 dynamic audio resource route.
 *
 * It serves the bytes of a registered, currently admissible audio resource to a
 * same-origin browser client. The request is an explicit acquisition
 * (`POST /audio?ref=...` with the audio-fetch header), never a cacheable GET:
 * a browser POST carries the `Origin` header, so the strict exact-origin policy
 * is kept and a missing Origin is refused rather than admitted.
 *
 * The route never treats the reference as a filename, path or URL; it hands the
 * opaque string only to the injected source (`AudioResourceSource`, satisfied by
 * the M1 `AudioResourceRegistry`), which refuses anything it does not currently
 * hold. Admission is scoped to the authoritative live session/epoch and its
 * serving lifecycle, captured at request start and rechecked after the resolver
 * settles and again immediately before bytes are published, so a Stop,
 * retirement, recovery or degraded state during acquisition can never publish
 * stale audio, even when the epoch itself did not change.
 *
 * The serving slot and the resource lease are held until the response finishes,
 * closes or errors. Early client disconnect, a late resolver settlement and
 * route disposal each release exactly once: a release requested before the
 * resolver settled is applied to the lease the moment it is held, so a
 * non-cooperating resolver cannot leak its resource. Disposal also terminates a
 * still-open response instead of waiting forever for completion.
 *
 * `AudioResolver.resolve(audioRef, signal)` remains the unchanged browser-side
 * consumer seam (M2); a browser resolver implements it by POSTing this route.
 */

/** Serving seam for the route; structurally satisfied by the M1 registry. */
export interface AudioResourceSource {
  /**
   * Pure admission query for one reference and its original session/epoch.
   * Returns `null` only while the reference is the same active, unretired
   * resource for that identity; otherwise a lifecycle code.
   */
  admission(audioRef: string, sessionId: string, epoch: number): string | null
  /** Resolve an admitted reference to an owned lease; failures are refusals. */
  resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease>
}

export interface AudioRouteIdentity {
  readonly sessionId: string
  readonly epoch: number
  /**
   * `false` marks a runtime that must not serve new audio: stopped (including
   * the initial stopped composition), retiring, degraded or otherwise not
   * currently serving. The route refuses it at admission and again after every
   * asynchronous boundary. An omitted value means the source asserted no
   * lifecycle: only the composition owner can know the label, and the
   * production wiring always asserts it.
   */
  readonly servable?: boolean
}

export interface AudioResourceRouteOptions {
  readonly source: AudioResourceSource
  /**
   * Authoritative live identity, read per request and after every asynchronous
   * boundary; a throwing read is treated as unavailable.
   */
  readonly liveIdentity: () => AudioRouteIdentity
  /** The endpoint's strict origin/host checks; both refuse missing values. */
  readonly allowOrigin: (origin: string | undefined) => boolean
  readonly allowHost: (host: string | undefined) => boolean
  /** Concurrent in-flight acquisitions; further requests are refused `busy`. */
  readonly maxConcurrent?: number
}

export interface AudioResourceRoute {
  readonly path: string
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean
  /** In-flight acquisitions, including ones whose resolver ignores abort. */
  pendingCount(): number
  /**
   * Refuses new work, aborts every in-flight acquisition signal and terminates
   * every still-open response, so no serve can wait forever on completion.
   */
  dispose(): void
}

const DEFAULT_MAX_CONCURRENT = 8

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i

function safeContentType(blob: Blob): string {
  return MIME_PATTERN.test(blob.type) ? blob.type : 'application/octet-stream'
}

/** A structured lifecycle refusal carries a string code; anything else is internal. */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * Resolves when the response has finished, closed or errored. Listeners are
 * attached before the first asynchronous boundary of a serve; an already
 * ended/destroyed response resolves immediately.
 */
function responseDone(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('finish', done)
      res.off('close', done)
      res.off('error', done)
      resolve()
    }
    res.once('finish', done)
    res.once('close', done)
    res.once('error', done)
  })
}

export function createAudioResourceRoute(options: AudioResourceRouteOptions): AudioResourceRoute {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 1024) {
    throw new RangeError(`maxConcurrent must be an integer between 1 and 1024, got ${maxConcurrent}`)
  }
  const { source, liveIdentity, allowOrigin, allowHost } = options
  let disposed = false
  let inFlight = 0
  interface InFlightServe {
    readonly controller: AbortController
    readonly res: ServerResponse
  }
  const inFlightServes = new Set<InFlightServe>()
  const pending = new Set<Promise<void>>()

  const writeJson = (res: ServerResponse, status: number, code: string): void => {
    if (res.headersSent || res.destroyed) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify({ ok: false, error: { code } }))
  }

  const isServable = (identity: AudioRouteIdentity): boolean => identity.servable !== false

  const stillLive = (identity: AudioRouteIdentity): boolean => {
    if (disposed) return false
    let current: AudioRouteIdentity
    try {
      current = liveIdentity()
    } catch {
      return false
    }
    return (
      current.sessionId === identity.sessionId &&
      current.epoch === identity.epoch &&
      isServable(current)
    )
  }

  /** Recheck after an asynchronous boundary: identity, disposition and admission. */
  const stale = (ref: string, identity: AudioRouteIdentity): boolean =>
    disposed || !stillLive(identity) || source.admission(ref, identity.sessionId, identity.epoch) !== null

  const serve = async (
    res: ServerResponse,
    ref: string,
    controller: AbortController,
  ): Promise<void> => {
    const signal = controller.signal
    const done = responseDone(res)
    let lease: AudioLease | null = null
    let releaseRequested = false
    let released = false
    /**
     * Releases the held lease exactly once. A release requested while the
     * resolver is still pending (early client disconnect or disposal) is
     * recorded here and applied by `holdLease` when the lease arrives, so a
     * late non-cooperating settlement still releases its resource.
     */
    const releaseIfHeld = (): void => {
      if (!releaseRequested || released || lease === null) return
      released = true
      const held = lease
      lease = null
      try {
        held.release()
      } catch {
        // A lease release fault must not wedge the response lifecycle.
      }
    }
    const requestRelease = (): void => {
      releaseRequested = true
      releaseIfHeld()
    }
    const holdLease = (held: AudioLease): void => {
      lease = held
      releaseIfHeld()
    }
    // The lease and the serving slot live until the response has finished,
    // closed or errored; an early disconnect aborts the acquisition.
    res.once('finish', requestRelease)
    res.once('close', () => {
      controller.abort()
      requestRelease()
    })
    res.once('error', requestRelease)

    try {
      let identity: AudioRouteIdentity
      try {
        identity = liveIdentity()
      } catch {
        writeJson(res, 503, 'unavailable')
        return
      }
      if (disposed) {
        writeJson(res, 503, 'unavailable')
        return
      }
      if (!isServable(identity)) {
        writeJson(res, 409, 'conflict')
        return
      }
      if (source.admission(ref, identity.sessionId, identity.epoch) !== null) {
        writeJson(res, 404, 'not_found')
        return
      }

      let heldLease: AudioLease | null = null
      try {
        heldLease = await source.resolve(ref, signal)
        holdLease(heldLease)
      } catch (error) {
        // `disposed` means the owner is gone (transient); every other structured
        // refusal stays `not_found`, so the route exposes no lifecycle oracle.
        const code = errorCode(error)
        if (code === 'disposed') writeJson(res, 503, 'unavailable')
        else if (code !== null) writeJson(res, 404, 'not_found')
        else writeJson(res, 500, 'internal')
        return
      }

      // The resolver settled: recheck before publishing anything. A release
      // already requested for an aborted or disposed serve was applied by
      // `holdLease`, so nothing further may be written.
      if (heldLease === null || releaseRequested || signal.aborted || res.destroyed) return
      if (stale(ref, identity)) {
        requestRelease()
        writeJson(res, 409, 'conflict')
        return
      }

      const bytes = Buffer.from(await heldLease.blob.arrayBuffer())
      if (releaseRequested || signal.aborted || res.destroyed) return
      if (stale(ref, identity)) {
        requestRelease()
        writeJson(res, 409, 'conflict')
        return
      }

      res.writeHead(200, {
        'content-type': safeContentType(heldLease.blob),
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
    } catch {
      if (res.headersSent) res.destroy()
      else writeJson(res, 500, 'internal')
    } finally {
      await done
      requestRelease()
    }
  }

  return {
    path: AUDIO_PATH,

    pendingCount: () => pending.size,

    handleHttp(req, res) {
      let url: URL
      try {
        url = new URL(req.url ?? '', 'http://localhost')
      } catch {
        return false
      }
      if (url.pathname !== AUDIO_PATH) return false

      if (req.method !== 'POST') {
        writeJson(res, 405, 'method_not_allowed')
        return true
      }
      if (req.headers[AUDIO_FETCH_HEADER] === undefined) {
        writeJson(res, 403, 'forbidden')
        return true
      }
      if (!allowOrigin(req.headers.origin) || !allowHost(req.headers.host)) {
        writeJson(res, 403, 'forbidden')
        return true
      }
      const refs = url.searchParams.getAll('ref')
      if (refs.length !== 1 || refs[0].length === 0) {
        writeJson(res, 400, 'malformed')
        return true
      }
      if (disposed) {
        writeJson(res, 503, 'unavailable')
        return true
      }
      if (inFlight >= maxConcurrent) {
        writeJson(res, 429, 'busy')
        return true
      }

      const controller = new AbortController()
      const entry: InFlightServe = { controller, res }
      inFlightServes.add(entry)
      inFlight += 1
      const operation = serve(res, refs[0], controller).finally(() => {
        inFlightServes.delete(entry)
        pending.delete(operation)
        inFlight -= 1
      })
      pending.add(operation)
      return true
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const { controller, res } of [...inFlightServes]) {
        controller.abort()
        // Terminate a still-open response so no serve waits forever on
        // response completion; a late non-cooperating resolver still releases
        // its resource when it settles.
        if (!res.writableEnded && !res.destroyed) res.destroy()
      }
    },
  }
}
