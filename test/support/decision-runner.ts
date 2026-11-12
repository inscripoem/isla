import type {
  ClockPort,
  SelectionPort,
  SelectionRequest,
  SelectionResult,
} from '../../src/contracts'
import { selectionResultSchema } from '../../src/contracts'
import {
  M3_COMPARISON_VARIANTS,
  ProviderSelectionError,
  SelectionCallError,
  createRuleSelectionPort,
} from '../../src/decision'
import type {
  ComparisonRun,
  EvalCase,
  Variant,
  VariantRun,
} from '../../src/evaluation/comparison'
import { runComparison } from '../../src/evaluation/comparison'
import { createCallContext } from './context'
import type {
  LoadedDecisionCorpus,
  LoadedDecisionCorpusCase,
} from './decision-corpus'
import {
  DecisionCorpusError,
  loadDecisionCorpus,
  toEvalCase,
} from './decision-corpus'
import { createVirtualClock } from './virtual-clock'

/**
 * Direct M3 selection runner.
 *
 * This is module evidence: it executes the fixture SelectionRequest through the
 * actual SelectionPort. It does not compose M5, generate runtime identities or
 * timestamps, or claim full-pipeline replay. The loader validates labels and
 * reviews as corpus data, but the port receives only the request; labels are
 * used for scoring only after the result returns.
 */

export type SelectionInvalidReason =
  | 'schema-invalid'
  | 'exact-one'
  | 'identity-mismatch'
  | 'unoffered-candidate'
  | 'intent-not-allowed'
  | 'candidate-expired'

export type SelectionFailureKind =
  | 'threw'
  | 'aborted'
  | 'deadline-exceeded'
  | 'invalid-deadline'
  | 'construction-failed'

export type SelectionScoreStatus =
  | 'adopted'
  | 'not-adopted'
  | 'unassessed'
  | 'not-scored'

export type IntentSuitability =
  | 'appropriate'
  | 'inappropriate'
  | 'unassessed'
  | 'not-applicable'

interface ObservationBase {
  readonly caseId: string
  readonly corpusVersion: string
  readonly rubricVersion: string
  readonly evidenceClass: 'corpus' | 'synthetic-test'
  readonly planMs: null
  readonly totalMs: null
}

export interface ObservedSelection extends ObservationBase {
  readonly status: 'observed'
  readonly result: SelectionResult
  readonly disposition: 'respond' | 'defer'
  readonly selectedEventId: string | null
  readonly replyIntent: string | null
  readonly labelStatus: 'draft' | 'reviewed'
  readonly scoreStatus: SelectionScoreStatus
  readonly adoptedScore: 0 | 1 | 2 | null
  readonly candidateScore: 0 | 1 | 2 | null
  readonly intentSuitability: IntentSuitability
  readonly certifiesCorpus: boolean
  readonly diagnostics: readonly string[]
}

export interface InvalidSelection extends ObservationBase {
  readonly status: 'invalid-result'
  readonly reason: SelectionInvalidReason
  readonly adoptedScore: null
  readonly scoreStatus: 'not-scored'
  readonly certifiesCorpus: false
  readonly diagnostics: readonly string[]
}

export interface TechnicalSelectionFailure extends ObservationBase {
  readonly status: 'technical-failure'
  readonly failure: {
    readonly kind: SelectionFailureKind
    readonly message: string
  }
  readonly adoptedScore: null
  readonly scoreStatus: 'not-scored'
  readonly certifiesCorpus: false
  readonly diagnostics: readonly string[]
}

export type SelectionCaseObservation =
  | ObservedSelection
  | InvalidSelection
  | TechnicalSelectionFailure

/** Non-label facts a factory may need; request labels and review stay out. */
export interface SelectionFactoryContext {
  readonly caseId: string
  readonly initialNowMs: number
}

/** Optional model ports for the multi-variant corpus comparison. */
export interface SelectionVariantPorts {
  readonly generalModel?: (
    clock: ClockPort,
    context: SelectionFactoryContext,
  ) => SelectionPort
  readonly jevModel?: (
    clock: ClockPort,
    context: SelectionFactoryContext,
  ) => SelectionPort
}

