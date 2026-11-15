import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runBench, serializeRecordedRun, type BenchConditions } from './bench'
import type { EvalCase, Variant, VariantRun } from './comparison'
import type { RunMeta } from './report'

/**
 * M6 / CP05 (#103) — the evaluation run command.
 *
 * Until now the pieces existed and nothing turned the key: `runBench` had no
 * caller outside its tests, and the production `runVariant` seam
 * (`src/runtime/evaluation-adapter.ts`) had none either. This is the missing
 * imperative shell — it executes a run and writes a recorded run, and it owns no
 * peers of its own.
 *
 * The peer set is supplied by an **evaluation harness module** named on the
 * command line, the same way `runtime:production` loads its deployment. That
 * keeps the ownership boundary intact: this module never imports the runtime
 * composition, and the deployment that wires peers stays with the owner of those
 * peers. The harness may be swapped for a synthetic one without changing the
 * runner, so the shell is testable with no provider and no product code.
 *
 * Refusals are data, faults throw:
 *
 *  - a missing/unreadable/invalid spec, an empty case set, a bad argument, a
 *    harness module that will not load or does not export a factory, and an
 *    output path that already exists are refusals — nothing is written;
 *  - a filesystem failure while writing is a fault, and the temporary file is
 *    removed so no partial artifact is left behind.
 *
 * The output is a recorded run, not a report. It carries observations only; the
 * report command recomputes every summary, and a not-run case stays an explicit
 * entry rather than a missing row.
 */

export interface RunSpec {
  readonly meta: RunMeta
  readonly conditions: BenchConditions
  readonly cases: readonly EvalCase[]
}

/** Context handed to the harness factory so it can read its own configuration. */
export interface EvaluationHarnessContext {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * What a harness module must supply: the variants it can execute and the
 * production `runVariant` seam for them. `close` is optional cleanup the runner
 * calls once, on both the success and the refusal path.
 */
export interface EvaluationHarness {
  readonly variants: readonly Variant[]
  readonly runVariant: (variant: Variant, evalCase: EvalCase) => Promise<VariantRun>
  readonly close?: () => Promise<void> | void
}

export type RunResult =
  | {
      readonly ok: true
      readonly path: string
      readonly records: number
      readonly notRun: number
      readonly outcomes: Readonly<Record<string, number>>
    }
  | { readonly ok: false; readonly violations: readonly string[] }

export interface RunArgs {
  readonly spec: string
  readonly harness: string
  readonly out: string
}

export type RunArgsParse = { readonly ok: true; readonly value: RunArgs } | { readonly ok: false; readonly message: string }

const FLAGS = ['--spec', '--harness', '--out'] as const

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parseRunArgs(argv: readonly string[]): RunArgsParse {
  const seen = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    if (!(FLAGS as readonly string[]).includes(flag)) {
      return { ok: false, message: `${flag} is not a recognised option; use ${FLAGS.join(', ')}` }
    }
    if (seen.has(flag)) return { ok: false, message: `${flag} is given more than once` }
    const value = argv[index + 1]
    if (!nonBlank(value)) return { ok: false, message: `${flag} requires a path` }
    seen.set(flag, value)
    index += 1
  }
  const missing = FLAGS.filter((flag) => !seen.has(flag))
  if (missing.length > 0) {
    return { ok: false, message: `missing required option(s): ${missing.join(', ')}` }
  }
  return {
    ok: true,
    value: {
      spec: seen.get('--spec') as string,
      harness: seen.get('--harness') as string,
      out: seen.get('--out') as string,
    },
  }
}

/**
 * Parse the run specification. Only the fields the runner itself needs are
 * checked here; the recorded-run parser and the report writer keep their own
 * stricter rules, so this cannot become a second, weaker validator.
 */
export function readRunSpec(text: string): { readonly ok: true; readonly spec: RunSpec } | { readonly ok: false; readonly violations: readonly string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, violations: [`the run spec is not valid JSON: ${describeError(error)}`] }
  }
  if (!isObject(raw)) return { ok: false, violations: ['the run spec must be a JSON object'] }

  const violations: string[] = []
  const meta = raw.meta
  if (!isObject(meta)) violations.push('meta must be an object')
  else {
    if (!nonBlank(meta.runId)) violations.push('meta.runId must be a non-empty string')
    if (!nonBlank(meta.generatedAt)) violations.push('meta.generatedAt must be a non-empty string')
  }
  if (!isObject(raw.conditions)) violations.push('conditions must be an object')

  const cases = raw.cases
  if (!Array.isArray(cases) || cases.length === 0) {
    violations.push('cases must be a non-empty array')
  } else {
    cases.forEach((entry, index) => {
      if (!isObject(entry)) violations.push(`cases[${index}] must be an object`)
      else {
        if (!nonBlank(entry.id)) violations.push(`cases[${index}].id must be a non-empty string`)
        if (!nonBlank(entry.input)) violations.push(`cases[${index}].input must be a non-empty string`)
      }
    })
  }

  if (violations.length > 0) return { ok: false, violations }
  return {
    ok: true,
    spec: {
      meta: meta as unknown as RunMeta,
      conditions: raw.conditions as unknown as BenchConditions,
      cases: cases as unknown as EvalCase[],
    },
  }
}

