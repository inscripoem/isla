import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Controlled benchmark: consistency-scan work bound (owner-review instrument).
 *
 * It loads one or more real source roots and, for each, runs the SAME checks
 * against that root's OWN code:
 *
 *   1. a direct `scanContradictions` over controlled statements;
 *   2. a direct scan of a single long word, the negation-regex regression;
 *   3. a real dialogue assembly through that root's store and port, with a long
 *      confirmed history and a 64-character prompt budget;
 *
 * and it measures the delay each synchronous chunk imposes on a zero-delay
 * timer scheduled immediately before it.
 *
 * By default it compares this tree (repaired) with the unchanged sibling at
 * commit 4bc4c184616e72bbf3d291ca2dadf03459efb4e2 (pre-repair). The sibling is
 * imported read-only; nothing is written to any root.
 *
 * Scope, so the numbers are not over-read:
 *   - this is a development instrument, not an acceptance gate;
 *   - it makes no claim of hard real-time behavior: the reproducible guarantee
 *     is the WORK COUNT (`comparisons`), not any duration;
 *   - it does not exercise the full pipeline (no provider, playback or
 *     runtime), only the pure scan and one real assembly call per size;
 *   - durations are machine-specific and vary with load;
 *   - a root whose `scanContradictions` returns the old `readonly
 *     Contradiction[]` has no counters, so those columns print `n/a` rather
 *     than a fabricated zero.
 *
 * Run: node_modules/.bin/tsx test/bench/consistency-budget.bench.ts [root ...]
 */

const SIBLING_COMMIT = '4bc4c184616e72bbf3d291ca2dadf03459efb4e2'
const SIZES = [128, 512, 1024]
const LONG_WORD_SIZES = [4_096, 32_768]

/* Structural views of each root's module surface. The runner is deliberately
   duck-typed, so it can load the old and the new tree without importing either
   tree's types. */

interface StatementInput {
  ref: unknown
  text: string
}

interface ScanOutcome {
  findings: number
  comparisons: number | null
  incomplete: boolean | null
  statementsExamined: number | null
  statementsOffered: number | null
}

interface ViewLike {
  turns: readonly unknown[]
  estimatedCharacters?: number
  consistencyAudit?: { statementsOffered?: number; incomplete?: boolean } | null
}

interface StoreLike {
  commit(delivery: unknown): Promise<void>
  confirmedHistory(sessionId: string): Promise<readonly unknown[]>
}

interface PortLike {
  generate(
    request: unknown,
    context: unknown,
    sink: { segment: (segment: unknown) => Promise<void> },
  ): Promise<unknown>
}

interface DialogueApi {
  createDeliveryMemoryStore(): StoreLike
  createDialoguePort(options: Record<string, unknown>): PortLike
  scanContradictions(input: {
    statements: readonly StatementInput[]
    maxFindings?: number
  }): unknown
}

interface FixtureApi {
  FIXTURE_SESSION_ID: string
  fixtureDialogueRequest(overrides?: Record<string, unknown>): unknown
  fixtureCommitDelivery(input: Record<string, unknown>): unknown
}

interface SupportApi {
  createCallContext(deadlineAtMs?: number): unknown
}

interface LoadedRoot {
  dir: string
  label: string
  dialogue: DialogueApi
  fixtures: FixtureApi
  support: SupportApi
}

const benchDir = dirname(fileURLToPath(import.meta.url))
const thisRoot = resolve(benchDir, '../..')
const siblingRoot = resolve(benchDir, `../../../m4-outcome-proposal-20261022`)

function labelFor(rootDir: string): string {
  if (rootDir === thisRoot) return 'repaired (this tree)'
  if (rootDir === siblingRoot) return `pre-repair (sibling ${SIBLING_COMMIT.slice(0, 7)})`
  return rootDir
}

