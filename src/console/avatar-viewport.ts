/**
 * Pure avatar viewport state and wire parsing for M2.
 *
 * It is deliberately DOM-free: no transport, no canvas, no timers and no real
 * socket. The console only projects what a local relay actually reported, so a
 * missing or stale frame can never invent an avatar. Frame bytes are never kept
 * in view state; only the parser result carries a payload, and callers draw it
 * and drop it.
 */

export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_DIMENSION = 1920
export const MIN_DIMENSION = 1
export const FRESHNESS_WINDOW_MS = 1500
export const AVATAR_CANVAS_CONTEXT_OPTIONS = { alpha: true } as const

export type AvatarRelayConfig =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'invalid'; readonly detail: string }
  | { readonly state: 'configured'; readonly url: string }

export type AvatarSourceKind = 'none' | 'synthetic' | 'ndi'

export interface AvatarStatus {
  readonly protocolVersion: '0.1'
  readonly kind: 'avatar.status'
  readonly source: AvatarSourceKind
  readonly fps: number | null
  readonly lastFrameAt: number | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Validate one `avatar.status` text message. Anything unexpected is rejected. */
export function parseAvatarStatus(value: unknown): AvatarStatus | null {
  const record = asRecord(value)
  if (record === null) return null
  if (record.protocolVersion !== '0.1' || record.kind !== 'avatar.status') return null
  const source = record.source
  if (source !== 'none' && source !== 'synthetic' && source !== 'ndi') return null

  const rawFps = record.fps
  let fps: number | null
  if (rawFps === null) {
    fps = null
  } else if (typeof rawFps === 'number' && Number.isFinite(rawFps) && rawFps >= 0) {
    fps = rawFps
  } else {
    return null
  }

  const rawLastFrameAt = record.lastFrameAt
  let lastFrameAt: number | null
  if (rawLastFrameAt === null) {
    lastFrameAt = null
  } else if (typeof rawLastFrameAt === 'number') {
    lastFrameAt = rawLastFrameAt
  } else {
    return null
  }

  return {
    protocolVersion: '0.1',
    kind: 'avatar.status',
    source,
    fps,
    lastFrameAt,
  }
}

const DEFAULT_RELAY_PATH = '/avatar'

/**
 * True when the value has a scheme-looking prefix that is not a bare host:port,
 * e.g. `javascript:…` or `file:…`. A `host:port` such as `localhost:4320/avatar`
 * has digits after the colon and is treated as a host, not a scheme.
 */
function looksLikeNonRelayScheme(value: string): boolean {
  const match = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/)
  if (match === null) return false
  return !/^[0-9]/.test(match[2] ?? '')
}

/**
 * Resolve the raw `VITE_AVATAR_RELAY_URL` value into a concrete websocket URL or
 * a stable failure. A blank value is unconfigured, a scheme-less host is
 * normalized to ws:// with the default relay path, and an unsupported or
 * malformed value becomes an `invalid` result with a safe detail. The raw value
 * is never echoed in a detail; this never throws.
 */
