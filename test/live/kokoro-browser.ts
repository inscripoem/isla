/// <reference lib="dom" />
import {
  PlayerDispatchError,
  createDomMediaDriver,
  createPlaybackController,
  type AudioLease,
  type AudioResolver,
  type MediaDriver,
  type MediaHandle,
  type PlaybackController,
} from '../../src/performance/browser/index'
import type {
  PerformanceCancel,
  PerformanceCommand,
  PerformanceReceipt,
} from '../../src/contracts/app'

/**
 * M1 kokoro generated-WAV browser smoke client (P002 round 06).
 *
 * It drives the real browser playback controller and DOM media driver against
 * one controlled, muted fixture output sequence. Native media events and the
 * single receipt observer are the only playback evidence; nothing here measures
 * acoustic speech, silence, loudness or network latency, and nothing is full
 * product I2 acceptance.
 */

const HARNESS_ID = 'm1-kokoro-generated-wav-browser-smoke'
const SESSION_ID = 'm1-kokoro-browser-smoke'
const INITIAL_EPOCH = 1
const CAPABILITY_REVISION = 1
const FIXTURE_AUDIO_REF = 'audio://fixture/kokoro-smoke'
const FIXTURE_AUDIO_URL = '/__kokoro_fixture/audio.wav'
const FIXTURE_METADATA_URL = '/__kokoro_fixture/metadata'

interface WavMetadata {
  readonly sha256: string
  readonly byteLength: number
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
  readonly floatFormat: string
  readonly frameCount: number
  readonly durationMs: number
}

interface CheckOutcome {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
}

type NativeMediaEventType = 'playing' | 'ended' | 'error' | 'emptied' | 'loadedmetadata'

interface NativeEventRecord {
  readonly type: NativeMediaEventType
  readonly atMs: number
  readonly trusted: boolean
}

interface MediaElementRecorder {
  readonly events: NativeEventRecord[]
  count(type: NativeMediaEventType): number
  waitFor(type: NativeMediaEventType, timeoutMs: number): Promise<void>
  dispose(): void
}

interface ElementObservation {
  readonly element: HTMLAudioElement
  readonly recorder: MediaElementRecorder
}

interface ObjectUrlStats {
  created: number
  revoked: number
  readonly live: Set<string>
}

interface NaturalRunReport {
  readonly outputId: string
  readonly nativeEvents: readonly NativeEventRecord[]
  readonly observerStages: readonly string[]
  readonly executeStage: string | null
  readonly srcCleared: boolean
  readonly paused: boolean
  readonly currentTime: number
}

interface StopRunReport {
  readonly outputId: string
  readonly nativeEvents: readonly NativeEventRecord[]
  readonly observerStages: readonly string[]
  readonly executeStage: string | null
  readonly cancelStage: string | null
  readonly correlatedTerminal: boolean
  readonly srcCleared: boolean
  readonly paused: boolean
  readonly currentTime: number
}

interface SmokeReport {
  readonly status: 'READY' | 'RUNNING' | 'PASS' | 'FAIL'
  readonly harness: string
  readonly generatedAt: string
  readonly checks: readonly CheckOutcome[]
  readonly faults: readonly string[]
  readonly limits: readonly string[]
  readonly fixture: {
    readonly metadata: WavMetadata | null
    readonly browserSha256: string
    readonly browserByteLength: number
  }
  readonly decodedAudio: {
    readonly durationMs: number
    readonly sampleRate: number
    readonly channels: number
  } | null
  readonly receipts: {
    readonly observer: readonly PerformanceReceipt[]
    readonly naturalExecute: PerformanceReceipt | null
    readonly stopExecute: PerformanceReceipt | null
    readonly stopCancel: PerformanceReceipt | null
  }
  readonly naturalRun: NaturalRunReport
  readonly stopRun: StopRunReport
  readonly resources: {
    readonly objectUrlsCreated: number
    readonly objectUrlsRevoked: number
    readonly liveObjectUrls: readonly string[]
    readonly leasesResolved: number
    readonly leasesReleased: number
    readonly audioContextClosed: boolean
    readonly controllerDisposed: boolean
  }
  readonly error: string | null
}

