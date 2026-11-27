import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { StyleContract, StyleViolationKind } from '../../src/dialogue/style-contract'
import type { StyleCheckOptions } from '../../src/dialogue/style-contract'
import { validateStyle } from '../../src/dialogue/style-contract'

/**
 * Loader for the authored persona-probe fixture (issue #146 A11).
 *
 * `tsconfig.test.json` does not set `resolveJsonModule`, so the fixture cannot
 * be imported as a module. It is read and PARSED here instead, and the shape is
 * narrowed by hand: a malformed fixture must fail loudly rather than arrive in
 * a test as `any`.
 *
 * This file is test support. Production code never imports it, and nothing in
 * it calls a provider or a model: the probes are read from disk and checked
 * with the deterministic `validateStyle`.
 */

/** Categories the fixture is required to cover. */
export const PERSONA_PROBE_CATEGORIES = [
  'name',
  'appearance',
  'preference',
  'boundary',
  'tsundere',
  'address',
] as const

export type PersonaProbeCategory = (typeof PERSONA_PROBE_CATEGORIES)[number]

/** One expected out-of-character violation. */
export interface PersonaProbeOocCase {
  /** The violation kind the guard must report for `lines`. */
  kind: StyleViolationKind
  lines: readonly string[]
  /** Prior confirmed lines, for the tic-gap window. */
  recentTurns?: readonly string[]
  /**
   * Contract overrides for this case only. Needed for `forbidden`: the derived
   * contract carries no forbidden pattern of its own, so a probe that exercises
   * that kind declares the pattern it is testing against.
   */
  contractOverrides?: { forbiddenPatterns?: readonly RegExp[] }
}

export interface PersonaProbe {
  id: string
  category: PersonaProbeCategory
  prompt: string
  /** Fixed in-character reply. Must produce zero violations. */
  normal: { lines: readonly string[] }
  /** Fixed out-of-character replies, each with the kind it must produce. */
  ooc: readonly PersonaProbeOocCase[]
}

export interface PersonaProbeFixture {
  schema: string
  about: string
  profile: { profileId: string; profileVersion: string }
  categories: readonly string[]
  probes: readonly PersonaProbe[]
}

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'm4',
  'persona-probe.json',
)

function fail(message: string): never {
  throw new Error(`persona-probe fixture: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    fail(`${where} must be an array of strings`)
  }
  return value as readonly string[]
}

function parseOoc(raw: unknown, probeId: string, index: number): PersonaProbeOocCase {
  const where = `probes[${probeId}].ooc[${index}]`
  if (!isRecord(raw)) fail(`${where} must be an object`)
  if (typeof raw['kind'] !== 'string') fail(`${where}.kind must be a string`)
  const overrides = raw['contractOverrides']
  if (overrides !== undefined && !isRecord(overrides)) {
    fail(`${where}.contractOverrides must be an object`)
  }
  const patterns = overrides?.['forbiddenPatterns']
  return {
    kind: raw['kind'] as StyleViolationKind,
    lines: stringArray(raw['lines'], `${where}.lines`),
    ...(raw['recentTurns'] === undefined
      ? {}
      : { recentTurns: stringArray(raw['recentTurns'], `${where}.recentTurns`) }),
    ...(patterns === undefined
      ? {}
      : {
          contractOverrides: {
            forbiddenPatterns: stringArray(
              patterns,
              `${where}.contractOverrides.forbiddenPatterns`,
            ).map((source) => new RegExp(source)),
          },
        }),
  }
}

function parseProbe(raw: unknown, index: number): PersonaProbe {
  if (!isRecord(raw)) fail(`probes[${index}] must be an object`)
  const id = raw['id']
  if (typeof id !== 'string' || id.length === 0) fail(`probes[${index}].id must be a string`)
  const category = raw['category']
  if (typeof category !== 'string') fail(`probes[${id}].category must be a string`)
  const prompt = raw['prompt']
  if (typeof prompt !== 'string' || prompt.length === 0) {
    fail(`probes[${id}].prompt must be a non-empty string`)
  }
  const normal = raw['normal']
  if (!isRecord(normal)) fail(`probes[${id}].normal must be an object`)
  const ooc = raw['ooc']
  if (!Array.isArray(ooc) || ooc.length === 0) {
    fail(`probes[${id}].ooc must be a non-empty array`)
  }
  return {
    id,
    category: category as PersonaProbeCategory,
    prompt,
    normal: { lines: stringArray(normal['lines'], `probes[${id}].normal.lines`) },
    ooc: ooc.map((entry, oocIndex) => parseOoc(entry, id, oocIndex)),
  }
}

/** Parses a fixture object; exported so the shape checks can be tested. */
export function parsePersonaProbeFixture(raw: unknown): PersonaProbeFixture {
  if (!isRecord(raw)) fail('the document must be an object')
  const profile = raw['profile']
  if (!isRecord(profile)) fail('profile must be an object')
  const profileId = profile['profileId']
  const profileVersion = profile['profileVersion']
  if (typeof profileId !== 'string') fail('profile.profileId must be a string')
  if (typeof profileVersion !== 'string') fail('profile.profileVersion must be a string')
  const probes = raw['probes']
  if (!Array.isArray(probes)) fail('probes must be an array')
  return {
    schema: typeof raw['schema'] === 'string' ? raw['schema'] : fail('schema must be a string'),
    about: typeof raw['about'] === 'string' ? raw['about'] : fail('about must be a string'),
    profile: { profileId, profileVersion },
    categories: stringArray(raw['categories'], 'categories'),
    probes: probes.map((probe, index) => parseProbe(probe, index)),
  }
}

let cached: PersonaProbeFixture | null = null

/** The fixture, read and parsed once per process. */
export function loadPersonaProbeFixture(): PersonaProbeFixture {
  if (cached !== null) return cached
  const text = readFileSync(FIXTURE_PATH, 'utf8')
  cached = parsePersonaProbeFixture(JSON.parse(text) as unknown)
  return cached
}

/** Violation kinds `validateStyle` reports for one candidate's lines. */
export function violationKindsOf(
  lines: readonly string[],
  contract: StyleContract,
  options: StyleCheckOptions,
): readonly StyleViolationKind[] {
  return validateStyle(lines, contract, options).map((violation) => violation.kind)
}
