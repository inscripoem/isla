import { Button, Card, Tag, Title } from 'animal-island-ui'
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
  readonly canBootstrapOperator: boolean
  readonly operatorRequestPending: boolean
  readonly operatorRequestError: string | null
  readonly onDraftChange: (voiceId: string) => void
  readonly onPreview: () => void
  readonly onStopPreview: () => void
  readonly onApply: () => void
  readonly onBootstrapOperator: () => void
}

function localeLabel(locale: VoiceLocale): string {
  return locale === 'en-US' ? 'US' : 'UK'
}

function voiceName(state: VoiceSelectionState, voiceId: string | null): string {
  if (voiceId === null) return 'none selected'
  const voice = state.voices.find((entry) => entry.id === voiceId)
  return voice === undefined ? voiceId : voice.name
}

function statusLine(props: VoiceCardProps): string {
  const { state, audition, connected, retiring, operator } = props
  if (!connected) return 'Connect an application session to load or preview voices.'
  if (state.pendingListMessageId !== null) return 'Loading installed voices…'
  if (audition.phase === 'preparing' || state.preview.requestMessageId !== null) {
    return `Preparing preview of ${voiceName(state, state.draftVoiceId)}…`
  }
  if (audition.phase === 'playing') return `Playing preview of ${voiceName(state, audition.voiceId)}.`
  if (audition.phase === 'blocked') {
    return 'Sample ready. Click Preview voice again to play it.'
  }
  if (audition.phase === 'error') return audition.detail ?? 'Preview playback failed.'
  if (state.selectionOutcome === 'pending') {
    return `Applying ${voiceName(state, state.draftVoiceId)}… waiting for the server acknowledgement.`
  }
  if (state.selectionOutcome === 'refused') {
    return `Voice change refused${state.lastError === null ? '.' : `: ${state.lastError.message}`}`
  }
  if (state.lastError !== null) return `Voice request failed: ${state.lastError.message}`
  if (state.selectionOutcome === 'unknown') {
    return 'Voice change is unconfirmed after the transport dropped. The last confirmed voice stays shown.'
  }
  if (retiring) return 'This session is retiring; applying a voice is disabled until a successor session.'
  if (audition.phase === 'ended') return 'Preview ended.'
  if (state.selectionOutcome === 'confirmed') return 'Voice change confirmed by the server.'
  if (state.voices.length === 0) return 'This deployment has no installed voices.'
  if (!operator) return 'Draft and preview are local. Use this voice requires operator authority.'
  return 'Draft and preview are local. Use this voice asks the server to change the active voice.'
}

export function VoiceCard(props: VoiceCardProps) {
  const { state, audition, connected, retiring, operator } = props
  const voicesAvailable = state.voices.length > 0
  const selectable = connected && voicesAvailable && state.pendingListMessageId === null
  const previewDisabled =
    retiring || !selectable || state.draftVoiceId === null || state.selectionOutcome === 'pending'
  const previewBusy =
    state.preview.requestMessageId !== null ||
    audition.phase === 'preparing' ||
    audition.phase === 'playing' ||
    audition.phase === 'blocked'
  const applyDisabled =
    !connected ||
    retiring ||
    !operator ||
    state.pendingListMessageId !== null ||
    state.draftVoiceId === null ||
    state.draftVoiceId === state.activeVoiceId ||
    state.selectionOutcome === 'pending'
  const activeNeedsQualifier =
    state.activeVoiceId !== null &&
    (!connected || state.pendingListMessageId !== null || state.selectionOutcome === 'unknown')

  return (
    <Card>
      <div className="console__card-head">
        <Title size="middle">Voice</Title>
        <Tag variant="outlined" color={operator ? 'app-teal' : 'app-yellow'}>
          {operator ? 'operator' : 'viewer'}
        </Tag>
      </div>

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
            if (event.target.value.length > 0) props.onDraftChange(event.target.value)
          }}
        >
          <option value="" disabled>
            {voicesAvailable ? 'Choose a voice' : 'No installed voices'}
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
      </div>

      <p className="console__hint console__voice-status" id="console-voice-status" role="status" aria-live="polite">
        {statusLine(props)}
      </p>

      {!operator && (
        <p className="console__hint">
          Viewer access: draft and preview are available on this local console, but only an operator can apply a
          voice.
          {props.canBootstrapOperator
            ? ' Bootstrap operator to enable Use this voice.'
            : ' Use this voice stays disabled until this connection has operator authority.'}
        </p>
      )}
      {!operator && props.canBootstrapOperator && (
        <div className="console__actions">
          <Button size="small" loading={props.operatorRequestPending} onClick={props.onBootstrapOperator}>
            Bootstrap operator
          </Button>
        </div>
      )}
      {props.operatorRequestError !== null && <p className="console__alert">{props.operatorRequestError}</p>}
    </Card>
  )
}
