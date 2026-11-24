/**
 * Reference live production deployment.
 *
 * This module is the composition root for the reference live deployment: it
 * parses the deployment environment through `parseReferenceLiveConfig` and
 * supplies the real M3/M4/M1 peers the production application expects. The
 * environment parser is the only configuration entry point; this module adds no
 * fallback environment reads and silently defaults no required value.
 *
 * The heavy peers are reached through `ReferenceLiveFactories`. The exported
 * `buildReferenceDeployment` seam lets an offline test supply deterministic
 * fakes and a controlled clock, so no network, VTube Studio session, model load
 * or SQLite handle is created by the test suite. `createProductionDeployment`
 * uses the real factories: rule selection/reaction over the supplied clock, the
 * OpenAI-compatible dialogue text source, a VTube Studio renderer, Kokoro
 * synthesis over the audio-resource registry, and the real registry itself.
 *
 * The VTube Studio path acquires one authenticated connection at deployment
 * creation and wraps its hotkey driver with `createMappedRenderer`. Every
 * advertised capability action is exactly one hotkey-map key and every binding
 * maps that action id to its configured hotkey. Any renderer whose advertised
 * action set differs from the hotkey map fails at creation rather than
 * silently advertising an action the deployment cannot dispatch.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import type {
  CapabilitySnapshot,
  ClockPort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
  VoiceOption,
} from '../../contracts'
import { NO_OP_ACTION } from '../../contracts'
import { createRuleReactionPort } from '../../decision/reaction'
import { createRuleSelectionPort } from '../../decision/selection'
import type { DialogueTextSource } from '../../dialogue/dialogue-port'
import { createOpenAiCompatibleTextSource } from '../../dialogue/provider-text-source'
import type { AudioResourceRegistry } from '../../performance/audio-resources'
import { createAudioResourceRegistry } from '../../performance/audio-resources'
import type { ReceiptTools } from '../../performance/browser/types'
import type { KokoroProviderConfig } from '../../performance/kokoro-provider'
import { createKokoroProvider } from '../../performance/kokoro-provider'
import { createKokoroSynthesis } from '../../performance/kokoro-synthesis'
import type { KokoroProvider, KokoroVoiceProfile } from '../../performance/kokoro-types'
import { listInstalledKokoroVoices } from '../../performance/voice-catalog'
import { createMappedRenderer } from '../../performance/mapped-renderer'
import type { VtsAcquisition, VtsCredentialStore } from '../vts-acquisition'
import {
  createVtsAcquisition,
  createVtsCredentialCoordinator,
} from '../vts-acquisition'
import type { VtsConnectionHandle, VtsConnectionSocket } from '../../performance/vts-connection'
import { createVtsConnectionHandle } from '../../performance/vts-connection'
import type { VtsActionMapping, VtsRenderer } from '../../performance/vts-driver'
import { createVtsRenderer } from '../../performance/vts-driver'
import type { RuntimeDeadlineGate } from '../deadline'
import type {
  ProductionDeployment,
  ProductionDeploymentContext,
  ProductionPeers,
  ProductionVoice,
} from '../production'
import { createVoicePreview, VoicePreviewError } from '../voice-preview'
import {
  VOICE_PROFILE_VERSION,
  VoiceSettingsError,
  createJsonFileVoiceSettingsPersistence,
  createVoiceSettings,
  type VoiceProfile,
  type VoiceSettings,
  type VoiceSettingsState,
} from '../voice-settings'
import type { ReferenceLiveConfig } from './reference-live-config'
import { parseReferenceLiveConfig } from './reference-live-config'

/**
 * The reference deployment's fixed live identities. These are deployment
 * choices, not environment defaults: every configurable value still comes from
 * `parseReferenceLiveConfig`, and a missing value fails there. This registered
 * Elleya@2 profile is the one source for both the peer profile and the initial
 * live selection; the VTS character identity below is derived from it so the
 * capability snapshot cannot drift.
 */
const REFERENCE_CHARACTER_PROFILE = {
  profileId: 'Elleya',
  profileVersion: '2',
} as const

const REFERENCE_VOICE_PROFILE: KokoroVoiceProfile = {
  voiceProfileId: 'voice-reference',
  voiceProfileVersion: '1',
  providerVoiceId: 'af_heart',
  speed: 1,
}

/** The exact fixed sentence the console auditions at speed 1. */
const REFERENCE_VOICE_PREVIEW_TEXT = "Hi, I'm Elleya. It's good to see you."

