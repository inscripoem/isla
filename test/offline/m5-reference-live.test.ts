import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  CallContext,
  CapabilitySnapshot,
  ClockPort,
  DecisionRequest,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SelectionRequest,
  SynthesisPort,
} from '../../src/contracts'
import {
  JevReactionError,
  JevSelectionError,
  ProviderReactionError,
  ProviderSelectionError,
  isLiveJevReactionPort,
  isLiveJevSelectionPort,
  isLiveProviderSelectionPort,
  isRuleSelectionPort,
} from '../../src/decision'
import type { DialogueTextSource } from '../../src/dialogue/dialogue-port'
import type { AudioResourceRegistry } from '../../src/performance/audio-resources'
import { createDeadlineGate } from '../../src/runtime/deadline'
import type {
  ReferenceLiveFactories,
  ReferenceRendererHandle,
  ReferenceSynthesisHandle,
} from '../../src/runtime/deployments/reference-live'
import {
  buildReferenceDeployment,
  createProductionDeployment,
} from '../../src/runtime/deployments/reference-live'
import { parseReferenceLiveConfig } from '../../src/runtime/deployments/reference-live-config'

/**
 * Offline contract for the reference live deployment module.
 *
 * Every heavy peer is an injected fake: these tests never open a WebSocket,
 * contact VTube Studio, load a Kokoro model, read a credential file or open
 * SQLite. They verify the deployment seam, the exact pass-through of parsed
 * configuration, the action/hotkey agreement check and the idempotent release.
 */

const REFERENCE_HOTKEYS: Record<string, string> = {
  'animation-1': 'b66cf516d694446b9e1aafbcf16459a9',
  'animation-2': 'c28e206b5e3c4eb5be3c1dcee11f02c0',
  'animation-3': 'ad4e0bc1a58746a58002ad180692e649',
}

function validEnv(): Record<string, string> {
  return {
    ISLA_LIVE_TEXT_BASE_URL: 'https://text.example.test/v1',
    ISLA_LIVE_TEXT_MODEL: 'reference-model',
    ISLA_LIVE_TEXT_API_KEY: 'sk-live-example-value',
    ISLA_VTS_WS_URL: 'wss://vts.example.test:8001',
    ISLA_VTS_PLUGIN_NAME: 'Reference Plugin',
    ISLA_VTS_PLUGIN_DEVELOPER: 'Reference Studio',
    ISLA_VTS_TOKEN_PATH: '/run/secrets/vts-token',
    ISLA_VTS_HOTKEY_MAP: JSON.stringify(REFERENCE_HOTKEYS),
    ISLA_KOKORO_MODEL_DIR: '/models/kokoro',
    ISLA_ALLOWED_ORIGINS: 'https://app.example.test,https://admin.example.test',
    ISLA_ALLOWED_HOSTS: 'app.example.test,admin.example.test',
  }
}

function fixedClock(value = 1_000): ClockPort {
  return { nowMs: () => value }
}

function generalEnv(): Record<string, string> {
  return {
    ...validEnv(),
    ISLA_DECISION_MODE: 'general',
    ISLA_LIVE_DECISION_BASE_URL: 'https://decision.example.test/v1',
    ISLA_LIVE_DECISION_MODEL: 'general-model-id',
    ISLA_LIVE_DECISION_API_KEY: 'sk-decision-example-value',
  }
}

function jevEnv(): Record<string, string> {
  return {
    ...validEnv(),
    ISLA_DECISION_MODE: 'jev',
    ISLA_LIVE_JEV_BASE_URL: 'https://jev.example.test/v1',
    ISLA_LIVE_JEV_MODEL: 'jev-model-id',
    ISLA_LIVE_JEV_API_KEY: 'sk-jev-example-value',
  }
}

const fakeSelection = {
  async select() {
    throw new Error('fake selection is not used')
  },
} as unknown as SelectionPort