/**
 * Adopted-score summary for one split. A draft, failed or unscored case is
 * counted as unreviewed rather than contributing a fabricated zero, and a split
 * with no adopted case has an unknown (null) sum.
 */
export interface SelectionSplitScoreSummary {
  readonly caseCount: number
  readonly adoptedCount: number
  readonly unreviewedOrUnscoredCount: number
  readonly adoptedScoreSum: number | null
}

export interface SelectionVariantsCorpusRun {
  readonly corpusVersion: string
  readonly casesSha256: string
  readonly comparison: ComparisonRun
  readonly observationsByVariant: Readonly<
    Record<string, readonly SelectionCaseObservation[]>
  >
  readonly splitScoresByVariant: Readonly<
    Record<
      string,
      {
        readonly dev: SelectionSplitScoreSummary
        readonly heldOut: SelectionSplitScoreSummary
      }
    >
  >
}

const NO_ATTEMPT_TIMING = {
  submitMs: null,
  planMs: null,
  dialogueMs: null,
  synthesisMs: null,
  firstAudibleMs: null,
  stopToSilenceMs: null,
} as const

function toVariantRun(
  variant: Variant,
  observation: SelectionCaseObservation,
): VariantRun {
  if (observation.status === 'observed') {
    return {
      ran: true,
      record: {
        caseId: observation.caseId,
        variantId: variant.id,
        cold: false,
        outcome: 'completed',
        timing: {
          ...NO_ATTEMPT_TIMING,
          planMs: observation.result.usage.elapsedMs,
        },
        totalMs: null,
        attempts: variant.kind === 'rules' ? 0 : 1,
        usage: {
          inputTokens: observation.result.usage.inputTokens,
          outputTokens: observation.result.usage.outputTokens,
          costUsd: null,
          usageMissing: observation.result.usage.usageMissing,
        },
        failureReason: null,
      },
    }
  }

  if (observation.status === 'invalid-result') {
    return {
      ran: true,
      record: {
        caseId: observation.caseId,
        variantId: variant.id,
        cold: false,
        outcome: 'failed',
        timing: { ...NO_ATTEMPT_TIMING },
        totalMs: null,
        attempts: variant.kind === 'rules' ? 0 : 1,
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          usageMissing: true,
        },
        failureReason: `invalid-result:${observation.reason}`,
      },
    }
  }

  return {
    ran: true,
    record: {
      caseId: observation.caseId,
      variantId: variant.id,
      cold: false,
      outcome: observation.failure.kind === 'aborted' ? 'cancelled' : 'failed',
      timing: { ...NO_ATTEMPT_TIMING },
      totalMs: null,
      attempts: observation.failure.kind === 'construction-failed' ? 0 : null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        usageMissing: true,
      },
      failureReason: `${observation.failure.kind}:${observation.failure.message}`,
    },
  }
}

function splitScore(
  observations: readonly SelectionCaseObservation[],
): SelectionSplitScoreSummary {
  let adoptedCount = 0
  let adoptedScoreSum = 0
  let unreviewedOrUnscoredCount = 0
  for (const observation of observations) {
    if (
      observation.status === 'observed' &&
      observation.scoreStatus === 'adopted' &&
      observation.adoptedScore !== null
    ) {
      adoptedCount += 1
      adoptedScoreSum += observation.adoptedScore
    } else {
      unreviewedOrUnscoredCount += 1
    }
  }
  return {
    caseCount: observations.length,
    adoptedCount,
    unreviewedOrUnscoredCount,
    adoptedScoreSum: adoptedCount === 0 ? null : adoptedScoreSum,
  }
}

/**
 * Runs every M3 comparison variant that is executable in selection-port mode
 * over the loaded corpus. It maps each case through `toEvalCase` so reference
 * labels and reply intents never reach the port or M6's case envelope, and it
 * records an honest not-run entry for variants that cannot execute here.
 */
