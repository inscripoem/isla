import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ComparisonRun, Variant } from './comparison'
import {
  TIMING_STAGES,
  summarise,
  summariseWindow,
  type Percentiles,
  type UsageSummary,
  type WindowSummary,
} from './metrics'

/**
 * M6-02 — the evaluation report.
 *
 * The report is the **receipt** for a benchmark run: it states what was measured,
 * under which conditions, and what was not measured. Gate G4 reads the generated
 * `docs/architecture/evaluation-table.md`, so the artifact has to be worth reading
 * by a human as well as greppable by the gate.
 *
 * Three rules make it honest rather than decorative:
 *
 *  - **No receipt without a real run.** A fixture text source, or latencies taken
 *    from an injected clock, are refused: a fixture run consumes no tokens and a
 *    fixture clock returns a constant, so either would be a measurement-shaped zero
 *    rather than a measurement (issue #41, M4's clock-domain warning).
 *  - **Unknown stays unknown.** A stage with no observed value prints `—`, never `0`;
 *    usage prints `unknown` when any attempt is missing it.
 *  - **"First attempt" is not "cold".** The runner's first-attempt window is labelled
 *    as such. Real cold/warm state is a **declared condition**, because the first
 *    attempt does not prove a cold process, provider, worker or cache (issue #41, M5).
 *
 * The conditions are declared by the harness. G4 can check that they are present; it
 * cannot check that they are true, and the report says so rather than implying
 * otherwise.
 */

/**
 * The conditions a run was performed under. They are **declared** by the harness: the
 * report can print them, but it cannot verify them, and G4 can only check that they are
 * recorded (issue #41 Q3; NFR-01).
 */
export interface FixedConditions {
  readonly hardware: string
  readonly providers: readonly string[]
  readonly workload: string
  /** Attempts the run was declared to include; must equal the records it produced. */
  readonly sampleSize: number
  /** The real state the run was started in — not inferred from the first attempt. */
  readonly coldWarm: 'cold' | 'warm' | 'mixed'
  readonly persona: { readonly profileId: string; readonly version: string }
  readonly modelVersion: string
  readonly promptVersion: string
  readonly textBudget: { readonly maxCharacters: number; readonly accounting: string }
  readonly history: { readonly source: 'durable' | 'local' | 'none'; readonly recordSet: string }
  readonly textSource: 'provider' | 'fixture'
  readonly clock: 'wall' | 'injected'
  readonly recall: { readonly supplied: boolean; readonly maxTurns: number | null }
}

/** Identity of the run the report describes: without it the artifact is unattributable. */
export interface RunMeta {
  readonly runId: string
  /** ISO calendar date, `YYYY-MM-DD`; supplied by the caller so the report stays deterministic. */
  readonly generatedAt: string
}

/** Everything the report needs: the run, the variants it covered, the conditions and its identity. */
export interface ReportInput {
  readonly run: ComparisonRun
  readonly variants: readonly Variant[]
  readonly conditions: FixedConditions
  readonly meta: RunMeta
}

export type ReportResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly violations: readonly string[] }

function blank(value: string): boolean {
  return value.trim().length === 0
}

/** A real calendar date: `Date.parse` accepts 2026-02-31 by rolling it into March. */
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** A duration was actually observed somewhere in the run — a stage or the total. */
function hasMeasuredDuration(run: ComparisonRun): boolean {
  return run.records.some(
    (record) => record.totalMs !== null || TIMING_STAGES.some((stage) => record.timing[stage] !== null),
  )
}

/** Every duration a record claims, stage timings included. */
function durationsOf(record: ComparisonRun['records'][number]): readonly (number | null)[] {
  return [record.totalMs, ...TIMING_STAGES.map((stage) => record.timing[stage])]
}

function invalidNumber(value: number | null): boolean {
  return value !== null && (!Number.isFinite(value) || value < 0)
}

/**
 * Everything that makes the report unpublishable, in a stable order.
 *
 * Validation is deliberately stricter than the renderer needs: a report is evidence, so a
 * negative duration, a failed attempt without a reason or a declared sample that differs
 * from the records is a defect even if it would print.
 */
