import { describe, expect, it } from 'vitest'
import { AUTHOR_CHARACTER_PROFILE } from '../../src/dialogue/persona'
import { deriveStyleContract } from '../../src/dialogue/style-contract'
import type { StyleContract, StyleViolationKind } from '../../src/dialogue/style-contract'
import {
  loadPersonaProbeFixture,
  PERSONA_PROBE_CATEGORIES,
  violationKindsOf,
} from '../support/persona-probe'

/**
 * Fixed persona probe (issue #146 A11, part 2).
 *
 * Regression only. Every assertion is deterministic string work over authored
 * fixtures: no provider, no network, no model judge, and no quality score. The
 * probes pin which violation kind the guard reports for known-bad lines, so a
 * change to the contract or the scanner surfaces as a failure instead of as
 * silent drift.
 */

const fixture = loadPersonaProbeFixture()
/** The contract the production reply path derives for the authored character. */
const contract = deriveStyleContract(AUTHOR_CHARACTER_PROFILE)
const standingFacts = AUTHOR_CHARACTER_PROFILE.standingFacts ?? []

/** Contract for one case: the derived one, plus that case's own overrides. */
function contractFor(overrides?: { forbiddenPatterns?: readonly RegExp[] }): StyleContract {
  return overrides === undefined ? contract : { ...contract, ...overrides }
}

describe('M4 persona probe — fixture shape', () => {
  it('is authored regression data, not user data, and declares its schema', () => {
    expect(fixture.schema).toBe('m4-persona-probe@1')
    expect(fixture.about).toContain('NOT real user data')
    expect(fixture.about).toContain('NOT a tuning target')
  })

  it('targets the authored character, so its standing facts apply', () => {
    expect(fixture.profile.profileId).toBe(AUTHOR_CHARACTER_PROFILE.profileId)
    expect(fixture.profile.profileVersion).toBe(AUTHOR_CHARACTER_PROFILE.version)
    expect(standingFacts.length).toBeGreaterThan(0)
  })

  it('holds 30 to 50 probes, each with a unique id', () => {
    expect(fixture.probes.length).toBeGreaterThanOrEqual(30)
    expect(fixture.probes.length).toBeLessThanOrEqual(50)
    const ids = fixture.probes.map((probe) => probe.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every required category', () => {
    const present = new Set(fixture.probes.map((probe) => probe.category))
    for (const category of PERSONA_PROBE_CATEGORIES) {
      expect(present.has(category), `category ${category}`).toBe(true)
    }
    // The declared category list and the probes agree in both directions.
    expect([...fixture.categories].sort()).toEqual([...PERSONA_PROBE_CATEGORIES].sort())
  })

  it('gives every probe a normal fixture and at least one OOC fixture', () => {
    for (const probe of fixture.probes) {
      expect(probe.normal.lines.length, probe.id).toBeGreaterThan(0)
      expect(probe.ooc.length, probe.id).toBeGreaterThan(0)
      for (const entry of probe.ooc) {
        expect(entry.lines.length, `${probe.id} ooc`).toBeGreaterThan(0)
        expect(VALIDATION_KINDS.has(entry.kind), `${probe.id} kind ${entry.kind}`).toBe(true)
      }
    }
  })

  it('exercises the required violation kinds', () => {
    const kinds = new Set(fixture.probes.flatMap((probe) => probe.ooc.map((entry) => entry.kind)))
    for (const kind of ['self-reference', 'audience-address', 'tic-frequency', 'boundary', 'forbidden', 'fact-contradiction'] as const) {
      expect(kinds.has(kind), `kind ${kind}`).toBe(true)
    }
  })
})

/** Kinds `validateStyle` can report (the whole union). */
const VALIDATION_KINDS: ReadonlySet<StyleViolationKind> = new Set<StyleViolationKind>([
  'self-reference',
  'audience-address',
  'tic-frequency',
  'sentence-length',
  'forbidden',
  'boundary',
  'fact-contradiction',
])

describe('M4 persona probe — validation', () => {
  it('every normal fixture is in character: zero violations', () => {
    const failures: string[] = []
    for (const probe of fixture.probes) {
      const violations = violationKindsOf(probe.normal.lines, contract, {
        standingFacts,
      })
      if (violations.length > 0) failures.push(`${probe.id}: ${violations.join(', ')}`)
    }
    expect(failures).toEqual([])
  })

  it('every OOC fixture produces exactly the violation kind it names', () => {
    const failures: string[] = []
    for (const probe of fixture.probes) {
      for (const [index, entry] of probe.ooc.entries()) {
        const kinds = violationKindsOf(entry.lines, contractFor(entry.contractOverrides), {
          standingFacts,
          ...(entry.recentTurns === undefined ? {} : { recentTurns: entry.recentTurns }),
        })
        const where = `${probe.id} ooc[${index}]`
        if (!kinds.includes(entry.kind)) {
          failures.push(`${where}: expected ${entry.kind}, saw [${kinds.join(', ')}]`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('keeps a normal reply clean where its OOC twin is not, so each probe discriminates', () => {
    // A probe whose normal line ALSO violated the named kind would not show that
    // the guard distinguishes the two; the pair must differ.
    const failures: string[] = []
    for (const probe of fixture.probes) {
      for (const entry of probe.ooc) {
        const normalKinds = violationKindsOf(probe.normal.lines, contract, { standingFacts })
        if (normalKinds.includes(entry.kind as StyleViolationKind)) {
          failures.push(`${probe.id}: normal line already violates ${entry.kind}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('reports violations deterministically: the same fixture twice gives the same answer', () => {
    const first = fixture.probes.map((probe) =>
      probe.ooc.map((entry) =>
        violationKindsOf(entry.lines, contractFor(entry.contractOverrides), {
          standingFacts,
          ...(entry.recentTurns === undefined ? {} : { recentTurns: entry.recentTurns }),
        }),
      ),
    )
    const second = fixture.probes.map((probe) =>
      probe.ooc.map((entry) =>
        violationKindsOf(entry.lines, contractFor(entry.contractOverrides), {
          standingFacts,
          ...(entry.recentTurns === undefined ? {} : { recentTurns: entry.recentTurns }),
        }),
      ),
    )
    expect(second).toEqual(first)
  })
})
