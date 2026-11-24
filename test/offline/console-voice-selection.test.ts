import { describe, expect, it } from 'vitest'
import {
  createInitialVoiceSelectionState,
  requestVoiceList,
  requestVoicePreview,
  requestVoiceSelection,
  stopVoicePreview,
  voiceApplyAllowed,
  withVoiceDisconnected,
  withVoiceDraft,
  withVoiceError,
  withVoiceSample,
  withVoiceState,
} from '../../src/console/voice-selection'

/**
 * Console voice selection (TA-004).
 *
 * The runtime and shared wire schemas are owned by the runtime/contract task.
 * This suite fixes only the console-side pure transitions for the chooser that
 * will be mounted in the real product console next round. It intentionally
 * drives the planned helper instead of reproducing its logic in a fake, so a
 * missing or divergent helper fails here before any UI is wired.
 *
 * Agreed wire shapes:
 * - client: voice.list {} / voice.select {voiceId} / voice.preview {voiceId}
 * - server: voice.state {requestMessageId, selectedVoiceId, voices}
 * - server: voice.sample {requestMessageId, voiceId, wavBase64}
 * - refusal: request.error
 *
 * A voice list may be empty. Preview responses are fenced by the helper's
 * preview epoch so a late sample cannot replay after Stop, disconnect or a
 * replacement preview. Viewer connections cannot apply a selection.
 */

const SESSION_ID = 'session-voice-selection'

const VOICES = [
  { id: 'af_heart', name: 'Heart', locale: 'en-US' },
  { id: 'bm_george', name: 'George', locale: 'en-GB' },
] as const

function identity(messageId: string) {
  return { sessionId: SESSION_ID, epoch: 3, messageId }
}

function voiceState(
  requestMessageId: string,
  selectedVoiceId: string | null,
  voices: readonly { id: string; name: string; locale: 'en-US' | 'en-GB' }[] = VOICES,
) {
  return {
    kind: 'voice.state' as const,
    payload: { requestMessageId, selectedVoiceId, voices: [...voices] },
  }
}

function voiceSample(requestMessageId: string, voiceId: string, wavBase64: string) {
  return {
    kind: 'voice.sample' as const,
    payload: { requestMessageId, voiceId, wavBase64 },
  }
}

/** A chooser whose voice.list request was acknowledged by the server. */
function listed(selectedVoiceId: string | null = 'af_heart') {
  const requested = requestVoiceList(createInitialVoiceSelectionState(), identity('voice-list-1'))
  return withVoiceState(
    requested.state,
    voiceState('voice-list-1', selectedVoiceId),
  )
}