/** Suffix of the sidecar JSON preference beside the configured database. */
const VOICE_SETTINGS_SUFFIX = '.voices.json'

const REFERENCE_KOKORO: Omit<KokoroProviderConfig, 'environment'> = {
  modelRoot: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  maxTokens: 512,
  voiceId: REFERENCE_VOICE_PROFILE.providerVoiceId,
  speed: REFERENCE_VOICE_PROFILE.speed,
}

/** Bundled Hiyori_A model id from M1 observations on issue #95; not re-measured by this PR. */
const REFERENCE_VTS_MODEL_ID = '00f9750080014d43bb398cd98e4f55ad'
const REFERENCE_VTS_RENDERER_ID = 'isla-reference-renderer'
const REFERENCE_VTS_CHARACTER_ID = REFERENCE_CHARACTER_PROFILE.profileId
const REFERENCE_VTS_CAPABILITY_REVISION = 1

/** The three reference actions pinned by README.md for the bundled Hiyori_A model. */
const REFERENCE_HOTKEY_ACTIONS = ['animation-1', 'animation-2', 'animation-3'] as const

const VTS_REQUEST_TIMEOUT_MS = 5_000
const VTS_MAX_PENDING = 8
const VTS_CLOSE_TIMEOUT_MS = 5_000
const VTS_ACQUISITION_TIMEOUT_MS = 30_000
const VTS_HUMAN_APPROVAL_TIMEOUT_MS = 60_000

const AUDIO_BYTE_BUDGET = 16 * 1024 * 1024
const AUDIO_RETENTION_MS = 5 * 60 * 1000

/** A renderer plus the deployment-owned cleanup for the connection it uses. */
export interface ReferenceRendererHandle {
  readonly renderer: RendererPort
  dispose(): void
}

export interface ReferenceRendererFactoryInput {
  readonly gate: RuntimeDeadlineGate
  readonly config: ReferenceLiveConfig
  readonly clock: ClockPort
  /** Ordered action-id/hotkey mappings derived from the config hotkey map. */
  readonly mappings: readonly VtsActionMapping[]
}

/** A synthesis adapter plus any provider cleanup the factory acquired. */
export interface ReferenceSynthesisHandle {
  readonly synthesis: SynthesisPort
  dispose?(): void | Promise<void>
}

export interface ReferenceSynthesisFactoryInput {
  readonly gate: RuntimeDeadlineGate
  readonly config: ReferenceLiveConfig
  readonly clock: ClockPort
  readonly registry: AudioResourceRegistry
}

/**
 * Injectable seam over every external peer. Omitted entries use the real
 * production factory; an offline test supplies fakes so no live connection,
 * model load or registry bytes are created.
 */
export interface ReferenceLiveFactories {
  readonly createSelection?: (clock: ClockPort) => SelectionPort
  readonly createReaction?: (clock: ClockPort) => ReactionPort
  readonly createTextSource?: (text: ReferenceLiveConfig['text']) => DialogueTextSource
  readonly createAudioResources?: (clock: ClockPort) => AudioResourceRegistry
  readonly createRenderer?: (input: ReferenceRendererFactoryInput) => ReferenceRendererHandle
  readonly createSynthesis?: (input: ReferenceSynthesisFactoryInput) => ReferenceSynthesisHandle
}

type Disposer = () => void | Promise<void>

interface RebindableGate extends RuntimeDeadlineGate {
  retarget(gate: RuntimeDeadlineGate): void
}

/**
 * A gate proxy that forwards each bind to the composition gate most recently
 * installed by `createRenderer`/`createSynthesis`. The reference deployment owns
 * one long-lived VTS connection and one long-lived Kokoro adapter, so the
 * per-composition gate is supplied at composition build time rather than at
 * deployment creation.
 */
function createRebindableGate(): RebindableGate {
  let target: RuntimeDeadlineGate | null = null
  return {
    retarget(gate) {
      target = gate
    },
    bind(context) {
      if (target === null) {
        throw new Error('reference-live: no composition deadline gate has been installed')
      }
      return target.bind(context)
    },
    dispose() {
      target = null
    },
  }
}

/**
 * Serialize all work over the one shared Kokoro model.
 *
 * Official replies retain priority: a preview started while speech is active or
 * waiting is refused immediately as `busy`, so normal speech never queues behind
 * a new audition. If a preview is already physically running when speech starts,
 * official work waits for that one real generation to settle; the provider has
 * no cancellation API, so no second call is ever started concurrently.
 */
