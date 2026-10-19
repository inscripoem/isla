import type { ComparisonRun, NotRunEntry, Variant } from './comparison'
import { summarise, type AttemptRecord } from './metrics'
import type { FixedConditions, ReportInput, RunMeta } from './report'

/**
 * M6-02 R1 — versioned recorded-run input.
 *
 * A recorded run is the file R2 writes and R1 reads. The file carries only the
 * observations a run actually made: identity, variants, declared conditions and
 * attempt records. It carries **no trusted summary**; `summarise` is called here
 * so a hand-edited total cannot become evidence.
 *
 * The parser is deliberately strict about shape. Report-level rules (fixture
 * source, injected clock, sample mismatch, empty attempts, blank conditions) are
 * still enforced by `writeEvaluationReport`; this module only gets a structurally
 * valid `ReportInput` to that writer.
 */

export const RECORDED_RUN_SCHEMA_VERSION = 1

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'meta',
  'variants',
  'conditions',
  'records',
  'notRun',
] as const

const META_KEYS = ['runId', 'generatedAt'] as const
const VARIANT_KEYS = ['id', 'kind', 'combined'] as const
const CONDITION_KEYS = [
  'hardware',
  'providers',
  'workload',
  'sampleSize',
  'coldWarm',
  'persona',
  'modelVersion',
  'promptVersion',
  'textBudget',
  'history',
  'textSource',
  'clock',
  'recall',
] as const
const PERSONA_KEYS = ['profileId', 'version'] as const
const TEXT_BUDGET_KEYS = ['maxCharacters', 'accounting'] as const
const HISTORY_KEYS = ['source', 'recordSet'] as const
const RECALL_KEYS = ['supplied', 'maxTurns'] as const
const RECORD_KEYS = [
  'caseId',
  'variantId',
  'cold',
  'outcome',
  'timing',
  'totalMs',
  'attempts',
  'usage',
  'failureReason',
] as const
const TIMING_KEYS = [
  'submitMs',
  'planMs',
  'dialogueMs',
  'synthesisMs',
  'firstAudibleMs',
  'stopToSilenceMs',
] as const
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'costUsd', 'usageMissing'] as const
const NOT_RUN_KEYS = ['variantId', 'caseId', 'reason'] as const
const OUTCOMES = ['completed', 'cancelled', 'failed'] as const
const VARIANT_KINDS = ['rules', 'model'] as const

type ObjectValue = Record<string, unknown>
type Validator = { violations: string[] }

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkObject(value: unknown, path: string, keys: readonly string[], validator: Validator): ObjectValue | null {
  if (!isObject(value)) {
    validator.violations.push(`${path} must be an object`)
    return null
  }
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) validator.violations.push(`${path}.${key} is not a recognised field`)
  }
  for (const key of keys) {
    if (!(key in value)) validator.violations.push(`${path}.${key} is required`)
  }
  return value
}

function readString(object: ObjectValue, key: string, path: string, validator: Validator): string | null {
  const value = object[key]
  if (typeof value !== 'string') {
    validator.violations.push(`${path}.${key} must be a string`)
    return null
  }
  return value
}

function readNonBlankString(
  object: ObjectValue,
  key: string,
  path: string,
  validator: Validator,
): string | null {
  const value = readString(object, key, path, validator)
  if (value === null) return null
  if (value.trim().length === 0) {
    validator.violations.push(`${path}.${key} must not be blank`)
    return null
  }
  return value
}

function readStringOrNull(
  object: ObjectValue,
  key: string,
  path: string,
  validator: Validator,
): string | null | undefined {
  const value = object[key]
  if (value === null) return null
  if (typeof value !== 'string') {
    validator.violations.push(`${path}.${key} must be a string or null`)
    return undefined
  }
  return value
}

function readBoolean(object: ObjectValue, key: string, path: string, validator: Validator): boolean | null {
  const value = object[key]
  if (typeof value !== 'boolean') {
    validator.violations.push(`${path}.${key} must be a boolean`)
    return null
  }
  return value
}

function readNumber(object: ObjectValue, key: string, path: string, validator: Validator): number | null {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    validator.violations.push(`${path}.${key} must be a finite number`)
    return null
  }
  return value
}

function readNumberOrNull(
  object: ObjectValue,
  key: string,
  path: string,
  validator: Validator,
): number | null | undefined {
  const value = object[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    validator.violations.push(`${path}.${key} must be a finite number or null`)
    return undefined
  }
  return value
}

function readArray(object: ObjectValue, key: string, path: string, validator: Validator): unknown[] | null {
  const value = object[key]
  if (!Array.isArray(value)) {
    validator.violations.push(`${path}.${key} must be an array`)
    return null
  }
  return value
}

function parseMeta(value: unknown, path: string, validator: Validator): RunMeta | null {
  const object = checkObject(value, path, META_KEYS, validator)
  if (object === null) return null
  const runId = readString(object, 'runId', path, validator)
  const generatedAt = readString(object, 'generatedAt', path, validator)
  return runId === null || generatedAt === null ? null : { runId, generatedAt }
}