async function loadRoot(rootDir: string): Promise<LoadedRoot> {
  const dialogue = (await import(
    pathToFileURL(resolve(rootDir, 'src/dialogue/index.ts')).href
  )) as DialogueApi
  const fixtures = (await import(
    pathToFileURL(resolve(rootDir, 'test/support/fixture-data.ts')).href
  )) as FixtureApi
  const support = (await import(
    pathToFileURL(resolve(rootDir, 'test/support/context.ts')).href
  )) as SupportApi
  return { dir: rootDir, label: labelFor(rootDir), dialogue, fixtures, support }
}

/** Controlled statements: two clauses each, unique tokens per index. */
function controlledStatements(count: number): StatementInput[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: { kind: 'turn', sessionId: 'bench-session', turnId: `turn-${index}` },
    text: `alpha${index} beta${index}。gamma${index} delta${index}`,
  }))
}

/**
 * Reduce either scan result shape to the same summary. Old code returns
 * `readonly Contradiction[]`; new code returns a structured result. Fields the
 * old shape does not carry stay null and print as `n/a`.
 */
function describeScan(result: unknown): ScanOutcome {
  if (Array.isArray(result)) {
    return {
      findings: result.length,
      comparisons: null,
      incomplete: null,
      statementsExamined: null,
      statementsOffered: null,
    }
  }
  const shaped = result as {
    findings?: readonly unknown[]
    comparisons?: number
    incomplete?: boolean
    statementsExamined?: number
    statementsOffered?: number
  }
  return {
    findings: shaped.findings?.length ?? 0,
    comparisons: typeof shaped.comparisons === 'number' ? shaped.comparisons : null,
    incomplete: typeof shaped.incomplete === 'boolean' ? shaped.incomplete : null,
    statementsExamined:
      typeof shaped.statementsExamined === 'number' ? shaped.statementsExamined : null,
    statementsOffered:
      typeof shaped.statementsOffered === 'number' ? shaped.statementsOffered : null,
  }
}

const show = (value: number | boolean | null): string => (value === null ? 'n/a' : String(value))

interface Timing {
  workMs: number
  timerDelayMs: number
}

/**
 * Run synchronous work with a zero-delay timer already scheduled. The timer
 * delay is the event-loop block the work imposes; a demonstration, not a
 * real-time measurement.
 */
async function measureWithTimer(work: () => void): Promise<Timing> {
  const startedAt = performance.now()
  let workMs = 0
  await new Promise<void>((resolveTimer) => {
    setTimeout(resolveTimer, 0)
    const workStartedAt = performance.now()
    work()
    workMs = performance.now() - workStartedAt
  })
  return { workMs, timerDelayMs: performance.now() - startedAt }
}

interface AssemblyResult extends Timing {
  view: ViewLike
}

/**
 * One real assembly through the root's own store and port. It commits the
 * requested history, then asserts that history was really read and admitted -
 * both by the store and by the scan - so an empty-context measurement fails
 * instead of quietly timing nothing.
 */
async function measureAssembly(root: LoadedRoot, turns: number): Promise<AssemblyResult> {
  const sessionId = root.fixtures.FIXTURE_SESSION_ID
  const memory = root.dialogue.createDeliveryMemoryStore()
  for (let index = 0; index < turns; index += 1) {
    await memory.commit(
      root.fixtures.fixtureCommitDelivery({
        sessionId,
        turnId: `turn-${index}`,
        segmentId: `turn-${index}-seg-0`,
        textHash: `${root.label}-hash-${index}`,
        text: `alpha${index} beta${index}。gamma${index} delta${index}`,
      }),
    )
  }

  const confirmed = await memory.confirmedHistory(sessionId)
  if (confirmed.length !== turns) {
    throw new Error(
      `${root.label}: committed ${turns} turns but confirmedHistory returned ${confirmed.length}`,
    )
  }

  const capture: { view: ViewLike | null } = { view: null }
  const port = root.dialogue.createDialoguePort({
    clock: { nowMs: () => 1_000 },
    history: memory,
    textSource: {
      model: 'bench-source',
      modelVersion: 'bench-v1',
      resolvedModel: null,
      async compose(view: ViewLike) {
        capture.view = view
        return ['Bench reply.']
      },
    },
  })

  const startedAt = performance.now()
  let timerAt = 0
  const timerPromise = new Promise<void>((resolveTimer) => {
    setTimeout(() => {
      timerAt = performance.now()
      resolveTimer()
    }, 0)
  })
  await port.generate(
    root.fixtures.fixtureDialogueRequest({ contextLimits: { maxTurns: 8, maxCharacters: 64 } }),
    root.support.createCallContext(),
    { segment: async () => {} },
  )
  const workMs = performance.now() - startedAt
  await timerPromise

  if (capture.view === null) throw new Error(`${root.label}: assembly produced no view`)
  const view = capture.view
  if (view.turns.length === 0) {
    throw new Error(`${root.label}: assembly admitted no history (${turns} committed)`)
  }
  const offered = view.consistencyAudit?.statementsOffered
  if (typeof offered === 'number' && offered < turns) {
    throw new Error(
      `${root.label}: audit offered ${offered} statements for ${turns} committed turns`,
    )
  }
  return { workMs, timerDelayMs: timerAt - startedAt, view }
}