interface SharedKokoroWork {
  readonly official: KokoroProvider
  readonly preview: KokoroProvider
  idle(): Promise<void>
}

function createSharedKokoroWork(provider: KokoroProvider): SharedKokoroWork {
  let tail: Promise<void> = Promise.resolve()
  let officialWaiting = 0
  let officialActive = 0
  let previewActive = 0

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const official: KokoroProvider = {
    generate(input) {
      officialWaiting += 1
      return enqueue(async () => {
        officialWaiting -= 1
        officialActive += 1
        try {
          return await provider.generate(input)
        } finally {
          officialActive -= 1
        }
      })
    },
  }

  const preview: KokoroProvider = {
    generate(input) {
      if (officialWaiting > 0 || officialActive > 0 || previewActive > 0) {
        return Promise.reject(
          new VoicePreviewError(
            'busy',
            'reference-live: a speech or preview generation is already running',
          ),
        )
      }
      previewActive += 1
      return enqueue(async () => {
        try {
          return await provider.generate(input)
        } finally {
          previewActive -= 1
        }
      })
    },
  }

  return {
    official,
    preview,
    async idle() {
      let observed = tail
      for (;;) {
        await observed
        if (observed === tail) return
        observed = tail
      }
    },
  }
}

/**
 * A readable but unavailable preference store. Listing and previewing remain
 * possible, while an adoption attempt reports `persistence_failed` and official
 * speech falls back to the fixed legacy profile.
 */
function createUnavailableVoiceSettings(
  voices: readonly VoiceOption[],
  cause: unknown,
): VoiceSettings {
  const state: VoiceSettingsState = Object.freeze({
    selectedVoiceId: null,
    voices: Object.freeze([...voices]),
  })
  const unavailable = (): never => {
    throw new VoiceSettingsError(
      'persistence_failed',
      'reference-live: voice preference storage is unavailable',
      { cause },
    )
  }
  return Object.freeze({
    state: () => state,
    select: async () => unavailable(),
    currentVoiceProfile: (): VoiceProfile => unavailable(),
  })
}

/**
 * Refuse a reference map that is not exactly the three actions pinned by the
 * README. The deployment owns the action set, so a missing or unexpected action
 * fails at build time instead of silently advertising an un-dispatchable action.
 */
function assertReferenceHotkeyActions(mappings: readonly VtsActionMapping[]): void {
  const expected = new Set<string>(REFERENCE_HOTKEY_ACTIONS)
  const actual = new Set(mappings.map((mapping) => mapping.actionId))
  const differences = [
    ...REFERENCE_HOTKEY_ACTIONS.filter((actionId) => !actual.has(actionId)).map(
      (actionId) => `missing action ${actionId}`,
    ),
    ...[...actual]
      .filter((actionId) => !expected.has(actionId))
      .map((actionId) => `unexpected action ${actionId}`),
  ]
  if (differences.length > 0) {
    throw new Error(
      `reference-live: hotkey map must contain exactly ${REFERENCE_HOTKEY_ACTIONS.join(', ')}: ${differences.join('; ')}`,
    )
  }
}

/**
 * Derive the exact ordered mappings from the configured hotkey map. The config
 * parser already trims and validates each key and value; this check keeps the
 * build seam honest when it is called with a hand-built config and refuses an
 * empty, ambiguous or non-reference action map before any provider is contacted.
 */
function toMappings(hotkeyMap: Readonly<Record<string, string>>): readonly VtsActionMapping[] {
  const entries = Object.entries(hotkeyMap)
  if (entries.length === 0) {
    throw new Error('reference-live: hotkey map must configure at least one action')
  }
  const seenHotkeys = new Set<string>()
  const mappings: VtsActionMapping[] = []
  for (const [actionId, hotkeyId] of entries) {
    if (actionId.trim().length === 0) {
      throw new Error('reference-live: hotkey map contains an empty action id')
    }
    if (hotkeyId.trim().length === 0) {
      throw new Error(`reference-live: hotkey map has no hotkey for action ${actionId}`)
    }
    if (actionId === NO_OP_ACTION) {
      throw new Error('reference-live: the no-op action must not be mapped to a hotkey')
    }
    if (seenHotkeys.has(hotkeyId)) {
      throw new Error(`reference-live: hotkey ${hotkeyId} is mapped more than once`)
    }
    seenHotkeys.add(hotkeyId)
    mappings.push({ actionId, hotkeyId })
  }
  assertReferenceHotkeyActions(mappings)
  return mappings
}