function collectReportViolations(input: ReportInput): string[] {
  const { run, variants, conditions, meta } = input
  const violations: string[] = []

  if (blank(meta.runId)) violations.push('the run id is required: a report that cannot be attributed is not evidence')
  if (!isCalendarDate(meta.generatedAt)) {
    violations.push('generatedAt must be a real YYYY-MM-DD calendar date')
  }

  if (blank(conditions.hardware)) violations.push('hardware is required for a published report')
  if (blank(conditions.workload)) violations.push('workload is required for a published report')
  if (conditions.providers.length === 0 || conditions.providers.some(blank)) {
    violations.push('at least one provider must be named for a published report')
  }
  if (blank(conditions.persona.profileId) || blank(conditions.persona.version)) {
    violations.push('the persona profile id and version are required (a version change alters every output)')
  }
  if (blank(conditions.modelVersion)) violations.push('the model version is required')
  if (blank(conditions.promptVersion)) violations.push('the prompt/intent-template version is required')
  if (blank(conditions.textBudget.accounting)) {
    violations.push('the text-budget accounting rule is required (rendered length and recall share it)')
  }
  if (!Number.isInteger(conditions.textBudget.maxCharacters) || conditions.textBudget.maxCharacters <= 0) {
    violations.push('the text budget must be a positive whole number of characters')
  }
  if (blank(conditions.history.recordSet)) {
    violations.push('the history source and record set are required (they change the prompt)')
  }
  if (!['durable', 'local', 'none'].includes(conditions.history.source)) {
    violations.push('the history source must be durable, local or none')
  }
  if (!['cold', 'warm', 'mixed'].includes(conditions.coldWarm)) {
    violations.push('the declared cold/warm state must be cold, warm or mixed')
  }
  if (conditions.recall.maxTurns !== null) {
    if (!Number.isInteger(conditions.recall.maxTurns) || conditions.recall.maxTurns < 0) {
      violations.push('maxTurns must be a non-negative whole number, or null when the case does not fix it')
    }
  }
  if (typeof conditions.recall.supplied !== 'boolean') {
    violations.push('whether a recall port was supplied must be recorded as true or false')
  }

  if (!Number.isInteger(conditions.sampleSize) || conditions.sampleSize <= 0) {
    violations.push(`the declared sample size (${conditions.sampleSize}) must be a positive whole number`)
  } else if (conditions.sampleSize !== run.records.length) {
    violations.push(
      `the declared sample size (${conditions.sampleSize}) does not match the ${run.records.length} attempts recorded`,
    )
  }

  if (run.records.length === 0) {
    violations.push('no attempts were recorded; a report with no attempts claims nothing')
  }

  if (!['provider', 'fixture'].includes(conditions.textSource)) {
    violations.push('the text source must be provider or fixture')
  }
  if (!['wall', 'injected'].includes(conditions.clock)) {
    violations.push('the clock must be wall or injected')
  }
  if (conditions.textSource === 'fixture') {
    violations.push(
      'a fixture text source is not a benchmark: it consumes no tokens and is not comparable to a provider run',
    )
  }
  if (conditions.clock === 'injected' && hasMeasuredDuration(run)) {
    violations.push(
      'an injected clock cannot measure latency: a fixture clock returns a constant, so its durations are not measurements',
    )
  }

  for (const record of run.records) {
    const label = `${record.variantId}/${record.caseId}`
    if (durationsOf(record).some(invalidNumber)) {
      violations.push(`${label} records a duration that is negative or not a finite number`)
    }
    if (!Number.isInteger(record.attempts) || record.attempts < 0) {
      violations.push(`${label} records ${record.attempts} attempts; a whole number >= 0 is required`)
    }
    if (
      [record.usage.inputTokens, record.usage.outputTokens, record.usage.costUsd].some(invalidNumber)
    ) {
      violations.push(`${label} records usage that is negative or not a finite number`)
    }
    if (record.outcome === 'failed' && (record.failureReason ?? '').trim().length === 0) {
      violations.push(`${label} is a failed attempt with no reason; a failure without a reason is a gap`)
    }
  }

  const ids = variants.map((variant) => variant.id)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length > 0) violations.push(`duplicate variant id(s): ${[...new Set(duplicates)].join(', ')}`)
  const known = new Set(ids)
  const unknown = [...run.records.map((record) => record.variantId), ...run.notRun.map((entry) => entry.variantId)]
    .filter((id) => !known.has(id))
  if (unknown.length > 0) violations.push(`recorded variant(s) not declared in the run: ${[...new Set(unknown)].join(', ')}`)

  return violations
}

