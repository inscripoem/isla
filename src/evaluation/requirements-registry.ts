import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import {
  caseRegistrySchema,
  casesJsonSchema,
  requirementsJsonSchema,
  requirementsRegistrySchema,
  type CaseRegistry,
  type RequirementsRegistry,
} from '../contracts/requirements'

export type RegistryResult =
  | { ok: true; registry: RequirementsRegistry }
  | { ok: false; errors: string[] }

export type CaseRegistryResult =
  | { ok: true; registry: CaseRegistry }
  | { ok: false; errors: string[] }

function parseYaml(text: string): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const document = parseDocument(text, { uniqueKeys: true })
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => error.message) }
  }
  return { ok: true, value: document.toJS() }
}

export function parseRequirementsRegistry(text: string): RegistryResult {
  const parsed = parseYaml(text)
  if (!parsed.ok) return parsed
  const result = requirementsRegistrySchema.safeParse(parsed.value)
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    }
  }
  return { ok: true, registry: result.data }
}

export function parseCaseRegistry(text: string): CaseRegistryResult {
  const parsed = parseYaml(text)
  if (!parsed.ok) return parsed
  const result = caseRegistrySchema.safeParse(parsed.value)
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    }
  }
  return { ok: true, registry: result.data }
}

export function loadRequirementsRegistry(path: string): RegistryResult {
  return parseRequirementsRegistry(readFileSync(path, 'utf8'))
}

export interface CrossCheckDeps {
  resolveFile(relative: string): string
  exists(path: string): boolean
  read(path: string): string
}

/**
 * Machine-checkable fit criteria: every deterministic acceptance must cite at
 * least one implemented case, and every implemented case must point at a real
 * test file containing the named test string. Pending cases cannot be used as
 * deterministic evidence.
 */
export function crossCheckRequirements(
  registry: RequirementsRegistry,
  caseRegistry: CaseRegistry,
  deps: CrossCheckDeps,
): string[] {
  const errors: string[] = []
  const byId = new Map(caseRegistry.cases.map((entry) => [entry.id, entry]))

  for (const entry of caseRegistry.cases) {
    if (entry.status === 'pending') {
      if (entry.verifier !== null) errors.push(`case ${entry.id}: pending case must not declare a verifier`)
      continue
    }
    if (entry.verifier === null) {
      errors.push(`case ${entry.id}: implemented case requires a verifier`)
      continue
    }
    const file = deps.resolveFile(entry.verifier.file)
    if (!deps.exists(file)) {
      errors.push(`case ${entry.id}: missing test file ${entry.verifier.file}`)
      continue
    }
    if (!deps.read(file).includes(entry.verifier.test)) {
      errors.push(`case ${entry.id}: test "${entry.verifier.test}" not found in ${entry.verifier.file}`)
    }
  }

  for (const requirement of registry.requirements) {
    for (const acceptance of requirement.acceptance) {
      for (const caseId of acceptance.cases) {
        if (!byId.has(caseId)) errors.push(`requirement ${requirement.id}: unknown case id ${caseId}`)
      }
      if (acceptance.kind !== 'deterministic') continue
      if (acceptance.cases.length === 0) {
        errors.push(`requirement ${requirement.id}: deterministic acceptance without criteria`)
        continue
      }
      for (const caseId of acceptance.cases) {
        const entry = byId.get(caseId)
        if (entry !== undefined && entry.status !== 'implemented') {
          errors.push(`requirement ${requirement.id}: deterministic acceptance cites pending case ${caseId}`)
        }
      }
    }
  }

  return errors
}

export function loadPreparationRegistry(
  rootDir: string,
): { ok: true } | { ok: false; errors: string[] } {
  const requirements = parseRequirementsRegistry(
    readFileSync(join(rootDir, 'docs/req/requirements.yaml'), 'utf8'),
  )
  if (!requirements.ok) return { ok: false, errors: requirements.errors }
  const cases = parseCaseRegistry(readFileSync(join(rootDir, 'docs/req/case-registry.yaml'), 'utf8'))
  if (!cases.ok) return { ok: false, errors: cases.errors }
  const errors = crossCheckRequirements(requirements.registry, cases.registry, {
    resolveFile: (relative) => join(rootDir, relative),
    exists: (path) => existsSync(path),
    read: (path) => readFileSync(path, 'utf8'),
  })
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

export function emitRequirementsSchema(): string {
  return `${JSON.stringify(requirementsJsonSchema(), null, 2)}\n`
}

export function emitCaseSchema(): string {
  return `${JSON.stringify(casesJsonSchema(), null, 2)}\n`
}