export function validateHarness(value: unknown): { readonly ok: true; readonly harness: EvaluationHarness } | { readonly ok: false; readonly violations: readonly string[] } {
  if (!isObject(value)) return { ok: false, violations: ['the harness factory must return an object'] }
  const violations: string[] = []
  const variants = value.variants
  if (!Array.isArray(variants) || variants.length === 0) {
    violations.push('the harness must supply at least one variant')
  } else {
    variants.forEach((variant, index) => {
      if (!isObject(variant)) violations.push(`variants[${index}] must be an object`)
      else {
        if (!nonBlank(variant.id)) violations.push(`variants[${index}].id must be a non-empty string`)
        if (variant.kind !== 'rules' && variant.kind !== 'model') {
          violations.push(`variants[${index}].kind must be rules or model`)
        }
        if (typeof variant.combined !== 'boolean') {
          violations.push(`variants[${index}].combined must be a boolean`)
        }
      }
    })
  }
  if (typeof value.runVariant !== 'function') {
    violations.push('the harness must supply a runVariant function')
  }
  if (violations.length > 0) return { ok: false, violations }
  return {
    ok: true,
    harness: {
      variants: variants as Variant[],
      runVariant: value.runVariant as EvaluationHarness['runVariant'],
      ...(typeof value.close === 'function' ? { close: value.close as () => void } : {}),
    },
  }
}

/**
 * Run the spec through the harness and write the recorded run.
 *
 * An existing output is refused rather than replaced: a recorded run is
 * evidence, and a second run belongs in a second file.
 */
export async function executeRun(
  spec: RunSpec,
  harness: EvaluationHarness,
  outPath: string,
): Promise<RunResult> {
  if (existsSync(outPath)) {
    return {
      ok: false,
      violations: [
        `refusing to overwrite ${outPath}: a recorded run is evidence and is never replaced; choose a new path`,
      ],
    }
  }

  const run = await runBench(
    {
      meta: spec.meta,
      conditions: spec.conditions,
      variants: harness.variants,
      cases: spec.cases,
    },
    { runVariant: harness.runVariant },
  )

  const json = serializeRecordedRun(run)
  writeAtomically(outPath, json)

  const outcomes: Record<string, number> = {}
  for (const record of run.records) {
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1
  }
  return { ok: true, path: outPath, records: run.records.length, notRun: run.notRun.length, outcomes }
}

function writeAtomically(path: string, text: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.tmp`)
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The original fault is the one worth reporting.
    }
    throw error
  }
}

async function loadHarness(
  modulePath: string,
  context: EvaluationHarnessContext,
): Promise<{ readonly ok: true; readonly harness: EvaluationHarness } | { readonly ok: false; readonly violations: readonly string[] }> {
  const absolute = resolve(context.cwd, modulePath)
  if (!existsSync(absolute)) {
    return { ok: false, violations: [`the harness module ${modulePath} does not exist`] }
  }
  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
  } catch (error) {
    return { ok: false, violations: [`the harness module ${modulePath} could not be loaded: ${describeError(error)}`] }
  }
  const factory = module.default ?? module.createEvaluationHarness
  if (typeof factory !== 'function') {
    return {
      ok: false,
      violations: [
        `the harness module ${modulePath} must default-export a factory (or export createEvaluationHarness)`,
      ],
    }
  }
  let value: unknown
  try {
    value = await (factory as (input: EvaluationHarnessContext) => unknown)(context)
  } catch (error) {
    return { ok: false, violations: [`the harness factory threw: ${describeError(error)}`] }
  }
  return validateHarness(value)
}

export async function runEvaluationCommand(argv: readonly string[]): Promise<number> {
  const args = parseRunArgs(argv)
  if (!args.ok) {
    process.stderr.write(`evaluation:run: ${args.message}\n`)
    return 2
  }

  let specText: string
  try {
    specText = readFileSync(resolve(process.cwd(), args.value.spec), 'utf8')
  } catch (error) {
    process.stderr.write(`evaluation:run: cannot read ${args.value.spec}: ${describeError(error)}\n`)
    return 1
  }
  const parsed = readRunSpec(specText)
  if (!parsed.ok) {
    process.stderr.write(`evaluation:run: refused ${args.value.spec}\n`)
    for (const violation of parsed.violations) process.stderr.write(`- ${violation}\n`)
    return 1
  }

  const context: EvaluationHarnessContext = { cwd: process.cwd(), env: process.env }
  const loaded = await loadHarness(args.value.harness, context)
  if (!loaded.ok) {
    process.stderr.write(`evaluation:run: refused ${args.value.harness}\n`)
    for (const violation of loaded.violations) process.stderr.write(`- ${violation}\n`)
    return 1
  }

  try {
    const result = await executeRun(parsed.spec, loaded.harness, resolve(process.cwd(), args.value.out))
    if (!result.ok) {
      for (const violation of result.violations) process.stderr.write(`evaluation:run: ${violation}\n`)
      return 1
    }
    process.stdout.write(`${JSON.stringify({ 'evaluation:run': result })}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`evaluation:run: cannot write ${args.value.out}: ${describeError(error)}\n`)
    return 2
  } finally {
    try {
      await loaded.harness.close?.()
    } catch {
      // Cleanup is best-effort; it cannot change the written artifact.
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = await runEvaluationCommand(process.argv.slice(2))
}
