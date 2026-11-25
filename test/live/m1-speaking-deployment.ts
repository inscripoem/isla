/**
 * M1 speaking-mouth production deployment for the Isla runtime CLI.
 *
 * This module is loaded through `ISLA_DEPLOYMENT_MODULE` and differs from the
 * reference live deployment in one deliberate way: the renderer targets the
 * operator's explicitly selected VTube Studio model instead of the bundled
 * Hiyori_A model id. Everything else is the normal production composition:
 * `parseReferenceLiveConfig`, the reference text provider, Kokoro synthesis,
 * voice settings, rules and peer lifecycle.
 *
 * The selected model id is required and never discovered. Acquisition uses the
 * configured endpoint, plugin identity and the existing token file read-only
 * (`existing-only`); this module never prompts for, replaces or writes a token.
 * The loaded model is checked before deployment construction, and the real VTS
 * renderer repeats the identity check on every dispatch.
 *
 * The connection is acquired before `buildReferenceDeployment` because that
 * builder's injected renderer factory is synchronous. The renderer is created
 * once, cached, and given a retargetable gate because the reference builder may
 * invoke the factory once per composition.
 *
 * When `ISLA_SPEAKING_MOUTH_SOURCE=envelope` and the parent supplied an IPC
 * channel, the deployment also forwards the registry's optional numeric volume
 * envelopes to the launcher. That observer is released before any other owned
 * lifecycle work; no audio bytes or credentials cross the channel.
 */

import { readFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import type { ReceiptTools } from '../../src/performance/browser/types'
import type { VolumeEnvelopeEvent } from '../../src/performance/lipsync/volume-envelope'
import type { VtsConnectionHandle, VtsConnectionSocket } from '../../src/performance/vts-connection'
import { createVtsConnectionHandle } from '../../src/performance/vts-connection'
import type { VtsTransport } from '../../src/performance/vts-client'
import { createVtsClient } from '../../src/performance/vts-client'
import type { VtsRenderer } from '../../src/performance/vts-driver'
import { createVtsRenderer } from '../../src/performance/vts-driver'
import type {
  ReferenceRendererFactoryInput,
  ReferenceRendererHandle,
} from '../../src/runtime/deployments/reference-live'
import { buildReferenceDeployment } from '../../src/runtime/deployments/reference-live'
import type { ReferenceLiveConfig } from '../../src/runtime/deployments/reference-live-config'
import { parseReferenceLiveConfig } from '../../src/runtime/deployments/reference-live-config'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import type {
  ProductionDeployment,
  ProductionDeploymentContext,
} from '../../src/runtime/production'
import type { VtsAcquisition, VtsCredentialStore } from '../../src/runtime/vts-acquisition'
import {
  createVtsAcquisition,
  createVtsCredentialCoordinator,
} from '../../src/runtime/vts-acquisition'

const MODEL_ID_ENV = 'ISLA_SPEAKING_MODEL_ID'
const MOUTH_SOURCE_ENV = 'ISLA_SPEAKING_MOUTH_SOURCE'
const MOUTH_ENVELOPE_MESSAGE = 'isla.mouth.volume-envelope'

const RENDERER_ID = 'isla-reference-renderer'
const CHARACTER_ID = 'Elleya'
const CAPABILITY_REVISION = 1

const VTS_OPEN_TIMEOUT_MS = 10_000
const VTS_CLOSE_TIMEOUT_MS = 5_000
const VTS_ACQUISITION_TIMEOUT_MS = 30_000
const VTS_REQUEST_TIMEOUT_MS = 5_000
const VTS_HUMAN_APPROVAL_TIMEOUT_MS = 60_000
const VTS_MAX_PENDING = 8

interface LiveGate extends RuntimeDeadlineGate {
  /** Forward future bindings to the composition gate most recently supplied. */
  retarget(gate: RuntimeDeadlineGate): void
}

/**
 * A gate proxy owned by the long-lived renderer. The reference builder invokes
 * the renderer factory with a fresh composition gate; retargeting keeps one
 * renderer and one transport subscriber while honoring every successor gate.
 */
function createLiveGate(): LiveGate {
  let target: RuntimeDeadlineGate | null = null
  return {
    retarget(gate) {
      target = gate
    },
    bind(context) {
      if (target === null) {
        throw new Error('speaking-deployment: no composition deadline gate is installed')
      }
      return target.bind(context)
    },
    dispose() {
      // The composition owns its gate; this proxy only forgets the target.
      target = null
    },
  }
}

/** Require the operator-selected VTS model id. No default and no discovery. */
function requireSelectedModelId(env: ProductionDeploymentContext['env']): string {
  const raw = env[MODEL_ID_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      `speaking-deployment: ${MODEL_ID_ENV} must name the VTube Studio model to animate`,
    )
  }
  return raw.trim()
}

