import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { formatUptime, idGlyph, statusToneStyle, type StatusTone } from './format'
import kanbanSheetUrl from '../assets/kanban/spritesheet.webp'

/* ------------------------------------------------------------------ *
 * Glyph: a hand-drawn stroke icon set. No emoji anywhere in the
 * console — every decoration is one of these line drawings, so the
 * voice stays consistent with the mascot and the nightloom chrome.
 * ------------------------------------------------------------------ */

export type GlyphName =
  | 'chat'
  | 'sliders'
  | 'ribbon'
  | 'wand'
  | 'medic'
  | 'scroll'
  | 'chart'
  | 'route'
  | 'mic'
  | 'dish'
  | 'pulse'
  | 'ticket'
  | 'plug'
  | 'moon'
  | 'pause'
  | 'target'
  | 'voice'
  | 'package'
  | 'heart'
  | 'spark'
  | 'boom'
  | 'danmaku'
  | 'cinema'
  | 'expand'
  | 'check'
  | 'cross'
  | 'play'

const GLYPH_PATHS: Record<GlyphName, ReactNode> = {
  chat: <path d="M3.5 5.5 h13 a1.5 1.5 0 0 1 1.5 1.5 v6 a1.5 1.5 0 0 1 -1.5 1.5 h-7 l-4 3.2 v-3.2 h-2 a1.5 1.5 0 0 1 -1.5 -1.5 v-6 a1.5 1.5 0 0 1 1.5 -1.5 z" />,
  sliders: (
    <>
      <path d="M4 6 h12 M4 14 h12" />
      <circle cx="8" cy="6" r="2.2" />
      <circle cx="12.5" cy="14" r="2.2" />
    </>
  ),
  ribbon: (
    <>
      <circle cx="10" cy="7" r="4.5" />
      <path d="M7 10.5 l-2.5 7 3.5-2 2 2.5 2-2.5 3.5 2 -2.5-7" />
    </>
  ),
  wand: (
    <>
      <path d="M4 16 L14 6" />
      <path d="M15.5 3.5 l0.9 2.1 2.1 0.9 -2.1 0.9 -0.9 2.1 -0.9-2.1 -2.1-0.9 2.1-0.9 z" />
      <path d="M5 4.5 l0.6 1.4 1.4 0.6 -1.4 0.6 -0.6 1.4 -0.6-1.4 -1.4-0.6 1.4-0.6 z" />
    </>
  ),
  medic: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5 v7 M6.5 10 h7" />
    </>
  ),
  scroll: (
    <>
      <path d="M5.5 3.5 h9 a1.5 1.5 0 0 1 1.5 1.5 v11.5 a1.5 1.5 0 0 1 -1.5 1.5 h-9 a1.5 1.5 0 0 1 -1.5 -1.5 v-11.5 a1.5 1.5 0 0 1 1.5 -1.5 z" />
      <path d="M7 7.5 h6 M7 10.5 h6 M7 13.5 h4" />
    </>
  ),
  chart: (
    <>
      <path d="M4 16.5 h12" />
      <path d="M6.5 13 v-4 M10 13 v-7 M13.5 13 v-2.5" />
    </>
  ),
  route: (
    <>
      <circle cx="5" cy="5" r="2.2" />
      <circle cx="15" cy="15" r="2.2" />
      <path d="M7 5 h5 a3 3 0 0 1 3 3 v4" />
    </>
  ),
  mic: (
    <>
      <rect x="7.5" y="3" width="5" height="9" rx="2.5" />
      <path d="M5 10.5 a5 5 0 0 0 10 0 M10 15.5 v2.5" />
    </>
  ),
  dish: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13 13 l4.5 4.5 M9 9 l5.5-5.5" />
    </>
  ),
  pulse: <path d="M3 11 h3.5 l2-5 2.5 8 2-4.5 h4.5" />,
  ticket: (
    <>
      <path d="M3.5 7.5 v-2 a1 1 0 0 1 1-1 h11 a1 1 0 0 1 1 1 v2 a2.5 2.5 0 0 0 0 5 v2 a1 1 0 0 1 -1 1 h-11 a1 1 0 0 1 -1-1 v-2 a2.5 2.5 0 0 0 0-5 z" />
      <path d="M10 5.5 v1.5 M10 9.5 v1.5 M10 13.5 v1.5" />
    </>
  ),
  plug: (
    <>
      <path d="M7 3.5 v4 M13 3.5 v4" />
      <path d="M5 7.5 h10 v3 a5 5 0 0 1 -10 0 z" />
      <path d="M10 15.5 v2.5" />
    </>
  ),
  moon: <path d="M15.5 12.5 a7 7 0 1 1 -8 -9.5 a5.6 5.6 0 0 0 8 9.5 z" />,
  pause: <path d="M7.5 5.5 v9 M12.5 5.5 v9" />,
  target: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M10 1.5 v3 M10 15.5 v3 M1.5 10 h3 M15.5 10 h3" />
    </>
  ),
  voice: (
    <>
      <path d="M4 8 a6 6 0 0 1 12 0" />
      <path d="M3.5 11.5 c2-2.8 4-2.8 5 0 s3 2.8 5 0 3-2.8 3 0" />
      <path d="M4 15 h12" />
    </>
  ),
  package: (
    <>
      <path d="M3.5 6.5 L10 3.5 l6.5 3 v7 L10 16.5 l-6.5-3 z" />
      <path d="M3.5 6.5 L10 9.5 l6.5-3 M10 9.5 v7" />
    </>
  ),
  heart: <path d="M10 16.5 c-4.5-3.2-7-5.8-7-8.6 a3.6 3.6 0 0 1 7-1.2 a3.6 3.6 0 0 1 7 1.2 c0 2.8-2.5 5.4-7 8.6 z" />,
  spark: <path d="M10 3 l1.6 4.4 4.4 1.6 -4.4 1.6 -1.6 4.4 -1.6-4.4 -4.4-1.6 4.4-1.6 z" />,
  boom: <path d="M10 3 l2 4.5 4.5 1 -3.5 3 1 4.5 -4-2.5 -4 2.5 1-4.5 -3.5-3 4.5-1 z" />,
  danmaku: (
    <>
      <path d="M3 5.5 h14 M5 9.5 h10 M7 13.5 h6" />
      <path d="M14 13.5 l3 3" />
    </>
  ),
  cinema: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="1.6" />
      <path d="M6.5 5 v10 M13.5 5 v10" />
    </>
  ),
  expand: (
    <>
      <path d="M3.5 7 v-3.5 h3.5 M16.5 7 v-3.5 h-3.5 M3.5 13 v3.5 h3.5 M16.5 13 v3.5 h-3.5" />
    </>
  ),
  play: <path d="M6.5 4.5 L16.5 10 L6.5 15.5 Z" fill="currentColor" stroke="none" />,
  check: <path d="M4 10.5 l4.2 4.2 L16 5.5" />,
  cross: (
    <>
      <path d="M5.5 5.5 l9 9 M14.5 5.5 l-9 9" />
    </>
  ),
}