/**
 * Refuse a renderer whose advertised action set is not exactly the configured
 * hotkey-map keys. A driver cannot silently advertise an unconfigured action,
 * and a configured action always remains dispatchable.
 */
function assertRendererAdvertisesExactly(
  renderer: RendererPort,
  mappings: readonly VtsActionMapping[],
): void {
  const advertised = renderer.capabilities().actions.map((action) => action.actionId)
  const expected = mappings.map((mapping) => mapping.actionId)
  const expectedSet = new Set(expected)
  const advertisedSet = new Set(advertised)
  for (const actionId of advertised) {
    if (!expectedSet.has(actionId)) {
      throw new Error(`reference-live: renderer advertises unconfigured action ${actionId}`)
    }
  }
  for (const actionId of expected) {
    if (!advertisedSet.has(actionId)) {
      throw new Error(`reference-live: renderer does not advertise configured action ${actionId}`)
    }
  }
  if (advertised.length !== expected.length) {
    throw new Error('reference-live: renderer advertises a different action set than the hotkey map')
  }
}

function buildCapabilitySnapshot(mappings: readonly VtsActionMapping[]): CapabilitySnapshot {
  return {
    rendererId: REFERENCE_VTS_RENDERER_ID,
    characterId: REFERENCE_VTS_CHARACTER_ID,
    capabilityRevision: REFERENCE_VTS_CAPABILITY_REVISION,
    actions: mappings.map((mapping) => ({
      actionId: mapping.actionId,
      description: `VTube Studio hotkey action ${mapping.actionId}`,
      observability: 'acceptance-only' as const,
      parameterBounds: [],
    })),
  }
}

function kokoroProviderConfig(config: ReferenceLiveConfig): KokoroProviderConfig {
  return {
    ...REFERENCE_KOKORO,
    environment: {
      localModelPath: config.kokoroModelDir,
      cacheDir: config.kokoroModelDir,
    },
  }
}

/**
 * A credential store backed by the configured token file. The acquisition
 * lifecycle owns serialization and binds the frozen plugin identity/target
 * record; this store only reads and writes the deployment's token path.
 */
function createTokenFileCredentialStore(tokenPath: string): VtsCredentialStore {
  return {
    async load(_record, signal) {
      if (signal.aborted) {
        throw new Error('reference-live: VTS credential load was aborted')
      }
      try {
        const value = readFileSync(tokenPath, 'utf8').trim()
        return value.length > 0 ? value : null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('reference-live: VTS credential could not be read')
      }
    },
    async save(_record, value, signal) {
      if (signal.aborted) {
        throw new Error('reference-live: VTS credential save was aborted')
      }
      writeFileSync(tokenPath, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  }
}

/** Open one WebSocket and adapt it to the offline D1 connection handle. */
function openVtsSocket(wsUrl: string, _signal: AbortSignal): Promise<VtsConnectionHandle> {
  return new Promise<VtsConnectionHandle>((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let settled = false
    const cleanup = (): void => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onOpen = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(
          createVtsConnectionHandle({
            socket: socket as unknown as VtsConnectionSocket,
            closeTimeoutMs: VTS_CLOSE_TIMEOUT_MS,
          }),
        )
      } catch (error) {
        try {
          socket.close()
        } catch {
          // The socket is already unusable; the creation error is the report.
        }
        reject(error)
      }
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`reference-live: VTS socket failed before open: ${error.message}`))
    }
    const onClose = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('reference-live: VTS socket closed before open'))
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

interface AcquiredVts {
  readonly acquisition: VtsAcquisition
  readonly handle: VtsConnectionHandle
}

/** Perform one bounded VTS acquisition attempt over the configured endpoint. */
async function acquireReferenceVts(config: ReferenceLiveConfig): Promise<AcquiredVts> {
  const acquisition = createVtsAcquisition({
    connect: (signal) => openVtsSocket(config.vts.wsUrl, signal),
    credentials: createVtsCredentialCoordinator(
      createTokenFileCredentialStore(config.vts.tokenPath),
    ),
    identity: {
      pluginName: config.vts.pluginName,
      pluginDeveloper: config.vts.pluginDeveloper,
    },
    target: config.vts.wsUrl,
    mode: 'allow-prompt',
    acquisitionTimeoutMs: VTS_ACQUISITION_TIMEOUT_MS,
    requestTimeoutMs: VTS_REQUEST_TIMEOUT_MS,
    humanApprovalTimeoutMs: VTS_HUMAN_APPROVAL_TIMEOUT_MS,
  })
  const result = await acquisition.acquire()
  if (result.kind === 'acquired') {
    return { acquisition, handle: result.handle }
  }
  const outcome = await acquisition.release()
  if (result.kind === 'failed') {
    throw new Error(
      `reference-live: VTS acquisition failed at ${result.stage}: ${result.reason} (release ${outcome})`,
    )
  }
  throw new Error(`reference-live: VTS acquisition was refused: ${result.reason}`)
}

