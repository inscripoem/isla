/**
 * TEST-SUPPORT evaluation harness — not a product deployment.
 *
 * `evaluation:run` deliberately does not import the runtime composition; it
 * loads a harness module instead. This is the smallest harness that makes a
 * reproducible pilot possible from the repository:
 *
 *  - real M4 OpenAI-compatible text source (configuration from ISLA_LIVE_TEXT_*),
 *  - real M3 rule selection and reaction,
 *  - M6 SQLite store and history reader,
 *  - fixture synthesis and renderer, and a controlled consumer, because the M1
 *    acoustic path and the M2 console are not part of this harness.
 *
 * Consequences, stated rather than hidden:
 *  - `synthesisMs`, `firstAudibleMs` and `stopToSilenceMs` are not measurements
 *    here; the run records them as null and the report renders "—".
 *  - the consumer is the controlled test kit, so delivery receipts prove the
 *    pipeline, not the product console.
 *  - the provenance companion is absent: the adapter does not expose the
 *    prepared-input identity (M5 #101), so every attempt is unscored.
 *
 * The text configuration is read from the same variable names as the live M4
 * suite, and a missing value is an error naming the variable, never a fallback.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuleReactionPort } from '../../src/decision/reaction'
import { createRuleSelectionPort } from '../../src/decision/selection'
import { createOpenAiCompatibleTextSource } from '../../src/dialogue/provider-text-source'
import type { Variant } from '../../src/evaluation/comparison'
import type {
  EvaluationHarness,
  EvaluationHarnessContext,
} from '../../src/evaluation/run-command'
import { createMonotonicClock } from '../../src/runtime/clock'
import { createEvaluationAdapter } from '../../src/runtime/evaluation-adapter'
import type { ProductionPeers } from '../../src/runtime/production'
import { createEventStore } from '../../src/storage/event-store'
import { createHistoryQuery } from '../../src/storage/history-query'
import { createSqliteBackend, migrate, openDatabase } from '../../src/storage/sqlite'
import { createFixtureRendererPort, createFixtureSynthesisPort } from './correct-ports'
import { createControlledConsumer } from './evaluation-consumer'
import { createControlledMediaDriver, createControlledResolver } from './m1-kit'

const VARIANT: Variant = { id: 'reference-text', kind: 'model', combined: false }

const TEXT_ENV = {
  baseUrl: 'ISLA_LIVE_TEXT_BASE_URL',
  model: 'ISLA_LIVE_TEXT_MODEL',
  apiKey: 'ISLA_LIVE_TEXT_API_KEY',
} as const

function required(env: EvaluationHarnessContext['env'], name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`evaluation-harness-reference: ${name} is required and has no fallback`)
  }
  return value
}

export default function createReferenceTextHarness(
  context: EvaluationHarnessContext,
): EvaluationHarness {
  const text = {
    baseUrl: required(context.env, TEXT_ENV.baseUrl),
    model: required(context.env, TEXT_ENV.model),
    apiKey: required(context.env, TEXT_ENV.apiKey),
  }

  const dir = context.env.ISLA_EVALUATION_DIR ?? mkdtempSync(join(tmpdir(), 'isla-reference-harness-'))
  const dbPath = join(dir, 'evaluation.db')
  const database = openDatabase(dbPath)
  migrate(database, { dbPath, backupDir: join(dir, 'backups') })
  const backend = createSqliteBackend(database)

  const clock = createMonotonicClock()
  const peers: ProductionPeers = {
    selection: createRuleSelectionPort({ clock }),
    reaction: createRuleReactionPort({ clock }),
    textSource: createOpenAiCompatibleTextSource(text),
    createRenderer: () => createFixtureRendererPort(),
    createSynthesis: () => createFixtureSynthesisPort(),
    // The registered product persona, not a harness-only identity.
    profile: { characterProfileId: 'Elleya', characterProfileVersion: '2' },
  }

  const resolver = createControlledResolver()
  resolver.setAutoResolve()
  const consumer = createControlledConsumer({
    media: createControlledMediaDriver({ autoEvents: true }),
    resolver,
    receiptPrefix: 'pilot',
  })

  const adapter = createEvaluationAdapter({
    store: createEventStore(backend),
    history: createHistoryQuery(backend),
    variants: [{ variant: VARIANT, peers }],
    consumer,
    clock,
  })

  process.stderr.write(`evaluation-harness-reference: store ${dbPath}\n`)

  return {
    variants: [VARIANT],
    runVariant: (variant, evalCase) => adapter.runVariant(variant, evalCase),
    async close() {
      try {
        consumer.detach()
      } catch {
        // Best-effort: the attempt's record is already settled.
      }
      database.close()
    },
  }
}