describe('console voice selection', () => {
  it('requests the installed voice list and renders the server voice objects', () => {
    const initial = createInitialVoiceSelectionState()
    const requested = requestVoiceList(initial, identity('voice-list-1'))

    expect(requested.message).toMatchObject({
      protocolVersion: '0.2',
      messageId: 'voice-list-1',
      sessionId: SESSION_ID,
      epoch: 3,
      kind: 'voice.list',
      payload: {},
    })

    const state = withVoiceState(
      requested.state,
      voiceState('voice-list-1', 'af_heart'),
    )
    expect(state.voices).toEqual([
      { id: 'af_heart', name: 'Heart', locale: 'en-US' },
      { id: 'bm_george', name: 'George', locale: 'en-GB' },
    ])
    expect(state.activeVoiceId).toBe('af_heart')
    expect(state.draftVoiceId).toBe('af_heart')
  })

  it('keeps a choice in the draft until the operator explicitly applies it', () => {
    const state = withVoiceDraft(listed(), 'bm_george')

    expect(state.draftVoiceId).toBe('bm_george')
    expect(state.activeVoiceId).toBe('af_heart')
    expect(state.pendingSelectionMessageId).toBeNull()
  })

  it('confirms the active voice only from the matching voice.state acknowledgement', () => {
    const draft = withVoiceDraft(listed(), 'bm_george')
    const requested = requestVoiceSelection(draft, identity('voice-select-1'), true)
    if (requested.message === null) throw new Error('expected a voice.select request')

    expect(requested.message).toMatchObject({
      kind: 'voice.select',
      payload: { voiceId: 'bm_george' },
    })
    // The explicit Use action starts a request; it does not itself change the
    // voice the operator is currently hearing.
    expect(requested.state.activeVoiceId).toBe('af_heart')
    expect(requested.state.selectionOutcome).toBe('pending')

    const unmatched = withVoiceState(
      requested.state,
      voiceState('voice-select-other', 'bm_george'),
    )
    expect(unmatched.activeVoiceId).toBe('af_heart')
    expect(unmatched.selectionOutcome).toBe('pending')

    const confirmed = withVoiceState(
      requested.state,
      voiceState(requested.message.messageId, 'bm_george'),
    )
    expect(confirmed.activeVoiceId).toBe('bm_george')
    expect(confirmed.draftVoiceId).toBe('bm_george')
    expect(confirmed.selectionOutcome).toBe('confirmed')
  })

  it('keeps the confirmed active voice when a selection is refused or the transport drops', () => {
    const draft = withVoiceDraft(listed(), 'bm_george')
    const requested = requestVoiceSelection(draft, identity('voice-select-2'), true)
    if (requested.message === null) throw new Error('expected a voice.select request')

    const refused = withVoiceError(requested.state, {
      requestMessageId: requested.message.messageId,
      code: 'refused',
      message: 'voice selection was refused',
    })
    expect(refused.activeVoiceId).toBe('af_heart')
    expect(refused.selectionOutcome).toBe('refused')
    expect(refused.lastError?.code).toBe('refused')

    const dropped = withVoiceDisconnected(requested.state)
    expect(dropped.activeVoiceId).toBe('af_heart')
    expect(dropped.selectionOutcome).toBe('unknown')
    expect(dropped.preview.requestMessageId).toBeNull()
  })

  it('previews a voice without committing the draft or the active voice', () => {
    const draft = withVoiceDraft(listed(), 'bm_george')
    const requested = requestVoicePreview(draft, 'bm_george', identity('voice-preview-1'))

    expect(requested.message).toMatchObject({
      kind: 'voice.preview',
      payload: { voiceId: 'bm_george' },
    })
    expect(requested.state.activeVoiceId).toBe('af_heart')
    expect(requested.state.draftVoiceId).toBe('bm_george')

    const sampled = withVoiceSample(
      requested.state,
      voiceSample('voice-preview-1', 'bm_george', 'UklGRg=='),
      requested.epoch,
    )
    expect(sampled.preview.wavBase64).toBe('UklGRg==')
    expect(sampled.activeVoiceId).toBe('af_heart')
    expect(sampled.draftVoiceId).toBe('bm_george')

    const stopped = stopVoicePreview(sampled)
    expect(stopped.preview.wavBase64).toBeNull()
    expect(stopped.activeVoiceId).toBe('af_heart')
    expect(stopped.draftVoiceId).toBe('bm_george')
  })

  it('fences stale preview samples after Stop, disconnect and replacement', () => {
    const first = requestVoicePreview(
      withVoiceDraft(listed(), 'bm_george'),
      'bm_george',
      identity('voice-preview-a'),
    )

    const stopped = stopVoicePreview(first.state)
    expect(
      withVoiceSample(
        stopped,
        voiceSample('voice-preview-a', 'bm_george', 'STOPPED-STALE'),
        first.epoch,
      ).preview.wavBase64,
    ).toBeNull()

    const disconnected = withVoiceDisconnected(first.state)
    expect(
      withVoiceSample(
        disconnected,
        voiceSample('voice-preview-a', 'bm_george', 'DISCONNECTED-STALE'),
        first.epoch,
      ).preview.wavBase64,
    ).toBeNull()

    const replacement = requestVoicePreview(
      first.state,
      'af_heart',
      identity('voice-preview-b'),
    )
    expect(replacement.epoch).toBeGreaterThan(first.epoch)
    expect(
      withVoiceSample(
        replacement.state,
        voiceSample('voice-preview-a', 'bm_george', 'REPLACED-STALE'),
        first.epoch,
      ).preview.wavBase64,
    ).toBeNull()

    const current = withVoiceSample(
      replacement.state,
      voiceSample('voice-preview-b', 'af_heart', 'FRESH'),
      replacement.epoch,
    )
    expect(current.preview.wavBase64).toBe('FRESH')
    expect(current.activeVoiceId).toBe('af_heart')
  })

  it('does not let a viewer apply a voice selection', () => {
    const draft = withVoiceDraft(listed(), 'bm_george')
    const requested = requestVoiceSelection(draft, identity('voice-select-viewer'), false)

    expect(requested.message).toBeNull()
    expect(requested.state.activeVoiceId).toBe('af_heart')
    expect(requested.state.draftVoiceId).toBe('bm_george')
    expect(requested.state.pendingSelectionMessageId).toBeNull()
    expect(voiceApplyAllowed(false)).toBe(false)
    expect(voiceApplyAllowed(true)).toBe(true)
  })

  it('renders an empty installed-voice list without inventing a selection', () => {
    const requested = requestVoiceList(createInitialVoiceSelectionState(), identity('voice-list-empty'))
    const state = withVoiceState(
      requested.state,
      voiceState('voice-list-empty', null, []),
    )

    expect(state.voices).toEqual([])
    expect(state.activeVoiceId).toBeNull()
    expect(state.draftVoiceId).toBeNull()

    const selection = requestVoiceSelection(state, identity('voice-select-empty'), true)
    expect(selection.message).toBeNull()
    expect(selection.state.activeVoiceId).toBeNull()
  })
})
