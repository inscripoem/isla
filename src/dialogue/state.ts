import { isSubstantiveSpeech } from './text'

/**
 * Inner state of a character: the five-dimensional value, its appraisal-driven
 * dynamics and the deterministic appraisal rules that feed them.
 *
 * Hard rules:
 *   - Pure functions only. No I/O, no clock read, no environment, no randomness
 *     and no model call, so a trajectory is reproducible offline and costs
 *     nothing (NFR-03 attribution, NFR-04: no extra provider attempt on the
 *     reply path).
 *   - State is NOT evidence. Nothing here enters the spoken-memory admission
 *     chain: it never reaches `classifyMemoryBucket` (./memory-semantics) and it
 *     never claims that anything was said. Persisting state is not part of this
 *     module.
 *   - Not wired into generation in this batch. `generate` renders the state its
 *     caller supplies and never calls `projectState` or `appraiseTurn`; the two
 *     are exercised by tests and by a future asynchronous state worker.
 *   - This module is the single source of the `CharacterState` type.
 *   - Deliberately independent from ./salience: no shared keyword table and no
 *     import, so the salience signal and the affect signal cannot couple.
 *
 * Theory borrowings (vocabulary and structure only, not implementations):
 *   - OCC (Ortony/Clore/Collins; Steunebrink, "The OCC Model Revisited") gives
 *     the `Appraisal` field names and their value ranges. No OCC emotion-type
 *     classification is implemented.
 *   - Gratch & Marsella's EMA gives the two-stage shape "appraisal variables ->
 *     impulse -> dynamics ceiling (`maxDelta`)".
 *   - ALMA (Gebhard) gives "short-term emotion separated from a long-term
 *     baseline, decaying back to it", which is `StateBaseline` plus `tauMs`.
 */

/* -------------------------------------------------------------------------- */
/* State and configuration                                                    */
/* -------------------------------------------------------------------------- */

/** One dimension of the character's inner state; every value is within 0..1. */
export interface CharacterState {
  mood: number
  stress: number
  energy: number
  attachment: number
  confidence: number
}

/** Long-term resting point each dimension decays towards during silence. */
export interface StateBaseline extends CharacterState {}

export type StateDimension = keyof CharacterState

/** Fixed dimension order for projection, rendering and tests. */
export const STATE_DIMENSION_KEYS: readonly StateDimension[] = [
  'mood',
  'stress',
  'energy',
  'attachment',
  'confidence',
]

export type StateRenderMode = 'numeric' | 'verbal'

export interface StateProfile {
  /** Emotional inertia in milliseconds; larger = slower. Must be > 0. */
  tauMs: number
  /** Per-turn absolute change cap per dimension, in 0..1 units. */
  maxDelta: number
  /** Target distance below which a dimension keeps its previous value. */
  deadzone: number
  /** Which state-block form the prompt uses. */
  renderMode: StateRenderMode
}

/**
 * Design defaults, not a calibrated optimum: every field can be overridden by a
 * caller-supplied profile. `tauMs` sits at ten minutes so "silent for ten
 * minutes" is ten inertia constants; `maxDelta` keeps a single turn from moving
 * any dimension from one end of its range to the other; `deadzone` filters
 * per-turn jitter.
 */
export const DEFAULT_STATE_PROFILE: StateProfile = {
  tauMs: 600_000,
  maxDelta: 0.15,
  deadzone: 0.02,
  renderMode: 'numeric',
}

/* -------------------------------------------------------------------------- */
/* Appraisal                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One cognitive appraisal of an event (OCC vocabulary: goal relevance,
 * goal congruence, agency, certainty, control, norm compatibility).
 * Ranges: goalRelevance/goalCongruence/normCompatibility in -1..1;
 * certainty/control in 0..1; agency is categorical.
 */
export interface Appraisal {
  goalRelevance: number
  goalCongruence: number
  agency: 'self' | 'other' | 'circumstance'
  certainty: number
  control: number
  normCompatibility: number
}

/** Speaker role of the text being appraised by `appraiseTurn`. */
export type AppraisalSpeakerRole = 'character' | 'listener'

/** Numeric factors one appraisal expands into, used by the weight table below. */
export type AppraisalFactor =
  | 'goalRelevance'
  | 'goalCongruence'
  | 'agencySelf'
  | 'agencyOther'
  | 'certainty'
  | 'control'
  | 'normCompatibility'