/**
 * Existing-token store over the configured token file. Reading is the only
 * supported operation: `existing-only` pairing never asks this store to save,
 * and this deployment never replaces an operator credential.
 */
function createReadOnlyTokenStore(tokenPath: string): VtsCredentialStore {
  return {
    async load(_record, signal) {
      if (signal.aborted) {
        throw new Error('speaking-deployment: VTS credential load was aborted')
      }
      try {
        const value = readFileSync(tokenPath, 'utf8').trim()
        return value.length > 0 ? value : null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('speaking-deployment: VTS credential could not be read')
      }
    },
    async save(_record, _value, signal) {
      if (signal.aborted) {
        throw new Error('speaking-deployment: VTS credential save was aborted')
      }
      throw new Error('speaking-deployment: VTS token replacement is not permitted')
    },
  }
}

/**
 * Physically release a socket that never reached the handle. A still-CONNECTING
 * `ws` emits an expected asynchronous `error` after intentional termination;
 * keep an error sink attached before terminating and remove it when the socket
 * closes, so the failed opening socket cannot crash the process or retain a
 * listener.
 */
function terminateSocket(socket: WebSocket): void {
  const ignoreExpectedError = (): void => {}
  const releaseSink = (): void => {
    try {
      socket.off('error', ignoreExpectedError)
    } catch {
      // The socket is already unusable; termination remains the report.
    }
    try {
      socket.off('close', releaseSink)
    } catch {
      // The socket is already unusable; termination remains the report.
    }
  }

  try {
    socket.on('error', ignoreExpectedError)
    socket.once('close', releaseSink)
  } catch {
    // The socket may already be unusable; termination still proceeds.
  }

  try {
    socket.terminate()
  } catch {
    try {
      socket.close()
    } catch {
      // The opening failure is the reportable error.
    }
  }

  // `terminate()` on an already closed socket emits no further close event, so
  // the sink must be released here instead of waiting for a future close.
  if (socket.readyState === WebSocket.CLOSED) releaseSink()
}

/**
 * Open one WebSocket and adopt it as the D1 connection handle after `open`.
 * Abort, timeout and pre-open failures physically release the socket; a socket
 * opened after cancellation still resolves so acquisition can close its late
 * handle. Failure text is fixed and never includes the endpoint or socket text.
 */
function openVtsSocket(wsUrl: string, signal: AbortSignal): Promise<VtsConnectionHandle> {
  return new Promise<VtsConnectionHandle>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('speaking-deployment: VTS socket open was aborted'))
      return
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(wsUrl)
    } catch {
      reject(new Error('speaking-deployment: VTS socket could not be created'))
      return
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const detach = (): void => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const fail = (message: string): void => {
      if (settled) return
      settled = true
      detach()
      terminateSocket(socket)
      reject(new Error(message))
    }

    const onOpen = (): void => {
      if (settled) return
      settled = true
      detach()
      try {
        resolve(
          createVtsConnectionHandle({
            socket: socket as unknown as VtsConnectionSocket,
            closeTimeoutMs: VTS_CLOSE_TIMEOUT_MS,
          }),
        )
      } catch {
        terminateSocket(socket)
        reject(new Error('speaking-deployment: VTS connection handle could not be created'))
      }
    }
    const onError = (): void => fail('speaking-deployment: VTS socket failed before opening')
    const onClose = (): void => fail('speaking-deployment: VTS socket closed before opening')
    const onAbort = (): void => fail('speaking-deployment: VTS socket open was aborted')

    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () => fail('speaking-deployment: VTS socket open timed out'),
      VTS_OPEN_TIMEOUT_MS,
    )
  })
}

interface AcquiredVts {
  readonly acquisition: VtsAcquisition
  readonly handle: VtsConnectionHandle
}

/**
 * The production peer view intentionally exposes only the composition and
 * serving seams. The launcher opts into the registry's optional synthesis
 * envelope observer without widening that shared M5 type.
 */
interface MouthEnvelopeRegistry {
  observeVolumeEnvelopes?: (
    listener: (event: VolumeEnvelopeEvent) => void,
  ) => () => void
}

/**
 * Subscribe once to the deployment's synthesis-envelope stream when the
 * launcher explicitly selected it and a parent IPC channel exists. Only the
 * numeric envelope is forwarded; audio bytes and credentials never cross IPC.
 * A closed or failing channel is ignored so normal playback continues.
 */
