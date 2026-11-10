import type { CharacterState, StateProfile } from './state'
import { STATE_DIMENSION_KEYS } from './state'

/**
 * Render a `CharacterState` as a prompt block (see ./state).
 *
 * Rendering is kept apart from the dynamics so the format lives in exactly one
 * place, the way `renderPersonaBlock` (./persona) fixes the persona layout here.
 *
 * Two forms:
 *   - numeric: one decimal per dimension. The header forbids the model from
 *     quoting the numbers back.
 *   - verbal: a qualitative band per dimension and no digit anywhere, for a
 *     caller that does not want exact values repeated in speech.
 *
 * Values are clamped to 0..1 before they are formatted, so an out-of-range input
 * can never render as an impossible state. The function is pure and
 * deterministic: no I/O, no clock, no randomness.
 */

const NUMERIC_HEADER = 'Current inner state (0-1, do not quote numbers):'
const VERBAL_HEADER = 'Current inner state (qualitative, do not quote numbers):'

function clamp01(value: number): number {
  // `Math.min(Math.max(...))` maps NaN to NaN, which would render as "NaN";
  // `value > 0 ? ... : 0` keeps a non-numeric input at the low end instead.
  const withinHigh = value < 1 ? value : 1
  return withinHigh > 0 ? withinHigh : 0
}

/**
 * Qualitative band for one dimension. Boundaries belong to the higher band:
 * 0.25 is 'somewhat low', 0.5 'somewhat high' and 0.75 'high'.
 */
function verbalBand(value: number): string {
  if (value < 0.25) return 'low'
  if (value < 0.5) return 'somewhat low'
  if (value < 0.75) return 'somewhat high'
  return 'high'
}

/**
 * Render the state block for one prompt.
 *
 * The result is two lines joined by a newline: the header and the readings in
 * fixed `STATE_DIMENSION_KEYS` order.
 */
export function renderStateBlock(state: CharacterState, profile: StateProfile): string {
  const values = STATE_DIMENSION_KEYS.map((dimension) => clamp01(state[dimension]))
  if (profile.renderMode === 'verbal') {
    const readings = STATE_DIMENSION_KEYS.map(
      (dimension, index) => `${dimension}: ${verbalBand(values[index] ?? 0)}`,
    )
    return [VERBAL_HEADER, readings.join(' | ')].join('\n')
  }
  const readings = STATE_DIMENSION_KEYS.map(
    (dimension, index) => `${dimension}=${(values[index] ?? 0).toFixed(1)}`,
  )
  return [NUMERIC_HEADER, readings.join(' ')].join('\n')
}