const TERMINAL_STAGES = new Set<string>(['completed', 'cancelled', 'failed'])

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`observation timeout: ${reason}`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isTerminalStage(stage: string): boolean {
  return TERMINAL_STAGES.has(stage)
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function readMetadata(value: unknown): WavMetadata | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const fields: readonly (readonly [keyof WavMetadata, 'string' | 'number'])[] = [
    ['sha256', 'string'],
    ['byteLength', 'number'],
    ['sampleRate', 'number'],
    ['channels', 'number'],
    ['bitsPerSample', 'number'],
    ['floatFormat', 'string'],
    ['frameCount', 'number'],
    ['durationMs', 'number'],
  ]
  for (const [key, kind] of fields) {
    if (typeof record[key] !== kind) return null
  }
  return record as unknown as WavMetadata
}

function createMediaElementRecorder(element: HTMLAudioElement): MediaElementRecorder {
  const events: NativeEventRecord[] = []
  interface Waiter {
    readonly type: NativeMediaEventType
    readonly resolve: () => void
    readonly timer: ReturnType<typeof setTimeout>
  }
  const pending = new Set<Waiter>()
  const handlers: { readonly type: NativeMediaEventType; readonly handler: (event: Event) => void }[] =
    []

  const record = (type: NativeMediaEventType, trusted: boolean): void => {
    events.push({ type, atMs: performance.now(), trusted })
    for (const waiter of [...pending]) {
      if (waiter.type !== type) continue
      clearTimeout(waiter.timer)
      pending.delete(waiter)
      waiter.resolve()
    }
  }

  const types: readonly NativeMediaEventType[] = [
    'playing',
    'ended',
    'error',
    'emptied',
    'loadedmetadata',
  ]
  for (const type of types) {
    const handler = (event: Event): void => record(type, event.isTrusted)
    handlers.push({ type, handler })
    element.addEventListener(type, handler, { passive: true })
  }

  return {
    events,
    count: (type) => events.filter((event) => event.type === type).length,
    waitFor: (type, timeoutMs) => {
      if (events.some((event) => event.type === type)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          type,
          resolve: () => resolve(),
          timer: setTimeout(() => {
            pending.delete(waiter)
            reject(new Error(`observation timeout: native "${type}" did not occur`))
          }, timeoutMs),
        }
        pending.add(waiter)
      })
    },
    dispose: () => {
      for (const { type, handler } of handlers) element.removeEventListener(type, handler)
      for (const waiter of [...pending]) {
        clearTimeout(waiter.timer)
        pending.delete(waiter)
      }
    },
  }
}

interface CaptureHandle {
  restore(): void
}

/**
 * Briefly installs a delegating `document.createElement` wrapper so a single
 * synchronously created audio element can be captured, muted and observed. It
 * restores the native method as soon as the audio element is created and never
 * intercepts other elements.
 */
function installAudioElementCapture(onAudio: (element: HTMLAudioElement) => void): CaptureHandle {
  type CreateElementFn = (tagName: string, options?: ElementCreationOptions) => HTMLElement
  const originalCreateElement = document.createElement
  const callCreateElement = originalCreateElement.bind(document) as unknown as CreateElementFn
  let restored = false

  const restore = (): void => {
    if (restored) return
    restored = true
    document.createElement = originalCreateElement
  }

  const patched: CreateElementFn = (tagName, options) => {
    const created = callCreateElement(tagName, options)
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'audio') {
      restore()
      onAudio(created as HTMLAudioElement)
    }
    return created
  }

  document.createElement = patched as unknown as typeof document.createElement
  return { restore }
}

interface CaptureSlot {
  createHandle(): MediaHandle
  waitForElement(timeoutMs: number): Promise<ElementObservation>
}

