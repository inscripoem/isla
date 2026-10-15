/**
 * M1-02 Kokoro live smoke over the pinned, cached model.
 *
 * Two explicit modes:
 *
 *  - default (`worker`): one persistent Node worker runs the real CPU inference,
 *    so the host event loop keeps serving timers and cancellation while the
 *    physical generation is pending;
 *  - `--main-thread`: the historical in-process diagnostic baseline, which is
 *    expected to show the SDK Promise blocking the main thread.
 *
 * Both modes run without network access (`allowRemoteModels=false`,
 * `local_files_only=true`), verify the pinned q8 binary by size and SHA-256, and
 * report:
 *
 *  1. an API-only, no-weights boundary probe over the two fixed measured
 *     fixtures (`512` and `513` full ids from the private
 *     `actual-boundary-fixtures.json`) using real `KokoroTTS` phonemization and
 *     the real cached tokenizer with an apply-trapped probe model;
 *  2. real-model CPU cold/warm inference plus the accepted 512-token inference
 *     through one long-lived provider, and the 513-token refusal;
 *  3. a real periodic-timer/AbortController observation during inference;
 *  4. one retained synthesis adapter used for a short accepted WAV and a real
 *     logical-cancellation sequence whose physical settlement is observed
 *     separately.
 *
 * The report is printed before any acceptance gate fails. The predicates are
 * hard gates on the observed facts, not advisory fields. The exact 512/513
 * crossing is now checked at runtime from the fixed fixtures, but no actual
 * weight loading or live run is claimed here. The worker has no model spy, so
 * every model-call-zero claim is explicitly API-only; worker model counters are
 * `null`.
 *
 * It makes no acoustic, physical-silence or product claim, and does not verify
 * or download a model. Run (after kokoro-setup.ts):
 *   pnpm exec tsx test/live/kokoro-smoke.ts
 *   pnpm exec tsx test/live/kokoro-smoke.ts --main-thread
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClockPort, PreparePerformance } from '../../src/contracts'
import type { DeadlineGate } from '../../src/performance/browser/types'
import { createAudioResourceRegistry } from '../../src/performance/audio-resources'
import { createKokoroSynthesis } from '../../src/performance/kokoro-synthesis'
import { createGuardedTokenizer } from '../../src/performance/kokoro-guard'
import type { KokoroProvider, KokoroProviderInput } from '../../src/performance/kokoro-types'
import {
  createKokoroProvider,
  createRealKokoroSdkLoader,
  type KokoroProviderConfig,
  type KokoroSdkLoader,
  type KokoroTtsLike,
} from '../../src/performance/kokoro-provider'
import { createKokoroWorkerProvider } from '../../src/performance/kokoro-worker-provider'
import { decodeMonoFloat32Wav } from '../support/m1-kokoro-kit'
import { measureTimerCallbacks, type TimerCallbackSample } from '../support/m1-kokoro-timing'
import {
  AUDIO_DIR,
  EXPECTED_Q8_BYTES,
  EXPECTED_Q8_SHA256,
  KOKORO_CACHE_DIR,
  KOKORO_LOCAL_FALLBACK_ROOT,
  MAX_TOKENS,
  REPO_ID,
  REVISION,
  SPEED,
  VOICE_ID,
  displayPath,
  q8OnnxPath,
} from './kokoro-live-config'

type SmokeMode = 'worker' | 'main-thread'

const MODE: SmokeMode = process.argv.includes('--main-thread') ? 'main-thread' : 'worker'

const SHORT_TEXT_A = 'Hello, this is a short local Kokoro smoke test.'
const SHORT_TEXT_B = 'The second short sentence checks warm inference.'
const PROBE_SENTINEL = 'm1-kokoro-smoke-probe-sentinel'

/**
 * The two fixed measured fixtures from the private
 * `actual-boundary-fixtures.json` (real phonemization + real cached tokenizer,
 * no weights). The expected full-id counts and text hashes are provenance facts
 * verified at runtime.
 */