/**
 * Expansion of one appraisal into the seven factors the weight table keys on.
 * Agency is categorical, so it becomes two indicators rather than one number.
 */
function factorsOf(appraisal: Appraisal): Readonly<Record<AppraisalFactor, number>> {
  return {
    goalRelevance: appraisal.goalRelevance,
    goalCongruence: appraisal.goalCongruence,
    agencySelf: appraisal.agency === 'self' ? 1 : 0,
    agencyOther: appraisal.agency === 'other' ? 1 : 0,
    certainty: appraisal.certainty,
    control: appraisal.control,
    normCompatibility: appraisal.normCompatibility,
  }
}

const FACTOR_KEYS: readonly AppraisalFactor[] = [
  'goalRelevance',
  'goalCongruence',
  'agencySelf',
  'agencyOther',
  'certainty',
  'control',
  'normCompatibility',
]

/**
 * How each appraisal factor pushes each dimension. Design defaults, not a
 * calibrated optimum.
 *
 *   - mood: a congruent outcome compatible with the norm lifts it.
 *   - stress: relevance raises it; low control, low certainty, other-agency and
 *     a negative or norm-breaking outcome raise it further.
 *   - energy: a relevant event costs energy to process; acting oneself adds a
 *     little.
 *   - attachment: a relevant, positive and directed-at-her event raises it.
 *   - confidence: control, certainty and her own action raise it.
 */
export const APPRAISAL_WEIGHTS: Readonly<
  Record<StateDimension, Readonly<Record<AppraisalFactor, number>>>
