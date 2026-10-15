import { describe, expect, it } from 'vitest'
import type { ConfirmedDelivery } from '../../src/contracts'
import { confirmedDeliverySchema } from '../../src/contracts'
import {
  ArchiveHistoryError,
  ArchiveSelectionError,
  createReconstructedHistoryPort,
  validateArchiveSelection,
} from '../../src/runtime/session-archives'
import type { ArchiveSelectionConfig, SessionProfileCatalogue } from '../../src/runtime/session-archives'

/**
 * M5 archive selection and reconstruction unit coverage: validation, snapshot
 * isolation, ordered composition, fail-closed session/persona/read checks, and
 * legacy attribution preservation. The live loopback demonstration is separate.
 */

function record(overrides: Partial<ConfirmedDelivery> & { sessionId: string; segmentId: string }): ConfirmedDelivery {
  return confirmedDeliverySchema.parse({
    turnId: 'turn-1',
    textHash: `hash-${overrides.segmentId}`,
    text: `text-${overrides.segmentId}`,
    outputId: null,
    receiptId: 'receipt-1',
    classification: 'fully-delivered',
    modality: 'audio',
    segmentIndex: 0,
    personaProfileId: 'character-fixture',
    personaProfileVersion: '1',
    ...overrides,
  })
}

function catalogue(entries: Record<string, { profileId: string; profileVersion: string }>): SessionProfileCatalogue {
  return new Map(Object.entries(entries))
}

function baseConfig(overrides: Partial<ArchiveSelectionConfig> = {}): ArchiveSelectionConfig {
  return {
    liveSessionId: 'session-live',
    liveProfile: { profileId: 'character-fixture', profileVersion: '1' },
    selectedSources: [],
    catalogue: catalogue({}),
    ...overrides,
  }
}

describe('M5 archive selection validation', () => {
  it('rejects a duplicate source', () => {
    const config = baseConfig({
      selectedSources: [{ sessionId: 'archive-a' }, { sessionId: 'archive-a' }],
      catalogue: catalogue({ 'archive-a': { profileId: 'character-fixture', profileVersion: '1' } }),
    })
    expect(() => validateArchiveSelection(config)).toThrowError(ArchiveSelectionError)
    try {
      validateArchiveSelection(config)
    } catch (error) {
      expect((error as ArchiveSelectionError).code).toBe('duplicate_source')
    }
  })

  it('rejects the live session appearing as an archive source', () => {
    const config = baseConfig({
      selectedSources: [{ sessionId: 'session-live' }],
      catalogue: catalogue({ 'session-live': { profileId: 'character-fixture', profileVersion: '1' } }),
    })
    expect(() => validateArchiveSelection(config)).toThrowError(/live session/)
  })

  it('rejects an unknown catalogue entry', () => {
    const config = baseConfig({ selectedSources: [{ sessionId: 'archive-a' }] })
    try {
      validateArchiveSelection(config)
      throw new Error('expected a rejection')
    } catch (error) {
      expect((error as ArchiveSelectionError).code).toBe('unknown_session_profile')
    }
  })

  it('rejects a catalogue entry from a different persona identity', () => {
    const config = baseConfig({
      selectedSources: [{ sessionId: 'archive-a' }],
      catalogue: catalogue({ 'archive-a': { profileId: 'someone-else', profileVersion: '1' } }),
    })
    try {
      validateArchiveSelection(config)
      throw new Error('expected a rejection')
    } catch (error) {
      expect((error as ArchiveSelectionError).code).toBe('incompatible_session_profile')
    }
  })

  it('permits an older known version of the same identity', () => {
    const selection = validateArchiveSelection(
      baseConfig({
        selectedSources: [{ sessionId: 'archive-a' }],
        catalogue: catalogue({ 'archive-a': { profileId: 'character-fixture', profileVersion: '0' } }),
      }),
    )
    expect(selection.sources[0]?.profile.profileVersion).toBe('0')
    expect(selection.liveProfile.profileVersion).toBe('1')
  })

  it('rejects an over-large selection instead of truncating it', () => {
    const selectedSources = Array.from({ length: 3 }, (_unused, index) => ({ sessionId: `archive-${index}` }))
    const catalogueEntries = Object.fromEntries(
      selectedSources.map((source) => [source.sessionId, { profileId: 'character-fixture', profileVersion: '1' }]),
    )
    const config = baseConfig({ selectedSources, catalogue: catalogue(catalogueEntries), maxSources: 2 })
    expect(() => validateArchiveSelection(config)).toThrowError(/at most 2/)
  })

  it('rejects non-sensible numerical bounds', () => {
    for (const maxSources of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5]) {
      try {
        validateArchiveSelection(baseConfig({ maxSources }))
        throw new Error('expected a rejection')
      } catch (error) {
        expect((error as ArchiveSelectionError).code).toBe('invalid_bounds')
      }
    }
  })

  it('rejects a live id that reuses a catalogued archive session', () => {
    const config = baseConfig({
      liveSessionId: 'archive-a',
      catalogue: catalogue({ 'archive-a': { profileId: 'character-fixture', profileVersion: '1' } }),
    })
    expect(() => validateArchiveSelection(config)).toThrowError(/must not reuse/)
  })

  it('snapshots the selection so later mutation cannot change it', () => {
    const selectedSources = [{ sessionId: 'archive-a' }]
    const profileEntry = { profileId: 'character-fixture', profileVersion: '1' }
    const config = baseConfig({
      selectedSources,
      catalogue: catalogue({ 'archive-a': profileEntry }),
    })
    const selection = validateArchiveSelection(config)
    // Mutating the caller's inputs after validation must not alter the snapshot.
    selectedSources.push({ sessionId: 'archive-b' })
    profileEntry.profileVersion = '9'
    expect(selection.sources.map((source) => source.sessionId)).toEqual(['archive-a'])
    expect(selection.sources[0]?.profile.profileVersion).toBe('1')

    // The nested profile is copied and frozen, so mutation through the returned
    // selection cannot alter reconstruction either.
    expect(() => {
      ;(selection.sources[0]!.profile as { profileVersion: string }).profileVersion = '7'
    }).toThrow()
    expect(selection.sources[0]?.profile.profileVersion).toBe('1')
  })

  it('accepts an empty selection', () => {
    const selection = validateArchiveSelection(baseConfig())
    expect(selection.sources).toEqual([])
  })
})

