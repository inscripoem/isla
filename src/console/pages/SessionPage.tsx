import type { CSSProperties, ReactNode } from 'react'
import type { InputSource } from '../../contracts'
import type { ConsoleState, RequestOutcome } from '../console-state'
import type { PerformerState } from '../performer-machine'
import type { RecoveryControlView } from '../recovery-control'
import { INPUT_SOURCES } from '../../contracts'
import {
  Card,
  ChatRow,
  Check,
  ChunkButton,
  Collapse,
  Code,
  Divider,
  Empty,
  FactChip,
  Facts,
  Glyph,
  StateIcon,
  Hint,
  Segment,
  showRecords,
  Tag,
  type GlyphName,
} from '../design/ui'

/*
 * The Control Deck: every operator-facing interface the console exposes,
 * in one panel — performer attach, operator bootstrap, the input composer,
 * the stage controls (Stop / Resume) and operator recovery. Sections are
 * ordered authority first, then the operator action, then its ledger.
 */

const OUTCOME_TONE: Record<RequestOutcome, 'pending' | 'unknown' | 'accepted' | 'applied' | 'duplicate' | 'rejected' | 'refused'> = {
  pending: 'pending',
  unknown: 'unknown',
  accepted: 'accepted',
  applied: 'applied',
  duplicate: 'duplicate',
  rejected: 'rejected',
  refused: 'refused',
}

const SOURCE_OPTIONS = INPUT_SOURCES.map((value) => ({ key: value, label: value }))

export interface ControlDeckProps {
  readonly state: ConsoleState
  readonly machine: PerformerState | null
  readonly source: InputSource
  readonly onSourceChange: (source: InputSource) => void
  readonly draft: string
  readonly onDraftChange: (draft: string) => void
  readonly allowDispatch: boolean
  readonly machinePath: boolean
  readonly onSubmit: () => void
  readonly onControl: (action: 'stop' | 'resume') => void
  readonly onAttach: () => void
  readonly onBootstrapOperator: () => void
  readonly operatorPending: boolean
  readonly operatorError: string | null
  readonly operatorButtonVisible: boolean
  readonly recovery: RecoveryControlView
  readonly recoveryAcknowledged: boolean
  readonly onRecoveryAcknowledge: (acknowledged: boolean) => void
  readonly onRequestRecovery: () => void
  readonly cinema: boolean
  readonly onToggleCinema: () => void
  readonly onFullscreen: () => void
}

