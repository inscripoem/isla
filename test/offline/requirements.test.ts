import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { describe, expect, it } from 'vitest'
import type { CaseRegistry, RequirementsRegistry } from '../../src/contracts/requirements'
import {
  crossCheckRequirements,
  emitCaseSchema,
  emitRequirementsSchema,
  loadPreparationRegistry,
  parseCaseRegistry,
  parseRequirementsRegistry,
} from '../../src/evaluation/requirements-registry'

const ROOT = process.cwd()
const REQ_DIR = join(ROOT, 'docs/req')

function registry(acceptance: RequirementsRegistry['requirements'][number]['acceptance']): RequirementsRegistry {
  return {
    version: '0.3',
    generatedFrom: 'test',
    requirements: [
      {
        id: 'FR-X',
        title: 'Example',
        category: 'functional',
        priority: 'must',
        owner: 'M5',
        collaborators: [],
        source: 'test',
        status: 'under-review',
        acceptance,
      },
    ],
  }
}

function cases(entries: CaseRegistry['cases']): CaseRegistry {
  return { version: '0.2', cases: entries }
}

const fakeDeps = (files: Record<string, string>) => ({
  resolveFile: (relative: string) => `/${relative}`,
  exists: (path: string) => path in files,
  read: (path: string) => files[path] ?? '',
})

describe('requirements registry structure', () => {
  it('loads and fully cross-checks the committed preparation registry', () => {
    const result = loadPreparationRegistry(ROOT)
    expect(result.ok).toBe(true)
  })

  it('rejects duplicate requirement ids', () => {
    const entry = parseRequirementsRegistry(
      'version: "0.3"\ngeneratedFrom: test\nrequirements:\n  - id: FR-01\n    title: t\n    category: functional\n    priority: must\n    owner: M5\n    collaborators: []\n    source: t\n    status: under-review\n    acceptance:\n      - kind: pending-metric\n        description: d\n        cases: []\n',
    )
    expect(entry.ok).toBe(true)
    if (!entry.ok) return
    const duplicated = { ...entry.registry, requirements: [...entry.registry.requirements, ...entry.registry.requirements] }
    expect(parseRequirementsRegistry(JSON.stringify(duplicated))).toEqual({
      ok: false,
      errors: expect.any(Array),
    })
  })

  it('rejects duplicate YAML keys and duplicate case ids', () => {
    expect(parseRequirementsRegistry('version: "0.3"\nversion: "0.4"\n').ok).toBe(false)
    const duplicated = parseCaseRegistry(
      'version: "0.2"\ncases:\n  - {id: C-01, status: pending, title: a, verifier: null}\n  - {id: C-01, status: pending, title: b, verifier: null}\n',
    )
    expect(duplicated.ok).toBe(false)
  })
})

describe('requirement taxonomy', () => {
  const parsed = parseRequirementsRegistry(
    readFileSync(join(REQ_DIR, 'requirements.yaml'), 'utf8'),
  )
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const requirements = parsed.registry.requirements
  const categories = new Set([
    'functional',
    'invariant',
    'security',
    'governance',
    'performance',
    'cost',
    'quality',
  ])

  it('uses only the course requirement categories', () => {
    for (const requirement of requirements) {
      expect(categories.has(requirement.category), requirement.id).toBe(true)
    }
  })

  it('gives every non-functional requirement a subtype', () => {
    for (const requirement of requirements) {
      if (requirement.category === 'functional') continue
      expect(requirement.subtype, requirement.id).toBeDefined()
    }
  })

  it('keeps the current invariant register equal to the invariant category', () => {
    const text = readFileSync(join(ROOT, 'docs/architecture/invariants.md'), 'utf8')
    const current = text.split('## Reclassified legacy controls')[0] ?? text
    const registered = new Set(
      Array.from(current.matchAll(/^\|\s*(INV-\d+)\s*\|/gm), (match) => match[1] as string),
    )
    const invariants = new Set(
      requirements
        .filter((requirement) => requirement.category === 'invariant')
        .map((requirement) => requirement.id),
    )
    expect(registered).toEqual(invariants)
  })
})

