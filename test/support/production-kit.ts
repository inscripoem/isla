import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import type {
  ClockPort,
  EventStorePort,
  ReactionPort,
  RendererPort,
  SelectionPort,
  SynthesisPort,
} from '../../src/contracts'
import type { DialogueTextSource } from '../../src/dialogue'
import type { RendererDriver } from '../../src/performance/mapped-renderer'
import { createMappedRenderer } from '../../src/performance/mapped-renderer'
import { createFixedSynthesis } from '../../src/performance/fixed-synthesis'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import type { DialogueOutcomeObserver } from '../../src/runtime/dialogue-outcome'
import type {
  ProductionAudioResources,
  ProductionDeployment,
  ProductionDeploymentContext,
  ProductionPeers,
} from '../../src/runtime/production'
import { createFixtureReactionPort, createFixtureSelectionPort } from './correct-ports'
import { fixtureCapabilitySnapshot, fixtureCommitDelivery, fixtureRuntimeEvent } from './fixture-data'
import { createCatalogDialogueTextSource } from './m4-kit'
import {
  M1_FIXTURE_VOICE_ID,
  M1_FIXTURE_VOICE_VERSION,
  createM1ActualAssetEntries,
} from './m1-kit'

/**
 * Test-only peers for the production application and the production CLI.
 *
 * The composition itself is the real production one; only the peer modules are
 * substitutes (M3 fixture selection/reaction, the M4 catalog text source and the
 * M1 fixed synthesis). This module is never imported by production code.
 */

export const TEST_DEPLOYMENT_ORIGIN = 'http://127.0.0.1:4173'

/** A renderer driver that reports only a local acceptance; it fabricates no avatar completion. */
function createAcceptanceDriver(): RendererDriver {
  return {
    async dispatch() {
      return { stage: 'accepted', reasonCode: 'test-acceptance', localTimeMs: null }
    },
  }
}

export interface TestProductionPeersOptions {
  clock: ClockPort
  selection?: SelectionPort
  reaction?: ReactionPort
  textSource?: DialogueTextSource
  createRenderer?: (gate: RuntimeDeadlineGate) => RendererPort
  createSynthesis?: (gate: RuntimeDeadlineGate) => SynthesisPort
  audioResources?: ProductionAudioResources
  /**
   * Observes every per-composition gate handed to the renderer or synthesis
   * factory, so a test can prove one gate per composition and a fresh gate for
   * each successor.
   */
  onGate?: (gate: RuntimeDeadlineGate, role: 'renderer' | 'synthesis') => void
  /** Observational dialogue generation/discard consumer; see `ProductionPeers`. */
  onDialogueOutcome?: DialogueOutcomeObserver
}

export function createTestProductionPeers(options: TestProductionPeersOptions): ProductionPeers {
  const clock = options.clock
  let receiptCounter = 0

  const defaultRenderer = (gate: RuntimeDeadlineGate): RendererPort =>
    createMappedRenderer({
      snapshot: fixtureCapabilitySnapshot(),
      bindings: [
        { actionId: 'neutral', driverAction: 'browser:neutral' },
        { actionId: 'smile', driverAction: 'browser:smile' },
      ],
      driver: createAcceptanceDriver(),
      deadlineGate: gate,
      receipts: {
        newReceiptId: () => `avatar-${(receiptCounter += 1)}`,
        localNowMs: () => null,
      },
    })

  const defaultSynthesis = (_gate: RuntimeDeadlineGate): SynthesisPort =>
    createFixedSynthesis({ entries: createM1ActualAssetEntries(), clock })

  const rendererFactory = options.createRenderer ?? defaultRenderer
  const synthesisFactory = options.createSynthesis ?? defaultSynthesis

  return {
    selection: options.selection ?? createFixtureSelectionPort(),
    reaction: options.reaction ?? createFixtureReactionPort(),
    textSource: options.textSource ?? createCatalogDialogueTextSource(),
    createRenderer: (gate) => {
      options.onGate?.(gate, 'renderer')
      return rendererFactory(gate)
    },
    createSynthesis: (gate) => {
      options.onGate?.(gate, 'synthesis')
      return synthesisFactory(gate)
    },
    ...(options.audioResources !== undefined ? { audioResources: options.audioResources } : {}),
    ...(options.onDialogueOutcome !== undefined
      ? { onDialogueOutcome: options.onDialogueOutcome }
      : {}),
    profile: {
      voiceProfileId: M1_FIXTURE_VOICE_ID,
      voiceProfileVersion: M1_FIXTURE_VOICE_VERSION,
    },
  }
}