export async function runSelectionVariantsOnCorpus(
  corpus: LoadedDecisionCorpus,
  ports: SelectionVariantPorts = {},
): Promise<SelectionVariantsCorpusRun> {
  const casesById = new Map(
    corpus.cases.map((entry) => [entry.entry.id, entry]),
  )
  const evalCases: EvalCase[] = corpus.cases.map((entry) =>
    toEvalCase(entry.entry, entry.request),
  )
  const observationsByVariant: Record<string, SelectionCaseObservation[]> = {}
  for (const variant of M3_COMPARISON_VARIANTS) {
    observationsByVariant[variant.id] = []
  }
  const heldOutById = new Map(
    corpus.cases.map((entry) => [entry.entry.id, entry.entry.heldOut]),
  )

  const runVariant = async (
    variant: Variant,
    evalCase: EvalCase,
  ): Promise<VariantRun> => {
    const entry = casesById.get(evalCase.id)
    if (entry === undefined) {
      return {
        ran: false,
        reason: `corpus has no case ${evalCase.id}`,
      }
    }

    let createSelection:
      | ((clock: ClockPort, context: SelectionFactoryContext) => SelectionPort)
      | undefined
    if (variant.id === 'm3-rules') {
      createSelection = (clock) => createRuleSelectionPort({ clock })
    } else if (variant.id === 'm3-general-model') {
      if (ports.generalModel === undefined) {
        return {
          ran: false,
          reason: 'm3-general-model selection provider is not configured',
        }
      }
      createSelection = ports.generalModel
    } else if (variant.id === 'm3-jev') {
      if (ports.jevModel === undefined) {
        return {
          ran: false,
          reason: 'm3-jev selection provider is not configured',
        }
      }
      createSelection = ports.jevModel
    } else if (variant.id === 'm3-m4-combined') {
      return {
        ran: false,
        reason:
          'm3-m4-combined requires full-turn selection-and-dialogue execution, not selection-port mode',
      }
    } else {
      return {
        ran: false,
        reason: `unsupported M3 comparison variant ${variant.id}`,
      }
    }

    if (createSelection === undefined) {
      return {
        ran: false,
        reason: `variant ${variant.id} has no selection factory`,
      }
    }

    const observation = await runSelectionCase(entry, { createSelection })
    const observations = observationsByVariant[variant.id] ?? []
    observations.push(observation)
    observationsByVariant[variant.id] = observations
    return toVariantRun(variant, observation)
  }

  const comparison = await runComparison(
    { variants: M3_COMPARISON_VARIANTS, cases: evalCases },
    { runVariant },
  )

  const splitScoresByVariant: Record<
    string,
    {
      readonly dev: SelectionSplitScoreSummary
      readonly heldOut: SelectionSplitScoreSummary
    }
  > = {}
  for (const [variantId, observations] of Object.entries(observationsByVariant)) {
    const dev: SelectionCaseObservation[] = []
    const heldOut: SelectionCaseObservation[] = []
    for (const observation of observations) {
      if (heldOutById.get(observation.caseId) === true) heldOut.push(observation)
      else dev.push(observation)
    }
    splitScoresByVariant[variantId] = {
      dev: splitScore(dev),
      heldOut: splitScore(heldOut),
    }
  }

  return {
    corpusVersion: corpus.manifest.corpusVersion,
    casesSha256: corpus.casesSha256,
    comparison,
    observationsByVariant,
    splitScoresByVariant,
  }
}

export interface SelectionRunOptions {
  /**
   * Creates the port for one case. The runner supplies a fresh virtual clock
   * reading that case's initialNowMs, so the actual port and the validation
   * reference use the same execution time. The context deliberately excludes
   * the request, reference labels and review record.
   */
  readonly createSelection: (
    clock: ClockPort,
    context: SelectionFactoryContext,
  ) => SelectionPort
  /** Defaults to the request deadline. Tests may supply an earlier caller deadline. */
  readonly contextDeadlineAtMs?: (entry: LoadedDecisionCorpusCase) => number
  readonly allowSynthetic?: boolean
}

export type SelectionCorpusResult =
  | {
      readonly status: 'not-run'
      readonly error: {
        readonly code: string
        readonly message: string
      }
    }
  | {
      readonly status: 'ran'
      readonly observations: readonly SelectionCaseObservation[]
    }

function formatIssues(error: {
  readonly issues: ReadonlyArray<{ readonly message: string }>
}): string {
  return error.issues.map((issue) => issue.message).join('; ')
}