const BOUNDARY_BASE = 'The quick brown fox jumps over the lazy dog. '
const EXACT_512_TEXT = `${BOUNDARY_BASE.repeat(9)}We can have a good day.`
const EXACT_513_TEXT = `${BOUNDARY_BASE.repeat(9)}The sky is bright blue.`
const EXACT_512_TEXT_SHA256 = '4bacdfa314b473494bf340382cea9e9d4cdbc1d323c586e14acd2892b209214c'
const EXACT_513_TEXT_SHA256 = 'eef34681683787cd6fdae7e77ffaa25a3ed7934abcd7bf17734e05fbd2ca6bfa'

/** Local development-smoke event-loop thresholds; not a production SLA. */
const MAX_WORKER_TIMER_LAG_MS = 250
const MAX_WORKER_ABORT_MS = 250

const BOUNDARY_PROFILE = {
  voiceProfileId: 'voice-smoke',
  voiceProfileVersion: '1',
  providerVoiceId: VOICE_ID,
  speed: SPEED,
} as const

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The shared monotonic smoke clock. */
function localClock(): ClockPort {
  return { nowMs: () => performance.now() }
}

/** Minimal local deadline gate for the smoke only (M5 owns production). */
function localDeadlineGate(): DeadlineGate {
  return {
    bind(context) {
      const controller = new AbortController()
      const onAbort = (): void => {
        if (!controller.signal.aborted) controller.abort()
      }
      if (context.signal.aborted) controller.abort()
      else context.signal.addEventListener('abort', onAbort, { once: true })
      return {
        signal: controller.signal,
        release() {
          context.signal.removeEventListener('abort', onAbort)
        },
      }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

/** Extract the single-batch sequence length from a model input, defensively. */
function tensorLength(value: unknown, depth = 0): number | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null
  if (ArrayBuffer.isView(value)) return null
  const dims = (value as { dims?: unknown }).dims
  if (Array.isArray(dims) && dims.length === 2 && typeof dims[1] === 'number') {
    return dims[1] as number
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key === 'data' || key === 'then') continue
    const found = tensorLength(record[key], depth + 1)
    if (found !== null) return found
  }
  return null
}

interface ProbeModel {
  readonly model: object
  calls(): number
  lastIdsLength(): number | null
}

/**
 * A model stand-in that records the actual full `input_ids` length from its
 * first invocation and then throws a recognized sentinel. It apply-traps the
 * callable model and also traps method calls, so the real `KokoroTTS` model
 * boundary is observed without loading weights or running inference.
 */
function createProbeModel(): ProbeModel {
  let calls = 0
  let lastLength: number | null = null
  const record = (args: readonly unknown[]): never => {
    calls += 1
    for (const arg of args) {
      const length = tensorLength(arg)
      if (length !== null) {
        lastLength = length
        break
      }
    }
    throw new Error(PROBE_SENTINEL)
  }
  const target = function probeModelTarget(...args: unknown[]): void {
    record(args)
  }
  const probeTarget = target as unknown as {
    generate?: (...args: unknown[]) => never
    _call?: (...args: unknown[]) => never
  }
  probeTarget.generate = (...args: unknown[]): never => record(args)
  probeTarget._call = (...args: unknown[]): never => record(args)
  const handler: ProxyHandler<object> = {
    apply(_inner, _thisArg, args) {
      return record(args as readonly unknown[])
    },
    get(inner, property) {
      const value = Reflect.get(inner, property, inner)
      if (typeof value === 'function') {
        return (...args: unknown[]): never => record(args)
      }
      return value
    },
  }
  return {
    model: new Proxy(target as unknown as object, handler),
    calls: () => calls,
    lastIdsLength: () => lastLength,
  }
}

type ProbeOutcome =
  | { readonly kind: 'recorded'; readonly length: number }
  | { readonly kind: 'too_long' }
  | { readonly kind: 'no_sentinel' }
  | { readonly kind: 'error'; readonly message: string }

async function runProbe(tts: KokoroTtsLike, text: string, probe: ProbeModel): Promise<ProbeOutcome> {
  try {
    await tts.generate(text, { voice: VOICE_ID, speed: SPEED })
    return { kind: 'no_sentinel' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(PROBE_SENTINEL)) {
      const length = probe.lastIdsLength()
      return length === null
        ? { kind: 'error', message: 'sentinel was thrown without a recorded input length' }
        : { kind: 'recorded', length }
    }
    if ((error as { code?: unknown }).code === 'input_too_long') return { kind: 'too_long' }
    return { kind: 'error', message }
  }
}

/**
 * A real loader whose model is apply-trapped to count both a direct callable
 * invocation and any method invocation. Used only in the main-thread diagnostic
 * to observe real model occupancy; worker mode has no such hook because the
 * model lives inside the worker.
 */
function createCountingLoader(): { loader: KokoroSdkLoader; calls: () => number } {
  const real = createRealKokoroSdkLoader()
  let modelCalls = 0
  const wrapModel = (model: unknown): object =>
    new Proxy(model as object, {
      apply(target, thisArg, args) {
        modelCalls += 1
        return Reflect.apply(target as (...inner: unknown[]) => unknown, thisArg, args)
      },
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            modelCalls += 1
            return Reflect.apply(value as (...inner: unknown[]) => unknown, target, args)
          }
        }
        return value
      },
    })
  const loader: KokoroSdkLoader = {
    configureEnvironment: (config) => real.configureEnvironment(config),
    loadTokenizer: (config) => real.loadTokenizer(config),
    ensureVoice: (voiceId) => real.ensureVoice(voiceId),
    async loadModel(config) {
      return wrapModel(await real.loadModel(config))
    },
    createTts: (model, tokenizer) => real.createTts(model, tokenizer),
  }
  return { loader, calls: () => modelCalls }
}