function observeMouthEnvelopes(
  context: ProductionDeploymentContext,
  audioResources: unknown,
): (() => void) | null {
  if (context.env[MOUTH_SOURCE_ENV]?.trim() !== 'envelope') return null
  if (process.connected !== true || typeof process.send !== 'function') return null

  const registry = audioResources as MouthEnvelopeRegistry | null | undefined
  if (
    registry === null ||
    registry === undefined ||
    typeof registry.observeVolumeEnvelopes !== 'function'
  ) {
    return null
  }

  let active = true
  let unsubscribe: (() => void) | null = null
  try {
    const stop = registry.observeVolumeEnvelopes((envelope) => {
      if (!active || process.connected !== true || typeof process.send !== 'function') {
        return
      }
      try {
        process.send(
          { type: MOUTH_ENVELOPE_MESSAGE, envelope },
          undefined,
          undefined,
          () => {},
        )
      } catch {
        // A parent that stopped listening must not disturb normal playback.
      }
    })
    if (typeof stop !== 'function') {
      active = false
      return null
    }
    unsubscribe = stop
  } catch {
    active = false
    return null
  }

  // Unsubscription is idempotent and also invalidates the listener immediately,
  // so a teardown race cannot forward one more event.
  return () => {
    if (!active) return
    active = false
    const stop = unsubscribe
    unsubscribe = null
    if (stop !== null) stop()
  }
}

/**
 * Perform one bounded, existing-token acquisition. A failed or refused attempt
 * is fully released before the safe classification is reported. `acquire` is
 * not retried: the production CLI reports the failure and exits.
 */
async function acquireVts(config: ReferenceLiveConfig): Promise<AcquiredVts> {
  const acquisition = createVtsAcquisition({
    connect: (signal) => openVtsSocket(config.vts.wsUrl, signal),
    credentials: createVtsCredentialCoordinator(
      createReadOnlyTokenStore(config.vts.tokenPath),
    ),
    identity: {
      pluginName: config.vts.pluginName,
      pluginDeveloper: config.vts.pluginDeveloper,
    },
    target: config.vts.wsUrl,
    mode: 'existing-only',
    acquisitionTimeoutMs: VTS_ACQUISITION_TIMEOUT_MS,
    requestTimeoutMs: VTS_REQUEST_TIMEOUT_MS,
    humanApprovalTimeoutMs: VTS_HUMAN_APPROVAL_TIMEOUT_MS,
  })

  try {
    const result = await acquisition.acquire()
    if (result.kind === 'acquired') {
      return { acquisition, handle: result.handle }
    }

    const outcome = await acquisition.release()
    if (result.kind === 'failed') {
      const pairing = result.pairing === null ? '' : ` pairing=${result.pairing}`
      throw new Error(
        `speaking-deployment: VTS acquisition failed at ${result.stage}: ${result.reason}${pairing} (release ${outcome})`,
      )
    }
    throw new Error(`speaking-deployment: VTS acquisition was refused: ${result.reason}`)
  } catch (error) {
    // A programming or unexpected failure still settles the owned lifecycle.
    try {
      await acquisition.release()
    } catch {
      // The acquisition failure is the reportable error.
    }
    throw error
  }
}

/**
 * Verify the configured model is the one currently loaded. The client uses a
 * borrowed transport view whose `dispose` is intentionally a no-op, so freeing
 * this short-lived subscriber leaves the acquired transport open for the real
 * renderer, which may claim the single application subscriber only afterwards.
 */
async function assertLoadedModel(transport: VtsTransport, modelId: string): Promise<void> {
  const borrowed: VtsTransport = {
    send: (serialized) => transport.send(serialized),
    subscribe: (listener) => transport.subscribe(listener),
    dispose: () => {},
  }
  const client = createVtsClient({
    transport: borrowed,
    timeoutMs: VTS_REQUEST_TIMEOUT_MS,
    maxPending: 1,
  })
  try {
    const signal = new AbortController().signal
    const result = await client.currentModel(signal)
    if (result.kind === 'failed') {
      throw new Error(
        `speaking-deployment: VTS current model query failed (${result.code})`,
      )
    }
    if (result.kind === 'api_error') {
      throw new Error('speaking-deployment: VTS rejected the current model query')
    }
    if (!result.data.modelLoaded) {
      throw new Error('speaking-deployment: no VTS model is currently loaded')
    }
    if (result.data.modelID !== modelId) {
      throw new Error(
        'speaking-deployment: the configured model is not the model currently loaded',
      )
    }
  } finally {
    client.dispose()
  }
}

/**
 * Production deployment factory loaded by the runtime CLI.
 *
 * Every exit path releases the acquired VTS lifecycle, and every path after
 * renderer creation disposes that renderer first. A setup or build failure is
 * rethrown unchanged; startup and release faults use fixed, bounded text.
 */
