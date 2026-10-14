/// <reference lib="dom" />
import {
  PlayerDispatchError,
  createDomMediaDriver,
  createPlaybackController,
  type AudioLease,
  type AudioResolver,
} from '../../src/performance/browser/index'
import type { PerformanceCommand, PerformanceReceipt } from '../../src/contracts/app'

/**
 * Isolated manual demo for the M1-01 browser player (T14).
 *
 * It uses the real DOM media driver, real Blob assets copied from the prepared
 * fixed WAV material, a local AbortController and a single observer sender. All
 * numbers and stages are API observations: the demo does not measure acoustic
 * output or silence.
 */

const SESSION_ID = 'session-demo'
const CAPABILITY_REVISION = 1

const ASSETS: ReadonlyMap<string, string> = new Map<string, string>([
  ['audio://fixture/segment-0', './assets/segment-0.wav'],
  ['audio://fixture/segment-1', './assets/segment-1.wav'],
])

const SUBTITLES: ReadonlyMap<string, string> = new Map<string, string>([
  ['audio://fixture/segment-0', 'We talked about the concert.'],
  ['audio://fixture/segment-1', 'It was loud and fun.'],
])

const SEGMENT_REFS: readonly string[] = [
  'audio://fixture/segment-0',
  'audio://fixture/segment-1',
]

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`demo: missing element #${id}`)
  return found as T
}

const statusEl = element<HTMLPreElement>('status')
const rendererEl = element<HTMLPreElement>('renderer')
const eventsEl = element<HTMLPreElement>('events')

const events: string[] = []
const observedReceiptIds = new Set<string>()

function log(message: string): void {
  const stamp = new Date().toISOString()
  events.push(`${stamp} ${message}`)
}

/** Registered, explicit ref-to-asset map. The ref is never used as a URL. */
function createDemoResolver(): AudioResolver {
  return {
    async resolve(audioRef: string, signal: AbortSignal): Promise<AudioLease> {
      const assetUrl = ASSETS.get(audioRef)
      if (assetUrl === undefined) throw new Error(`unregistered audio ref: ${audioRef}`)
      const response = await fetch(assetUrl, { signal })
      if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`)
      const blob = await response.blob()
      return {
        blob,
        release() {
          // The DOM driver owns its object URL; the lease owns only the Blob.
        },
      }
    },
  }
}

let receiptCounter = 0
let outputCounter = 0
let cancelCounter = 0
let epoch = 1
let activeAbort: AbortController | null = null

const controller = createPlaybackController({
  sessionId: SESSION_ID,
  initialEpoch: epoch,
  resolver: createDemoResolver(),
  media: createDomMediaDriver(),
  receipts: {
    newReceiptId: () => {
      receiptCounter += 1
      return `demo-receipt-${receiptCounter}`
    },
    localNowMs: () => Math.round(performance.now()),
  },
  onReceipt: (receipt: PerformanceReceipt) => {
    // The single observer sender: each fact is recorded exactly once here.
    observedReceiptIds.add(receipt.receiptId)
    log(`receipt ${receipt.stage} output=${receipt.outputId} id=${receipt.receiptId}`)
    render()
  },
  reportFault: (error: unknown) => {
    log(`fault: ${error instanceof Error ? error.message : String(error)}`)
    render()
  },
})

function currentStatusText(): string {
  const status = controller.status()
  return [
    `idle: ${status.idle}`,
    `activeOutputId: ${status.activeOutputId ?? 'null'}`,
    `lastStage: ${status.lastStage ?? 'null'}`,
    `epoch: ${epoch}`,
    `observed receipts: ${observedReceiptIds.size}`,
  ].join('\n')
}

function render(): void {
  statusEl.textContent = currentStatusText()
  eventsEl.textContent = events.length === 0 ? '(no events yet)' : events.join('\n')
}

function renderRendererDisplay(command: PerformanceCommand): void {
  rendererEl.textContent = [
    'This test display is separate from audio playback.',
    `outputId: ${command.outputId}`,
    `action: ${command.actionId}`,
    `subtitle: ${command.subtitleText}`,
  ].join('\n')
}

async function play(segmentIndex: number): Promise<void> {
  if (activeAbort !== null) activeAbort.abort()
  const audioRef = SEGMENT_REFS[segmentIndex]
  if (audioRef === undefined) return
  outputCounter += 1
  const command: PerformanceCommand = {
    outputId: `demo-output-${outputCounter}`,
    sessionId: SESSION_ID,
    epoch,
    turnId: `demo-turn-${outputCounter}`,
    segmentId: `demo-segment-${segmentIndex}`,
    audioRef,
    subtitleText: SUBTITLES.get(audioRef) ?? '',
    actionId: 'smile',
    capabilityRevision: CAPABILITY_REVISION,
  }
  renderRendererDisplay(command)
  const abort = new AbortController()
  activeAbort = abort
  log(`execute ${command.outputId} ref=${audioRef}`)
  render()
  try {
    const receipt = await controller.execute(command, { signal: abort.signal })
    log(`execute settled output=${receipt.outputId} stage=${receipt.stage}`)
  } catch (error) {
    if (error instanceof PlayerDispatchError) log(`execute rejected code=${error.code}`)
    else log(`execute error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (activeAbort === abort) activeAbort = null
    render()
  }
}

async function stop(): Promise<void> {
  const abort = activeAbort
  if (abort !== null) abort.abort()
  cancelCounter += 1
  const newEpoch = epoch + 1
  try {
    const receipt = await controller.cancel({
      requestId: `demo-cancel-${cancelCounter}`,
      revokedEpoch: epoch,
      newEpoch,
    })
    epoch = newEpoch
    log(receipt === null ? 'stop: no active output (idle)' : `stop stage=${receipt.stage}`)
  } catch (error) {
    if (error instanceof PlayerDispatchError) log(`stop rejected code=${error.code}`)
    else log(`stop error: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (activeAbort === abort) activeAbort = null
    render()
  }
}

function dispose(): void {
  if (activeAbort !== null) {
    activeAbort.abort()
    activeAbort = null
  }
  controller.dispose()
  log('dispose: prevented new admission and attempted local cleanup')
  render()
}

element<HTMLButtonElement>('play-0').addEventListener('click', () => {
  void play(0)
})
element<HTMLButtonElement>('play-1').addEventListener('click', () => {
  void play(1)
})
element<HTMLButtonElement>('stop').addEventListener('click', () => {
  void stop()
})
element<HTMLButtonElement>('dispose').addEventListener('click', () => {
  dispose()
})

log('demo ready; browser media events are the only start/end evidence')
render()