interface TrackedProvider {
  readonly provider: KokoroProvider
  inFlight(): number
  maxInFlight(): number
}

/** Smoke-only instrumentation: observe real physical generation occupancy. */
function createTrackedProvider(provider: KokoroProvider): TrackedProvider {
  let inFlight = 0
  let maxInFlight = 0
  return {
    provider: {
      generate(input: KokoroProviderInput) {
        inFlight += 1
        if (inFlight > maxInFlight) maxInFlight = inFlight
        const settle = (): void => {
          inFlight -= 1
        }
        return provider.generate(input).then(
          (audio) => {
            settle()
            return audio
          },
          (error) => {
            settle()
            throw error
          },
        )
      },
    },
    inFlight: () => inFlight,
    maxInFlight: () => maxInFlight,
  }
}

interface ProviderSession {
  readonly mode: SmokeMode
  readonly provider: KokoroProvider
  readonly initMs: number
  /** Real model-call counter; only the main-thread diagnostic can observe it. */
  readonly modelCalls: (() => number) | null
  close(): Promise<void>
}

async function createProviderSession(config: KokoroProviderConfig): Promise<ProviderSession> {
  if (MODE === 'worker') {
    const start = performance.now()
    const handle = await createKokoroWorkerProvider(config)
    return {
      mode: 'worker',
      provider: handle.provider,
      initMs: performance.now() - start,
      modelCalls: null,
      close: () => handle.close(),
    }
  }
  const { loader, calls } = createCountingLoader()
  const start = performance.now()
  const provider = await createKokoroProvider(config, loader)
  return {
    mode: 'main-thread',
    provider,
    initMs: performance.now() - start,
    modelCalls: calls,
    close: async () => {},
  }
}

