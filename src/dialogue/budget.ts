/**
 * Layered character budget for dialogue context assembly.
 *
 * Model. One `maxCharacters` allowance is split into fixed section quotas before
 * anything is rendered, so no section can starve another:
 *
 *   persona -> state -> workingMemory -> recall -> history
 *
 * The mechanism borrows the shape of two well-known prompt-assembly designs
 * without adopting either implementation: fixed-size resident blocks with one
 * quota each (Letta/MemGPT style - a section's quota is its own and cannot be
 * consumed by a busier neighbour), and a section cap that stops injection once
 * it is reached instead of emitting a soft warning (SillyTavern World Info
 * style). The Generative Agents composition order (normalize each unit, then
 * combine) is followed by keeping every section in ONE character unit rather
 * than mixing store sizes.
 *
 * Allocation is a per-ASSEMBLY decision, not a shared pool: each section is
 * capped independently, and whatever a section leaves unused flows back to
 * history, which is the only section that absorbs the remainder. `history`
 * additionally never falls below `HISTORY_MIN_SHARE` of the total, so a long
 * conversation keeps its most recent turns even when the other sections are
 * generous.
 *
 * The default shares are an INITIAL, pinned choice (0.2 / 0.1 / 0.1 / 0.2 /
 * 0.4). They carry no claimed quality or cost effect; retuning is deferred to a
 * later batch driven by probe and evaluation data.
 *
 * Everything here is pure arithmetic and validation: no I/O, no clock, no
 * randomness, no environment, and no import from another module of this
 * repository. Determinism is what lets the reply path use it without adding any
 * provider call.
 */

/** A budgeted section of the assembled context, in fixed allocation order. */
export type BudgetSection = 'persona' | 'state' | 'workingMemory' | 'recall' | 'history'

/**
 * Per-section SHARES of `contextLimits.maxCharacters`, as fractions.
 *
 * Shares are not character counts: they are resolved to integer caps by
 * `allocateBudget` for one assembly, so the same plan scales with the configured
 * budget.
 */
export interface BudgetPlan {
  persona: number
  state: number
  workingMemory: number
  recall: number
  history: number
}

/** Integer character caps per section, as resolved for one assembly. */
export interface SectionLimits {
  persona: number
  state: number
  workingMemory: number
  recall: number
  history: number
}

/**
 * One section's plan cap, effective bound, usage and drop count for one
 * assembly. Carries no memory text: it is a diagnostic shape, safe to log.
 *
 * `limit` is the cap the section was held to, `used` the characters it actually
 * charged, and `dropped` how many candidates it refused to make room.
 */
export interface BudgetSectionUsage {
  section: BudgetSection
  limit: number
  used: number
  dropped: number
}

/**
 * Initial shares (0.2 / 0.1 / 0.1 / 0.2 / 0.4). Pinned for this batch; a later
 * batch may retune them against probe and evaluation data.
 */
export const DEFAULT_BUDGET_PLAN: BudgetPlan = {
  persona: 0.2,
  state: 0.1,
  workingMemory: 0.1,
  recall: 0.2,
  history: 0.4,
}

/** History never falls below this share of maxCharacters when a plan is applied. */
export const HISTORY_MIN_SHARE = 0.35

/**
 * Tolerance for summing floating-point shares. It only has to absorb
 * accumulation error (the default plan totals 1.0000000000000002), never a real
 * over-allocation.
 */
const SHARE_TOLERANCE = 1e-6

/** Sections whose caps are resolved before history takes the remainder. */
const NON_HISTORY_SECTIONS: readonly Exclude<BudgetSection, 'history'>[] = [
  'persona',
  'state',
  'workingMemory',
  'recall',
]

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/**
 * Deterministic, integer character caps per section. Throws on an invalid plan
 * or a negative/non-finite maxCharacters. Sum of caps <= maxCharacters;
 * caps.history >= floor(HISTORY_MIN_SHARE * maxCharacters).
 *
 * A plan is rejected rather than quietly corrected when its non-history shares
 * leave no room for the history floor: honoring it would have to violate either
 * the floor or the total cap, and a bound that is silently broken is not a
 * bound.
 */