function report(view: ViewLike): string {
  const audit = view.consistencyAudit
  const incomplete = audit && typeof audit.incomplete === 'boolean' ? String(audit.incomplete) : 'n/a'
  return [view.turns.length, view.estimatedCharacters ?? 'n/a', incomplete].join('\t')
}

async function runRoot(root: LoadedRoot): Promise<void> {
  console.log(`\n== ${root.label} ==`)
  console.log(root.dir)

  console.log('\ndirect scan, controlled statements (two clauses each)')
  console.log(
    'size\tscan ms\ttimer ms\tfindings\tcomparisons\tincomplete\texamined\toffered',
  )
  for (const size of SIZES) {
    const statements = controlledStatements(size)
    const captured: { result: unknown } = { result: null }
    const timing = await measureWithTimer(() => {
      captured.result = root.dialogue.scanContradictions({ statements })
    })
    if (captured.result === null) throw new Error(`${root.label}: scan did not run`)
    const scan = describeScan(captured.result)
    console.log(
      [
        size,
        timing.workMs.toFixed(1),
        timing.timerDelayMs.toFixed(1),
        scan.findings,
        show(scan.comparisons),
        show(scan.incomplete),
        show(scan.statementsExamined),
        show(scan.statementsOffered),
      ].join('\t'),
    )
  }

  console.log('\ndirect scan, single long word (negation-regex regression)')
  console.log('chars\tscan ms\ttimer ms\tfindings\texamined')
  for (const chars of LONG_WORD_SIZES) {
    const statements: StatementInput[] = [
      { ref: { kind: 'persona-fact', factIndex: 0 }, text: 'x'.repeat(chars) },
    ]
    const captured: { result: unknown } = { result: null }
    const timing = await measureWithTimer(() => {
      captured.result = root.dialogue.scanContradictions({ statements })
    })
    if (captured.result === null) throw new Error(`${root.label}: long-word scan did not run`)
    const scan = describeScan(captured.result)
    console.log(
      [
        chars,
        timing.workMs.toFixed(1),
        timing.timerDelayMs.toFixed(1),
        scan.findings,
        show(scan.statementsExamined),
      ].join('\t'),
    )
  }

  console.log('\ndialogue assembly through the real store and port, 64-character budget')
  console.log('turns\tassembly ms\ttimer ms\tkept turns\testimated chars\taudit incomplete')
  for (const size of SIZES) {
    const { workMs, timerDelayMs, view } = await measureAssembly(root, size)
    console.log([size, workMs.toFixed(1), timerDelayMs.toFixed(1), report(view)].join('\t'))
  }
}

const requested = process.argv.slice(2).map((value) => resolve(value))
const rootDirs = requested.length > 0 ? requested : [thisRoot, siblingRoot]

for (const rootDir of rootDirs) {
  if (!existsSync(resolve(rootDir, 'src/dialogue/index.ts'))) {
    console.log(`\n[skip] ${rootDir}: no src/dialogue/index.ts`)
    continue
  }
  await runRoot(await loadRoot(rootDir))
}