describe('machine-checkable fit criteria', () => {
  it('rejects a deterministic acceptance without criteria', () => {
    const errors = crossCheckRequirements(
      registry([{ kind: 'deterministic', description: 'd', cases: [] }]),
      cases([{ id: 'C-01', status: 'pending', title: 'a', verifier: null }]),
      fakeDeps({}),
    )
    expect(errors.some((error) => error.includes('deterministic acceptance without criteria'))).toBe(true)
  })

  it('rejects an unknown case id', () => {
    const errors = crossCheckRequirements(
      registry([{ kind: 'deterministic', description: 'd', cases: ['C-99'] }]),
      cases([{ id: 'C-01', status: 'implemented', title: 'a', verifier: { file: 'f', test: 'x' } }]),
      fakeDeps({ '/f': 'x' }),
    )
    expect(errors.some((error) => error.includes('unknown case id C-99'))).toBe(true)
  })

  it('rejects a missing test file', () => {
    const errors = crossCheckRequirements(
      registry([{ kind: 'deterministic', description: 'd', cases: ['C-01'] }]),
      cases([{ id: 'C-01', status: 'implemented', title: 'a', verifier: { file: 'missing.ts', test: 'x' } }]),
      fakeDeps({}),
    )
    expect(errors.some((error) => error.includes('missing test file'))).toBe(true)
  })

  it('rejects a verifier test string that is not present in the file', () => {
    const errors = crossCheckRequirements(
      registry([{ kind: 'deterministic', description: 'd', cases: ['C-01'] }]),
      cases([{ id: 'C-01', status: 'implemented', title: 'a', verifier: { file: 'f.ts', test: 'does-not-exist' } }]),
      fakeDeps({ '/f.ts': 'some other text' }),
    )
    expect(errors.some((error) => error.includes('not found in f.ts'))).toBe(true)
  })

  it('rejects a deterministic acceptance that cites a pending case', () => {
    const errors = crossCheckRequirements(
      registry([{ kind: 'deterministic', description: 'd', cases: ['C-05'] }]),
      cases([{ id: 'C-05', status: 'pending', title: 'a', verifier: null }]),
      fakeDeps({}),
    )
    expect(errors.some((error) => error.includes('cites pending case C-05'))).toBe(true)
  })

  it('rejects an implemented case without a verifier and a pending case with one', () => {
    const missingVerifier = crossCheckRequirements(
      registry([{ kind: 'pending-metric', description: 'd', cases: [] }]),
      cases([{ id: 'C-01', status: 'implemented', title: 'a', verifier: null }]),
      fakeDeps({}),
    )
    expect(missingVerifier.some((error) => error.includes('requires a verifier'))).toBe(true)
    const pendingWithVerifier = crossCheckRequirements(
      registry([{ kind: 'pending-metric', description: 'd', cases: [] }]),
      cases([{ id: 'C-02', status: 'pending', title: 'a', verifier: { file: 'f', test: 'x' } }]),
      fakeDeps({}),
    )
    expect(pendingWithVerifier.some((error) => error.includes('must not declare a verifier'))).toBe(true)
  })
})

describe('schema drift and PRD', () => {
  it('keeps the committed JSON schemas in sync', () => {
    // A Windows checkout may materialise CRLF. Compare content, not checkout
    // line endings, while still rejecting any other difference or a lone CR.
    const normalizeCrlf = (text: string): string => text.replace(/\r\n/g, '\n')
    const requirementsSchema = readFileSync(join(REQ_DIR, 'req-schema.json'), 'utf8')
    const caseSchema = readFileSync(join(REQ_DIR, 'case-schema.json'), 'utf8')
    expect(normalizeCrlf(requirementsSchema)).toBe(emitRequirementsSchema())
    expect(normalizeCrlf(caseSchema)).toBe(emitCaseSchema())
    expect(requirementsSchema.replace(/\r\n/g, '')).not.toContain('\r')
    expect(caseSchema.replace(/\r\n/g, '')).not.toContain('\r')
  })

  it('parses the YAML PRD without errors', () => {
    const document = parseDocument(readFileSync(join(REQ_DIR, 'prd.yaml'), 'utf8'), { uniqueKeys: true })
    expect(document.errors).toEqual([])
  })
})