export function Glyph({ name, size = 16, className }: { readonly name: GlyphName; readonly size?: number; readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`isla-glyph ${className ?? ''}`.trim()}
    >
      {GLYPH_PATHS[name]}
    </svg>
  )
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

export type CardTone = 'plain' | 'pink' | 'sky' | 'lime' | 'purple' | 'orange'

const CARD_TONE_CLASS: Record<CardTone, string> = {
  plain: '',
  pink: 'isla-card--pink',
  sky: 'isla-card--sky',
  lime: 'isla-card--lime',
  purple: 'isla-card--purple',
  orange: 'isla-card--orange',
}

export interface CardProps {
  readonly title?: string
  /** A drawn line glyph; the console never uses emoji. */
  readonly icon?: GlyphName
  readonly iconBg?: string
  readonly tone?: CardTone
  readonly badge?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly hover?: boolean
  /** Renders the head as a toggle that collapses the panel body. */
  readonly collapsible?: boolean
  /** Initial body state for a collapsible panel (default open). */
  readonly defaultOpen?: boolean
}

export function Card({
  title,
  icon,
  iconBg,
  tone = 'plain',
  badge,
  children,
  className,
  hover,
  collapsible = false,
  defaultOpen = true,
}: CardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const cardRef = useRef<HTMLElement | null>(null)
  const head = (title !== undefined || badge !== undefined) && (
    <div className="isla-card__head">
      {title !== undefined && (
        <h2 className="isla-card__title">
          {icon !== undefined && (
            <span className="isla-card__title-icon" style={iconBg === undefined ? undefined : { background: iconBg }}>
              <Glyph name={icon} size={16} />
            </span>
          )}
          {collapsible ? (
            <button
              type="button"
              className="isla-card__toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {title}
              <span className={`isla-collapse__chevron ${open ? 'is-open' : ''}`.trim()} aria-hidden="true" />
            </button>
          ) : (
            title
          )}
        </h2>
      )}
      {badge}
    </div>
  )
  const floating = collapsible && open

  // Expanded cards fill ONLY the left column's unfilled area below the
  // stage wall — never the stage itself, never full screen, no overlay.
  // Geometry is measured and applied as inline styles; a FLIP transition
  // animates the move from the column slot into the free area.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (card === null) return
    if (!floating) {
      card.style.position = ''
      card.style.left = ''
      card.style.top = ''
      card.style.width = ''
      card.style.height = ''
      card.style.zIndex = ''
      card.style.transform = ''
      return
    }
    const deck = card.closest('.console__deck')
    const wall = document.querySelector('.console__stagewall')
    if (deck === null || wall === null) return
    const consoleEl = card.closest('.console')
    if (consoleEl === null) return
    const apply = (): void => {
      // Document-anchored placement: the card occupies the left column's
      // unfilled area below the stage wall and scrolls with the page.
      const deckRect = deck.getBoundingClientRect()
      const wallRect = wall.getBoundingClientRect()
      const consoleRect = consoleEl.getBoundingClientRect()
      card.style.position = 'absolute'
      card.style.left = `${Math.round(wallRect.left - consoleRect.left)}px`
      card.style.width = `${Math.round(wallRect.width)}px`
      card.style.top = `${Math.round(wallRect.bottom - consoleRect.top + 16)}px`
      card.style.height = `${Math.max(320, Math.round(deckRect.bottom - wallRect.bottom - 16))}px`
      card.style.zIndex = '9400'
      // Kill any residual or transitioning transform: a non-none transform
      // would turn the card into its own containing block and break the
      // absolute anchoring.
      card.style.transform = 'none'
      card.style.willChange = 'auto'
    }
    const first = card.getBoundingClientRect()
    apply()
    const last = card.getBoundingClientRect()
    const dx = first.left - last.left
    const dy = first.top - last.top
    const sx = first.width / (last.width || 1)
    const sy = first.height / (last.height || 1)
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) {
      card.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'top left' },
          { transform: 'translate(0, 0) scale(1, 1)', transformOrigin: 'top left' },
        ],
        { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      )
    }
    const onResize = (): void => apply()
    const onSibling = (event: Event): void => {
      if ((event as CustomEvent).detail !== card) setOpen(false)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('isla-card-expand', onSibling as EventListener)
    window.dispatchEvent(new CustomEvent('isla-card-expand', { detail: card }))
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('isla-card-expand', onSibling as EventListener)
    }
  }, [floating])

  // While floating, the entrance animation class is stripped: its
  // fill-forwards transform would become the containing block for the
  // fixed position and make the card scroll with the page.
  const classes = [
    'isla-card',
    CARD_TONE_CLASS[tone],
    hover ? 'isla-card--hover' : '',
    floating ? 'isla-card--float' : '',
    className ?? '',
  ]
    .filter((entry) => entry !== '')
    .join(' ')
    .replace(/isla-rise(-focus)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return (
    <section
      ref={cardRef}
      className={classes}
    >
      {head}
      {collapsible ? (
        <div className={`isla-card__body ${open ? 'is-open' : ''}`.trim()}>
          <div className="isla-card__body-inner">{children}</div>
        </div>
      ) : (
        children
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Status tag: text always names the status; colour only accompanies it.
 * ------------------------------------------------------------------ */

export interface TagProps {
  readonly tone?: StatusTone
  readonly dot?: boolean
  readonly pulse?: boolean
  readonly mono?: boolean
  readonly children: ReactNode
}

export function Tag({ tone = 'neutral', dot, pulse, mono, children }: TagProps) {
  return (
    <span className={`isla-tag ${mono ? 'isla-tag--mono' : ''}`.trim()} style={statusToneStyle(tone)}>
      {dot && <span className={`isla-tag__dot ${pulse ? 'isla-tag__dot--pulse' : ''}`.trim()} aria-hidden="true" />}
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Chunky button
 * ------------------------------------------------------------------ */

export interface ChunkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'ghost' | 'primary' | 'danger' | 'lime'
  readonly size?: 'regular' | 'sm'
  readonly busy?: boolean
  readonly children: ReactNode
}

const VARIANT_CLASS: Record<NonNullable<ChunkButtonProps['variant']>, string> = {
  ghost: 'isla-btn--ghost',
  primary: 'isla-btn--primary',
  danger: 'isla-btn--danger',
  lime: 'isla-btn--lime',
}

/**
 * The button element renders only its label text: browser acceptance checks
 * match these buttons by exact text, so no icon nodes or generated content
 * may join the label. Busy feedback is a class-level pulse.
 */
export function ChunkButton({ variant = 'ghost', size, busy, children, className, type, ...rest }: ChunkButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`isla-btn ${VARIANT_CLASS[variant]} ${size === 'sm' ? 'isla-btn--sm' : ''} ${busy ? 'isla-btn--busy' : ''} ${className ?? ''}`.trim()}
      aria-busy={busy === undefined ? undefined : busy}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * Facts: the shared dl.facts grid (acceptance scripts read this).
 * ------------------------------------------------------------------ */

export function Facts({
  rows,
  hidden = false,
}: {
  readonly rows: readonly (readonly [string, ReactNode])[]
  readonly hidden?: boolean
}) {
  return (
    <dl className="facts" hidden={hidden}>
      {rows.flatMap(([label, value]) => [
        <dt key={`${label}-label`}>{label}</dt>,
        <dd key={`${label}-value`}>{value}</dd>,
      ])}
    </dl>
  )
}

/* ------------------------------------------------------------------ *
 * Text atoms
 * ------------------------------------------------------------------ */

export function Hint({ children }: { readonly children: ReactNode }) {
  return <p className="isla-hint">{children}</p>
}

export function Alert({ children }: { readonly children: ReactNode }) {
  return <p className="isla-alert" role="alert">{children}</p>
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return (
    <p className="isla-empty">
      <span className="isla-empty__mark" aria-hidden="true" />
      {children}
    </p>
  )
}

export function Divider() {
  return <hr className="isla-divider" />
}

/* ------------------------------------------------------------------ *
 * Collapse: one expandable event row (the button label carries the
 * event identity, e.g. "#6 delivery.committed"). The chevron is drawn
 * in CSS; no glyph characters join the label.
 * ------------------------------------------------------------------ */

export function Collapse({
  label,
  meta,
  icon,
  children,
}: {
  readonly label: string
  readonly meta?: string
  readonly icon?: GlyphName
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`isla-collapse ${open ? 'is-open' : ''}`.trim()}>
      <button type="button" className="isla-collapse__head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="isla-collapse__chevron" aria-hidden="true" />
        {icon !== undefined && <Glyph name={icon} size={14} />}
        <span>{label}</span>
        {meta !== undefined && <span className="isla-chat__meta">{meta}</span>}
      </button>
      <div className="isla-collapse__body">
        <div className="isla-collapse__inner">{children}</div>
      </div>
    </div>
  )
}

export function Code({ code }: { readonly code: string }) {
  return <pre className="isla-code">{code}</pre>
}

/* ------------------------------------------------------------------ *
 * Chat feed rows (FAN CHAT style, outcome-barred bubbles).
 * ------------------------------------------------------------------ */

export interface ChatRowProps {
  readonly name: string
  readonly text: string
  readonly meta?: string
  readonly detail?: string | null
  readonly tone?: StatusTone
  readonly pending?: boolean
}

export function ChatRow({ name, text, meta, detail, tone = 'neutral', pending }: ChatRowProps) {
  const toneStyle = pending ? undefined : { ...chatVars(tone) }
  return (
    <li className={`isla-chat__item ${pending ? 'isla-chat__item--pending' : ''}`.trim()} style={toneStyle}>
      <span className="isla-chat__name" aria-hidden="true">{idGlyph(name)}</span>
      <span className="isla-chat__name">{name}:</span>
      <span className="isla-chat__text">{text}</span>
      {meta !== undefined && <span className="isla-chat__meta">{meta}</span>}
      {detail !== undefined && detail !== null && <span className="isla-chat__detail">{detail}</span>}
    </li>
  )
}

function chatVars(tone: StatusTone): Record<string, string> {
  const varName = `--isla-status-${tone}`
  return {
    '--chat-bar': `var(${varName})`,
    '--chat-bg': `color-mix(in srgb, var(${varName}) 14%, white)`,
    '--chat-name': `var(${varName})`,
  }
}

/* ------------------------------------------------------------------ *
 * Segmented selector (input source).
 * ------------------------------------------------------------------ */

export interface SegmentProps<T extends string> {
  readonly label: string
  readonly options: readonly { readonly key: T; readonly label: string }[]
  readonly value: T
  readonly disabled?: boolean
  readonly onChange: (key: T) => void
}

export function Segment<T extends string>({ label, options, value, disabled, onChange }: SegmentProps<T>) {
  return (
    <div className="isla-segment" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="isla-segment__item"
          aria-pressed={option.key === value}
          disabled={disabled}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Sticker checkbox
 * ------------------------------------------------------------------ */

export function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
  readonly children: ReactNode
}) {
  const id = useId()
  return (
    <span className="isla-check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id}>{children}</label>
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Pop numeral: pulses whenever the value changes.
 * ------------------------------------------------------------------ */

export function PopNum({ value, children }: { readonly value: number | string; readonly children: ReactNode }) {
  // Adjust during render: a value change flips the pulse flag synchronously,
  // the timeout below clears it after one beat.
  const [previous, setPrevious] = useState(value)
  const [pop, setPop] = useState(false)
  if (previous !== value) {
    setPrevious(value)
    setPop(true)
  }
  useEffect(() => {
    if (!pop) return
    const timer = window.setTimeout(() => setPop(false), 260)
    return () => window.clearTimeout(timer)
  }, [pop])
  return <span className={pop ? 'isla-pop' : undefined}>{children}</span>
}

/* ------------------------------------------------------------------ *
 * Uptime chip: ticks once a second from an injected start second.
 * ------------------------------------------------------------------ */

export function UptimeChip({ seconds }: { readonly seconds: number }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="isla-stat">{formatUptime(seconds + tick)}</span>
}

/**
 * Stage visualizer: a row of bars that dance while the performer speaks
 * and settle to a flat baseline when idle. Purely visual — the playback
 * state is always spelled out in text nearby.
 */
export function AudioBars({ speaking }: { readonly speaking: boolean }) {
  return (
    <span className={`isla-eq ${speaking ? 'is-speaking' : ''}`.trim()} aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} className="isla-eq__bar" />
      ))}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Particle: the circular on/off dot that fronts every status label.
 * On = lit candy particle with a soft pulse; off = hollow hairline.
 * ------------------------------------------------------------------ */

export function Particle({ on, pulse = true }: { readonly on: boolean; readonly pulse?: boolean }) {
  return (
    <span
      className={`isla-particle ${on ? 'is-on' : ''} ${on && pulse ? 'is-pulse' : ''}`.trim()}
      aria-hidden="true"
    />
  )
}

/* ------------------------------------------------------------------ *
 * Kanban sprites: the mascot row lives on the brand flip board.
 * The sheet (assets/kanban/spritesheet.webp) is 8 columns of 192x208
 * cells; each state walks its own row at 4 frames per cycle.
 * Sheet reused from the MIT-licensed aemeath_withclaude project.
 * ------------------------------------------------------------------ */

export type KanbanState =
  | 'idle'
  | 'waving'
  | 'jumping'
  | 'waiting'
  | 'chatting'
  | 'review'
  | 'celebrating'
  | 'building'
  | 'analyzing'
  | 'fetching'
  | 'searching'
  | 'running'

const KANBAN_ROW: Record<KanbanState, number> = {
  idle: 0,
  waving: 3,
  jumping: 4,
  waiting: 6,
  chatting: 9,
  review: 8,
  celebrating: 14,
  building: 13,
  analyzing: 12,
  fetching: 10,
  searching: 11,
  running: 7,
}

export function KanbanSprite({
  state,
  size = 40,
  duration = 1.8,
  delay = 0,
}: {
  readonly state: KanbanState
  readonly size?: number
  readonly duration?: number
  readonly delay?: number
}) {
  const scale = size / 192
  const cellW = 192 * scale
  const cellH = 208 * scale
  const style = {
    width: `${cellW}px`,
    height: `${cellH}px`,
    backgroundImage: `url(${kanbanSheetUrl})`,
    backgroundSize: `${cellW * 8}px ${cellH * 15}px`,
    '--ky': `${-KANBAN_ROW[state] * cellH}px`,
    '--cw': `${cellW}px`,
    animationDuration: `${duration}s`,
    animationDelay: `${delay}s`,
  } as Record<string, string>
  return <span className="isla-kanban__sprite" style={style} />
}

const KANBAN_CAST: readonly { readonly state: KanbanState; readonly duration: number }[] = [
  { state: 'idle', duration: 2.2 },
  { state: 'waving', duration: 1.4 },
  { state: 'jumping', duration: 1.1 },
  { state: 'chatting', duration: 1.6 },
  { state: 'celebrating', duration: 1.3 },
  { state: 'building', duration: 1.5 },
  { state: 'analyzing', duration: 1.7 },
  { state: 'searching', duration: 1.75 },
  { state: 'running', duration: 1.2 },
]

export function KanbanRow({ size = 38 }: { readonly size?: number }) {
  return (
    <span className="isla-kanban" aria-hidden="true">
      {KANBAN_CAST.map((member, index) => (
        <span
          className="isla-kanban__member"
          key={member.state}
          style={{ '--bob-delay': `${index * 240}ms` } as Record<string, string>}
        >
          <KanbanSprite state={member.state} size={size} duration={member.duration} delay={index * -0.35} />
        </span>
      ))}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * HandwrittenIsla: monoline "ISLA" letterforms that draw themselves
 * stroke by stroke (stroke-dashoffset over a normalised pathLength).
 * ------------------------------------------------------------------ */

export function HandwrittenIsla({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 224 96"
      className={`isla-write ${className ?? ''}`.trim()}
      role="img"
      aria-label="Isla"
    >
      <defs>
        <linearGradient id="isla-write-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--isla-sky)" />
          <stop offset="55%" stopColor="var(--isla-pink)" />
          <stop offset="100%" stopColor="var(--isla-yellow)" />
        </linearGradient>
      </defs>
      {/* I */}
      <path className="isla-write__stroke" style={{ '--d': '0ms', '--dd': '520ms' } as Record<string, string>}
        pathLength={100} d="M22 14 H40 M31 14 V82 M22 82 H40" />
      {/* S */}
      <path className="isla-write__stroke" style={{ '--d': '560ms', '--dd': '760ms' } as Record<string, string>}
        pathLength={100} d="M78 24 C64 12 50 22 57 35 C64 47 84 44 83 58 C82 74 58 80 50 68" />
      {/* L */}
      <path className="isla-write__stroke" style={{ '--d': '1360ms', '--dd': '480ms' } as Record<string, string>}
        pathLength={100} d="M106 14 V82 L146 82" />
      {/* A */}
      <path className="isla-write__stroke" style={{ '--d': '1880ms', '--dd': '860ms' } as Record<string, string>}
        pathLength={100} d="M158 82 L186 14 L214 82 M170 55 L200 55" />
    </svg>
  )
}

/**
 * HandwrittenIslaStudio: the whole "ISLA STUDIO" line as one English-signature
 * cursive — a single continuous pen stroke from the capital I entry swash
 * through the connected "sla", the capital S swash and the connected "tudio",
 * finishing in the classic underline flourish beneath the name. The t
 * crossbar and the i dot follow as short strokes. Strokes draw sequentially
 * via stroke-dashoffset over a normalised pathLength; remount (keyed by the
 * brand cycle) to replay.
 */
export function HandwrittenIslaStudio({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 8 420 152"
      className={`isla-write ${className ?? ''}`.trim()}
      role="img"
      aria-label="Isla Studio"
    >
      <defs>
        <linearGradient id="isla-write-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--isla-sky)" />
          <stop offset="45%" stopColor="var(--isla-pink)" />
          <stop offset="100%" stopColor="var(--isla-yellow)" />
        </linearGradient>
      </defs>
      {/* The strokes are vertically stretched for a taller signature while
        * vector-effect keeps the pen weight uniform. */}
      <g transform="scale(1 1.36)">
      <path className="isla-write__stroke" style={{ '--d': '0ms', '--dd': '4400ms' } as Record<string, string>}
        pathLength={100} d="M 14 94 C 28 88, 36 74, 38 58 C 40 42, 36 26, 46 22 C 54 19, 58 30, 54 42 C 50 56, 44 70, 42 84 C 41 90, 46 92, 52 86 C 58 74, 66 64, 74 62 C 84 59, 88 66, 82 72 C 76 78, 70 84, 76 88 C 82 92, 90 84, 96 76 C 100 58, 104 36, 110 26 C 114 18, 122 22, 120 34 C 118 46, 112 66, 108 82 C 106 90, 112 92, 118 86 C 124 80, 130 70, 136 64 C 144 58, 152 62, 150 72 C 148 82, 140 90, 134 86 C 130 83, 132 72, 138 64 C 142 60, 148 62, 152 74 C 154 82, 154 88, 158 88 C 164 84, 172 62, 184 48 C 176 44, 184 30, 198 26 C 214 21, 224 32, 214 44 C 204 56, 196 62, 206 72 C 216 82, 232 74, 240 62 C 246 54, 250 38, 256 30 C 260 24, 266 26, 262 38 C 258 52, 252 72, 248 84 C 246 90, 252 92, 258 86 C 264 76, 270 62, 276 58 C 282 55, 284 62, 280 72 C 277 80, 280 88, 286 84 C 292 80, 296 66, 300 58 C 304 55, 306 62, 302 74 C 300 82, 302 90, 310 86 C 316 58, 322 34, 328 24 C 332 16, 340 20, 338 32 C 336 46, 330 68, 326 84 C 324 90, 330 92, 336 86 C 340 78, 346 66, 352 62 C 358 58, 360 66, 356 74 C 353 81, 356 88, 362 86 C 368 60, 376 58, 382 62 C 388 66, 386 78, 380 84 C 374 90, 366 88, 368 78 C 370 70, 378 62, 386 58 C 396 54, 400 60, 392 70 C 360 100, 220 108, 80 100 C 60 98, 40 94, 30 90" />
      {/* t crossbar */}
      <path className="isla-write__stroke" style={{ '--d': '4500ms', '--dd': '350ms' } as Record<string, string>}
        pathLength={100} d="M 238 40 C 250 35, 262 33, 274 35" />
      {/* i dot */}
      <path className="isla-write__stroke" style={{ '--d': '4950ms', '--dd': '220ms' } as Record<string, string>}
        pathLength={100} d="M 351 45 L 356 46" />
      </g>
    </svg>
  )
}

/**
 * HandwrittenStudio: the "STUDIO" word in the same monoline handwriting,
 * drawing its six letters right after ISLA finishes. Static once drawn;
 * remount it (keyed by the brand cycle) to replay the strokes.
 */
export function HandwrittenStudio({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 350 96"
      className={`isla-write isla-write--studio ${className ?? ''}`.trim()}
      role="img"
      aria-label="Studio"
    >
      <defs>
        <linearGradient id="isla-studio-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--isla-sky)" />
          <stop offset="55%" stopColor="var(--isla-pink)" />
          <stop offset="100%" stopColor="var(--isla-yellow)" />
        </linearGradient>
      </defs>
      {/* S */}
      <path className="isla-write__stroke" style={{ '--d': '2950ms', '--dd': '620ms' } as Record<string, string>}
        pathLength={100} d="M52 24 C38 12 24 22 31 35 C38 47 58 44 57 58 C56 74 32 80 24 68" />
      {/* T */}
      <path className="isla-write__stroke" style={{ '--d': '3620ms', '--dd': '460ms' } as Record<string, string>}
        pathLength={100} d="M74 14 H118 M96 14 V82" />
      {/* U */}
      <path className="isla-write__stroke" style={{ '--d': '4130ms', '--dd': '560ms' } as Record<string, string>}
        pathLength={100} d="M136 14 V56 C136 78 178 78 178 56 V14" />
      {/* D */}
      <path className="isla-write__stroke" style={{ '--d': '4740ms', '--dd': '560ms' } as Record<string, string>}
        pathLength={100} d="M196 14 V82 M196 14 C240 12 240 84 196 82" />
      {/* I */}
      <path className="isla-write__stroke" style={{ '--d': '5350ms', '--dd': '460ms' } as Record<string, string>}
        pathLength={100} d="M262 14 H278 M270 14 V82 M262 82 H278" />
      {/* O */}
      <path className="isla-write__stroke" style={{ '--d': '5860ms', '--dd': '640ms' } as Record<string, string>}
        pathLength={100} d="M318 14 C340 14 340 82 318 82 C296 82 296 14 318 14" />
    </svg>
  )
}

/* ------------------------------------------------------------------ *
 * StateIcon: the drawn check / cross / neutral dot used across the
 * readouts so a state is never conveyed by text alone.
 * ------------------------------------------------------------------ */

export function StateIcon({ ok, plain = false }: { readonly ok: boolean; readonly plain?: boolean }) {
  return (
    <span className={`fact-ico ${ok ? 'is-ok' : plain ? 'is-plain' : 'is-bad'}`.trim()} aria-hidden="true">
      <Glyph name={plain ? 'spark' : ok ? 'check' : 'cross'} size={13} />
    </span>
  )
}

const FACT_OK = new Set([
  'yes',
  'confirmed',
  'applied',
  'accepted',
  'fully-delivered',
  'running',
  'completed',
  'started',
  'delivered',
  'respond',
  'ok',
])
const FACT_BAD = new Set([
  'no',
  'unknown',
  'refused',
  'rejected',
  'failed',
  'cancelled',
  'stopped',
  'not reported',
  'error',
])
const FACT_HIDDEN = new Set(['true', 'false', 'none'])

/**
 * FactChip renders one readout value as a visual chip: a drawn check /
 * cross / neutral particle plus the value. Protocol words the browser
 * acceptance reads verbatim stay exactly as reported; true/false/none
 * collapse into the icon with the raw word kept for assistive tech and
 * the conformance scripts. `tone` overrides the word sets when a value's
 * polarity is not the generic one (for example a synthetic plan is a
 * fallback, not a success), and `noneNeutral` keeps `none` readable as a
 * neutral state instead of hiding it behind a red cross.
 */
export function FactChip({
  value,
  tone,
  noneNeutral = false,
}: {
  readonly value: string
  readonly tone?: 'ok' | 'bad' | 'plain'
  readonly noneNeutral?: boolean
}) {
  const hidden = FACT_HIDDEN.has(value) && !(noneNeutral && value === 'none')
  // true/false/none collapse into a check or cross with the raw word kept
  // hidden for the conformance scripts and assistive tech.
  const ok = tone !== undefined ? tone === 'ok' : hidden ? value === 'true' : FACT_OK.has(value)
  const bad = tone !== undefined ? tone === 'bad' : hidden ? value !== 'true' : FACT_BAD.has(value)
  return (
    <span className={`fact-chip ${ok ? 'is-ok' : bad ? 'is-bad' : 'is-plain'}`.trim()}>
      <StateIcon ok={ok} plain={!ok && !bad} />
      {hidden ? <span className="isla-visually-hidden">{value}</span> : <span className="fact-chip__text">{value}</span>}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Records modal: the full log view opened from any ledger that shows
 * only its newest seven entries. Rendered through a portal on demand;
 * the imperative entry mirrors the toast pattern.
 */
/* oxlint-disable react/only-export-components */

export interface RecordRow {
  readonly glyph: GlyphName
  readonly title: string
  readonly meta: string
  readonly detail?: string
  readonly tone?: 'ok' | 'bad' | 'plain'
  /** Filter category shown as a checkbox in the modal. */
  readonly type?: string
}

let recordsRoot: { open(title: string, rows: readonly RecordRow[]): void } | null = null
const recordsListeners = new Set<() => void>()
let recordsState: { title: string; rows: readonly RecordRow[] } | null = null

function notifyRecords(): void {
  for (const listener of recordsListeners) listener()
}

function ensureRecordsHost(): void {
  if (recordsRoot !== null) return
  const host = document.createElement('div')
  host.setAttribute('data-isla-records-root', '')
  document.body.appendChild(host)
  const root = createRoot(host)
  const Store = (): null => {
    const [, setTick] = useState(0)
    useEffect(() => {
      const listener = (): void => setTick((value) => value + 1)
      recordsListeners.add(listener)
      return () => {
        recordsListeners.delete(listener)
      }
    }, [])
    return null
  }
  root.render(
    <>
      <Store />
      <RecordsModal />
    </>,
  )
  recordsRoot = {
    open(title: string, rows: readonly RecordRow[]): void {
      recordsState = { title, rows }
      notifyRecords()
    },
  }
}

function RecordsModal() {
  const [query, setQuery] = useState('')
  const [checkedTypes, setCheckedTypes] = useState<readonly string[]>([])
  const close = (): void => {
    recordsState = null
    setQuery('')
    setCheckedTypes([])
    notifyRecords()
  }
  useEffect(() => {
    if (recordsState === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (recordsState === null) return null
  const allTypes = [...new Set(recordsState.rows.map((row) => row.type ?? 'Record'))]
  const active = checkedTypes.length === 0 ? allTypes : checkedTypes
  const needle = query.trim().toLowerCase()
  const filtered = recordsState.rows.filter(
    (row) =>
      active.includes(row.type ?? 'Record') &&
      (needle === '' ||
        `${row.title} ${row.meta} ${row.detail ?? ''}`.toLowerCase().includes(needle)),
  )
  return (
    <div className="isla-modal-backdrop" onClick={close}>
      <div className="isla-modal" role="dialog" aria-label={recordsState.title} onClick={(event) => event.stopPropagation()}>
        <div className="isla-modal__head">
          <span className="isla-modal__title">{recordsState.title}</span>
          <button type="button" className="isla-modal__close" aria-label="Close records" onClick={close}>
            ×
          </button>
        </div>
        <div className="isla-modal__filters">
          <input
            type="search"
            className="isla-modal__search"
            placeholder="Search records…"
            aria-label="Search records"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="isla-modal__types" role="group" aria-label="Filter by type">
            {allTypes.map((type) => (
              <button
                key={type}
                type="button"
                className={`isla-modal__type ${checkedTypes.includes(type) ? 'is-on' : ''}`.trim()}
                aria-pressed={checkedTypes.includes(type)}
                onClick={() =>
                  setCheckedTypes((current) =>
                    current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type],
                  )
                }
              >
                <StateIcon ok={false} plain />
                {type}
              </button>
            ))}
          </div>
        </div>
        <ul className="isla-modal__list">
          {filtered.map((row, index) => (
            <li key={`${index}-${row.title}-${row.meta}`} className="isla-chat__item">
              <span className={`fact-ico ${row.tone === 'ok' ? 'is-ok' : row.tone === 'bad' ? 'is-bad' : 'is-plain'}`.trim()} aria-hidden="true">
                <Glyph name={row.glyph} size={13} />
              </span>
              <span className="isla-modal__row-title">{row.title}</span>
              <span className="isla-chat__meta">{row.meta}</span>
              {row.detail !== undefined && <span className="isla-chat__detail">{row.detail}</span>}
            </li>
          ))}
          {filtered.length === 0 && <li className="isla-display__row is-empty">No records match the filters.</li>}
        </ul>
        <p className="isla-modal__count">
          Showing {filtered.length} of {recordsState.rows.length} records
        </p>
      </div>
    </div>
  )
}

/** Open the full-records modal for a ledger. */
export function showRecords(title: string, rows: readonly RecordRow[]): void {
  ensureRecordsHost()
  recordsRoot?.open(title, rows)
}
