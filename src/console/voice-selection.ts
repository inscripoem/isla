import {
  APPLICATION_CONTRACT_VERSION,
  voiceSampleMessageSchema,
  voiceStateMessageSchema,
} from '../contracts'
import type {
  VoiceListMessage,
  VoiceOption,
  VoicePreviewMessage,
  VoiceSampleMessage,
  VoiceSelectMessage,
  VoiceStateMessage,
} from '../contracts'

export type { VoiceLocale, VoiceOption } from '../contracts'

/**
 * Console-side voice selection (TA-004).
 *
 * The shared application contract owns the wire schemas now. This module keeps
 * only the console's pure transitions and the request builders, so the card can
 * be tested without a browser, transport or backend.
 *
 * The active voice changes only when a `voice.state` acknowledgement correlates
 * to the request that asked for it. Drafts, previews and local transport loss
 * never promote themselves to the active voice.
 */

export interface VoiceRequestIdentity {
  readonly sessionId: string
  readonly epoch: number
  readonly messageId: string
}

export type VoiceClientMessage = VoiceListMessage | VoiceSelectMessage | VoicePreviewMessage

/** The server body a transition needs; the full shared envelope is accepted too. */
export type VoiceStateUpdate = Pick<VoiceStateMessage, 'kind' | 'payload'>
export type VoiceSampleUpdate = Pick<VoiceSampleMessage, 'kind' | 'payload'>

export type VoiceServerMessage = VoiceStateMessage | VoiceSampleMessage

export type VoiceSelectionOutcome = 'idle' | 'pending' | 'confirmed' | 'refused' | 'unknown'

export interface VoiceErrorView {
  readonly requestMessageId: string | null
  readonly code: string
  readonly message: string
}

export interface VoicePreviewState {
  /** Local fence for slow, replaced or late sample responses. */
  readonly epoch: number
  readonly requestMessageId: string | null
  readonly voiceId: string | null
  readonly wavBase64: string | null
}

export interface VoiceSelectionState {
  readonly voices: readonly VoiceOption[]
  /** The operator's dropdown choice. It is never the active voice by itself. */
  readonly draftVoiceId: string | null
  /** The last server-confirmed active voice, or null when none is selected. */
  readonly activeVoiceId: string | null
  readonly selectionOutcome: VoiceSelectionOutcome
  readonly pendingSelectionMessageId: string | null
  readonly pendingListMessageId: string | null
  readonly preview: VoicePreviewState
  readonly lastError: VoiceErrorView | null
}

const INITIAL_PREVIEW: VoicePreviewState = {
  epoch: 0,
  requestMessageId: null,
  voiceId: null,
  wavBase64: null,
}

export function createInitialVoiceSelectionState(): VoiceSelectionState {
  return {
    voices: [],
    draftVoiceId: null,
    activeVoiceId: null,
    selectionOutcome: 'idle',
    pendingSelectionMessageId: null,
    pendingListMessageId: null,
    preview: INITIAL_PREVIEW,
    lastError: null,
  }
}

function createEnvelope(identity: VoiceRequestIdentity) {
  return {
    protocolVersion: APPLICATION_CONTRACT_VERSION,
    messageId: identity.messageId,
    sessionId: identity.sessionId,
    epoch: identity.epoch,
  } as const
}

export function requestVoiceList(
  state: VoiceSelectionState,
  identity: VoiceRequestIdentity,
): { readonly state: VoiceSelectionState; readonly message: VoiceListMessage } {
  return {
    state: {
      ...state,
      pendingListMessageId: identity.messageId,
      lastError: null,
    },
    message: { ...createEnvelope(identity), kind: 'voice.list', payload: {} },
  }
}

/**
 * Change only the draft. No request is sent and the active voice is untouched.
 * An adoption in flight holds the draft: a later dropdown change cannot replace
 * the choice whose acknowledgement is still outstanding.
 */
export function withVoiceDraft(state: VoiceSelectionState, voiceId: string): VoiceSelectionState {
  if (state.pendingSelectionMessageId !== null || state.selectionOutcome === 'pending') return state
  return {
    ...state,
    draftVoiceId: voiceId,
    // A new intent supersedes an old refusal, confirmation or uncertain result.
    selectionOutcome: 'idle',
    lastError: null,
  }
}

/**
 * Start an explicit apply request for the current draft. The active voice stays
 * where it was until a matching `voice.state` acknowledgement arrives.
 */
export function requestVoiceSelection(
  state: VoiceSelectionState,
  identity: VoiceRequestIdentity,
  operator: boolean,
): { readonly state: VoiceSelectionState; readonly message: VoiceSelectMessage | null } {
  if (!voiceApplyAllowed(operator)) return { state, message: null }
  // Event-time guard: a second click cannot duplicate an adoption that is
  // already awaiting its correlated acknowledgement, even before a re-render.
  if (state.pendingSelectionMessageId !== null || state.selectionOutcome === 'pending') {
    return { state, message: null }
  }
  const voiceId = state.draftVoiceId
  if (voiceId === null) return { state, message: null }
  if (!state.voices.some((voice) => voice.id === voiceId)) return { state, message: null }
  return {
    state: {
      ...state,
      pendingSelectionMessageId: identity.messageId,
      selectionOutcome: 'pending',
      lastError: null,
    },
    message: { ...createEnvelope(identity), kind: 'voice.select', payload: { voiceId } },
  }
}

/** Whether this connection's authority may ask the server to change the voice. */
export function voiceApplyAllowed(operator: boolean): boolean {
  return operator
}

/**
 * Start one audition request. The preview gets a fresh local epoch, so every
 * sample response for an earlier request is fenced out even if it arrives after
 * a replacement, Stop or disconnect.
 */
