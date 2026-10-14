import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { columnIndex, parseTables } from './markdown'
import {
  crossCheckRequirements,
  parseCaseRegistry,
  parseRequirementsRegistry,
} from './requirements-registry'

/**
 * M6 / R3 — traceability fitness functions (ADR-006, INV-12).
 *
 * Machine-checks the visibility chain (`REQ → Driver → Concept → Element →
 * Interface → Code → Test → Monitor`) across the repository artifacts. An empty
 * array means the chain is intact; each violation names the broken link. Run as
 * a CI fitness function (gate) and tested in `test/offline/trace-fitness.test.ts`.
 *
 * The functions are deliberately file-system-injected so a test can inject a
 * defect and prove each check rejects it.
 */

export interface TraceViolation {
  readonly code: string
  readonly message: string
}

export interface TraceFs {
  read(relative: string): string
  exists(relative: string): boolean
  list(relative: string): string[]
}

export interface TraceOptions {
  /** Files changed by the diff (CI); used by the frozen-path gate. */
  readonly changedFiles?: readonly string[]
}

/** Filesystem view rooted at `root` (production use). */
export function nodeTraceFs(root: string): TraceFs {
  return {
    read: (relative) => readFileSync(join(root, relative), 'utf8'),
    exists: (relative) => existsSync(join(root, relative)),
    list: (relative) => {
      try {
        return readdirSync(join(root, relative))
      } catch {
        return []
      }
    },
  }
}