export function allocateBudget(maxCharacters: number, plan: BudgetPlan): SectionLimits {
  if (!isNonNegativeFinite(maxCharacters)) {
    throw new Error('budget: maxCharacters must be a finite number >= 0')
  }
  for (const section of [...NON_HISTORY_SECTIONS, 'history'] as const) {
    if (!isNonNegativeFinite(plan[section])) {
      throw new Error('budget: every share must be a finite number >= 0')
    }
  }

  const nonHistoryShare = NON_HISTORY_SECTIONS.reduce((sum, section) => sum + plan[section], 0)
  if (nonHistoryShare > 1 - HISTORY_MIN_SHARE + SHARE_TOLERANCE) {
    throw new Error('budget: non-history shares leave no room for the history floor')
  }
  const totalShare = nonHistoryShare + plan.history
  if (totalShare > 1 + SHARE_TOLERANCE) {
    throw new Error('budget: shares exceed the total budget')
  }

  const persona = Math.floor(plan.persona * maxCharacters)
  const state = Math.floor(plan.state * maxCharacters)
  const workingMemory = Math.floor(plan.workingMemory * maxCharacters)
  const recall = Math.floor(plan.recall * maxCharacters)

  // The non-history check above guarantees the remainder covers the history
  // floor, so the min() below never binds for a valid plan. It still appears so
  // the total cap is enforced here and not only by the caller's arithmetic.
  const remaining = maxCharacters - persona - state - workingMemory - recall
  const history = Math.min(
    remaining,
    Math.max(Math.floor(plan.history * maxCharacters), historyFloorCharacters(maxCharacters)),
  )

  return { persona, state, workingMemory, recall, history }
}

/**
 * The effective lower bound of the history section for one assembly: the floor
 * of `HISTORY_MIN_SHARE` times `maxCharacters`.
 *
 * `allocateBudget` can only honour the floor while every section's cap is still
 * unused. A block charged to the shared pool outside its own section can shrink
 * the history remainder below the floor, so a caller building the same
 * arithmetic guards against this one function instead of recomputing the floor.
 */
export function historyFloorCharacters(maxCharacters: number): number {
  return Math.floor(HISTORY_MIN_SHARE * maxCharacters)
}

/** True when the code point is a CJK ideograph counted in the 1/1.5 bucket. */
function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff)
  )
}

/**
 * Approximate token count over exactly the budget-charged rendered lines.
 *
 * AGGREGATE SCOPE: latin and cjk code-point counts are summed across ALL lines
 * first, then ONE ceil is applied to the totals - never per line. CJK code
 * points in [0x3400, 0x4DBF] and [0x4E00, 0x9FFF] cost 1/1.5 each; every other
 * code point (ASCII, spaces, CJK punctuation such as U+3000-U+303F) costs 1/4;
 * the result is Math.ceil(latin/4 + cjk/1.5).
 *
 * APPROXIMATE, NOT A MEASUREMENT: M4 has no tokenizer, for the same reason
 * `estimatedCharacters` is a character count rather than a token count. This is
 * an assembly-time diagnostic only; it must never be used as a quality or cost
 * conclusion. Per-line rounding is a different, equally deterministic contract
 * and is deliberately NOT used here.
 */
export function estimateTokensFromLines(lines: readonly string[]): number {
  let latinCharacters = 0
  let cjkCharacters = 0
  for (const line of lines) {
    for (const character of line) {
      if (isCjkCodePoint(character.codePointAt(0) ?? 0)) cjkCharacters += 1
      else latinCharacters += 1
    }
  }
  return Math.ceil(latinCharacters / 4 + cjkCharacters / 1.5)
}