function parseVariants(value: unknown[], path: string, validator: Validator): Variant[] | null {
  const variants: Variant[] = []
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    const object = checkObject(item, itemPath, VARIANT_KEYS, validator)
    if (object === null) continue
    const id = readNonBlankString(object, 'id', itemPath, validator)
    const kind = readString(object, 'kind', itemPath, validator)
    const combined = readBoolean(object, 'combined', itemPath, validator)
    if (kind !== null && !VARIANT_KINDS.includes(kind as (typeof VARIANT_KINDS)[number])) {
      validator.violations.push(`${itemPath}.kind must be "rules" or "model"`)
      continue
    }
    if (id === null || kind === null || combined === null) continue
    variants.push({ id, kind: kind as Variant['kind'], combined })
  }
  return variants
}

function parseConditions(value: unknown, path: string, validator: Validator): FixedConditions | null {
  const object = checkObject(value, path, CONDITION_KEYS, validator)
  if (object === null) return null

  const hardware = readString(object, 'hardware', path, validator)
  const providers = readArray(object, 'providers', path, validator)
  const workload = readString(object, 'workload', path, validator)
  const sampleSize = readNumber(object, 'sampleSize', path, validator)
  const coldWarm = readString(object, 'coldWarm', path, validator)
  const persona = checkObject(object.persona, `${path}.persona`, PERSONA_KEYS, validator)
  const profileId = persona === null ? null : readString(persona, 'profileId', `${path}.persona`, validator)
  const version = persona === null ? null : readString(persona, 'version', `${path}.persona`, validator)
  const modelVersion = readString(object, 'modelVersion', path, validator)
  const promptVersion = readString(object, 'promptVersion', path, validator)
  const textBudget = checkObject(object.textBudget, `${path}.textBudget`, TEXT_BUDGET_KEYS, validator)
  const maxCharacters = textBudget === null ? null : readNumber(textBudget, 'maxCharacters', `${path}.textBudget`, validator)
  const accounting = textBudget === null ? null : readString(textBudget, 'accounting', `${path}.textBudget`, validator)
  const history = checkObject(object.history, `${path}.history`, HISTORY_KEYS, validator)
  const historySource = history === null ? null : readString(history, 'source', `${path}.history`, validator)
  const recordSet = history === null ? null : readString(history, 'recordSet', `${path}.history`, validator)
  const textSource = readString(object, 'textSource', path, validator)
  const clock = readString(object, 'clock', path, validator)
  const recall = checkObject(object.recall, `${path}.recall`, RECALL_KEYS, validator)
  const supplied = recall === null ? null : readBoolean(recall, 'supplied', `${path}.recall`, validator)
  const maxTurns = recall === null ? null : readNumberOrNull(recall, 'maxTurns', `${path}.recall`, validator)

  if (providers !== null) {
    for (const [index, provider] of providers.entries()) {
      if (typeof provider !== 'string') validator.violations.push(`${path}.providers[${index}] must be a string`)
    }
  }

  if (
    hardware === null ||
    providers === null ||
    providers.some((provider) => typeof provider !== 'string') ||
    workload === null ||
    sampleSize === null ||
    coldWarm === null ||
    profileId === null ||
    version === null ||
    modelVersion === null ||
    promptVersion === null ||
    maxCharacters === null ||
    accounting === null ||
    historySource === null ||
    recordSet === null ||
    textSource === null ||
    clock === null ||
    supplied === null ||
    maxTurns === undefined
  ) {
    return null
  }

  return {
    hardware,
    providers: providers as string[],
    workload,
    sampleSize,
    coldWarm: coldWarm as FixedConditions['coldWarm'],
    persona: { profileId, version },
    modelVersion,
    promptVersion,
    textBudget: { maxCharacters, accounting },
    history: {
      source: historySource as FixedConditions['history']['source'],
      recordSet,
    },
    textSource: textSource as FixedConditions['textSource'],
    clock: clock as FixedConditions['clock'],
    recall: { supplied, maxTurns },
  }
}