function createCaptureSlot(): CaptureSlot {
  const realDriver = createDomMediaDriver()
  let observation: ElementObservation | null = null
  let resolvePending: ((value: ElementObservation) => void) | null = null

  const accept = (element: HTMLAudioElement): void => {
    element.muted = true
    const recorder = createMediaElementRecorder(element)
    observation = { element, recorder }
    const resolve = resolvePending
    if (resolve !== null) {
      resolvePending = null
      resolve(observation)
    }
  }

  return {
    createHandle() {
      const capture = installAudioElementCapture(accept)
      try {
        return realDriver.create()
      } finally {
        capture.restore()
      }
    },
    waitForElement(timeoutMs) {
      if (observation !== null) return Promise.resolve(observation)
      return new Promise<ElementObservation>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (resolvePending === null) return
          resolvePending = null
          reject(new Error('observation timeout: driver did not create an audio element'))
        }, timeoutMs)
        resolvePending = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
      })
    },
  }
}

interface ObjectUrlInstrumentation {
  readonly stats: ObjectUrlStats
  restore(): void
}

function installObjectUrlInstrumentation(): ObjectUrlInstrumentation {
  const stats: ObjectUrlStats = { created: 0, revoked: 0, live: new Set<string>() }
  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL
  const callCreateObjectUrl = originalCreateObjectUrl.bind(URL)
  const callRevokeObjectUrl = originalRevokeObjectUrl.bind(URL)
  URL.createObjectURL = ((object: Blob | MediaSource): string => {
    const url = callCreateObjectUrl(object)
    stats.created += 1
    stats.live.add(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string): void => {
    stats.revoked += 1
    stats.live.delete(url)
    callRevokeObjectUrl(url)
  }) as typeof URL.revokeObjectURL
  return {
    stats,
    restore: () => {
      URL.createObjectURL = originalCreateObjectUrl
      URL.revokeObjectURL = originalRevokeObjectUrl
    },
  }
}

function makeCommand(index: number, label: string): PerformanceCommand {
  return {
    outputId: `kb-output-${index}-${label}`,
    sessionId: SESSION_ID,
    epoch: INITIAL_EPOCH,
    turnId: `kb-turn-${index}`,
    segmentId: `kb-segment-${index}`,
    audioRef: FIXTURE_AUDIO_REF,
    subtitleText: `Kokoro generated smoke fixture (${label}).`,
    actionId: 'neutral',
    capabilityRevision: CAPABILITY_REVISION,
  }
}

function emptyNatural(outputId: string): NaturalRunReport {
  return {
    outputId,
    nativeEvents: [],
    observerStages: [],
    executeStage: null,
    srcCleared: false,
    paused: false,
    currentTime: -1,
  }
}

function emptyStop(outputId: string): StopRunReport {
  return {
    outputId,
    nativeEvents: [],
    observerStages: [],
    executeStage: null,
    cancelStage: null,
    correlatedTerminal: false,
    srcCleared: false,
    paused: false,
    currentTime: -1,
  }
}

async function runSmoke(): Promise<SmokeReport> {
  const checks: CheckOutcome[] = []
  const faults: string[] = []
  const limits: readonly string[] = [
    'Playback is muted: this validates the browser media API path only.',
    'It does not prove acoustic speech, silence, loudness, latency or real network timing.',
    'It is not full product I2 acceptance.',
  ]

  const addCheck = (id: string, ok: boolean, detail: string): boolean => {
    checks.push({ id, ok, detail })
    return ok
  }
  const fail = (id: string, detail: string): false => {
    addCheck(id, false, detail)
    return false
  }

  const observedReceipts: PerformanceReceipt[] = []
  interface ReceiptWaiter {
    readonly predicate: (receipt: PerformanceReceipt) => boolean
    readonly resolve: (receipt: PerformanceReceipt | null) => void
    readonly timer: ReturnType<typeof setTimeout>
  }
  const receiptWaiters = new Set<ReceiptWaiter>()
  let receiptCounter = 0
  let resolveCount = 0
  let releaseCount = 0
  let activeSlot: CaptureSlot | null = null
  let verifiedBlob: Blob | null = null

  const waitForReceipt = (
    predicate: (receipt: PerformanceReceipt) => boolean,
    timeoutMs: number,
  ): Promise<PerformanceReceipt | null> => {
    const existing = observedReceipts.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const waiter: ReceiptWaiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          receiptWaiters.delete(waiter)
          resolve(null)
        }, timeoutMs),
      }
      receiptWaiters.add(waiter)
    })
  }

  const originalCreateElementRef = document.createElement
  const originalObjectUrlCreateRef = URL.createObjectURL
  const originalObjectUrlRevokeRef = URL.revokeObjectURL

  const urlInstrument = installObjectUrlInstrumentation()
  let controllerDisposed = false
  let contextClosed = false

  const resolver: AudioResolver = {
    async resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease> {
      if (audioRef !== FIXTURE_AUDIO_REF) throw new Error(`unregistered audio ref: ${audioRef}`)
      if (signal.aborted) throw new Error('resolver aborted before start')
      const verified = verifiedBlob
      if (verified === null) throw new Error('verified fixture blob is unavailable')
      resolveCount += 1
      let released = false
      return {
        blob: verified,
        release() {
          if (released) return
          released = true
          releaseCount += 1
        },
      }
    },
  }

  const media: MediaDriver = {
    create(): MediaHandle {
      if (activeSlot === null) throw new Error('capture slot is not armed')
      return activeSlot.createHandle()
    },
  }

  const controller: PlaybackController = createPlaybackController({
    sessionId: SESSION_ID,
    initialEpoch: INITIAL_EPOCH,
    resolver,
    media,
    receipts: {
      newReceiptId: () => {
        receiptCounter += 1
        return `kb-receipt-${receiptCounter}`
      },
      localNowMs: () => Math.round(performance.now()),
    },
    onReceipt: (receipt) => {
      observedReceipts.push(receipt)
      for (const waiter of [...receiptWaiters]) {
        if (!waiter.predicate(receipt)) continue
        clearTimeout(waiter.timer)
        receiptWaiters.delete(waiter)
        waiter.resolve(receipt)
      }
    },
    reportFault: (error) => {
      faults.push(describeError(error))
    },
  })

  const naturalCommand = makeCommand(1, 'natural')
  const stopCommand = makeCommand(2, 'stop')
  const naturalAbort = new AbortController()
  const stopAbort = new AbortController()

  let metadata: WavMetadata | null = null
  let browserSha256 = ''
  let browserByteLength = 0
  let decodedAudio: SmokeReport['decodedAudio'] = null
  let naturalReport = emptyNatural(naturalCommand.outputId)
  let stopReport = emptyStop(stopCommand.outputId)
  let naturalExecuteReceipt: PerformanceReceipt | null = null
  let stopExecuteReceipt: PerformanceReceipt | null = null
  let stopCancelReceipt: PerformanceReceipt | null = null
  let topError: string | null = null

  try {
    const metadataResponse = await fetch(FIXTURE_METADATA_URL, { cache: 'no-store' })
    addCheck('fixture.metadata.status', metadataResponse.ok, `HTTP ${metadataResponse.status}`)
    addCheck(
      'fixture.metadata.cacheControl',
      metadataResponse.headers.get('cache-control') === 'no-store',
      `cache-control: ${metadataResponse.headers.get('cache-control') ?? '(none)'}`,
    )
    if (!metadataResponse.ok) throw new Error(`metadata route returned HTTP ${metadataResponse.status}`)
    const metadataJson: unknown = await metadataResponse.json()
    metadata = readMetadata(metadataJson)
    addCheck(
      'fixture.metadata.shape',
      metadata !== null,
      metadata === null ? 'unexpected metadata payload' : 'metadata fields present',
    )
    if (metadata === null) throw new Error('fixture metadata was not a valid WAV description')

    const audioResponse = await fetch(FIXTURE_AUDIO_URL, { cache: 'no-store' })
    addCheck('fixture.audio.status', audioResponse.ok, `HTTP ${audioResponse.status}`)
    addCheck(
      'fixture.audio.contentType',
      audioResponse.headers.get('content-type') === 'audio/wav',
      `content-type: ${audioResponse.headers.get('content-type') ?? '(none)'}`,
    )
    if (!audioResponse.ok) throw new Error(`audio route returned HTTP ${audioResponse.status}`)
    const arrayBuffer = await audioResponse.arrayBuffer()
    browserByteLength = arrayBuffer.byteLength
    browserSha256 = await sha256Hex(arrayBuffer)
    addCheck(
      'fixture.audio.sizeMatchesMetadata',
      browserByteLength === metadata.byteLength,
      `browser ${browserByteLength} vs metadata ${metadata.byteLength}`,
    )
    addCheck(
      'fixture.audio.shaMatchesMetadata',
      browserSha256 === metadata.sha256,
      `browser ${browserSha256} vs metadata ${metadata.sha256}`,
    )
    // Freeze the exact already hash/size-verified bytes as the single owned
    // Blob both controlled-ref acquisitions will play. If verification fails,
    // no Blob is stored and the resolver refuses to play anything.
    if (browserByteLength === metadata.byteLength && browserSha256 === metadata.sha256) {
      verifiedBlob = new Blob([arrayBuffer], { type: 'audio/wav' })
    }
    addCheck(
      'fixture.blob.verified',
      verifiedBlob !== null,
      verifiedBlob === null
        ? 'no verified immutable Blob available for playback'
        : 'one verified immutable Blob will back both plays',
    )

    const audioContext = new AudioContext()
    let decoded: AudioBuffer | null = null
    try {
      decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0))
      decodedAudio = {
        durationMs: decoded.duration * 1000,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
      }
      addCheck(
        'audio.decode.ok',
        true,
        `decoded ${decoded.duration.toFixed(4)}s at ${decoded.sampleRate}Hz`,
      )
    } catch (error) {
      fail('audio.decode.ok', describeError(error))
    } finally {
      try {
        await audioContext.close()
        contextClosed = true
      } catch (error) {
        faults.push(describeError(error))
      }
    }
    if (decoded !== null) {
      const decodedDurationMs = decoded.duration * 1000
      const expectedMs = (metadata.frameCount / metadata.sampleRate) * 1000
      const toleranceMs = (2 / decoded.sampleRate) * 1000 + 1
      addCheck(
        'audio.decode.channels',
        decoded.numberOfChannels === metadata.channels,
        `decoded ${decoded.numberOfChannels} vs metadata ${metadata.channels}`,
      )
      addCheck(
        'audio.decode.duration',
        Math.abs(decodedDurationMs - expectedMs) <= toleranceMs,
        `decoded ${decodedDurationMs.toFixed(3)}ms vs expected ${expectedMs.toFixed(3)}ms (tolerance ${toleranceMs.toFixed(3)}ms)`,
      )
    }

    const observationTimeoutMs = Math.min(
      30000,
      Math.max(10000, metadata.durationMs * 2 + 5000),
    )

    const observeNative = async (
      recorder: MediaElementRecorder,
      type: NativeMediaEventType,
      id: string,
    ): Promise<boolean> => {
      try {
        await recorder.waitFor(type, observationTimeoutMs)
        return addCheck(id, true, `native "${type}" observed`)
      } catch (error) {
        return fail(id, describeError(error))
      }
    }

    const stagesOf = (outputId: string): string[] =>
      observedReceipts.filter((receipt) => receipt.outputId === outputId).map((r) => r.stage)

    const terminalsOf = (outputId: string): PerformanceReceipt[] =>
      observedReceipts.filter(
        (receipt) => receipt.outputId === outputId && isTerminalStage(receipt.stage),
      )

    // ---- Output 1: natural run ----
    const naturalSlot = createCaptureSlot()
    activeSlot = naturalSlot
    const naturalExecute = controller.execute(naturalCommand, { signal: naturalAbort.signal })
    let naturalObservation: ElementObservation | null = null
    try {
      naturalObservation = await naturalSlot.waitForElement(observationTimeoutMs)
    } catch (error) {
      fail('natural.element.created', describeError(error))
    } finally {
      activeSlot = null
    }

    if (naturalObservation !== null) {
      await observeNative(naturalObservation.recorder, 'playing', 'natural.native.playing')
      await observeNative(naturalObservation.recorder, 'ended', 'natural.native.ended')
    }

    try {
      naturalExecuteReceipt = await withTimeout(
        naturalExecute,
        observationTimeoutMs,
        'natural execute did not settle',
      )
    } catch (error) {
      fail('natural.execute.settled', describeError(error))
    }

    const naturalStages = stagesOf(naturalCommand.outputId)
    const naturalTerminals = terminalsOf(naturalCommand.outputId)
    const naturalAccepted = naturalStages.indexOf('accepted')
    const naturalStarted = naturalStages.indexOf('started')
    const naturalTerminalIndex = naturalStages.findIndex(isTerminalStage)
    addCheck('natural.observer.accepted', naturalAccepted >= 0, `stages: ${naturalStages.join(', ') || '(none)'}`)
    addCheck('natural.observer.started', naturalStarted > naturalAccepted, `stages: ${naturalStages.join(', ') || '(none)'}`)
    addCheck(
      'natural.observer.ordering',
      naturalAccepted >= 0 && naturalStarted > naturalAccepted && naturalTerminalIndex > naturalStarted,
      `accepted=${naturalAccepted} started=${naturalStarted} terminal=${naturalTerminalIndex}`,
    )
    addCheck(
      'natural.observer.singleTerminal',
      naturalTerminals.length === 1,
      `${naturalTerminals.length} terminal observer receipts for ${naturalCommand.outputId}`,
    )
    addCheck(
      'natural.observer.identity',
      naturalStages.length > 0 &&
        observedReceipts
          .filter((receipt) => receipt.outputId === naturalCommand.outputId)
          .every(
            (receipt) =>
              receipt.sessionId === SESSION_ID &&
              receipt.epoch === naturalCommand.epoch &&
              receipt.turnId === naturalCommand.turnId,
          ),
      'observer receipts carry the original output identity',
    )
    const naturalIds = observedReceipts
      .filter((receipt) => receipt.outputId === naturalCommand.outputId)
      .map((receipt) => receipt.receiptId)
    addCheck(
      'natural.observer.uniqueIds',
      new Set(naturalIds).size === naturalIds.length,
      `${naturalIds.length} receipts, ${new Set(naturalIds).size} unique ids`,
    )
    addCheck(
      'natural.execute.completed',
      naturalExecuteReceipt !== null && naturalExecuteReceipt.stage === 'completed',
      naturalExecuteReceipt === null ? 'no execute receipt' : `execute stage: ${naturalExecuteReceipt.stage}`,
    )
    addCheck(
      'natural.terminal.shared',
      naturalTerminals.length === 1 &&
        naturalExecuteReceipt !== null &&
        naturalTerminals[0] !== undefined &&
        naturalTerminals[0].receiptId === naturalExecuteReceipt.receiptId,
      'execute terminal matches the single observer terminal',
    )
    addCheck(
      'natural.native.endedRecorded',
      naturalObservation !== null && naturalObservation.recorder.count('ended') === 1,
      naturalObservation === null
        ? 'no element observed'
        : `ended events: ${naturalObservation.recorder.count('ended')}`,
    )

    const naturalStatus = controller.status()
    addCheck(
      'natural.status.idle',
      naturalStatus.idle === true,
      `idle=${naturalStatus.idle} activeOutputId=${naturalStatus.activeOutputId ?? 'null'}`,
    )

    if (naturalObservation !== null) {
      const element = naturalObservation.element
      const srcCleared = !element.hasAttribute('src')
      addCheck('natural.dom.srcCleared', srcCleared, `src present: ${element.hasAttribute('src')}`)
      addCheck('natural.dom.paused', element.paused === true, `paused=${element.paused}`)
      addCheck(
        'natural.dom.currentTimeReset',
        Math.abs(element.currentTime) < 0.001,
        `currentTime=${element.currentTime}`,
      )
      naturalReport = {
        outputId: naturalCommand.outputId,
        nativeEvents: [...naturalObservation.recorder.events],
        observerStages: naturalStages,
        executeStage: naturalExecuteReceipt?.stage ?? null,
        srcCleared,
        paused: element.paused,
        currentTime: element.currentTime,
      }
      naturalObservation.recorder.dispose()
    } else {
      naturalReport = {
        ...naturalReport,
        observerStages: naturalStages,
        executeStage: naturalExecuteReceipt?.stage ?? null,
      }
    }

    addCheck('natural.lease.released', releaseCount === 1, `leases released after natural run: ${releaseCount}`)
    addCheck(
      'natural.objectUrl.revoked',
      urlInstrument.stats.live.size === 0 && urlInstrument.stats.created === 1,
      `created=${urlInstrument.stats.created} revoked=${urlInstrument.stats.revoked} live=${urlInstrument.stats.live.size}`,
    )

    // ---- Output 2: stop run ----
    const stopSlot = createCaptureSlot()
    activeSlot = stopSlot
    const stopExecute = controller.execute(stopCommand, { signal: stopAbort.signal })
    let stopObservation: ElementObservation | null = null
    try {
      stopObservation = await stopSlot.waitForElement(observationTimeoutMs)
    } catch (error) {
      fail('stop.element.created', describeError(error))
    } finally {
      activeSlot = null
    }

    if (stopObservation !== null) {
      await observeNative(stopObservation.recorder, 'playing', 'stop.native.playing')
    }
    const stopStarted = await waitForReceipt(
      (receipt) => receipt.stage === 'started' && receipt.outputId === stopCommand.outputId,
      observationTimeoutMs,
    )
    addCheck(
      'stop.observer.started',
      stopStarted !== null,
      stopStarted === null ? 'timeout waiting for one started receipt' : 'started receipt observed',
    )

    const cancelRequest: PerformanceCancel = {
      requestId: 'kb-cancel-1',
      revokedEpoch: INITIAL_EPOCH,
      newEpoch: INITIAL_EPOCH + 1,
    }
    try {
      stopCancelReceipt = await controller.cancel(cancelRequest)
      addCheck('stop.cancel.accepted', true, 'trusted cancel returned')
    } catch (error) {
      fail(
        'stop.cancel.accepted',
        error instanceof PlayerDispatchError ? `cancel rejected: ${error.code}` : describeError(error),
      )
    }

    try {
      stopExecuteReceipt = await withTimeout(
        stopExecute,
        observationTimeoutMs,
        'stop execute did not settle',
      )
    } catch (error) {
      fail('stop.execute.settled', describeError(error))
    }

    const stopStages = stagesOf(stopCommand.outputId)
    const stopTerminals = terminalsOf(stopCommand.outputId)
    addCheck(
      'stop.cancel.cancelled',
      stopCancelReceipt !== null && stopCancelReceipt.stage === 'cancelled',
      stopCancelReceipt === null ? 'cancel returned null' : `cancel stage: ${stopCancelReceipt.stage}`,
    )
    addCheck(
      'stop.execute.cancelled',
      stopExecuteReceipt !== null && stopExecuteReceipt.stage === 'cancelled',
      stopExecuteReceipt === null ? 'no execute receipt' : `execute stage: ${stopExecuteReceipt.stage}`,
    )
    const correlated =
      stopCancelReceipt !== null &&
      stopExecuteReceipt !== null &&
      stopCancelReceipt.receiptId === stopExecuteReceipt.receiptId
    addCheck(
      'stop.terminal.correlated',
      correlated,
      correlated ? 'execute and cancel share one cancelled terminal' : 'execute/cancel terminals differ',
    )
    addCheck(
      'stop.observer.singleTerminal',
      stopTerminals.length === 1 && stopTerminals[0]?.stage === 'cancelled',
      `${stopTerminals.length} terminal observer receipts (${stopTerminals.map((r) => r.stage).join(', ') || 'none'})`,
    )
    addCheck(
      'stop.observer.noCompleted',
      !stopStages.includes('completed'),
      `stages: ${stopStages.join(', ') || '(none)'}`,
    )
    addCheck(
      'stop.native.noEnded',
      stopObservation !== null && stopObservation.recorder.count('ended') === 0,
      stopObservation === null
        ? 'no element observed'
        : `ended events: ${stopObservation.recorder.count('ended')}`,
    )

    const stopStatus = controller.status()
    addCheck(
      'stop.status.idle',
      stopStatus.idle === true,
      `idle=${stopStatus.idle} activeOutputId=${stopStatus.activeOutputId ?? 'null'}`,
    )

    if (stopObservation !== null) {
      const element = stopObservation.element
      const srcCleared = !element.hasAttribute('src')
      addCheck('stop.dom.srcCleared', srcCleared, `src present: ${element.hasAttribute('src')}`)
      addCheck('stop.dom.paused', element.paused === true, `paused=${element.paused}`)
      addCheck(
        'stop.dom.currentTimeReset',
        Math.abs(element.currentTime) < 0.001,
        `currentTime=${element.currentTime}`,
      )
      stopReport = {
        outputId: stopCommand.outputId,
        nativeEvents: [...stopObservation.recorder.events],
        observerStages: stopStages,
        executeStage: stopExecuteReceipt?.stage ?? null,
        cancelStage: stopCancelReceipt?.stage ?? null,
        correlatedTerminal: correlated,
        srcCleared,
        paused: element.paused,
        currentTime: element.currentTime,
      }
      stopObservation.recorder.dispose()
    } else {
      stopReport = {
        ...stopReport,
        observerStages: stopStages,
        executeStage: stopExecuteReceipt?.stage ?? null,
        cancelStage: stopCancelReceipt?.stage ?? null,
        correlatedTerminal: correlated,
      }
    }

    addCheck(
      'stop.lease.released',
      releaseCount === resolveCount && resolveCount === 2,
      `leases resolved=${resolveCount} released=${releaseCount}`,
    )
    addCheck(
      'resources.noLiveObjectUrls',
      urlInstrument.stats.live.size === 0,
      `live object URLs: ${urlInstrument.stats.live.size}`,
    )
  } catch (error) {
    topError = describeError(error)
    faults.push(topError)
  } finally {
    activeSlot = null
    try {
      controller.dispose()
      controllerDisposed = true
    } catch (error) {
      faults.push(describeError(error))
    }
    urlInstrument.restore()
    naturalAbort.abort()
    stopAbort.abort()
  }

  addCheck(
    'cleanup.createElementRestored',
    document.createElement === originalCreateElementRef,
    'document.createElement reference equals its per-run original',
  )
  addCheck(
    'cleanup.objectUrlCreateRestored',
    URL.createObjectURL === originalObjectUrlCreateRef,
    'URL.createObjectURL reference equals its per-run original',
  )
  addCheck(
    'cleanup.objectUrlRevokeRestored',
    URL.revokeObjectURL === originalObjectUrlRevokeRef,
    'URL.revokeObjectURL reference equals its per-run original',
  )

  const passed =
    topError === null && faults.length === 0 && checks.length > 0 && checks.every((check) => check.ok)

  return {
    status: passed ? 'PASS' : 'FAIL',
    harness: HARNESS_ID,
    generatedAt: new Date().toISOString(),
    checks,
    faults,
    limits,
    fixture: {
      metadata,
      browserSha256,
      browserByteLength,
    },
    decodedAudio,
    receipts: {
      observer: observedReceipts,
      naturalExecute: naturalExecuteReceipt,
      stopExecute: stopExecuteReceipt,
      stopCancel: stopCancelReceipt,
    },
    naturalRun: naturalReport,
    stopRun: stopReport,
    resources: {
      objectUrlsCreated: urlInstrument.stats.created,
      objectUrlsRevoked: urlInstrument.stats.revoked,
      liveObjectUrls: [...urlInstrument.stats.live],
      leasesResolved: resolveCount,
      leasesReleased: releaseCount,
      audioContextClosed: contextClosed,
      controllerDisposed,
    },
    error: topError,
  }
}

const runButton = document.getElementById('run')
const resultElement = document.getElementById('result')

async function handleRun(): Promise<void> {
  if (runButton instanceof HTMLButtonElement) runButton.disabled = true
  if (resultElement !== null) {
    resultElement.textContent = JSON.stringify({ status: 'RUNNING', harness: HARNESS_ID })
  }
  try {
    const report = await runSmoke()
    if (resultElement !== null) resultElement.textContent = JSON.stringify(report, null, 2)
  } catch (error) {
    if (resultElement !== null) {
      resultElement.textContent = JSON.stringify(
        { status: 'FAIL', harness: HARNESS_ID, error: describeError(error) },
        null,
        2,
      )
    }
  } finally {
    if (runButton instanceof HTMLButtonElement) runButton.disabled = false
  }
}

if (runButton instanceof HTMLButtonElement) {
  runButton.addEventListener('click', () => {
    void handleRun()
  })
}
