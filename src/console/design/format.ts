/*
 * Formatting primitives for the M2 console. Pure functions only: formatting
 * that needs a clock takes the value as an argument, so projections stay
 * testable without a browser.
 */

/**
 * Server vocabulary → tone token. The console never invents a status word;
 * only the colour voice changes. `neutral` is for runtime-reported facts.
 */
export type StatusTone =
  | 'pending'
  | 'unknown'
  | 'accepted'
  | 'applied'
  | 'duplicate'
  | 'rejected'
  | 'refused'
  | 'open'
  | 'connecting'
  | 'closed'
  | 'error'
  | 'neutral'

const TAG_TONE_VAR: Record<StatusTone, string> = {
  pending: 'var(--isla-status-pending)',
  unknown: 'var(--isla-status-unknown)',
  accepted: 'var(--isla-status-accepted)',
  applied: 'var(--isla-status-applied)',
  duplicate: 'var(--isla-status-duplicate)',
  rejected: 'var(--isla-status-rejected)',
  refused: 'var(--isla-status-refused)',
  open: 'var(--isla-status-open)',
  connecting: 'var(--isla-status-connecting)',
  closed: 'var(--isla-status-closed)',
  error: 'var(--isla-status-error)',
  neutral: 'var(--isla-status-neutral)',
}

/** Inline style carrying only token references, never raw colours. */
export function statusToneStyle(tone: StatusTone): Record<string, string> {
  return { '--tag-bg': `color-mix(in srgb, ${TAG_TONE_VAR[tone]} 22%, white)`, '--tag-fg': `var(--isla-status-${tone})` }
}

export function chatToneStyle(tone: StatusTone): Record<string, string> {
  return {
    '--chat-bar': `var(--isla-status-${tone})`,
    '--chat-bg': `color-mix(in srgb, ${TAG_TONE_VAR[tone]} 14%, white)`,
    '--chat-name': `var(--isla-status-${tone})`,
  }
}

/** Milliseconds → a short human duration; the raw value stays in the title. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} m ${seconds} s`
}

/** Seconds of uptime → `1 h 02 m` style (the raw value stays in the facts). */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.floor(seconds % 60)
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} m`
  if (minutes > 0) return `${minutes} m ${String(rest).padStart(2, '0')} s`
  return `${rest} s`
}

/** First code point of an id, used for avatar chips in the chat feed. */
export function idGlyph(id: string): string {
  const first = [...id.trim()][0]
  return first === undefined ? '*' : first.toUpperCase()
}

/** Capitalize the first letter of a short UI word (display only). */
export function capWord(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)
}
