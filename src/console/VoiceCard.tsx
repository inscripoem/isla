import { Button, Card, Title } from 'animal-island-ui'
import type { VoiceAuditionView } from './voice-audition'
import type { VoiceLocale, VoiceSelectionState } from './voice-selection'

/**
 * Compact product Voice card (TA-004).
 *
 * The card shows the server-confirmed active voice, a draft choice in a native
 * labeled combobox, a local-only audition, and the explicit operator apply
 * action. It never turns a dropdown change or a preview into the active voice.
 */

export interface VoiceCardProps {
  readonly state: VoiceSelectionState
  readonly audition: VoiceAuditionView
  readonly connected: boolean
  readonly retiring: boolean
  readonly operator: boolean
  readonly productPlaybackBusy: boolean
  readonly voiceListUnavailable: boolean
  readonly canEnableVoiceChanges: boolean
  readonly operatorRequestPending: boolean
  readonly operatorRequestError: string | null
  readonly onDraftChange: (voiceId: string) => void
  readonly onPreview: () => void
  readonly onStopPreview: () => void
  readonly onApply: () => void
  readonly onEnableVoiceChanges: () => void
}

function localeLabel(locale: VoiceLocale): string {
  return locale === 'en-US' ? 'US' : 'UK'
}

function voiceName(state: VoiceSelectionState, voiceId: string | null): string {
  if (voiceId === null) return 'none selected'
  const voice = state.voices.find((entry) => entry.id === voiceId)
  return voice === undefined ? voiceId : voice.name
}

function viewerStatus(props: VoiceCardProps): string {
  return props.canEnableVoiceChanges
    ? 'Preview a voice, or enable voice changes to use it for replies.'
    : 'Preview a voice; only an operator can use it for replies.'
}

function statusLine(props: VoiceCardProps): string {
  const { state, audition, connected, retiring, operator, productPlaybackBusy } = props
  if (!connected) return 'Connect an application session to choose a voice.'
  if (props.voiceListUnavailable) return 'Installed voices are unavailable on this runtime.'
  if (state.pendingListMessageId !== null) return 'Waiting for installed voices…'
  if (audition.phase === 'preparing' || state.preview.requestMessageId !== null) {
    return `Preparing preview of ${voiceName(state, state.draftVoiceId)}…`
  }
  if (audition.phase === 'playing') return `Playing preview of ${voiceName(state, audition.voiceId)}.`
  if (audition.phase === 'blocked') return 'Sample ready. Click Preview voice again to play it.'
  if (audition.phase === 'error') return audition.detail ?? 'Preview playback failed.'
  if (state.selectionOutcome === 'pending') {
    return `Applying ${voiceName(state, state.draftVoiceId)}…`
  }
  if (state.selectionOutcome === 'refused') {
    return `Voice change refused${state.lastError === null ? '.' : `: ${state.lastError.message}`}`
  }
  if (state.lastError !== null) return `Voice request failed: ${state.lastError.message}`
  if (state.selectionOutcome === 'unknown') return 'Voice change unconfirmed. Current voice stays shown.'
  if (state.voices.length === 0) return 'No installed voices.'
  if (retiring) return 'Voice changes are unavailable while this session retires.'
  if (productPlaybackBusy) return 'Preview is unavailable while product playback is active.'
  if (audition.phase === 'ended') return 'Preview ended.'
  if (!operator) return viewerStatus(props)
  return 'Changes apply to the next reply.'
}

export function VoiceCard(props: VoiceCardProps) {
  const { state, audition, connected, retiring, operator, productPlaybackBusy } = props
  const voicesAvailable = state.voices.length > 0
  const waitingForVoices = state.pendingListMessageId !== null
  const adopting =
    state.pendingSelectionMessageId !== null || state.selectionOutcome === 'pending'
  const selectable = connected && voicesAvailable && !waitingForVoices && !adopting
  const sameSampleInFlight =
    state.draftVoiceId !== null &&
    ((state.preview.requestMessageId !== null && state.preview.voiceId === state.draftVoiceId) ||
      ((audition.phase === 'preparing' || audition.phase === 'playing') &&
        audition.voiceId === state.draftVoiceId))
  const previewDisabled =
    retiring ||
    productPlaybackBusy ||
    !selectable ||
    state.draftVoiceId === null ||
    sameSampleInFlight
  const previewBusy =
    state.preview.requestMessageId !== null ||
    audition.phase === 'preparing' ||
    audition.phase === 'playing' ||
    audition.phase === 'blocked'
  const applyDisabled =
    !connected ||
    retiring ||
    !operator ||
    waitingForVoices ||
    state.draftVoiceId === null ||
    state.draftVoiceId === state.activeVoiceId ||
    adopting
  const activeNeedsQualifier =
    state.activeVoiceId !== null &&
    (!connected || waitingForVoices || state.selectionOutcome === 'unknown')
  const placeholder = props.voiceListUnavailable
    ? 'Installed voices unavailable'
    : waitingForVoices
      ? 'Waiting for installed voices…'
      : voicesAvailable
        ? 'Choose a voice'
        : 'No installed voices'

  return (
    <Card>
      <Title size="middle">Voice</Title>

      <p className="console__voice-current" aria-live="polite">
        Current voice: <strong>{voiceName(state, state.activeVoiceId)}</strong>
        {activeNeedsQualifier ? ' (last confirmed)' : ''}
      </p>

      <div className="console__field console__voice-field">
        <label className="console__label" htmlFor="console-voice">
          Voice
        </label>
        <select
          id="console-voice"
          className="console__voice-select"
          value={state.draftVoiceId ?? ''}
          disabled={!selectable}
          aria-describedby="console-voice-status"
          onChange={(event) => {
            if (adopting) return
            if (event.target.value.length > 0) props.onDraftChange(event.target.value)
          }}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {state.voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {`${voice.name} (${localeLabel(voice.locale)})`}
            </option>
          ))}
        </select>
      </div>

      <div className="console__actions console__voice-actions">
        <Button size="small" disabled={previewDisabled} onClick={props.onPreview}>
          Preview voice
        </Button>
        <Button size="small" disabled={!previewBusy} onClick={props.onStopPreview}>
          Stop preview
        </Button>
        <Button size="small" type="primary" disabled={applyDisabled} onClick={props.onApply}>
          Use this voice
        </Button>
        {!operator && props.canEnableVoiceChanges && (
          <Button size="small" loading={props.operatorRequestPending} onClick={props.onEnableVoiceChanges}>
            Enable voice changes
          </Button>
        )}
      </div>

      <p className="console__hint console__voice-status" id="console-voice-status" role="status" aria-live="polite">
        {statusLine(props)}
      </p>

      {props.operatorRequestError !== null && <p className="console__alert">{props.operatorRequestError}</p>}
    </Card>
  )
}