function parseRecord(value: unknown, path: string, validator: Validator): AttemptRecord | null {
  const object = checkObject(value, path, RECORD_KEYS, validator)
  if (object === null) return null
  const caseId = readNonBlankString(object, 'caseId', path, validator)
  const variantId = readNonBlankString(object, 'variantId', path, validator)
  const cold = readBoolean(object, 'cold', path, validator)
  const outcome = readString(object, 'outcome', path, validator)
  if (outcome !== null && !OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    validator.violations.push(`${path}.outcome must be completed, cancelled or failed`)
    return null
  }

  const timingObject = checkObject(object.timing, `${path}.timing`, TIMING_KEYS, validator)
  const timing = timingObject === null
    ? null
    : {
        submitMs: readNumberOrNull(timingObject, 'submitMs', `${path}.timing`, validator),
        planMs: readNumberOrNull(timingObject, 'planMs', `${path}.timing`, validator),
        dialogueMs: readNumberOrNull(timingObject, 'dialogueMs', `${path}.timing`, validator),
        synthesisMs: readNumberOrNull(timingObject, 'synthesisMs', `${path}.timing`, validator),
        firstAudibleMs: readNumberOrNull(timingObject, 'firstAudibleMs', `${path}.timing`, validator),
        stopToSilenceMs: readNumberOrNull(timingObject, 'stopToSilenceMs', `${path}.timing`, validator),
      }

  const totalMs = readNumberOrNull(object, 'totalMs', path, validator)
  const attempts = readNumberOrNull(object, 'attempts', path, validator)
  const usageObject = checkObject(object.usage, `${path}.usage`, USAGE_KEYS, validator)
  const usage = usageObject === null
    ? null
    : {
        inputTokens: readNumberOrNull(usageObject, 'inputTokens', `${path}.usage`, validator),
        outputTokens: readNumberOrNull(usageObject, 'outputTokens', `${path}.usage`, validator),
        costUsd: readNumberOrNull(usageObject, 'costUsd', `${path}.usage`, validator),
        usageMissing: readBoolean(usageObject, 'usageMissing', `${path}.usage`, validator),
      }
  const failureReason = readStringOrNull(object, 'failureReason', path, validator)

  if (
    caseId === null ||
    variantId === null ||
    cold === null ||
    outcome === null ||
    timing === null ||
    Object.values(timing).some((value) => value === undefined) ||
    totalMs === undefined ||
    attempts === undefined ||
    usage === null ||
    usage.usageMissing === null ||
    Object.values(usage).some((value) => value === undefined) ||
    failureReason === undefined
  ) {
    return null
  }

  return {
    caseId,
    variantId,
    cold,
    outcome: outcome as AttemptRecord['outcome'],
    timing: timing as AttemptRecord['timing'],
    totalMs,
    attempts,
    usage: usage as AttemptRecord['usage'],
    failureReason,
  }
}

function parseRecords(value: unknown[], path: string, validator: Validator): AttemptRecord[] | null {
  const records: AttemptRecord[] = []
  for (const [index, item] of value.entries()) {
    const record = parseRecord(item, `${path}[${index}]`, validator)
    if (record !== null) records.push(record)
  }
  return records
}

function parseNotRun(value: unknown[], path: string, validator: Validator): NotRunEntry[] | null {
  const entries: NotRunEntry[] = []
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    const object = checkObject(item, itemPath, NOT_RUN_KEYS, validator)
    if (object === null) continue
    const variantId = readNonBlankString(object, 'variantId', itemPath, validator)
    const caseId = readNonBlankString(object, 'caseId', itemPath, validator)
    const reason = readNonBlankString(object, 'reason', itemPath, validator)
    if (variantId === null || caseId === null || reason === null) continue
    entries.push({ variantId, caseId, reason })
  }
  return entries
}

export type RecordedRunParseResult =
  | { readonly ok: true; readonly input: ReportInput }
  | { readonly ok: false; readonly violations: readonly string[] }

/**
 * Parse and structurally validate a versioned recorded run.
 *
 * Report-level semantic refusals remain in `writeEvaluationReport`; this parser
 * only guarantees the shape and recomputes the summary.
 */
export function parseRecordedRun(text: string): RecordedRunParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      violations: [`recorded run is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const validator: Validator = { violations: [] }
  const top = checkObject(raw, '$', TOP_LEVEL_KEYS, validator)
  if (top === null) return { ok: false, violations: validator.violations }

  const schemaVersion = readNumber(top, 'schemaVersion', '$', validator)
  if (schemaVersion !== null && schemaVersion !== RECORDED_RUN_SCHEMA_VERSION) {
    validator.violations.push(
      `$.schemaVersion must be ${RECORDED_RUN_SCHEMA_VERSION}; received ${schemaVersion}`,
    )
  }

  const meta = parseMeta(top.meta, '$.meta', validator)
  const variantsArray = readArray(top, 'variants', '$', validator)
  const variants = variantsArray === null ? null : parseVariants(variantsArray, '$.variants', validator)
  const conditions = parseConditions(top.conditions, '$.conditions', validator)
  const recordsArray = readArray(top, 'records', '$', validator)
  const records = recordsArray === null ? null : parseRecords(recordsArray, '$.records', validator)
  const notRunArray = readArray(top, 'notRun', '$', validator)
  const notRun = notRunArray === null ? null : parseNotRun(notRunArray, '$.notRun', validator)

  if (
    schemaVersion === null ||
    meta === null ||
    variants === null ||
    conditions === null ||
    records === null ||
    notRun === null ||
    validator.violations.length > 0
  ) {
    return { ok: false, violations: validator.violations }
  }

  const run: ComparisonRun = {
    records,
    notRun,
    summary: summarise(records),
  }

  return {
    ok: true,
    input: { run, variants, conditions, meta },
  }
}