export function ControlDeck(props: ControlDeckProps) {
  const { state, machine } = props
  const session = state.session
  const retiring = session?.retiring === true

  const recovery = machine?.recovery
  // The line-by-line recovery trace: only facts the runtime has actually
  // reported appear, in request order.
  const rec = recovery
  const traceSteps: readonly { readonly label: string; readonly value: string; readonly ok: boolean; readonly plain: boolean }[] = [
    ...(rec !== undefined && rec.status !== 'idle'
      ? [{ label: 'Recovery request', value: rec.status, ok: rec.status !== 'failed', plain: rec.status === 'requested' }]
      : []),
    ...(rec !== undefined && rec.retiredSessionId !== null
      ? [{ label: 'Session retired', value: rec.retiredSessionId, ok: true, plain: false }]
      : []),
    ...(rec !== undefined && rec.successorSessionId !== null
      ? [{ label: 'Successor session', value: rec.successorSessionId, ok: true, plain: false }]
      : []),
    ...(rec !== undefined && rec.recoveries > 0
      ? [{ label: 'Recoveries total', value: String(rec.recoveries), ok: true, plain: false }]
      : []),
    ...(rec !== undefined && rec.remainingRecoveries !== null
      ? [{ label: 'Remaining recoveries', value: String(rec.remainingRecoveries), ok: true, plain: false }]
      : []),
  ]

  const recoveryRows: readonly (readonly [string, ReactNode])[] = [
    ['Recovery status', <FactChip key="rs" value={recovery === undefined ? 'none' : recovery.status} />],
    ['Retired session', <FactChip key="rd" value={recovery?.retiredSessionId ?? 'none'} />],
    ['Successor session', <FactChip key="ss" value={recovery?.successorSessionId ?? 'none'} />],
    ['Recoveries', <FactChip key="rc" value={recovery === undefined ? 'none' : String(recovery.recoveries)} />],
    [
      'Remaining recoveries',
      <FactChip key="rr" value={recovery === undefined || recovery.remainingRecoveries === null ? 'unknown' : String(recovery.remainingRecoveries)} />,
    ],
  ]

  return (
    <div className="console__stack">
      <Card title="Control Deck" icon="sliders" tone="sky" className="isla-rise" hover>
        <div className="control-deck">
          <section className="control-deck__section" aria-label="Authority">
            <h3 className="control-deck__head">Authority</h3>
            <div className="console__actions">
              <ChunkButton size="sm" variant="lime" disabled={!props.machinePath} onClick={props.onAttach}>
                Attach performer
              </ChunkButton>
              {props.operatorButtonVisible && (
                <ChunkButton size="sm" variant="primary" busy={props.operatorPending} onClick={props.onBootstrapOperator}>
                  Bootstrap operator
                </ChunkButton>
              )}
              {machine !== null && machine.operator && <Tag tone="applied" dot>operator</Tag>}
            </div>
            {props.operatorError !== null && <Hint>{props.operatorError}</Hint>}
            {machine?.error !== undefined && machine.error !== null && <Hint>{machine.error}</Hint>}
          </section>

          <section className="control-deck__section" aria-label="Send input">
            <h3 className="control-deck__head">Send Input</h3>
            <form
              className="console__form"
              onSubmit={(event) => {
                event.preventDefault()
                props.onSubmit()
              }}
            >
              <div className="console__field">
                <span className="console__label" id="console-source-label">
                  Input source
                </span>
                <Segment
                  label="Input source"
                  options={SOURCE_OPTIONS}
                  value={props.source}
                  disabled={!props.allowDispatch}
                  onChange={(key) => props.onSourceChange(key)}
                />
              </div>
              <div className="console__field">
                <label className="console__label" htmlFor="console-text">
                  Message text
                </label>
                <input
                  id="console-text"
                  className="isla-input"
                  value={props.draft}
                  disabled={!props.allowDispatch}
                  placeholder="Say something to the stage…"
                  onChange={(event) => props.onDraftChange(event.target.value)}
                />
              </div>
              <ChunkButton type="submit" variant="primary" disabled={!props.allowDispatch || props.draft.trim().length === 0}>
                Submit input
              </ChunkButton>
            </form>
          </section>

          <section className="control-deck__section" aria-label="Stage controls">
            <h3 className="control-deck__head">Stage Controls</h3>
            {/* Player-transport buttons: the live one glows while the other
              * waits — Resume lights only once the stage is stopped. */}
            <div className="console__transport">
              <button
                type="button"
                className={`transport-btn transport-btn--stop ${!retiring && session !== null && session.lifecycle !== 'stopped' ? 'is-hot' : ''}`.trim()}
                aria-label="Stop"
                disabled={!props.allowDispatch}
                onClick={() => props.onControl('stop')}
              >
                <Glyph name="pause" size={30} />
                <span className="transport-btn__label">Stop</span>
              </button>
              <button
                type="button"
                className={`transport-btn transport-btn--resume ${session !== null && session.lifecycle === 'stopped' ? 'is-hot' : ''}`.trim()}
                aria-label="Resume"
                disabled={!props.allowDispatch || session === null || session.lifecycle !== 'stopped'}
                onClick={() => props.onControl('resume')}
              >
                <Glyph name="play" size={30} />
                <span className="transport-btn__label">Resume</span>
              </button>
              <button
                type="button"
                className={`transport-btn ${props.cinema ? 'is-lit' : ''}`.trim()}
                aria-label="Cinema mode"
                data-tip="Cinema mode (C)"
                onClick={props.onToggleCinema}
              >
                <Glyph name="cinema" size={30} />
                <span className="transport-btn__label">Cinema</span>
              </button>
              <button
                type="button"
                className="transport-btn"
                aria-label="Fullscreen stage"
                data-tip="Fullscreen stage (F)"
                onClick={props.onFullscreen}
              >
                <Glyph name="expand" size={30} />
                <span className="transport-btn__label">Fullscreen</span>
              </button>
            </div>
          </section>

          <section className="control-deck__section" aria-label="Recovery">
            <h3 className="control-deck__head">Recovery</h3>
            <Hint>An operator decision: retires this session and continues in a fresh successor.</Hint>
            <div className="console__actions console__actions--check">
              <Check
                checked={props.recoveryAcknowledged}
                disabled={!props.recovery.available}
                onChange={props.onRecoveryAcknowledge}
              >
                I acknowledge local playback in this session has ended.
              </Check>
              <ChunkButton size="sm" variant="danger" disabled={!props.recovery.requestable} onClick={props.onRequestRecovery}>
                Request recovery
              </ChunkButton>
            </div>
            {/* The trace stays out of sight until a recovery is actually
              * attempted; afterwards every known fact appears line by line,
              * closing with a success or failure banner. The exact protocol
              * records remain in the DOM (visually hidden while idle) for the
              * conformance walk. */}
            <div className="recovery-trace" hidden={rec === undefined || rec.status === 'idle'} role="status">
              {rec !== undefined && rec.status === 'failed' ? (
                <div className="recovery-banner is-bad" role="alert">
                  <span className="recovery-banner__ico" aria-hidden="true">
                    <Glyph name="cross" size={22} />
                  </span>
                  Recovery Failed
                </div>
              ) : rec !== undefined && (rec.status === 'applied' || rec.status === 'already_applied') ? (
                <div className="recovery-banner is-ok" role="status">
                  <span className="recovery-banner__ico" aria-hidden="true">
                    <Glyph name="check" size={22} />
                  </span>
                  Recovery Succeeded
                </div>
              ) : (
                <div className="recovery-line" style={{ '--i': '0' } as Record<string, string>}>
                  <StateIcon ok={false} plain />
                  <span className="recovery-line__label">Recovery request</span>
                  <span className="recovery-line__value">{rec !== undefined ? rec.status : ''} — waiting for the runtime</span>
                </div>
              )}
              <ul className="recovery-trace__rows">
                {traceSteps.map((step, index) => (
                  <li key={step.label} className="recovery-line" style={{ '--i': String(index + 1) } as Record<string, string>}>
                    <StateIcon ok={step.ok} plain={step.plain} />
                    <span className="recovery-line__label">{step.label}</span>
                    <span className="recovery-line__value">{step.value}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Facts rows={recoveryRows} hidden={rec === undefined || rec.status === 'idle'} />
          </section>
        </div>
      </Card>

      <Card title="Transmission Ledger" icon="chat" tone="pink" className="isla-rise" collapsible>
        {state.inputs.length > 7 && (
          <button type="button" className="isla-viewall" onClick={() => showRecords('All input requests', state.inputs.slice().reverse().map((input) => ({ glyph: 'ticket', title: input.text, meta: `${input.outcome} · seq ${input.seq ?? '—'}`, detail: input.detail ?? undefined, tone: input.outcome === 'accepted' || input.outcome === 'applied' ? 'ok' : input.outcome === 'rejected' || input.outcome === 'refused' ? 'bad' : 'plain', type: input.source })))}>
            View all {state.inputs.length} input records
          </button>
        )}
        {state.inputs.length > 0 && (
          <ul className="isla-chat">
            {[...state.inputs].slice(-7).reverse().map((input) => (
              <ChatRow
                key={input.messageId}
                name={input.source}
                tone={OUTCOME_TONE[input.outcome]}
                pending={input.outcome === 'pending'}
                text={input.text}
                meta={[input.outcome, input.eventId === null ? null : input.eventId, input.seq === null ? null : `seq ${input.seq}`]
                  .filter((part) => part !== null)
                  .join(' · ')}
                detail={input.detail}
              />
            ))}
          </ul>
        )}
        {state.controls.length > 7 && (
          <button type="button" className="isla-viewall" onClick={() => showRecords('All control requests', state.controls.slice().reverse().map((control) => ({ glyph: control.action === 'stop' ? 'pause' : 'play', title: control.action === 'stop' ? 'Stop the stage' : 'Resume the stage', meta: `${control.outcome} · epoch ${control.previousEpoch ?? '—'} → ${control.epoch ?? '—'}`, detail: control.detail ?? undefined, tone: control.outcome === 'applied' ? 'ok' : control.outcome === 'refused' ? 'bad' : 'plain', type: control.action === 'stop' ? 'Stop' : 'Resume' })))}>
            View all {state.controls.length} control records
          </button>
        )}
        {state.controls.length > 0 && (
          <ul className="isla-chat">
            {[...state.controls].slice(-7).reverse().map((control) => (
              <ChatRow
                key={control.messageId}
                name={control.action}
                tone={OUTCOME_TONE[control.outcome]}
                pending={control.outcome === 'pending'}
                text={control.action === 'stop' ? 'Stop the stage' : 'Resume the stage'}
                meta={[control.outcome, control.previousEpoch === null || control.epoch === null ? control.requestId : `epoch ${control.previousEpoch} → ${control.epoch}`]
                  .filter((part) => part !== null)
                  .join(' · ')}
                detail={control.detail}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/**
 * Session facts: the identity readout for the accepted session, collapsed
 * by default — the facts stay in the DOM for the conformance walk.
 */
export function SessionFacts({ state, machine }: { readonly state: ConsoleState; readonly machine: PerformerState | null }) {
  const session = state.session

  const sessionRaw: readonly { readonly label: string; readonly value: string; readonly group: string; readonly glyph?: GlyphName }[] = [
    { label: 'Session', value: session === null ? 'unknown' : session.sessionId, group: 'Identity', glyph: 'ribbon' },
    { label: 'Epoch', value: session === null ? 'unknown' : String(session.epoch), group: 'Identity', glyph: 'pulse' },
    { label: 'Lifecycle', value: session === null ? 'unknown' : session.lifecycle, group: 'Identity', glyph: 'pulse' },
    { label: 'Active turn', value: session === null ? 'unknown' : (session.activeTurnId ?? 'none'), group: 'Identity', glyph: 'route' },
    { label: 'Performer', value: session === null ? 'unknown' : session.performerStatus, group: 'Authority', glyph: 'mic' },
    { label: 'Output confirmation', value: session === null ? 'unknown' : session.outputConfirmation, group: 'Playback', glyph: 'check' },
    { label: 'Capability revision', value: session === null ? 'unknown' : String(session.capabilityRevision), group: 'Identity', glyph: 'sliders' },
    { label: 'Accepted sequence', value: session === null ? 'unknown' : String(session.lastSeq), group: 'Identity', glyph: 'chart' },
    { label: 'Retiring', value: session === null ? 'unknown' : session.retiring ? 'yes' : 'no', group: 'Authority', glyph: 'medic' },
  ]

  const sessionRows: readonly (readonly [string, ReactNode])[] = [
    ['Session', <FactChip key="sid" value={session === null ? 'unknown' : session.sessionId} />],
    ['Epoch', <FactChip key="ep" value={session === null ? 'unknown' : String(session.epoch)} />],
    ['Lifecycle', <FactChip key="lc" value={session === null ? 'unknown' : session.lifecycle} />],
    ['Active turn', <FactChip key="at" value={session === null ? 'unknown' : (session.activeTurnId ?? 'none')} />],
    ['Performer', <FactChip key="pf" value={session === null ? 'unknown' : session.performerStatus} />],
    ['Output confirmation', <FactChip key="oc" value={session === null ? 'unknown' : session.outputConfirmation} />],
    ['Capability revision', <FactChip key="cr" value={session === null ? 'unknown' : String(session.capabilityRevision)} />],
    ['Accepted sequence', <FactChip key="sq" value={session === null ? 'unknown' : String(session.lastSeq)} />],
    ['Retiring', <FactChip key="rt" value={session === null ? 'unknown' : session.retiring ? 'yes' : 'no'} />],
  ]

  const authorityRows: readonly (readonly [string, ReactNode])[] = [
    ['Performer attached', <FactChip key="pa" value={machine === null ? 'unknown' : machine.performer ? 'yes' : 'no'} />],
    ['Operator authority', <FactChip key="oa" value={machine === null ? 'unknown' : machine.operator ? 'yes' : 'no'} />],
    ['Session retiring', <FactChip key="sr" value={session === null ? 'unknown' : session.retiring ? 'yes' : 'no'} />],
  ]

  return (
    <Card
      title="Session Facts"
      icon="ribbon"
      tone="purple"
      className="isla-rise"
      collapsible
      defaultOpen={false}
    >
      <button
        type="button"
        className="isla-viewall"
        onClick={() =>
          showRecords(
            'Session Facts — all records',
            sessionRaw.map((entry) => ({
              glyph: (entry.glyph ?? 'pulse') as GlyphName,
              title: entry.label,
              meta: entry.value,
              type: entry.group,
            })),
          )
        }
      >
        View all {sessionRaw.length} session records
      </button>
      <Facts rows={sessionRows} />
      <Divider />
      <h3 className="isla-card__title isla-card__title--sub">
        <span className="isla-card__title-icon" style={{ background: 'var(--isla-orange-soft)' }} aria-hidden="true">
          <Glyph name="wand" size={15} />
        </span>
        Authority
      </h3>
      <Facts rows={authorityRows} />
    </Card>
  )
}

/**
 * Events and errors: only events above the accepted sequence are shown;
 * replayed history is never rendered. Collapsed by default.
 */
export function EventsSection({ state }: { readonly state: ConsoleState }) {
  return (
    <Card title="Events and Errors" icon="scroll" className="isla-rise" collapsible defaultOpen={false}>
      {state.events.length === 0 ? (
        <Empty>No new events.</Empty>
      ) : (
        <div className="console__events">
          {state.events.length > 7 && (
            <button type="button" className="isla-viewall" onClick={() => showRecords('All session events', state.events.slice().reverse().map((event) => ({ glyph: eventGlyph(event.type), title: `#${event.seq} ${event.type}`, meta: '', detail: JSON.stringify(event.data), tone: 'plain', type: event.type })))}>
              View all {state.events.length} event records
            </button>
          )}
          {[...state.events].slice(-7).reverse().map((event) => (
            <Collapse key={event.seq} label={`#${event.seq} ${event.type}`} icon={eventGlyph(event.type)}>
              <Code code={JSON.stringify(event.data, null, 2)} />
            </Collapse>
          ))}
        </div>
      )}
      {state.errors.length > 0 && (
        <>
          <Divider />
          <ul className="isla-chat">
            {[...state.errors].reverse().map((error, index) => (
              <li
                key={`${index}-${error.code}-${error.message}`}
                className="isla-chat__item"
                style={{ '--chat-bar': 'var(--isla-red)', '--chat-bg': 'var(--isla-red-soft)', '--chat-name': 'var(--isla-red)' } as CSSProperties}
              >
                <span className="isla-chat__name">{error.code}</span>
                <span className="isla-chat__detail">{error.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

function eventGlyph(type: string): GlyphName {
  if (type.startsWith('input.')) return 'ticket'
  if (type.startsWith('selection.')) return 'route'
  if (type.startsWith('turn.')) return 'voice'
  if (type.startsWith('delivery.')) return 'package'
  if (type.startsWith('recovery.')) return 'medic'
  if (type.startsWith('performance.')) return 'mic'
  return 'pulse'
}