function makeRequest(overrides: {
  requestId: string
  segmentId: string
  text: string
  deadlineAtMs: number
}): PreparePerformance {
  return {
    requestId: overrides.requestId,
    sessionId: 'smoke-session',
    epoch: 1,
    turnId: 'smoke-turn',
    segmentId: overrides.segmentId,
    text: overrides.text,
    voiceProfileId: BOUNDARY_PROFILE.voiceProfileId,
    voiceProfileVersion: BOUNDARY_PROFILE.voiceProfileVersion,
    deadline: { atMs: overrides.deadlineAtMs },
  }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    step: 'kokoro-smoke',
    mode: MODE,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    repoId: REPO_ID,
    revision: REVISION,
    voiceId: VOICE_ID,
    speed: SPEED,
    maxTokens: MAX_TOKENS,
  }
  const failures: string[] = []
  const gate = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures.push(`${name}: ${detail}`)
  }

  // Fail honestly before any load when the pinned cache is absent.
  const onnxPath = q8OnnxPath()
  if (!existsSync(onnxPath)) {
    throw new Error(
      `m1-kokoro-smoke: missing cached q8 model at ${displayPath(onnxPath)}; run kokoro-setup.ts first`,
    )
  }
  const onnxBytes = statSync(onnxPath).size
  const onnxSha = sha256File(onnxPath)
  if (onnxBytes !== EXPECTED_Q8_BYTES || onnxSha !== EXPECTED_Q8_SHA256) {
    throw new Error('m1-kokoro-smoke: cached q8 model does not match the advertised size/SHA-256')
  }
  report.modelOnnx = { path: displayPath(onnxPath), bytes: onnxBytes, sha256: onnxSha }

  const config: KokoroProviderConfig = {
    modelRoot: REPO_ID,
    revision: REVISION,
    maxTokens: MAX_TOKENS,
    voiceId: VOICE_ID,
    speed: SPEED,
    environment: { localModelPath: KOKORO_LOCAL_FALLBACK_ROOT, cacheDir: KOKORO_CACHE_DIR },
  }

  let session: ProviderSession | null = null
  try {
    // 1. API-only, no-weights boundary measurement over the two fixed measured
    //    fixtures. The unrestricted tokenizer + probe model records the real
    //    full id count for each; the guarded tokenizer then accepts 512 and
    //    refuses 513 before the model. No weights are loaded.
    const apiLoader = createRealKokoroSdkLoader()
    await apiLoader.configureEnvironment(config)
    const rawTokenizer = await apiLoader.loadTokenizer(config)

    const noRefusalTokenizer = createGuardedTokenizer(rawTokenizer, 1_000_000)
    const measureProbe = createProbeModel()
    const measureTts = apiLoader.createTts(measureProbe.model, noRefusalTokenizer)
    const outcome512 = await runProbe(measureTts, EXACT_512_TEXT, measureProbe)
    const outcome513 = await runProbe(measureTts, EXACT_513_TEXT, measureProbe)

    const guardedTokenizer = createGuardedTokenizer(rawTokenizer, MAX_TOKENS)
    const guardProbe = createProbeModel()
    const guardedTts = apiLoader.createTts(guardProbe.model, guardedTokenizer)
    const callsBefore512 = guardProbe.calls()
    const guarded512 = await runProbe(guardedTts, EXACT_512_TEXT, guardProbe)
    const callsAfter512 = guardProbe.calls()
    const callsBefore513 = guardProbe.calls()
    const guarded513 = await runProbe(guardedTts, EXACT_513_TEXT, guardProbe)
    const callsAfter513 = guardProbe.calls()

    const text512Sha = createHash('sha256').update(EXACT_512_TEXT, 'utf8').digest('hex')
    const text513Sha = createHash('sha256').update(EXACT_513_TEXT, 'utf8').digest('hex')
    const fullLength512 = outcome512.kind === 'recorded' ? outcome512.length : null
    const fullLength513 = outcome513.kind === 'recorded' ? outcome513.length : null
    const guarded512Length = guarded512.kind === 'recorded' ? guarded512.length : null
    const guarded512PositiveModelCalls = callsAfter512 - callsBefore512
    const guarded513ModelCallDelta = callsAfter513 - callsBefore513
    const exactBoundaryVerified = fullLength512 === MAX_TOKENS && fullLength513 === MAX_TOKENS + 1

    report.apiProbe = {
      method:
        'fixed measured fixtures; real KokoroTTS phonemize -> real cached tokenizer with a probe model that records the full ids then throws a sentinel; no weights',
      fixture512TextSha256: text512Sha,
      fixture513TextSha256: text513Sha,
      fullLength512,
      fullLength513,
      exactBoundaryVerified,
      guarded512Length,
      guarded512ReachedModel: guarded512PositiveModelCalls >= 1,
      guarded513Refused: guarded513.kind === 'too_long' && guarded513ModelCallDelta === 0,
      guarded513ModelCallDelta,
      positiveModelCalls: guarded512PositiveModelCalls,
      modelCallEvidenceScope: 'api-only (no weights); worker provides no model spy and worker model counters are null',
    }
    gate('api.fixture512TextSha', text512Sha === EXACT_512_TEXT_SHA256, text512Sha)
    gate('api.fixture513TextSha', text513Sha === EXACT_513_TEXT_SHA256, text513Sha)
    gate('api.exact512', fullLength512 === 512, `fullLength=${fullLength512}`)
    gate('api.exact513', fullLength513 === 513, `fullLength=${fullLength513}`)
    gate('api.exactBoundaryVerified', exactBoundaryVerified, `512=${fullLength512} 513=${fullLength513}`)
    gate(
      'api.guarded512ReachedModel',
      guarded512Length === 512 && guarded512PositiveModelCalls >= 1,
      `length=${guarded512Length} calls=${guarded512PositiveModelCalls}`,
    )
    gate(
      'api.guarded513RefusedZeroModelCalls',
      guarded513.kind === 'too_long' && guarded513ModelCallDelta === 0,
      JSON.stringify(guarded513),
    )
    gate('api.positiveModelControl', guarded512PositiveModelCalls >= 1, `calls=${guarded512PositiveModelCalls}`)

    // 2. One real provider: the persistent worker by default, or the main-thread
    //    diagnostic when explicitly requested.
    session = await createProviderSession(config)
    const tracked = createTrackedProvider(session.provider)
    report.provider = { mode: session.mode, initMs: round(session.initMs) }

    // 2a. Positive control with a real main-thread timer and AbortController,
    //     tracked while the physical generation is still pending. The
    //     responsiveness statistic is the individual per-callback delay; the
    //     cumulative cadence drift is advisory only (some platforms fire a
    //     nominal interval slower than requested without ever blocking).
    const requestedIntervalMs = 10
    const samples: TimerCallbackSample[] = []
    const controller = new AbortController()
    let abortObserved: number | null = null
    const probeStart = performance.now()
    const onAbort = (): void => {
      abortObserved = performance.now() - probeStart
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    let coldInFlight = false
    const timer = setInterval(() => {
      samples.push({ offsetMs: performance.now() - probeStart, pending: coldInFlight })
    }, requestedIntervalMs)
    const abortTimer = setTimeout(() => controller.abort(), 5)

    coldInFlight = true
    const coldStart = performance.now()
    const coldAudio = await tracked.provider.generate({ text: SHORT_TEXT_A, voiceId: VOICE_ID, speed: SPEED })
    const coldEnd = performance.now()
    coldInFlight = false
    await new Promise((resolve) => setTimeout(resolve, 30))
    clearInterval(timer)
    clearTimeout(abortTimer)
    controller.signal.removeEventListener('abort', onAbort)

    const timerMeasurement = measureTimerCallbacks(samples, requestedIntervalMs)
    report.coldInference = {
      ms: round(coldEnd - coldStart),
      samples: coldAudio.samples.length,
      sampleRate: coldAudio.sampleRate,
      durationMs: round((coldAudio.samples.length / coldAudio.sampleRate) * 1000),
    }
    report.mainThread = {
      requestedIntervalMs,
      timerCallbacksObserved: timerMeasurement.callbacks.length,
      timerCallbacksWhileGenerationPending: timerMeasurement.pendingCallbacks,
      maxPendingTimerLagMs: round(timerMeasurement.maxPendingDelayMs),
      maxTimerLagMs: round(timerMeasurement.maxDelayMs),
      maxCumulativeCadenceDriftMs: round(timerMeasurement.maxCumulativeDriftMs),
      metricDefinition:
        'per-callback delay = max(0, actualOffsetMs - previousActualOffsetMs - requestedIntervalMs); cumulative cadence drift is advisory and separately named',
      callbacks: timerMeasurement.callbacks,
      abortScheduledMs: 5,
      abortObservedMs: abortObserved === null ? null : round(abortObserved as number),
      abortSignalObserved: controller.signal.aborted,
      responsivenessGated: session.mode === 'worker',
      thresholdNote:
        'worker-mode development-smoke thresholds (maxPendingTimerLagMs<=250, abortObservedMs<=250) are local to this smoke, not a production SLA; the gate is on the individual pending callback delay, not cumulative drift',
      note:
        session.mode === 'worker'
          ? 'inference runs in the persistent worker; main-thread timers and abort continue while the physical job is pending'
          : 'main-thread diagnostic baseline: the SDK Promise blocks the main thread, so the observed timer lag is the recorded baseline rather than a probe failure (responsiveness gates skipped)',
    }
    gate('cold.samples', coldAudio.samples.length > 0, `samples=${coldAudio.samples.length}`)
    gate('cold.sampleRate', coldAudio.sampleRate === 24000, `sampleRate=${coldAudio.sampleRate}`)
    if (session.mode === 'worker') {
      gate(
        'worker.timerWhilePending',
        timerMeasurement.pendingCallbacks >= 1,
        `pendingCallbacks=${timerMeasurement.pendingCallbacks}`,
      )
      gate(
        'worker.maxPendingTimerLag',
        timerMeasurement.maxPendingDelayMs <= MAX_WORKER_TIMER_LAG_MS,
        `maxPendingTimerLagMs=${round(timerMeasurement.maxPendingDelayMs)}`,
      )
      gate(
        'worker.abortResponse',
        abortObserved !== null && (abortObserved as number) <= MAX_WORKER_ABORT_MS,
        `abortObservedMs=${abortObserved === null ? 'null' : round(abortObserved as number)}`,
      )
    }

    if (session.modelCalls !== null) {
      report.positiveModelControl = session.modelCalls()
    }

    // 2b. Warm inference.
    const warmStart = performance.now()
    const warmAudio = await tracked.provider.generate({ text: SHORT_TEXT_B, voiceId: VOICE_ID, speed: SPEED })
    report.warmInference = {
      ms: round(performance.now() - warmStart),
      samples: warmAudio.samples.length,
      sampleRate: warmAudio.sampleRate,
    }
    gate('warm.samples', warmAudio.samples.length > 0, `samples=${warmAudio.samples.length}`)

    // 2c. Accepted 512-token inference through the real provider. This audio is
    //     intentionally not written to the browser WAV fixture.
    const callsBefore512Inference = session.modelCalls === null ? null : session.modelCalls()
    const start512 = performance.now()
    const audio512 = await tracked.provider.generate({ text: EXACT_512_TEXT, voiceId: VOICE_ID, speed: SPEED })
    const callsAfter512Inference = session.modelCalls === null ? null : session.modelCalls()
    report.actual512Inference = {
      ms: round(performance.now() - start512),
      samples: audio512.samples.length,
      sampleRate: audio512.sampleRate,
      durationMs: round((audio512.samples.length / audio512.sampleRate) * 1000),
      modelCallsDuring:
        callsBefore512Inference === null || callsAfter512Inference === null
          ? null
          : callsAfter512Inference - callsBefore512Inference,
      note: 'real 512-token provider inference; the browser WAV fixture remains the short 3.65s output',
    }
    gate('actual512.samples', audio512.samples.length > 0, `samples=${audio512.samples.length}`)
    gate('actual512.sampleRate', audio512.sampleRate === 24000, `sampleRate=${audio512.sampleRate}`)
    gate('actual512.duration', audio512.samples.length / audio512.sampleRate > 0, 'nonpositive duration')

    // 2d. 513-token refusal. In the main-thread diagnostic the apply-trapped
    //     loader additionally proves zero model calls; worker mode relies on the
    //     API-probe zero-call evidence (no worker model spy).
    const callsBeforeOver = session.modelCalls === null ? null : session.modelCalls()
    let overLimitRefused = false
    try {
      await tracked.provider.generate({ text: EXACT_513_TEXT, voiceId: VOICE_ID, speed: SPEED })
    } catch (error) {
      overLimitRefused = (error as { code?: unknown }).code === 'input_too_long'
    }
    const callsAfterOver = session.modelCalls === null ? null : session.modelCalls()
    report.overLimit = {
      refused: overLimitRefused,
      modelCallsBefore: callsBeforeOver,
      modelCallsAfter: callsAfterOver,
      modelCallsDuring: callsBeforeOver === null || callsAfterOver === null ? null : callsAfterOver - callsBeforeOver,
      modelCallEvidenceScope: session.modelCalls === null ? 'api-only (worker has no model spy)' : 'main-thread counting loader',
    }
    gate('overLimit.refused', overLimitRefused, 'input_too_long was not observed')
    if (callsBeforeOver !== null && callsAfterOver !== null) {
      gate('overLimit.zeroModelCalls', callsAfterOver === callsBeforeOver, `delta=${callsAfterOver - callsBeforeOver}`)
    }

    // 3. One retained provider + synthesis adapter for the short WAV and cancellation.
    const clock = localClock()
    const gateKeeper = localDeadlineGate()
    const registry = createAudioResourceRegistry({ clock, byteBudget: 50_000_000, retentionMs: 600_000 })
    const synthesis = createKokoroSynthesis({
      provider: tracked.provider,
      profiles: [BOUNDARY_PROFILE],
      registry,
      clock,
      deadlineGate: gateKeeper,
    })

    // 3a. One accepted prepare through the real adapter -> short WAV on disk.
    const wavRequest = makeRequest({
      requestId: 'smoke-wav',
      segmentId: 'smoke-wav-seg',
      text: SHORT_TEXT_A,
      deadlineAtMs: clock.nowMs() + 120_000,
    })
    const prepared = await synthesis.prepare(wavRequest, {
      signal: new AbortController().signal,
      deadline: { atMs: wavRequest.deadline.atMs },
    })
    gate('wav.prepared', prepared.ok, prepared.ok ? 'ok' : prepared.reasonCode)
    if (prepared.ok) {
      const lease = await registry.resolve(prepared.audioRef, new AbortController().signal)
      const bytes = new Uint8Array(await lease.blob.arrayBuffer())
      lease.release()
      registry.retire(prepared.audioRef)
      mkdirSync(AUDIO_DIR, { recursive: true })
      const wavPath = join(AUDIO_DIR, 'kokoro-smoke.wav')
      writeFileSync(wavPath, bytes)
      const decoded = decodeMonoFloat32Wav(bytes)
      const durationFromHeader = (decoded.frameCount / decoded.sampleRateHz) * 1000
      const wavConsistent =
        decoded.riff === 'RIFF' &&
        decoded.wave === 'WAVE' &&
        decoded.audioFormat === 3 &&
        decoded.channels === 1 &&
        decoded.bitsPerSample === 32 &&
        decoded.sampleRateHz === 24000 &&
        decoded.dataByteLength === decoded.frameCount * 4 &&
        Math.abs(durationFromHeader - decoded.durationMs) < 1e-6 &&
        Math.abs(decoded.durationMs - (prepared.durationMs ?? -1)) < 1e-3
      report.wav = {
        path: displayPath(wavPath),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        format: prepared.format,
        durationMs: prepared.durationMs,
        decoded: {
          audioFormat: decoded.audioFormat,
          channels: decoded.channels,
          bitsPerSample: decoded.bitsPerSample,
          sampleRateHz: decoded.sampleRateHz,
          dataByteLength: decoded.dataByteLength,
          frameCount: decoded.frameCount,
          durationMs: decoded.durationMs,
        },
        registryUsedBytesAfterRetire: registry.snapshot().usedBytes,
        note: 'short accepted fixture retained for the browser harness; the 512-token audio is not written here',
      }
      gate('wav.headerConsistency', wavConsistent, JSON.stringify(report.wav))
      gate('wav.registryReclaimed', registry.snapshot().usedBytes === 0, `usedBytes=${registry.snapshot().usedBytes}`)
    }

    // 3b. Actual logical cancellation: abort the caller signal mid-generation,
    //     confirm the retained adapter stays busy while the physical job is
    //     pending, then observe physical settlement and reuse.
    const cancelContext = new AbortController()
    const cancelRequest = makeRequest({
      requestId: 'smoke-cancel',
      segmentId: 'smoke-cancel-seg',
      text: SHORT_TEXT_B,
      deadlineAtMs: clock.nowMs() + 120_000,
    })
    const pending = synthesis.prepare(cancelRequest, {
      signal: cancelContext.signal,
      deadline: { atMs: cancelRequest.deadline.atMs },
    })
    const started = await waitFor(() => tracked.inFlight() >= 1, 120_000)
    const inFlightAtAbort = tracked.inFlight()
    cancelContext.abort()
    const cancelled = await pending
    const inFlightAfterLogical = tracked.inFlight()

    const busyProbe = await synthesis.prepare(
      makeRequest({
        requestId: 'smoke-busy',
        segmentId: 'smoke-busy-seg',
        text: SHORT_TEXT_A,
        deadlineAtMs: clock.nowMs() + 120_000,
      }),
      { signal: new AbortController().signal, deadline: { atMs: clock.nowMs() + 120_000 } },
    )

    const settleStart = performance.now()
    const physicalSettled = await waitFor(() => tracked.inFlight() === 0, 120_000)
    const settleMs = performance.now() - settleStart
    const maxPhysicalInFlight = tracked.maxInFlight()
    const registryBytesAfterSettlement = registry.snapshot().usedBytes

    // Reuse only after settlement: a fresh prepare must succeed and reclaim.
    const reuseRequest = makeRequest({
      requestId: 'smoke-reuse',
      segmentId: 'smoke-reuse-seg',
      text: SHORT_TEXT_A,
      deadlineAtMs: clock.nowMs() + 120_000,
    })
    const reusePending = synthesis.prepare(reuseRequest, {
      signal: new AbortController().signal,
      deadline: { atMs: reuseRequest.deadline.atMs },
    })
    const reuseStarted = await waitFor(() => tracked.inFlight() >= 1, 120_000)
    const reused = await reusePending
    if (reused.ok) registry.retire(reused.audioRef)
    const registryBytesAfterReuseRetire = registry.snapshot().usedBytes

    report.logicalCancel = {
      reasonCode: cancelled.ok ? 'ok' : cancelled.reasonCode,
      inFlightAtAbort,
      physicalJobStarted: started,
      inFlightAfterLogicalCancel: inFlightAfterLogical,
      adapterBusyWhilePending: busyProbe.ok === false && busyProbe.reasonCode === 'busy',
      physicalSettled,
      physicalSettlementWaitMs: round(settleMs),
      maxPhysicalInFlight,
      registryUsedBytesAfterSettlement: registryBytesAfterSettlement,
      reusableAfterSettlement: reused.ok && reuseStarted,
      registryUsedBytesAfterReuseRetire: registryBytesAfterReuseRetire,
    }
    gate(
      'cancel.reason',
      cancelled.ok === false && cancelled.reasonCode === 'cancelled_or_expired',
      cancelled.ok ? 'ok' : cancelled.reasonCode,
    )
    gate('cancel.physicalStartedAtAbort', started && inFlightAtAbort >= 1, `started=${started} inFlight=${inFlightAtAbort}`)
    gate('cancel.pendingAfterLogicalReturn', inFlightAfterLogical >= 1, `inFlight=${inFlightAfterLogical}`)
    gate(
      'cancel.adapterBusyWhilePending',
      busyProbe.ok === false && busyProbe.reasonCode === 'busy',
      busyProbe.ok ? 'ok' : busyProbe.reasonCode,
    )
    gate('cancel.maxPhysicalInFlight', maxPhysicalInFlight === 1, `max=${maxPhysicalInFlight}`)
    gate('cancel.physicalSettled', physicalSettled, `settled=${physicalSettled}`)
    gate('cancel.registryZeroAfterSettlement', registryBytesAfterSettlement === 0, `usedBytes=${registryBytesAfterSettlement}`)
    gate('cancel.reusableAfterSettlement', reused.ok && reuseStarted, reused.ok ? 'ok' : reused.reasonCode)
    gate('cancel.registryReclaimedAfterReuse', registryBytesAfterReuseRetire === 0, `usedBytes=${registryBytesAfterReuseRetire}`)
  } finally {
    if (session !== null) {
      const closeStart = performance.now()
      await session.close()
      report.providerCloseMs = round(performance.now() - closeStart)
    }
  }

  report.gates = { pass: failures.length === 0, failures }
  console.log(JSON.stringify(report, null, 2))
  if (failures.length > 0) {
    throw new Error(`m1-kokoro-smoke: ${failures.length} acceptance gate(s) failed: ${failures.join('; ')}`)
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ step: 'kokoro-smoke', ok: false, error: String(error) }))
  process.exitCode = 1
})
