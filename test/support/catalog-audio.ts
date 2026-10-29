import type { ClockPort, PreparedAudio, SynthesisPort } from '../../src/contracts'
import { AudioResourceError, createAudioResourceRegistry } from '../../src/performance/audio-resources'
import type { AudioResourceErrorCode, AudioResourceRegistry } from '../../src/performance/audio-resources'
import { createFixedSynthesis } from '../../src/performance/fixed-synthesis'
import type { FixedAudioEntry } from '../../src/performance/fixed-synthesis'
import type { RuntimeDeadlineGate } from '../../src/runtime/deadline'
import type { ProductionAudioResources } from '../../src/runtime/production'
import {
  M1_ACTUAL_WAV_EXPECTED,
  M1_FIXTURE_FORMAT,
  createM1ActualAssetEntries,
  parseM1Wav,
  readM1ActualWavAssets,
} from './m1-kit'
import type { M1ActualWavAsset } from './m1-kit'

/**
 * Controlled fixed-catalog audio for the test production deployment.
 *
 * The deployment presents the exact catalog text/reference/duration tuple from
 * `createM1ActualAssetEntries()` and serves the prepared WAV bytes through the
 * real M1 `AudioResourceRegistry`. The registry generates and owns its own
 * opaque reference per registration, so a stable catalog reference cannot be
 * passed to `register`. This module therefore maps each catalog reference to the
 * registration currently bound to the live session/epoch and delegates every
 * admission, resolution, retirement and lease to the registry. It creates one
 * registry; no caller receives a second authoritative one.
 *
 * The binding is one entry per catalog reference. A repeated preparation for the
 * same session/epoch reuses the active registration (the catalog bytes and
 * duration are immutable, so the output identity is unchanged in content). Once
 * the registry has reclaimed a registration (a released lease or expiry), the
 * next preparation registers again. A replacement registration is never bound
 * while the previous one is still admitted; when no registration can be bound,
 * the preparation fails instead of serving unrelated bytes.
 *
 * Test-only: production code never imports this module.
 */

const BYTE_BUDGET = 16 * 1024 * 1024
const RETENTION_MS = 10 * 60 * 1000

export interface CatalogAudio {
  readonly createSynthesis: (gate: RuntimeDeadlineGate) => SynthesisPort
  readonly audioResources: ProductionAudioResources
}

interface Binding {
  readonly sessionId: string
  readonly epoch: number
  readonly registryRef: string
}

function refuse(code: AudioResourceErrorCode): never {
  throw new AudioResourceError(code)
}