type Validation =
  | {
      readonly ok: true
      readonly result: SelectionResult
    }
  | {
      readonly ok: false
      readonly reason: SelectionInvalidReason
      readonly message: string
    }

export function validateSelectionResult(
  raw: unknown,
  request: SelectionRequest,
  initialNowMs: number,
): Validation {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    (raw as { disposition?: unknown }).disposition === 'respond' &&
    Array.isArray((raw as { selectedEventIds?: unknown }).selectedEventIds) &&
    (raw as { selectedEventIds: unknown[] }).selectedEventIds.length !== 1
  ) {
    return {
      ok: false,
      reason: 'exact-one',
      message: 'respond must select exactly one event id',
    }
  }

  const parsed = selectionResultSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'schema-invalid',
      message: formatIssues(parsed.error),
    }
  }
  const result = parsed.data
  if (
    result.requestId !== request.requestId ||
    result.sessionId !== request.sessionId ||
    result.epoch !== request.epoch ||
    result.snapshotRevision !== request.snapshotRevision
  ) {
    return {
      ok: false,
      reason: 'identity-mismatch',
      message: 'selection result does not echo the request identity and revision',
    }
  }
  if (result.disposition === 'defer') {
    return { ok: true, result }
  }

  const selected = request.candidates.find(
    (candidate) => candidate.eventId === result.selectedEventIds[0],
  )
  if (selected === undefined) {
    return {
      ok: false,
      reason: 'unoffered-candidate',
      message: 'selection result names a candidate that was not offered',
    }
  }
  if (result.replyIntent === null || !request.allowedIntents.includes(result.replyIntent)) {
    return {
      ok: false,
      reason: 'intent-not-allowed',
      message: 'selection result intent is not allowed by the request',
    }
  }
  if (selected.expiresAtMs <= initialNowMs) {
    return {
      ok: false,
      reason: 'candidate-expired',
      message: 'selection result chose a candidate expired at the fixture time',
    }
  }
  return { ok: true, result }
}