/**
 * Seeds durable evidence for one retired session: one fully-delivered turn
 * (confirmed history) and one `partial-unknown` turn with unknown terminal
 * outcome and null persona attribution. A restart scenario seeds this through
 * the production store so the real SQLite backend persists it.
 */
export async function seedProductionEvidence(store: EventStorePort, sessionId: string): Promise<void> {
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId,
      turnId: 'turn-confirmed',
      segmentId: 'segment-confirmed',
      textHash: 'hash-confirmed',
      text: 'confirmed words',
      outputId: 'output-confirmed',
      receiptId: 'receipt-confirmed',
    }),
    fixtureRuntimeEvent({
      eventId: `event-confirmed-${sessionId}`,
      seq: 1,
      sessionId,
      type: 'delivery.committed',
    }),
  )
  await store.commitDeliveryWithEvent(
    fixtureCommitDelivery({
      sessionId,
      turnId: 'turn-unresolved',
      segmentId: 'segment-unresolved',
      textHash: 'hash-unresolved',
      text: 'unresolved words',
      outputId: 'output-unresolved',
      receiptId: 'receipt-unresolved',
      classification: 'partial-unknown',
      terminalOutcome: 'unknown',
      personaProfileId: null,
      personaProfileVersion: null,
    }),
    fixtureRuntimeEvent({
      eventId: `event-unresolved-${sessionId}`,
      seq: 2,
      sessionId,
      type: 'delivery.committed',
    }),
  )
}

/**
 * The dialogue-context observation hook for the cross-process acceptance.
 *
 * When `ISLA_TEST_DIALOGUE_CAPTURE_FILE` names a file, the deployment's text
 * source appends one JSON line per assembled dialogue context, summarising the
 * confirmed history the real M4 context assembly supplied to the provider. The
 * emitted catalog text is unchanged. Test-only: the file path comes from the
 * environment of a test-spawned CLI process, and production code never imports
 * this module.
 */
export const DIALOGUE_CAPTURE_ENV = 'ISLA_TEST_DIALOGUE_CAPTURE_FILE'

/**
 * When `ISLA_TEST_RELEASE_MARKER_FILE` names a file, the deployment returns an
 * owned release that appends one line per call. `ISLA_TEST_RELEASE_HOLD_FILE`
 * makes that release stay pending until the parent creates the named file, so a
 * caller that reports completion without awaiting the release is observable.
 * When `ISLA_TEST_RELEASE_FAIL` is set, the release also rejects after the hold
 * and the marker write, so the parent process can observe the CLI's
 * incomplete-shutdown reporting. Test-only: the paths come from the environment
 * of a test-spawned CLI process, and production code never imports this module.
 */
export const RELEASE_MARKER_ENV = 'ISLA_TEST_RELEASE_MARKER_FILE'
export const RELEASE_HOLD_ENV = 'ISLA_TEST_RELEASE_HOLD_FILE'
export const RELEASE_FAIL_ENV = 'ISLA_TEST_RELEASE_FAIL'