export function createCatalogAudio(clock: ClockPort): CatalogAudio {
  const entries = createM1ActualAssetEntries()
  const assets = new Map<string, M1ActualWavAsset>(
    readM1ActualWavAssets().map((asset) => [asset.ref, asset]),
  )
  const expectedByRef = new Map<string, (typeof M1_ACTUAL_WAV_EXPECTED)[number]>(
    M1_ACTUAL_WAV_EXPECTED.map((entry) => [entry.ref, entry]),
  )
  const entriesByRef = new Map<string, FixedAudioEntry>()

  for (const entry of entries) {
    const asset = assets.get(entry.audioRef)
    const expected = expectedByRef.get(entry.audioRef)
    if (asset === undefined || expected === undefined) {
      throw new Error(`catalog-audio: no prepared WAV asset for ${entry.audioRef}`)
    }
    if (entry.format !== M1_FIXTURE_FORMAT) {
      throw new Error(`catalog-audio: unsupported catalog format for ${entry.audioRef}`)
    }
    if (asset.bytes.byteLength !== expected.sizeBytes) {
      throw new Error(`catalog-audio: prepared WAV size does not match the manifest for ${entry.audioRef}`)
    }
    const info = parseM1Wav(asset.bytes)
    if (
      info.channels !== expected.channels ||
      info.sampleRateHz !== expected.sampleRateHz ||
      info.bitsPerSample !== expected.bitsPerSample
    ) {
      throw new Error(`catalog-audio: prepared WAV header does not match the manifest for ${entry.audioRef}`)
    }
    if (info.durationMs !== entry.durationMs) {
      throw new Error(`catalog-audio: prepared WAV duration does not match the catalog for ${entry.audioRef}`)
    }
    entriesByRef.set(entry.audioRef, entry)
  }

  const registry: AudioResourceRegistry = createAudioResourceRegistry({
    clock,
    byteBudget: BYTE_BUDGET,
    retentionMs: RETENTION_MS,
  })
  const fixed = createFixedSynthesis({ entries, clock })
  // One binding per catalog reference: the application has one live composition,
  // so an older session/epoch binding is retired before it can coexist with the
  // current one. If a binding is ever ambiguous, admission and resolve fail
  // closed instead of guessing which output the request belongs to.
  const bindings = new Map<string, Binding>()

  const failure = (
    prepared: Extract<PreparedAudio, { ok: true }>,
    reasonCode: string,
  ): PreparedAudio => ({
    ok: false,
    requestId: prepared.requestId,
    sessionId: prepared.sessionId,
    epoch: prepared.epoch,
    turnId: prepared.turnId,
    segmentId: prepared.segmentId,
    reasonCode,
    message: `catalog-audio: ${reasonCode}`,
  })

  const admitted = (ref: string, sessionId: string, epoch: number): string | null => {
    const entry = entriesByRef.get(ref)
    if (entry === undefined) {
      // An unrecognized reference is not a catalog output; only the registry can
      // decide it, and it owns no catalog binding for it.
      return registry.admission(ref, sessionId, epoch)
    }
    const binding = bindings.get(ref)
    if (binding === undefined) return 'unknown_ref'
    if (binding.sessionId !== sessionId || binding.epoch !== epoch) return 'unknown_ref'
    return registry.admission(binding.registryRef, sessionId, epoch)
  }

  const bind = (prepared: Extract<PreparedAudio, { ok: true }>): void => {
    const entry = entriesByRef.get(prepared.audioRef)
    if (entry === undefined) refuse('invalid_ref')
    const asset = assets.get(prepared.audioRef)
    if (asset === undefined) refuse('invalid_input')

    const binding = bindings.get(prepared.audioRef)
    if (binding !== undefined) {
      const sameIdentity =
        binding.sessionId === prepared.sessionId && binding.epoch === prepared.epoch
      if (!sameIdentity) {
        // Never replace a binding owned by another live session/epoch. The
        // caller must retire the old identity first (Stop or disposal does).
        refuse('session_retired')
      }
      registry.collectExpired()
      if (registry.admission(binding.registryRef, prepared.sessionId, prepared.epoch) === null) {
        return
      }
    }

    const registration = registry.register({
      requestId: prepared.requestId,
      sessionId: prepared.sessionId,
      epoch: prepared.epoch,
      turnId: prepared.turnId,
      segmentId: prepared.segmentId,
      voiceProfileId: entry.voiceProfileId,
      voiceProfileVersion: entry.voiceProfileVersion,
      format: entry.format,
      bytes: asset.bytes,
    })
    bindings.set(prepared.audioRef, {
      sessionId: prepared.sessionId,
      epoch: prepared.epoch,
      registryRef: registration.audioRef,
    })
  }

  const createSynthesis = (_gate: RuntimeDeadlineGate): SynthesisPort => ({
    async prepare(request, context) {
      const prepared = await fixed.prepare(request, context)
      if (!prepared.ok) return prepared
      try {
        bind(prepared)
      } catch {
        // A refused registration means this output has no authoritative bytes or
        // has lost its session/epoch. Fail the output instead of dispatching a
        // catalog reference that no resource can serve.
        return failure(prepared, 'audio_resource_unavailable')
      }
      return prepared
    },
  })

  const audioResources: ProductionAudioResources = {
    admission: admitted,
    resolve(ref, signal) {
      const entry = entriesByRef.get(ref)
      if (entry === undefined) return registry.resolve(ref, signal)
      const binding = bindings.get(ref)
      if (binding === undefined) {
        return Promise.reject(new AudioResourceError('unknown_ref'))
      }
      return registry.resolve(binding.registryRef, signal)
    },
    retireBefore(sessionId, newEpoch) {
      const retired = registry.retireBefore(sessionId, newEpoch)
      for (const [ref, binding] of bindings) {
        if (binding.sessionId === sessionId && binding.epoch < newEpoch) {
          bindings.delete(ref)
        }
      }
      return retired
    },
    retireSession(sessionId) {
      const retired = registry.retireSession(sessionId)
      for (const [ref, binding] of bindings) {
        if (binding.sessionId === sessionId) bindings.delete(ref)
      }
      return retired
    },
  }

  return { createSynthesis, audioResources }
}