function failureKind(error: unknown): SelectionFailureKind {
  if (error instanceof SelectionCallError) return error.code
  if (error instanceof ProviderSelectionError) {
    return error.code === 'aborted' ||
      error.code === 'deadline-exceeded' ||
      error.code === 'invalid-deadline'
      ? error.code
      : 'threw'
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  ) {
    return 'aborted'
  }
  return 'threw'
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function evidenceClass(entry: LoadedDecisionCorpusCase): 'corpus' | 'synthetic-test' {
  return entry.review.status === 'reviewed' &&
    entry.review.provenance === 'synthetic-test'
    ? 'synthetic-test'
    : 'corpus'
}

function intentSuitability(
  result: SelectionResult,
  entry: LoadedDecisionCorpusCase,
): IntentSuitability {
  if (result.disposition === 'defer') return 'not-applicable'
  const selected = result.selectedEventIds[0]
  const label = entry.label.intentLabels.find(
    (intentLabel) => intentLabel.selectedEventId === selected,
  )
  if (label === undefined || result.replyIntent === null) return 'unassessed'
  if (label.acceptableIntents.includes(result.replyIntent)) return 'appropriate'
  return label.coverage === 'exhaustive' ? 'inappropriate' : 'unassessed'
}

function observe(
  entry: LoadedDecisionCorpusCase,
  result: SelectionResult,
): ObservedSelection {
  const base = {
    caseId: entry.entry.id,
    corpusVersion: entry.corpusVersion,
    rubricVersion: entry.rubricVersion,
    evidenceClass: evidenceClass(entry),
    planMs: null,
    totalMs: null,
  } as const
  const disposition = result.disposition
  const labelStatus = entry.review.status

  if (labelStatus === 'draft') {
    return {
      ...base,
      status: 'observed',
      result,
      disposition,
      selectedEventId: result.selectedEventIds[0] ?? null,
      replyIntent: result.replyIntent,
      labelStatus,
      scoreStatus: 'not-adopted',
      adoptedScore: null,
      candidateScore: null,
      intentSuitability: disposition === 'defer' ? 'not-applicable' : 'unassessed',
      certifiesCorpus: false,
      diagnostics: ['draft-label'],
    }
  }

  const selectedIds = result.selectedEventIds.join(',')
  const score = entry.label.selectionScores.find(
    (candidate) =>
      candidate.disposition === disposition &&
      candidate.selectedEventIds.join(',') === selectedIds,
  )
  const candidateScore = score?.score ?? null
  const suitability = intentSuitability(result, entry)
  const certifiesCorpus =
    entry.review.provenance === 'human' && base.evidenceClass === 'corpus'
  const diagnostics: string[] = []
  if (candidateScore === null) diagnostics.push('label-outcome-not-covered')
  if (suitability === 'unassessed') diagnostics.push('intent-not-assessed')

  return {
    ...base,
    status: 'observed',
    result,
    disposition,
    selectedEventId: result.selectedEventIds[0] ?? null,
    replyIntent: result.replyIntent,
    labelStatus,
    scoreStatus: candidateScore === null ? 'unassessed' : 'adopted',
    adoptedScore: candidateScore,
    candidateScore,
    intentSuitability: suitability,
    certifiesCorpus,
    diagnostics,
  }
}

function technicalFailure(
  entry: LoadedDecisionCorpusCase,
  kind: SelectionFailureKind,
  error: unknown,
  diagnostic: string,
): TechnicalSelectionFailure {
  return {
    caseId: entry.entry.id,
    corpusVersion: entry.corpusVersion,
    rubricVersion: entry.rubricVersion,
    evidenceClass: evidenceClass(entry),
    planMs: null,
    totalMs: null,
    status: 'technical-failure',
    failure: { kind, message: failureMessage(error) },
    adoptedScore: null,
    scoreStatus: 'not-scored',
    certifiesCorpus: false,
    diagnostics: [diagnostic],
  }
}

export async function runSelectionCase(
  entry: LoadedDecisionCorpusCase,
  options: SelectionRunOptions,
): Promise<SelectionCaseObservation> {
  const clock = createVirtualClock(entry.entry.initialNowMs)
  const factoryContext: SelectionFactoryContext = {
    caseId: entry.entry.id,
    initialNowMs: entry.entry.initialNowMs,
  }
  let selection: SelectionPort
  try {
    selection = options.createSelection(clock, factoryContext)
  } catch (error) {
    return technicalFailure(
      entry,
      'construction-failed',
      error,
      'selection-factory-failed',
    )
  }

  const context = createCallContext(
    options.contextDeadlineAtMs?.(entry) ?? entry.request.deadline.atMs,
  )
  let raw: unknown
  try {
    raw = await selection.select(entry.request, context)
  } catch (error) {
    return technicalFailure(entry, failureKind(error), error, 'selection-call-failed')
  }

  const validation = validateSelectionResult(
    raw,
    entry.request,
    entry.entry.initialNowMs,
  )
  if (!validation.ok) {
    return {
      caseId: entry.entry.id,
      corpusVersion: entry.corpusVersion,
      rubricVersion: entry.rubricVersion,
      evidenceClass: evidenceClass(entry),
      planMs: null,
      totalMs: null,
      status: 'invalid-result',
      reason: validation.reason,
      adoptedScore: null,
      scoreStatus: 'not-scored',
      certifiesCorpus: false,
      diagnostics: [validation.message],
    }
  }

  return observe(entry, validation.result)
}

export function runSelectionCorpus(
  corpus: LoadedDecisionCorpus,
  options: SelectionRunOptions,
): Promise<SelectionCorpusResult> {
  return (async () => {
    const observations: SelectionCaseObservation[] = []
    for (const entry of corpus.cases) {
      observations.push(await runSelectionCase(entry, options))
    }
    return { status: 'ran' as const, observations }
  })()
}

export async function runSelectionCorpusFromManifest(
  manifestPath: string,
  options: SelectionRunOptions,
): Promise<SelectionCorpusResult> {
  let corpus: LoadedDecisionCorpus
  try {
    corpus = loadDecisionCorpus(manifestPath, {
      allowSynthetic: options.allowSynthetic === true,
    })
  } catch (error) {
    return {
      status: 'not-run',
      error: {
        code: error instanceof DecisionCorpusError ? error.code : 'corpus-invalid',
        message: failureMessage(error),
      },
    }
  }
  return runSelectionCorpus(corpus, options)
}