const ARCH = 'docs/architecture'
const ADR_DIR = `${ARCH}/adr`
const DELTA_DIR = `${ARCH}/delta`
const ADR_ID = /ADR-(\d{3})/g
const CASE_ID = /\bC-\d+\b/g
const SRC_PATH = /`(src\/[^`]+)`/g
const FROZEN_MANIFEST = `${ARCH}/frozen.yaml`

function architectureDocs(fs: TraceFs): string[] {
  const at = (dir: string): string[] =>
    fs
      .list(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => `${dir}/${name}`)
  return [...at(ARCH), ...at(ADR_DIR), ...at(DELTA_DIR)]
}

export function collectTraceViolations(fs: TraceFs, options: TraceOptions = {}): TraceViolation[] {
  const violations: TraceViolation[] = []
  const add = (code: string, message: string): void => {
    violations.push({ code, message })
  }
  const readOr = (path: string): string | null => {
    if (!fs.exists(path)) {
      add('doc-missing', `required artifact is missing: ${path}`)
      return null
    }
    return fs.read(path)
  }

  // 1. Registry cross-check: REQ -> implemented case -> present test.
  const requirementsText = readOr('docs/req/requirements.yaml')
  const casesText = readOr('docs/req/case-registry.yaml')
  if (requirementsText === null || casesText === null) return violations

  const requirements = parseRequirementsRegistry(requirementsText)
  const cases = parseCaseRegistry(casesText)
  if (!requirements.ok) {
    for (const error of requirements.errors) add('registry-requirements', error)
  }
  if (!cases.ok) {
    for (const error of cases.errors) add('registry-cases', error)
  }
  if (!requirements.ok || !cases.ok) return violations

  for (const error of crossCheckRequirements(requirements.registry, cases.registry, {
    resolveFile: (relative) => relative,
    exists: (path) => fs.exists(path),
    read: (path) => fs.read(path),
  })) {
    add('registry-crosscheck', error)
  }

  const caseIds = new Set(cases.registry.cases.map((entry) => entry.id))

  // 2. Every invariant is registered with a verification and an explicit owner.
  //    The Owner column keeps a shared register classifiable when several roles
  //    contribute rows (mixed-artifact rule, ADR-006).
  const invariantsText = readOr(`${ARCH}/invariants.md`)
  if (invariantsText !== null) {
    const table = parseTables(invariantsText).find((candidate) => columnIndex(candidate.header, 'ID') >= 0)
    const byId = new Map((table?.rows ?? []).map((row) => [(row[0] ?? '').trim(), row]))
    const verifyColumn = table ? columnIndex(table.header, 'Verification') : -1
    const ownerColumn = table ? columnIndex(table.header, 'Owner') : -1
    if (table !== undefined && ownerColumn < 0) {
      add('invariants-no-owner-column', 'invariants.md table has no Owner column')
    }
    for (const requirement of requirements.registry.requirements) {
      if (requirement.category !== 'invariant') continue
      const row = byId.get(requirement.id)
      if (row === undefined) {
        add('invariant-unregistered', `invariant ${requirement.id} has no row in invariants.md`)
      } else {
        if (verifyColumn >= 0 && (row[verifyColumn] ?? '').length === 0) {
          add('invariant-no-verification', `invariant ${requirement.id} has no verification`)
        }
        if (ownerColumn >= 0 && (row[ownerColumn] ?? '').trim().length === 0) {
          add('invariant-no-owner', `invariant ${requirement.id} has no owner`)
        }
      }
    }
  }

  // 3. Trace-matrix rows reference existing components and cases, and carry an
  //    explicit owner so shared rows stay classifiable.
  const traceText = readOr(`${ARCH}/trace-matrix.md`)
  if (traceText !== null) {
    for (const table of parseTables(traceText)) {
      const componentColumn = columnIndex(table.header, 'Enforcing component')
      if (componentColumn < 0) continue
      const caseColumn = columnIndex(table.header, 'Case')
      const ownerColumn = columnIndex(table.header, 'Owner')
      if (ownerColumn < 0) {
        add('trace-no-owner-column', 'trace-matrix.md table has no Owner column')
      }
      for (const row of table.rows) {
        if (ownerColumn >= 0 && (row[ownerColumn] ?? '').trim().length === 0) {
          add('trace-no-owner', 'a trace-matrix row has no owner')
        }
        for (const match of (row[componentColumn] ?? '').matchAll(SRC_PATH)) {
          const path = match[1] ?? ''
          // Skip brace-glob shorthand (e.g. `{a,b}.ts`) — not a literal path.
          if (path.includes('{')) continue
          if (!fs.exists(path)) add('trace-component-missing', `trace row references missing component ${path}`)
        }
        if (caseColumn >= 0) {
          for (const match of (row[caseColumn] ?? '').matchAll(CASE_ID)) {
            if (!caseIds.has(match[0])) add('trace-case-unknown', `trace row references unknown case ${match[0]}`)
          }
        }
      }
    }
  }

  // 4. Every runtime-policy row has an operational fallback.
  const policyText = readOr(`${ARCH}/runtime-policy-catalog.md`)
  if (policyText !== null) {
    for (const table of parseTables(policyText)) {
      const fallbackColumn = columnIndex(table.header, 'Fallback')
      if (fallbackColumn < 0) continue
      for (const row of table.rows) {
        if ((row[fallbackColumn] ?? '').length === 0) {
          add('runtime-policy-no-fallback', 'a runtime-policy row has no fallback')
        }
      }
    }
  }

  // 5. ADR references resolve and every ADR file is referenced.
  const adrNumbers = new Set(
    fs
      .list(ADR_DIR)
      .filter((name) => /^\d{3}.*\.md$/.test(name))
      .map((name) => name.slice(0, 3)),
  )
  const referenced = new Set<string>()
  for (const doc of architectureDocs(fs)) {
    const text = fs.exists(doc) ? fs.read(doc) : ''
    for (const match of text.matchAll(ADR_ID)) {
      const number = match[1] ?? ''
      referenced.add(number)
      if (!adrNumbers.has(number)) add('adr-missing', `ADR-${number} is referenced but has no file`)
    }
  }
  for (const number of adrNumbers) {
    if (!referenced.has(number)) add('adr-unreferenced', `ADR-${number} has a file but is never referenced`)
  }

  // 6. The option ledger exists and records at least one rejected option.
  if (readOr(`${ARCH}/option-ledger.md`) !== null) {
    const tables = parseTables(fs.read(`${ARCH}/option-ledger.md`))
    if (tables.every((table) => table.rows.length === 0)) {
      add('option-ledger-empty', 'option-ledger.md records no options')
    }
  }

  // 7. Frozen paths exist and are unmodified (CI passes the changed-file list).
  if (fs.exists(FROZEN_MANIFEST)) {
    const manifest = parseYaml(fs.read(FROZEN_MANIFEST)) as { frozen?: unknown } | null
    const frozen = Array.isArray(manifest?.frozen) ? (manifest.frozen as unknown[]) : []
    for (const entry of frozen) {
      if (typeof entry !== 'string') continue
      if (!fs.exists(entry)) add('frozen-path-missing', `frozen path does not exist: ${entry}`)
      if (options.changedFiles !== undefined && options.changedFiles.includes(entry)) {
        add('frozen-modified', `frozen path modified: ${entry}`)
      }
    }
  }

  return violations
}