/**
 * Build the deployment from an already parsed configuration. The factories are
 * an explicit test seam; production calls this with `{}` and the real peers.
 * When the real Kokoro path is used and an explicit `databasePath` is supplied,
 * the deployment also owns voice settings (persisted in a `<databasePath>.voices.json`
 * sidecar), the installed-voice catalog and the fixed-text preview capability.
 * A failed build releases every resource acquired up to that point before the
 * original failure is rethrown.
 */
export async function buildReferenceDeployment(
  config: ReferenceLiveConfig,
  factories: ReferenceLiveFactories,
  clock: ClockPort,
  databasePath?: string,
): Promise<ProductionDeployment> {
  const mappings = toMappings(config.hotkeyMap)
  const disposers: Disposer[] = []
  let releaseStarted: Promise<void> | null = null

  const release = (): Promise<void> => {
    if (releaseStarted !== null) {
      // A repeated call never re-runs cleanup and never throws: the first call
      // already reported any fault through the owned lifecycle contract.
      return releaseStarted.then(
        () => undefined,
        () => undefined,
      )
    }
    releaseStarted = (async () => {
      const failures: unknown[] = []
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, 'reference-live: release failed')
      }
    })()
    return releaseStarted
  }

  try {
    const selection =
      factories.createSelection !== undefined
        ? factories.createSelection(clock)
        : createRuleSelectionPort({ clock })
    const reaction =
      factories.createReaction !== undefined
        ? factories.createReaction(clock)
        : createRuleReactionPort({ clock })
    const textSource =
      factories.createTextSource !== undefined
        ? factories.createTextSource(config.text)
        : createOpenAiCompatibleTextSource(config.text)
    const audioResources = (
      factories.createAudioResources ??
      ((runtimeClock: ClockPort) =>
        createAudioResourceRegistry({
          clock: runtimeClock,
          byteBudget: AUDIO_BYTE_BUDGET,
          retentionMs: AUDIO_RETENTION_MS,
        }))
    )(clock)
    disposers.push(() => audioResources.dispose())

    let createSynthesis: (gate: RuntimeDeadlineGate) => SynthesisPort
    // Voice selection is an optional deployment capability. It is only built
    // for the real Kokoro path with an explicit durable preference sidecar, so
    // older custom-synthesis factory tests remain model- and filesystem-free.
    let voice: ProductionVoice | undefined
    if (factories.createSynthesis !== undefined) {
      const synthesisFactory = factories.createSynthesis
      createSynthesis = (gate) => {
        const handle = synthesisFactory({
          gate,
          config,
          clock,
          registry: audioResources,
        })
        if (handle.dispose !== undefined) {
          disposers.push(() => handle.dispose?.())
        }
        return handle.synthesis
      }
    } else {
      const provider = await createKokoroProvider(kokoroProviderConfig(config))
      const work = createSharedKokoroWork(provider)
      const installedVoices = listInstalledKokoroVoices()
      const profiles: readonly KokoroVoiceProfile[] = [
        ...installedVoices.map((entry) => ({
          voiceProfileId: entry.id,
          voiceProfileVersion: VOICE_PROFILE_VERSION,
          providerVoiceId: entry.id,
          speed: 1,
        })),
        // Preserve the old public profile tuple for callers and profiles that
        // predate explicit selection.
        REFERENCE_VOICE_PROFILE,
      ]
      const synthesisGate = createRebindableGate()
      const synthesis = createKokoroSynthesis({
        provider: work.official,
        profiles,
        registry: audioResources,
        clock,
        deadlineGate: synthesisGate,
      })
      createSynthesis = (gate) => {
        synthesisGate.retarget(gate)
        return synthesis
      }
      if (
        databasePath !== undefined &&
        databasePath.length > 0 &&
        installedVoices.length > 0
      ) {
        let settings: VoiceSettings
        try {
          settings = await createVoiceSettings({
            voices: installedVoices,
            persistence: createJsonFileVoiceSettingsPersistence(
              `${databasePath}${VOICE_SETTINGS_SUFFIX}`,
            ),
          })
        } catch (error) {
          // Official speech remains available; the console gets a readable
          // storage refusal on adoption instead of a fabricated selection.
          settings = createUnavailableVoiceSettings(installedVoices, error)
        }
        voice = {
          settings,
          preview: createVoicePreview({
            provider: work.preview,
            text: REFERENCE_VOICE_PREVIEW_TEXT,
            speed: 1,
          }),
        }
      }
      disposers.push(async () => {
        await synthesis.whenIdle()
        await work.idle()
      })
    }

    let createRenderer: (gate: RuntimeDeadlineGate) => RendererPort
    if (factories.createRenderer !== undefined) {
      const rendererFactory = factories.createRenderer
      createRenderer = (gate) => {
        const handle = rendererFactory({ gate, config, clock, mappings })
        disposers.push(() => handle.dispose())
        assertRendererAdvertisesExactly(handle.renderer, mappings)
        return handle.renderer
      }
    } else {
      const acquired = await acquireReferenceVts(config)
      let vtsRenderer: VtsRenderer | null = null
      disposers.push(async () => {
        vtsRenderer?.dispose()
        const outcome = await acquired.acquisition.release()
        if (outcome !== 'stopped') {
          throw new Error(`reference-live: VTS connection release finished as ${outcome}`)
        }
      })

      const vtsGate = createRebindableGate()
      let receiptSequence = 0
      const receipts: ReceiptTools = {
        newReceiptId: () => `vts-receipt-${(receiptSequence += 1)}`,
        localNowMs: () => clock.nowMs(),
      }
      vtsRenderer = createVtsRenderer({
        transport: acquired.handle.transport,
        modelId: REFERENCE_VTS_MODEL_ID,
        rendererId: REFERENCE_VTS_RENDERER_ID,
        characterId: REFERENCE_VTS_CHARACTER_ID,
        capabilityRevision: REFERENCE_VTS_CAPABILITY_REVISION,
        mappings,
        timeoutMs: VTS_REQUEST_TIMEOUT_MS,
        maxPending: VTS_MAX_PENDING,
        deadlineGate: vtsGate,
        receipts,
      })
      // `createVtsRenderer` already composes a mapped renderer around its VTS
      // driver. Rebuild that composition here so the advertised actions and
      // bindings are visibly derived from the same config hotkey map.
      const renderer = createMappedRenderer({
        snapshot: buildCapabilitySnapshot(mappings),
        bindings: mappings.map((mapping) => ({
          actionId: mapping.actionId,
          driverAction: mapping.hotkeyId,
        })),
        driver: vtsRenderer.driver,
        deadlineGate: vtsGate,
        receipts,
      })
      assertRendererAdvertisesExactly(renderer, mappings)
      createRenderer = (gate) => {
        vtsGate.retarget(gate)
        return renderer
      }
    }

    const peers: ProductionPeers = {
      selection,
      reaction,
      textSource,
      createRenderer,
      createSynthesis,
      audioResources,
      ...(voice !== undefined ? { voice } : {}),
      profile: {
        characterProfileId: REFERENCE_CHARACTER_PROFILE.profileId,
        characterProfileVersion: REFERENCE_CHARACTER_PROFILE.profileVersion,
        voiceProfileId: REFERENCE_VOICE_PROFILE.voiceProfileId,
        voiceProfileVersion: REFERENCE_VOICE_PROFILE.voiceProfileVersion,
      },
    }

    return {
      peers,
      initialSelection: {
        // A fresh live session: no archive source reuses this id and the
        // catalogue starts empty. Archive reconstruction remains operator
        // configuration, not a silent deployment default.
        liveSessionId: `session-${randomUUID()}`,
        liveProfile: {
          profileId: REFERENCE_CHARACTER_PROFILE.profileId,
          profileVersion: REFERENCE_CHARACTER_PROFILE.profileVersion,
        },
        selectedSources: [],
        catalogue: new Map(),
      },
      allowedOrigins: config.allowedOrigins,
      allowedHosts: config.allowedHosts,
      release,
    }
  } catch (error) {
    try {
      await release()
    } catch {
      // The build failure is the reportable error; cleanup faults do not
      // replace it.
    }
    throw error
  }
}

/** Production deployment module entry loaded by the runtime CLI. */
export async function createProductionDeployment(
  context: ProductionDeploymentContext,
): Promise<ProductionDeployment> {
  const config = parseReferenceLiveConfig(context.env)
  return buildReferenceDeployment(config, {}, context.clock, context.databasePath)
}

export default createProductionDeployment