describe('M5 reconstructed history port', () => {
  const archiveA = [
    record({ sessionId: 'archive-a', segmentId: 'a-1', segmentIndex: 1, turnId: 'turn-1' }),
    record({ sessionId: 'archive-a', segmentId: 'a-0', segmentIndex: 0, turnId: 'turn-1' }),
    record({ sessionId: 'archive-a', segmentId: 'a-null', segmentIndex: null, turnId: 'turn-1' }),
  ]
  const archiveB = [record({ sessionId: 'archive-b', segmentId: 'b-0', segmentIndex: 0, turnId: 'turn-1' })]
  const live = [record({ sessionId: 'session-live', segmentId: 'l-0', segmentIndex: 0, turnId: 'turn-live' })]

  function portFor(
    read: (sessionId: string) => Promise<ConfirmedDelivery[]>,
    overrides: Partial<ArchiveSelectionConfig> = {},
  ) {
    const selection = validateArchiveSelection(
      baseConfig({
        selectedSources: [{ sessionId: 'archive-a' }, { sessionId: 'archive-b' }],
        catalogue: catalogue({
          'archive-a': { profileId: 'character-fixture', profileVersion: '1' },
          'archive-b': { profileId: 'character-fixture', profileVersion: '1' },
        }),
        ...overrides,
      }),
    )
    return createReconstructedHistoryPort({ selection, readSessionHistory: read })
  }

  it('returns archives in selection order then the live session, retaining ids and per-source order', async () => {
    const port = portFor(async (sessionId) => {
      if (sessionId === 'archive-a') return archiveA
      if (sessionId === 'archive-b') return archiveB
      if (sessionId === 'session-live') return live
      return []
    })
    const records = await port.confirmedHistory('session-live')
    expect(records.map((entry) => entry.segmentId)).toEqual(['a-1', 'a-0', 'a-null', 'b-0', 'l-0'])
    expect(records.map((entry) => entry.sessionId)).toEqual([
      'archive-a',
      'archive-a',
      'archive-a',
      'archive-b',
      'session-live',
    ])
  })

  it('lets a new local delivery coexist with restored records instead of hiding them', async () => {
    const port = portFor(async (sessionId) => {
      if (sessionId === 'archive-a') return archiveA
      if (sessionId === 'archive-b') return archiveB
      return live
    })
    const records = await port.confirmedHistory('session-live')
    expect(records.filter((entry) => entry.sessionId === 'session-live')).toHaveLength(1)
    expect(records.filter((entry) => entry.sessionId === 'archive-a')).toHaveLength(3)
    expect(records.filter((entry) => entry.sessionId === 'archive-b')).toHaveLength(1)
  })

  it('validates and returns a selected source queried directly', async () => {
    const port = portFor(async (sessionId) => (sessionId === 'archive-a' ? archiveA : []))
    const records = await port.confirmedHistory('archive-a')
    expect(records.map((entry) => entry.segmentId)).toEqual(['a-1', 'a-0', 'a-null'])
  })

  it('rejects a query for a session outside the selection instead of forwarding it', async () => {
    const port = portFor(async () => live)
    await expect(port.confirmedHistory('some-other-session')).rejects.toMatchObject({
      code: 'unscoped_session_request',
    })
  })

  it('rejects a record whose session does not match the requested source', async () => {
    const port = portFor(async (sessionId) =>
      sessionId === 'archive-a'
        ? [record({ sessionId: 'archive-b', segmentId: 'wrong' })]
        : [],
    )
    await expect(port.confirmedHistory('session-live')).rejects.toMatchObject({
      code: 'source_session_mismatch',
    })
  })

  it('rejects a known persona identity contradicting the trusted catalogue', async () => {
    const port = portFor(async (sessionId) =>
      sessionId === 'archive-a'
        ? [record({ sessionId: 'archive-a', segmentId: 'a-bad', personaProfileId: 'someone-else' })]
        : [],
    )
    await expect(port.confirmedHistory('session-live')).rejects.toBeInstanceOf(ArchiveHistoryError)
    await expect(port.confirmedHistory('session-live')).rejects.toMatchObject({
      code: 'source_persona_mismatch',
    })
  })

  it('preserves null and half-known attribution without inferring it', async () => {
    const port = portFor(async (sessionId) =>
      sessionId === 'archive-a'
        ? [
            record({ sessionId: 'archive-a', segmentId: 'a-null-id', personaProfileId: null, personaProfileVersion: '1' }),
            record({ sessionId: 'archive-a', segmentId: 'a-null-version', personaProfileId: 'character-fixture', personaProfileVersion: null }),
          ]
        : [],
    )
    const records = await port.confirmedHistory('session-live')
    expect(records.find((entry) => entry.segmentId === 'a-null-id')?.personaProfileId).toBeNull()
    expect(records.find((entry) => entry.segmentId === 'a-null-version')?.personaProfileVersion).toBeNull()
  })

  it('fails closed when a source read throws', async () => {
    const port = portFor(async (sessionId) => {
      if (sessionId === 'archive-b') throw new Error('disk unavailable')
      return []
    })
    await expect(port.confirmedHistory('session-live')).rejects.toMatchObject({
      code: 'source_read_failed',
    })
  })

  it('rejects a source that exceeds the per-source bound', async () => {
    const selection = validateArchiveSelection(
      baseConfig({
        selectedSources: [{ sessionId: 'archive-a' }],
        catalogue: catalogue({ 'archive-a': { profileId: 'character-fixture', profileVersion: '1' } }),
      }),
    )
    const port = createReconstructedHistoryPort({
      selection,
      maxRecordsPerSource: 1,
      readSessionHistory: async () => archiveA,
    })
    await expect(port.confirmedHistory('session-live')).rejects.toMatchObject({
      code: 'source_too_large',
    })
  })

  it('rejects an invalid per-source record bound', () => {
    const selection = validateArchiveSelection(baseConfig())
    for (const maxRecordsPerSource of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5]) {
      try {
        createReconstructedHistoryPort({
          selection,
          maxRecordsPerSource,
          readSessionHistory: async () => [],
        })
        throw new Error('expected a rejection')
      } catch (error) {
        expect((error as ArchiveSelectionError).code).toBe('invalid_bounds')
      }
    }
  })

  it('rejects a known live persona identity contradicting the live profile', async () => {
    const port = portFor(async (sessionId) =>
      sessionId === 'session-live'
        ? [record({ sessionId: 'session-live', segmentId: 'l-bad', personaProfileId: 'someone-else' })]
        : [],
    )
    await expect(port.confirmedHistory('session-live')).rejects.toMatchObject({
      code: 'live_persona_mismatch',
    })
  })

  it('still validates a direct query for a selected source', async () => {
    const port = portFor(async (sessionId) =>
      sessionId === 'archive-a'
        ? [record({ sessionId: 'archive-a', segmentId: 'a-bad', personaProfileId: 'someone-else' })]
        : [],
    )
    await expect(port.confirmedHistory('archive-a')).rejects.toMatchObject({
      code: 'source_persona_mismatch',
    })
  })
})