/** A number with at most `digits` decimals, without trailing zeros. */
function decimal(value: number, digits: number): string {
  const fixed = value.toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Milliseconds: one decimal is enough to read, and `—` means "not observed". */
function ms(value: number | null): string {
  return value === null ? '—' : decimal(value, 1)
}

/** A whole-number quantity — tokens, or a turn limit; `—` when unobserved. */
function count(value: number | null): string {
  return value === null ? '—' : decimal(value, 0)
}

/** Cost: six decimals, because a per-attempt cost of $0.002 must not print as $0.0. */
function cost(value: number | null): string {
  return value === null ? '—' : decimal(value, 6)
}

/** A Markdown table cell: a pipe or a line break would break the table. */
function cell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** A share of attempts, one decimal. */
function rate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

/** Tokens and cost, or `unknown` — never a partial total. */
function usage(summary: UsageSummary): string {
  if (summary.unknown) return 'unknown'
  return `${count(summary.inputTokens)} in / ${count(summary.outputTokens)} out / $${cost(summary.costUsd)}`
}

const STAGE_LABEL: Record<(typeof TIMING_STAGES)[number], string> = {
  submitMs: 'submit (M5)',
  planMs: 'plan (M3)',
  dialogueMs: 'dialogue (M4)',
  synthesisMs: 'synthesis (M1)',
  firstAudibleMs: 'first audible (M1)',
  stopToSilenceMs: 'stop→silence (M1/M2)',
}

/** One row per stage: the sample it measured, then p50/p95 (`—` when n = 0). */
function latencyRows(variantId: string, window: string, summary: WindowSummary): string[] {
  return TIMING_STAGES.map((stage) => {
    const measured: Percentiles = summary.stages[stage]
    return `| ${cell(variantId)} | ${window} | ${STAGE_LABEL[stage]} | ${measured.n} | ${ms(
      measured.p50,
    )} | ${ms(measured.p95)} |`
  })
}

/**
 * Render the Markdown gate G4 reads, or return the reasons the run cannot be published.
 *
 * Rendering never throws for a bad input: the refusals are data, so a caller can show them.
 * Use `writeEvaluationReport` to create the artifact itself.
 */
export function renderEvaluationReport(input: ReportInput): ReportResult {
  const { run, variants, conditions, meta } = input
  const violations = collectReportViolations(input)
  if (violations.length > 0) return { ok: false, violations }

  const lines: string[] = [
    '# Evaluation report',
    '',
    `> Run \`${meta.runId}\` — generated ${meta.generatedAt}.`,
    '',
    '> The conditions below are **declared by the run harness**, not inferred from the records.',
    '> Gate **G4** checks that hardware, provider, workload, sample size and cold/warm state are',
    '> recorded; it cannot check that they are true.',
    '',
    '## Fixed conditions',
    '',
    '| Condition | Value |',
    '| --- | --- |',
    `| Hardware | ${cell(conditions.hardware)} |`,
    `| Providers | ${cell(conditions.providers.join(', '))} |`,
    `| Workload | ${cell(conditions.workload)} |`,
    `| Sample size (attempts) | ${conditions.sampleSize} |`,
    `| Cold/warm state (declared) | ${conditions.coldWarm} |`,
    `| Persona profile | \`${cell(conditions.persona.profileId)}\` @ \`${cell(conditions.persona.version)}\` |`,
    `| Model version | ${cell(conditions.modelVersion)} |`,
    `| Prompt version | ${cell(conditions.promptVersion)} |`,
    `| Text budget | ${conditions.textBudget.maxCharacters} characters — ${cell(conditions.textBudget.accounting)} |`,
    `| History | ${conditions.history.source} / ${cell(conditions.history.recordSet)} |`,
    `| Text source | ${conditions.textSource} |`,
    `| Clock | ${conditions.clock} |`,
    `| maxTurns | ${count(conditions.recall.maxTurns)} |`,
    `| Recall port | ${conditions.recall.supplied ? 'supplied' : 'not supplied'} |`,
    '',
    '## Results by variant',
    '',
    '| Variant | Kind | Combined | Attempts | Completed | Cancelled | Failed | Failure rate | Usage |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const variant of variants) {
    const records = run.records.filter((record) => record.variantId === variant.id)
    // One aggregation rule: every cell below comes from `summarise`, so the report
    // cannot drift from the metric definitions.
    const variantSummary = summarise(records)
    lines.push(
      `| ${cell(variant.id)} | ${variant.kind} | ${variant.combined ? 'yes' : 'no'} | ${variantSummary.attempts} | ${
        variantSummary.outcomes.completed
      } | ${variantSummary.outcomes.cancelled} | ${variantSummary.outcomes.failed} | ${rate(
        variantSummary.failureRate,
      )} | ${usage(variantSummary.usage)} |`,
    )
  }

  lines.push(
    '',
    '## Latency (ms)',
    '',
    '> **First attempt** means the variant\'s first actual attempt in this run. It is **not** evidence of a',
    '> cold process, provider, worker or cache; the declared cold/warm state above is the run condition.',
    '> `n` is the number of attempts that actually reported the stage; `—` means it was not observed.',
    '',
    '| Variant | Window | Stage | n | p50 | p95 |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  for (const variant of variants) {
    const records = run.records.filter((record) => record.variantId === variant.id)
    const first = records.filter((record) => record.cold)
    const later = records.filter((record) => !record.cold)
    lines.push(...latencyRows(variant.id, 'first attempt', summariseWindow(first)))
    lines.push(...latencyRows(variant.id, 'later attempts', summariseWindow(later)))
  }

  lines.push(
    '',
    '## Every attempt',
    '',
    '| Case | Variant | Window | Outcome | total ms | attempts | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const record of run.records) {
    lines.push(
      `| ${cell(record.caseId)} | ${cell(record.variantId)} | ${record.cold ? 'first' : 'later'} | ${
        record.outcome
      } | ${ms(record.totalMs)} | ${record.attempts} | ${cell(record.failureReason ?? '')} |`,
    )
  }

  lines.push('', '## Not run', '')
  if (run.notRun.length === 0) {
    lines.push('No case was skipped: every case was attempted for every variant.')
  } else {
    lines.push('| Variant | Case | Reason |', '| --- | --- | --- |')
    for (const entry of run.notRun) {
      lines.push(`| ${cell(entry.variantId)} | ${cell(entry.caseId)} | ${cell(entry.reason)} |`)
    }
  }

  return { ok: true, markdown: `${lines.join('\n')}\n` }
}

/** The artifact gate G4 reads. */
const EVALUATION_TABLE_PATH = 'docs/architecture/evaluation-table.md'

export type WriteReportResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly violations: readonly string[] }

/**
 * Validate, then write the report — or write nothing.
 *
 * The table is the artifact G4 checks, so the writer is the one place allowed to create it. It refuses
 * before touching the filesystem, writes through a temporary file in the destination directory and
 * renames, so a partial table can never be mistaken for a complete one.
 */
export function writeEvaluationReport(
  input: ReportInput,
  path: string = EVALUATION_TABLE_PATH,
): WriteReportResult {
  const rendered = renderEvaluationReport(input)
  if (!rendered.ok) return { ok: false, violations: rendered.violations }

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try {
    writeFileSync(temporary, rendered.markdown, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return { ok: true, path }
}