const fakeReaction = {
  async decide() {
    throw new Error('fake reaction is not used')
  },
} as unknown as ReactionPort

const fakeTextSource = {
  model: 'fake-model',
  modelVersion: 'fake-v1',
  resolvedModel: null,
  async compose() {
    return { lines: [] }
  },
} as unknown as DialogueTextSource

const fakeSynthesis = {
  async prepare() {
    throw new Error('fake synthesis is not used')
  },
  async whenIdle() {
    return undefined
  },
} as unknown as SynthesisPort

function fakeCapabilities(actions: readonly string[]): CapabilitySnapshot {
  return {
    rendererId: 'fake-renderer',
    characterId: 'fake-character',
    capabilityRevision: 1,
    actions: actions.map((actionId) => ({
      actionId,
      description: `fake ${actionId}`,
      observability: 'acceptance-only' as const,
      parameterBounds: [],
    })),
  }
}

function fakeRenderer(actions: readonly string[]): RendererPort {
  return {
    capabilities: () => fakeCapabilities(actions),
    async execute() {
      throw new Error('fake renderer execute is not used')
    },
  } as unknown as RendererPort
}

function fakeRegistry(onDispose: () => void): AudioResourceRegistry {
  return {
    register() {
      throw new Error('fake registry register is not used')
    },
    retire() {
      return false
    },
    retireBefore() {
      return 0
    },
    retireSession() {
      return 0
    },
    collectExpired() {
      return 0
    },
    dispose: onDispose,
    admission() {
      return null
    },
    resolve() {
      return Promise.reject(new Error('fake registry resolve is not used'))
    },
    snapshot() {
      return {
        disposed: false,
        byteBudget: 1,
        usedBytes: 0,
        activeCount: 0,
        leasedCount: 0,
        retiredSessions: {},
        resources: [],
      }
    },
  } as unknown as AudioResourceRegistry
}

function fakeFactories(
  disposed: string[],
  rendererActions?: readonly string[],
): ReferenceLiveFactories {
  return {
    createSelection: () => fakeSelection,
    createReaction: () => fakeReaction,
    createTextSource: () => fakeTextSource,
    createAudioResources: () =>
      fakeRegistry(() => {
        disposed.push('registry')
      }),
    createRenderer: (input): ReferenceRendererHandle => ({
      renderer: fakeRenderer(rendererActions ?? input.mappings.map((mapping) => mapping.actionId)),
      dispose: () => {
        disposed.push('renderer')
      },
    }),
    createSynthesis: (): ReferenceSynthesisHandle => ({
      synthesis: fakeSynthesis,
      dispose: () => {
        disposed.push('synthesis')
      },
    }),
  }
}

/**
 * The heavy peers only. Selection and reaction are left to the configured
 * decision mode so the test observes which ports the deployment really builds.
 */
function fakePeerFactories(disposed: string[]): ReferenceLiveFactories {
  return {
    createTextSource: () => fakeTextSource,
    createAudioResources: () =>
      fakeRegistry(() => {
        disposed.push('registry')
      }),
    createRenderer: (input): ReferenceRendererHandle => ({
      renderer: fakeRenderer(input.mappings.map((mapping) => mapping.actionId)),
      dispose: () => {
        disposed.push('renderer')
      },
    }),
    createSynthesis: (): ReferenceSynthesisHandle => ({
      synthesis: fakeSynthesis,
      dispose: () => {
        disposed.push('synthesis')
      },
    }),
  }
}