export async function createProductionDeployment(
  context: ProductionDeploymentContext,
): Promise<ProductionDeployment> {
  const config = parseReferenceLiveConfig(context.env)
  const selectedModelId = requireSelectedModelId(context.env)

  let acquisition: VtsAcquisition | null = null
  let vtsRenderer: VtsRenderer | null = null
  let unsubscribeMouthEnvelopes: (() => void) | null = null

  const disposeRenderer = (): void => {
    // `VtsRenderer.dispose` is idempotent; the reference builder also registers
    // this handle in its own release list, so repeated calls are expected.
    vtsRenderer?.dispose()
  }

  const liveGate = createLiveGate()
  let receiptSequence = 0
  const receipts: ReceiptTools = {
    newReceiptId: () => `vts-receipt-${(receiptSequence += 1)}`,
    localNowMs: () => context.clock.nowMs(),
  }

  try {
    const acquired = await acquireVts(config)
    acquisition = acquired.acquisition
    const transport = acquired.handle.transport

    await assertLoadedModel(transport, selectedModelId)

    const createRenderer = (
      input: ReferenceRendererFactoryInput,
    ): ReferenceRendererHandle => {
      // Every composition receives its own gate; the cached renderer forwards
      // future dispatches to the newest one without opening a second client.
      liveGate.retarget(input.gate)
      let current = vtsRenderer
      if (current === null) {
        current = createVtsRenderer({
          transport,
          modelId: selectedModelId,
          rendererId: RENDERER_ID,
          characterId: CHARACTER_ID,
          capabilityRevision: CAPABILITY_REVISION,
          mappings: input.mappings,
          timeoutMs: VTS_REQUEST_TIMEOUT_MS,
          maxPending: VTS_MAX_PENDING,
          deadlineGate: liveGate,
          receipts,
        })
        vtsRenderer = current
      }
      return { renderer: current.renderer, dispose: disposeRenderer }
    }

    const deployment = await buildReferenceDeployment(
      config,
      { createRenderer },
      context.clock,
      context.databasePath,
    )

    unsubscribeMouthEnvelopes = observeMouthEnvelopes(
      context,
      deployment.peers.audioResources,
    )

    const baseRelease = deployment.release
    let releaseStarted: Promise<void> | null = null
    const release = (): Promise<void> => {
      if (releaseStarted !== null) return releaseStarted
      releaseStarted = (async () => {
        const failures: unknown[] = []

        // Release the optional mouth observer before any owned lifecycle work.
        const unsubscribe = unsubscribeMouthEnvelopes
        unsubscribeMouthEnvelopes = null
        if (unsubscribe !== null) {
          try {
            unsubscribe()
          } catch (error) {
            failures.push(error)
          }
        }

        // Close the renderer before the reference peers so the VTS subscription
        // ends before Kokoro's idle wait. The builder's own disposer is
        // idempotent, so its later call does not close anything twice.
        try {
          disposeRenderer()
        } catch (error) {
          failures.push(error)
        }

        if (baseRelease !== undefined) {
          try {
            await baseRelease()
          } catch (error) {
            failures.push(error)
          }
        }

        if (acquisition !== null) {
          try {
            const outcome = await acquisition.release()
            if (outcome !== 'stopped') {
              failures.push(
                new Error(
                  `speaking-deployment: VTS connection release finished as ${outcome}`,
                ),
              )
            }
          } catch (error) {
            failures.push(
              new Error('speaking-deployment: VTS connection release failed', {
                cause: error,
              }),
            )
          }
        }

        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          throw new AggregateError(failures, 'speaking-deployment: release failed', {
            cause: failures[0],
          })
        }
      })()
      return releaseStarted
    }

    return {
      peers: deployment.peers,
      initialSelection: deployment.initialSelection,
      allowedOrigins: deployment.allowedOrigins,
      ...(deployment.allowedHosts !== undefined
        ? { allowedHosts: deployment.allowedHosts }
        : {}),
      release,
    }
  } catch (error) {
    const unsubscribe = unsubscribeMouthEnvelopes
    unsubscribeMouthEnvelopes = null
    if (unsubscribe !== null) {
      try {
        unsubscribe()
      } catch {
        // The setup or build failure is the reportable error.
      }
    }
    try {
      disposeRenderer()
    } catch {
      // The setup or build failure is the reportable error.
    }
    if (acquisition !== null) {
      try {
        await acquisition.release()
      } catch {
        // The setup or build failure is the reportable error.
      }
    }
    throw error
  }
}

export default createProductionDeployment