export function requestVoicePreview(
  state: VoiceSelectionState,
  voiceId: string,
  identity: VoiceRequestIdentity,
): { readonly state: VoiceSelectionState; readonly message: VoicePreviewMessage; readonly epoch: number } {
  const epoch = state.preview.epoch + 1
  return {
    state: {
      ...state,
      preview: {
        epoch,
        requestMessageId: identity.messageId,
        voiceId,
        wavBase64: null,
      },
      lastError: null,
    },
    message: { ...createEnvelope(identity), kind: 'voice.preview', payload: { voiceId } },
    epoch,
  }
}

/**
 * Stop one audition and fence every response still in flight. The draft and the
 * active voice are never changed here.
 */
export function stopVoicePreview(state: VoiceSelectionState): VoiceSelectionState {
  return {
    ...state,
    preview: {
      ...state.preview,
      epoch: state.preview.epoch + 1,
      requestMessageId: null,
      voiceId: null,
      wavBase64: null,
    },
  }
}

/** Accept only the sample that belongs to the current preview epoch and request. */
export function withVoiceSample(
  state: VoiceSelectionState,
  message: VoiceSampleUpdate,
  epoch: number,
): VoiceSelectionState {
  const preview = state.preview
  if (epoch !== preview.epoch) return state
  if (preview.requestMessageId === null) return state
  if (preview.requestMessageId !== message.payload.requestMessageId) return state
  if (preview.voiceId !== message.payload.voiceId) return state
  return {
    ...state,
    preview: {
      ...preview,
      requestMessageId: null,
      wavBase64: message.payload.wavBase64,
    },
  }
}

/**
 * Apply one correlated server voice state. A response that matches neither the
 * outstanding list nor the outstanding selection request is stale and ignored.
 */
export function withVoiceState(
  state: VoiceSelectionState,
  message: VoiceStateUpdate,
): VoiceSelectionState {
  const requestMessageId = message.payload.requestMessageId
  const matchesSelection =
    state.pendingSelectionMessageId !== null && requestMessageId === state.pendingSelectionMessageId
  const matchesList =
    state.pendingListMessageId !== null && requestMessageId === state.pendingListMessageId
  if (!matchesSelection && !matchesList) return state

  const voices = [...message.payload.voices]
  if (matchesSelection) {
    return {
      ...state,
      voices,
      activeVoiceId: message.payload.selectedVoiceId,
      draftVoiceId: message.payload.selectedVoiceId,
      selectionOutcome: 'confirmed',
      pendingSelectionMessageId: null,
      pendingListMessageId: null,
      lastError: null,
    }
  }
  // A list response may confirm the current voice, but it must not overwrite a
  // selection the operator has already started.
  if (state.pendingSelectionMessageId !== null) {
    return { ...state, voices, pendingListMessageId: null }
  }
  const draftStillInstalled =
    state.draftVoiceId !== null && voices.some((voice) => voice.id === state.draftVoiceId)
  return {
    ...state,
    voices,
    activeVoiceId: message.payload.selectedVoiceId,
    // A fresh authoritative list clears stale outcomes, but it must not discard
    // a genuine draft the user picked after the previous result.
    draftVoiceId: draftStillInstalled ? state.draftVoiceId : message.payload.selectedVoiceId,
    selectionOutcome: 'idle',
    pendingListMessageId: null,
    lastError: null,
  }
}

/**
 * Record a request refusal or a local dispatch failure. Only a matching voice
 * request is settled; the already-confirmed active voice is preserved.
 */
export function withVoiceError(
  state: VoiceSelectionState,
  error: VoiceErrorView,
): VoiceSelectionState {
  const requestMessageId = error.requestMessageId
  const matchesSelection =
    requestMessageId !== null && requestMessageId === state.pendingSelectionMessageId
  const matchesList = requestMessageId !== null && requestMessageId === state.pendingListMessageId
  const matchesPreview =
    requestMessageId !== null && requestMessageId === state.preview.requestMessageId
  if (!matchesSelection && !matchesList && !matchesPreview) {
    return { ...state, lastError: error }
  }
  const selectionOutcome = matchesSelection
    ? error.code === 'transport_error' || error.code === 'unknown'
      ? 'unknown'
      : 'refused'
    : state.selectionOutcome
  return {
    ...state,
    selectionOutcome,
    pendingSelectionMessageId: matchesSelection ? null : state.pendingSelectionMessageId,
    pendingListMessageId: matchesList ? null : state.pendingListMessageId,
    preview: matchesPreview
      ? {
          ...state.preview,
          epoch: state.preview.epoch + 1,
          requestMessageId: null,
          voiceId: null,
          wavBase64: null,
        }
      : state.preview,
    lastError: error,
  }
}

/**
 * Fence all preview and selection requests after a transport loss. The last
 * confirmed active voice stays visible; a draft is never promoted to it.
 */
export function withVoiceDisconnected(state: VoiceSelectionState): VoiceSelectionState {
  return {
    ...state,
    selectionOutcome: state.selectionOutcome === 'pending' ? 'unknown' : state.selectionOutcome,
    pendingSelectionMessageId: null,
    pendingListMessageId: null,
    preview: {
      ...state.preview,
      epoch: state.preview.epoch + 1,
      requestMessageId: null,
      voiceId: null,
      wavBase64: null,
    },
  }
}

/**
 * Strictly validate one inbound voice message with the shared application
 * schemas. The transport validates the envelope first; this keeps the console
 * from trusting a cast when it projects the voice payload.
 */
export function parseVoiceServerMessage(value: unknown): VoiceServerMessage | null {
  const state = voiceStateMessageSchema.safeParse(value)
  if (state.success) return state.data
  const sample = voiceSampleMessageSchema.safeParse(value)
  if (sample.success) return sample.data
  return null
}