export function createCaptureWritingTextSource(filePath: string): DialogueTextSource {
  const base = createCatalogDialogueTextSource()
  return {
    model: base.model,
    modelVersion: base.modelVersion,
    resolvedModel: base.resolvedModel,
    async compose(view, maxSegments) {
      appendFileSync(
        filePath,
        `${JSON.stringify({
          selectedInputText: view.selectedInputText,
          historySource: view.historySource,
          history: view.history.map((record) => ({
            sessionId: record.sessionId,
            turnId: record.turnId,
            segmentId: record.segmentId,
            text: record.text,
            classification: record.classification,
            personaProfileId: record.personaProfileId,
          })),
          turns: view.turns.map((turn) => ({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            text: turn.text,
            interrupted: turn.interrupted,
          })),
          exclusions: view.exclusions.map((exclusion) => ({
            sessionId: exclusion.sessionId,
            turnId: exclusion.turnId,
            reason: exclusion.reason,
          })),
        })}\n`,
      )
      return base.compose(view, maxSegments)
    },
  }
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Deployment module used by the production-CLI smoke tests. The live session id
 * and the archive sources come from the environment, so a test can drive a
 * durable restart without editing the module:
 *
 * - `ISLA_TEST_LIVE_SESSION_ID`: explicit fresh live id (default: random).
 * - `ISLA_TEST_ARCHIVE_SESSIONS`: comma-separated retired session ids to
 *   reconstruct, each catalogued under the fixture persona identity.
 * - `ISLA_TEST_DIALOGUE_CAPTURE_FILE`: optional file that receives one JSON line
 *   per assembled dialogue context (see `createCaptureWritingTextSource`).
 * - `ISLA_TEST_RELEASE_MARKER_FILE`: optional file that receives one line per
 *   deployment-owned release call, so the CLI's startup-failure and shutdown
 *   paths can be observed from the parent process.
 * - `ISLA_TEST_RELEASE_HOLD_FILE`: makes the deployment-owned release stay
 *   pending until the parent creates the named file, so awaiting the release is
 *   distinguishable from merely invoking it.
 * - `ISLA_TEST_RELEASE_FAIL`: makes the deployment-owned release reject after
 *   recording its call, so the CLI's incomplete-shutdown reporting is
 *   observable.
 */
export function createTestProductionDeployment(
  context: ProductionDeploymentContext,
): ProductionDeployment {
  const liveSessionId =
    nonEmpty(context.env.ISLA_TEST_LIVE_SESSION_ID) ?? `session-${randomUUID()}`
  const archiveIds = (context.env.ISLA_TEST_ARCHIVE_SESSIONS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const captureFile = nonEmpty(context.env[DIALOGUE_CAPTURE_ENV])
  const releaseMarker = nonEmpty(context.env[RELEASE_MARKER_ENV])
  const releaseHold = nonEmpty(context.env[RELEASE_HOLD_ENV])
  const releaseFails = nonEmpty(context.env[RELEASE_FAIL_ENV]) !== null
  const liveProfile = { profileId: 'character-fixture', profileVersion: '1' }
  return {
    peers: createTestProductionPeers({
      clock: context.clock,
      ...(captureFile !== null ? { textSource: createCaptureWritingTextSource(captureFile) } : {}),
    }),
    initialSelection: {
      liveSessionId,
      liveProfile,
      selectedSources: archiveIds.map((sessionId) => ({ sessionId })),
      catalogue: new Map(archiveIds.map((sessionId) => [sessionId, liveProfile])),
    },
    allowedOrigins: [TEST_DEPLOYMENT_ORIGIN],
    ...(releaseMarker !== null || releaseHold !== null || releaseFails
      ? {
          release: async () => {
            // The marker records the call at release start, before any hold, so
            // a parent can observe a genuinely pending release.
            if (releaseMarker !== null) appendFileSync(releaseMarker, 'release\n')
            if (releaseHold !== null) {
              while (!existsSync(releaseHold)) {
                await new Promise((resolve) => setTimeout(resolve, 25))
              }
            }
            if (releaseFails) throw new Error('test deployment: owned release failed')
          },
        }
      : {}),
  }
}
