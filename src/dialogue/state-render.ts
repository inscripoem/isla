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
 * Values are clamped to 0..1 before they are formatted, so a finite
 * out-of-range input can never render as an impossible state. A dimension that
 * is not a finite number (`NaN`, an infinity, or a null from an untyped caller)
 * is a different case: it is unknown, not extreme, so the WHOLE block is
 * refused and nothing is rendered rather than reporting that unknown as a
 * number. The function is pure and deterministic: no I/O, no clock, no
 * randomness.
 */

const NUMERIC_HEADER = 'Current inner state (0-1, do not quote numbers):'
const VERBAL_HEADER = 'Current inner state (qualitative, do not quote numbers):'

function clamp01(value: number): number {
  // Callers pass finite numbers only: `renderStateBlock` refuses anything else
  // before reaching this point, so this is the plain clamp and needs no
  // non-finite special case. The guard upstream is not cosmetic - NaN survives
  // every comparison, so clamping first would render NaN as a value inside the
  // range (and a null as the low end), which is exactly the made-up reading the
  // guard prevents.
  return Math.min(1, Math.max(0, value))
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
 * Render the state block for one prompt, or `null` when the state is not
 * renderable.
 *
 * The result is two lines joined by a newline: the header and the readings in
 * fixed `STATE_DIMENSION_KEYS` order. If any dimension is not a finite number
 * the whole block is refused: rendering the remaining four would silently
 * misstate the state, and an unknown value must not be presented as a reading.
 * Returning null rather than throwing matches `renderWorkingMemoryBlock`
 * (./working-memory), whose only "nothing renderable" case is also null.
 */
export function renderStateBlock(
  state: CharacterState,
  profile: StateProfile,
): string | null {
  const raw = STATE_DIMENSION_KEYS.map((dimension) => state[dimension])
  if (!raw.every((value) => Number.isFinite(value))) return null
  const values = raw.map(clamp01)
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