describe('reference live deployment', () => {
  it('builds from injected factories, passes config through and releases owned resources once', async () => {
    const config = parseReferenceLiveConfig(validEnv())
    const clock = fixedClock()
    const disposed: string[] = []

    const deployment = await buildReferenceDeployment(config, fakeFactories(disposed), clock)

    expect(deployment.allowedOrigins).toEqual(config.allowedOrigins)
    expect(deployment.allowedHosts).toEqual(config.allowedHosts)
    expect(deployment.initialSelection.liveSessionId).toMatch(/^session-/)
    expect(deployment.initialSelection.liveProfile).toEqual({
      profileId: 'Elleya',
      profileVersion: '2',
    })
    expect(deployment.initialSelection.selectedSources).toEqual([])
    expect(deployment.initialSelection.catalogue.size).toBe(0)
    expect(deployment.peers.profile).toMatchObject({
      characterProfileId: 'Elleya',
      characterProfileVersion: '2',
    })
    expect(deployment.peers.selection).toBe(fakeSelection)
    expect(deployment.peers.reaction).toBe(fakeReaction)
    expect(deployment.peers.textSource).toBe(fakeTextSource)
    expect(deployment.peers.audioResources).toBeDefined()

    // The lazy peer factories are the deployment-owned resources; create them
    // before release so their cleanup is observable.
    const gate = createDeadlineGate(clock)
    expect(deployment.peers.createRenderer(gate)).toBeDefined()
    expect(deployment.peers.createSynthesis(gate)).toBeDefined()

    expect(deployment.release).toBeTypeOf('function')
    await deployment.release?.()
    await deployment.release?.()

    expect(disposed.filter((name) => name === 'renderer')).toHaveLength(1)
    expect(disposed.filter((name) => name === 'synthesis')).toHaveLength(1)
    expect(disposed.filter((name) => name === 'registry')).toHaveLength(1)
    gate.dispose()
  })

  it('uses the rule decision ports by default', async () => {
    const config = parseReferenceLiveConfig(validEnv())
    const deployment = await buildReferenceDeployment(
      config,
      fakePeerFactories([]),
      fixedClock(),
    )

    expect(isRuleSelectionPort(deployment.peers.selection)).toBe(true)
    expect(isLiveProviderSelectionPort(deployment.peers.selection)).toBe(false)

    await deployment.release?.()
  })

  it('builds OpenAI-compatible decision ports for the general model', async () => {
    const config = parseReferenceLiveConfig(generalEnv())
    const deployment = await buildReferenceDeployment(
      config,
      fakePeerFactories([]),
      fixedClock(),
    )

    expect(config.decision?.mode).toBe('general')
    expect(isLiveProviderSelectionPort(deployment.peers.selection)).toBe(true)
    expect(isLiveJevSelectionPort(deployment.peers.selection)).toBe(false)
    expect(isRuleSelectionPort(deployment.peers.selection)).toBe(false)
    // No signal is the first validated fault, so both calls refuse before any
    // transport attempt; construction alone never contacts the provider.
    await expect(
      deployment.peers.selection.select({} as SelectionRequest, {} as CallContext),
    ).rejects.toBeInstanceOf(ProviderSelectionError)
    await expect(
      deployment.peers.reaction.decide({} as DecisionRequest, {} as CallContext),
    ).rejects.toBeInstanceOf(ProviderReactionError)

    await deployment.release?.()
  })

  it('builds Jev decisions ports for the dedicated Jev configuration', async () => {
    const config = parseReferenceLiveConfig(jevEnv())
    const deployment = await buildReferenceDeployment(
      config,
      fakePeerFactories([]),
      fixedClock(),
    )

    expect(config.decision).toEqual({
      mode: 'jev',
      provider: {
        baseUrl: 'https://jev.example.test/v1',
        model: 'jev-model-id',
        apiKey: 'sk-jev-example-value',
      },
    })
    // Jev is a classifier on POST /v1/decisions, not an OpenAI chat model.
    expect(isLiveJevSelectionPort(deployment.peers.selection)).toBe(true)
    expect(isLiveJevReactionPort(deployment.peers.reaction)).toBe(true)
    expect(isLiveProviderSelectionPort(deployment.peers.selection)).toBe(false)
    // No signal is the first validated fault, so both calls refuse before any
    // transport attempt; construction alone never contacts the provider.
    await expect(
      deployment.peers.selection.select({} as SelectionRequest, {} as CallContext),
    ).rejects.toBeInstanceOf(JevSelectionError)
    await expect(
      deployment.peers.reaction.decide({} as DecisionRequest, {} as CallContext),
    ).rejects.toBeInstanceOf(JevReactionError)

    await deployment.release?.()
  })

  it('keeps injected decision factories ahead of the configured mode', async () => {
    const config = parseReferenceLiveConfig(jevEnv())
    const deployment = await buildReferenceDeployment(
      config,
      fakeFactories([]),
      fixedClock(),
    )

    expect(deployment.peers.selection).toBe(fakeSelection)
    expect(deployment.peers.reaction).toBe(fakeReaction)
    expect(isLiveProviderSelectionPort(deployment.peers.selection)).toBe(false)

    await deployment.release?.()
  })

  it('keeps custom-synthesis factory builds voice-free even with a database path', async () => {
    const config = parseReferenceLiveConfig(validEnv())
    const directory = mkdtempSync(join(tmpdir(), 'isla-reference-voice-'))
    const databasePath = join(directory, 'isla.db')
    try {
      const deployment = await buildReferenceDeployment(
        config,
        fakeFactories([]),
        fixedClock(),
        databasePath,
      )

      expect(deployment.peers.voice).toBeUndefined()
      expect(existsSync(`${databasePath}.voices.json`)).toBe(false)
      expect(existsSync(databasePath)).toBe(false)
      await deployment.release?.()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails loudly when a hand-built configuration has an empty hotkey map', async () => {
    const config = { ...parseReferenceLiveConfig(validEnv()), hotkeyMap: {} }

    await expect(buildReferenceDeployment(config, {}, fixedClock())).rejects.toThrow(/hotkey map/)
  })

  it('fails closed when the reference hotkey map is missing a pinned action', async () => {
    const hotkeys = { ...REFERENCE_HOTKEYS }
    delete hotkeys['animation-3']
    const env = validEnv()
    env.ISLA_VTS_HOTKEY_MAP = JSON.stringify(hotkeys)
    const config = parseReferenceLiveConfig(env)

    await expect(buildReferenceDeployment(config, {}, fixedClock())).rejects.toThrow(
      /missing action animation-3/,
    )
  })

  it('fails closed when the reference hotkey map has an unexpected action', async () => {
    const env = validEnv()
    env.ISLA_VTS_HOTKEY_MAP = JSON.stringify({
      ...REFERENCE_HOTKEYS,
      'animation-4': 'd00d0000000000000000000000000000',
    })
    const config = parseReferenceLiveConfig(env)

    await expect(buildReferenceDeployment(config, {}, fixedClock())).rejects.toThrow(
      /unexpected action animation-4/,
    )
  })

  it('fails loudly when the VTS renderer advertises an unconfigured action', async () => {
    const config = parseReferenceLiveConfig(validEnv())
    const clock = fixedClock()
    const disposed: string[] = []
    const deployment = await buildReferenceDeployment(
      config,
      fakeFactories(disposed, ['animation-1', 'animation-2', 'animation-3', 'unconfigured-action']),
      clock,
    )
    const gate = createDeadlineGate(clock)

    expect(() => deployment.peers.createRenderer(gate)).toThrow(/unconfigured action/)

    await deployment.release?.()
    expect(disposed.filter((name) => name === 'renderer')).toHaveLength(1)
    expect(disposed.filter((name) => name === 'registry')).toHaveLength(1)
    gate.dispose()
  })

  it('fails through the production factory when configuration is missing', async () => {
    await expect(
      createProductionDeployment({
        clock: fixedClock(),
        databasePath: '/tmp/isla-reference-live.db',
        env: {},
      }),
    ).rejects.toThrow(/missing or invalid environment variables: .*ISLA_VTS_HOTKEY_MAP/)
  })
})