export function resolveAvatarRelayUrl(raw: string | null | undefined): AvatarRelayConfig {
  if (raw === null || raw === undefined) return { state: 'unconfigured' }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { state: 'unconfigured' }

  let candidate: string
  const schemeEnd = trimmed.indexOf('://')
  if (schemeEnd !== -1) {
    const scheme = trimmed.slice(0, schemeEnd).toLowerCase()
    const rest = trimmed.slice(schemeEnd + 3)
    if (scheme === 'ws' || scheme === 'wss') {
      candidate = trimmed
    } else if (scheme === 'http') {
      candidate = `ws://${rest}`
    } else if (scheme === 'https') {
      candidate = `wss://${rest}`
    } else {
      return { state: 'invalid', detail: `unsupported relay url scheme: ${scheme}` }
    }
  } else if (looksLikeNonRelayScheme(trimmed)) {
    return {
      state: 'invalid',
      detail: 'relay url must use ws://, wss://, http:// or https://',
    }
  } else {
    candidate = `ws://${trimmed}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { state: 'invalid', detail: 'relay url is not a valid URL' }
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return {
      state: 'invalid',
      detail: `unsupported relay url scheme: ${url.protocol.replace(':', '')}`,
    }
  }
  if (url.hostname.length === 0) {
    return { state: 'invalid', detail: 'relay url is not a valid URL' }
  }
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = DEFAULT_RELAY_PATH
  }
  return { state: 'configured', url: url.toString() }
}

export type AvatarPhase = 'unavailable' | 'connecting' | 'live' | 'stale' | 'error'

export interface AvatarViewportState {
  readonly configured: boolean
  readonly phase: AvatarPhase
  readonly source: AvatarSourceKind
  readonly fps: number | null
  readonly lastFrameAt: number | null
  readonly lastFrameReceivedAtMs: number | null
  readonly detail: string | null
}

export function createAvatarViewportState(
  configured: boolean,
  detail: string | null = null,
): AvatarViewportState {
  if (!configured) {
    return {
      configured,
      phase: 'unavailable',
      source: 'none',
      fps: null,
      lastFrameAt: null,
      lastFrameReceivedAtMs: null,
      detail,
    }
  }
  if (detail !== null) {
    return {
      configured,
      phase: 'error',
      source: 'none',
      fps: null,
      lastFrameAt: null,
      lastFrameReceivedAtMs: null,
      detail,
    }
  }
  return {
    configured,
    phase: 'connecting',
    source: 'none',
    fps: null,
    lastFrameAt: null,
    lastFrameReceivedAtMs: null,
    detail: null,
  }
}

export type AvatarViewportAction =
  | { readonly type: 'socket-open' }
  | { readonly type: 'status'; readonly status: AvatarStatus }
  | { readonly type: 'frame'; readonly receivedAtMs: number }
  | { readonly type: 'tick'; readonly nowMs: number }
  | { readonly type: 'socket-closed'; readonly detail?: string | null }
  | { readonly type: 'socket-error'; readonly detail?: string | null }
  | { readonly type: 'frame-rejected'; readonly code: string }
  | { readonly type: 'reconnect' }

/**
 * Reduce one relay observation onto the viewport. A status alone never claims a
 * live avatar, and a live phase goes stale only after the freshness window.
 * Frame clocks are monotonic: a late or out-of-order frame never rewinds the
 * received time or revives a closed socket, and once in `error`/`unavailable` a
 * status or frame is ignored. Nothing here reconnects on its own: that is always
 * an explicit operator action.
 */
export function reduceAvatarViewport(
  state: AvatarViewportState,
  action: AvatarViewportAction,
): AvatarViewportState {
  if (!state.configured) return state
  switch (action.type) {
    case 'socket-open':
      return { ...state, phase: 'connecting', detail: null }
    case 'status': {
      if (state.phase === 'error' || state.phase === 'unavailable') return state
      const status = action.status
      const next: AvatarViewportState = {
        ...state,
        source: status.source,
        fps: status.fps,
        lastFrameAt:
          status.lastFrameAt === null
            ? state.lastFrameAt
            : state.lastFrameAt === null
              ? status.lastFrameAt
              : Math.max(state.lastFrameAt, status.lastFrameAt),
      }
      if (status.source === 'none' && (state.phase === 'connecting' || state.phase === 'live')) {
        return { ...next, phase: 'stale', detail: 'relay reports no source' }
      }
      return next
    }
    case 'frame':
      if (state.phase === 'error') return state
      if (
        state.lastFrameReceivedAtMs !== null &&
        action.receivedAtMs < state.lastFrameReceivedAtMs
      ) {
        return state
      }
      return { ...state, phase: 'live', lastFrameReceivedAtMs: action.receivedAtMs, detail: null }
    case 'tick':
      if (
        state.phase === 'live' &&
        state.lastFrameReceivedAtMs !== null &&
        action.nowMs - state.lastFrameReceivedAtMs > FRESHNESS_WINDOW_MS
      ) {
        return { ...state, phase: 'stale', detail: 'no frame within the freshness window' }
      }
      return state
    case 'socket-closed':
      return { ...state, phase: 'error', detail: action.detail ?? 'relay connection closed' }
    case 'socket-error':
      return { ...state, phase: 'error', detail: action.detail ?? 'relay connection error' }
    case 'frame-rejected':
      if (state.phase === 'error') return state
      return { ...state, detail: `frame rejected: ${action.code}` }
    case 'reconnect':
      if (state.phase !== 'stale' && state.phase !== 'error') return state
      return {
        ...state,
        phase: 'connecting',
        lastFrameReceivedAtMs: null,
        lastFrameAt: null,
        fps: null,
        source: 'none',
        detail: null,
      }
    default:
      return state
  }
}

export interface AvatarFrame {
  readonly format: 1
  readonly width: number
  readonly height: number
  readonly hasAlpha: boolean | null
  readonly payload: Uint8Array
}

export type AvatarFrameErrorCode =
  | 'too_short'
  | 'too_large'
  | 'bad_magic'
  | 'bad_version'
  | 'bad_format'
  | 'bad_dimensions'
  | 'bad_webp'

export type AvatarFrameParseResult =
  | { readonly ok: true; readonly frame: AvatarFrame }
  | { readonly ok: false; readonly code: AvatarFrameErrorCode }

const FRAME_HEADER_BYTES = 8
const MIN_WEBP_BYTES = 12
const VP8X_FLAG_ALPHA = 0x10

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

function readHasAlpha(payload: Uint8Array): boolean | null {
  if (payload.byteLength < 21) return null
  if (!matchesAscii(payload, 12, 'VP8X')) return null
  return (payload[20]! & VP8X_FLAG_ALPHA) !== 0
}

/**
 * Parse the binary `avatar.frame` envelope. A rejected result never exposes the
 * input bytes or a partial frame; only a successful parse returns a payload view
 * after the 8-byte header.
 */
export function parseAvatarFrame(bytes: ArrayBuffer | Uint8Array): AvatarFrameParseResult {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength > MAX_FRAME_BYTES) return { ok: false, code: 'too_large' }
  if (view.byteLength < FRAME_HEADER_BYTES + MIN_WEBP_BYTES) return { ok: false, code: 'too_short' }
  if (view[0] !== 0x41 || view[1] !== 0x56) return { ok: false, code: 'bad_magic' }
  if (view[2] !== 1) return { ok: false, code: 'bad_version' }
  if (view[3] !== 1) return { ok: false, code: 'bad_format' }
  const width = (view[4]! << 8) | view[5]!
  const height = (view[6]! << 8) | view[7]!
  if (
    width < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height < MIN_DIMENSION ||
    height > MAX_DIMENSION
  ) {
    return { ok: false, code: 'bad_dimensions' }
  }
  if (!matchesAscii(view, FRAME_HEADER_BYTES, 'RIFF') || !matchesAscii(view, 16, 'WEBP')) {
    return { ok: false, code: 'bad_webp' }
  }
  const payload = view.subarray(FRAME_HEADER_BYTES)
  return {
    ok: true,
    frame: {
      format: 1,
      width,
      height,
      hasAlpha: readHasAlpha(payload),
      payload,
    },
  }
}

export type AvatarDecodeResult<T> =
  | { readonly ok: true; readonly bitmap: T }
  | { readonly ok: false; readonly code: 'decode_failed' }

/**
 * Decode an already-parsed frame payload. A decoder rejection is reported as a
 * stable code rather than propagated, so one bad frame can never tear down the
 * viewport.
 */
export async function decodeAvatarFrame<T>(
  frame: AvatarFrame,
  createBitmap: (payload: Uint8Array) => Promise<T>,
): Promise<AvatarDecodeResult<T>> {
  try {
    const bitmap = await createBitmap(frame.payload)
    return { ok: true, bitmap }
  } catch {
    return { ok: false, code: 'decode_failed' }
  }
}