> = {
  mood: {
    goalRelevance: 0,
    goalCongruence: 0.6,
    agencySelf: 0,
    agencyOther: 0,
    certainty: 0,
    control: 0,
    normCompatibility: 0.4,
  },
  stress: {
    goalRelevance: 0.4,
    goalCongruence: -0.3,
    agencySelf: 0,
    agencyOther: 0.1,
    certainty: -0.1,
    control: -0.4,
    normCompatibility: -0.2,
  },
  energy: {
    goalRelevance: 0.5,
    goalCongruence: 0.1,
    agencySelf: 0.1,
    agencyOther: 0,
    certainty: 0,
    control: 0.2,
    normCompatibility: 0,
  },
  attachment: {
    goalRelevance: 0.3,
    goalCongruence: 0.2,
    agencySelf: 0,
    agencyOther: 0.2,
    certainty: 0,
    control: 0,
    normCompatibility: 0.1,
  },
  confidence: {
    goalRelevance: 0,
    goalCongruence: 0.1,
    agencySelf: 0.2,
    agencyOther: -0.1,
    certainty: 0.3,
    control: 0.4,
    normCompatibility: 0,
  },
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Project the next state from the previous one, the appraisals of the elapsed
 * interval and the elapsed time.
 *
 *   1. An invalid `tauMs` (not a finite positive number) returns a copy of
 *      `prev`: a broken profile must never throw on the reply path.
 *   2. For every dimension, in `STATE_DIMENSION_KEYS` order:
 *        drive    = sum over appraisals of weight * factor,
 *        target   = clamp01(baseline + drive),
 *        deadzone = |target - prev| < profile.deadzone keeps `prev` (strictly
 *                   less; a target exactly one deadzone away still moves),
 *        alpha    = 1 - exp(-max(0, dtMs) / tauMs),
 *        moved    = prev + alpha * (target - prev),
 *        next     = clamp01(clamp(moved, prev - maxDelta, prev + maxDelta)).
 *   3. The result is a new object; `prev` is never modified.
 *   4. No appraisal means every drive is zero, target equals the baseline and
 *      the same dynamics regress the state towards its baseline during silence.
 *      No special branch is needed for that case.
 */
export function projectState(
  prev: CharacterState,
  appraisals: readonly Appraisal[],
  dtMs: number,
  baseline: StateBaseline,
  profile: { tauMs: number; maxDelta: number; deadzone: number },
): CharacterState {
  if (!(Number.isFinite(profile.tauMs) && profile.tauMs > 0)) {
    return { ...prev }
  }

  // One pass over the appraisals expands each one once, then every dimension
  // sums the same factors with its own weights.
  const expanded = appraisals.map(factorsOf)
  const alpha = 1 - Math.exp(-Math.max(0, dtMs) / profile.tauMs)
  const next: CharacterState = { ...prev }
  for (const dimension of STATE_DIMENSION_KEYS) {
    const weights = APPRAISAL_WEIGHTS[dimension]
    let drive = 0
    for (const factors of expanded) {
      for (const factor of FACTOR_KEYS) {
        drive += weights[factor] * factors[factor]
      }
    }
    const previous = prev[dimension]
    const target = clamp01(baseline[dimension] + drive)
    if (Math.abs(target - previous) < profile.deadzone) {
      next[dimension] = previous
      continue
    }
    const moved = previous + alpha * (target - previous)
    next[dimension] = clamp01(clamp(moved, previous - profile.maxDelta, previous + profile.maxDelta))
  }
  return next
}

/* -------------------------------------------------------------------------- */
/* Deterministic appraisal rules                                              */
/* -------------------------------------------------------------------------- */

/*
 * NOTE: deliberately independent from ./salience keyword tables (no shared
 * constants, no import) so the two signals cannot couple.
 *
 * The tables are data, not configuration: both CJK and English forms are listed
 * because listener input is not guaranteed to be English. They are coarse
 * heuristics; their precision and recall are not assessed.
 */
const POSITIVE_AFFECT_PATTERN =
  /喜欢|开心|高兴|谢谢|感谢|厉害|真棒|太棒|爱你|warm|wonderful|great|thanks|thank you|glad|happy|love|awesome|amazing/i
const NEGATIVE_AFFECT_PATTERN =
  /讨厌|烦|生气|失望|难过|伤心|害怕|担心|滚|hate|angry|upset|disappointed|sad|scared|worried|shut up|idiot/i
const INTENSIFIER_PATTERN =
  /很|超|真的|非常|特别|太|极|extremely|really|very|absolutely|totally|so much/i
const DIRECTED_AT_CHARACTER_PATTERN = /[你您]|\b(?:you|your|yours)\b/i
const PROMISE_PATTERN =
  /答应|承诺|约定|保证|说好了|一言为定|promise|swear|assure|you have my word/i
const BOUNDARY_VIOLATION_PATTERN = /骗|欺负|羞辱|侮辱|liar|insult|humiliate|betray/i

/**
 * Appraise one turn with fixed rules. At most one appraisal is produced per
 * turn; text no rule fires on produces an empty list.
 *
 * Negativity wins any tie, which is a deterministic resolution and not a claim
 * that negative wording dominates in real dialogue.
 */
export function appraiseTurn(text: string, role: AppraisalSpeakerRole): readonly Appraisal[] {
  // Punctuation-only text is not speech (see ./text), so it appraises nothing.
  if (!isSubstantiveSpeech(text)) return []

  const boundary = BOUNDARY_VIOLATION_PATTERN.test(text)
  const promise = PROMISE_PATTERN.test(text)
  const positive = POSITIVE_AFFECT_PATTERN.test(text)
  const negative = NEGATIVE_AFFECT_PATTERN.test(text)
  const intense = INTENSIFIER_PATTERN.test(text)
  if (!boundary && !promise && !positive && !negative) return []

  // A promise or boundary-only turn is relevant, but less so than one that
  // carries affect.
  const goalRelevance = positive || negative || boundary ? (intense ? 0.8 : 0.6) : 0.4
  // Negative affect and a norm violation win over positive affect; a
  // promise-only turn is mildly congruent.
  const goalCongruence =
    negative || boundary ? -(intense ? 0.8 : 0.6) : positive ? (intense ? 0.8 : 0.6) : 0.4
  const agency: Appraisal['agency'] =
    role === 'character'
      ? 'self'
      : role === 'listener' && DIRECTED_AT_CHARACTER_PATTERN.test(text)
        ? 'other'
        : 'circumstance'

  return [
    {
      goalRelevance,
      goalCongruence,
      agency,
      certainty: 0.5,
      control: agency === 'self' ? 0.7 : agency === 'other' ? 0.2 : 0.3,
      normCompatibility: boundary ? -0.8 : promise ? 0.5 : 0,
    },
  ]
}
