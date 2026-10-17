import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * M6-GOV-05 / M6-GOV-04 — the evaluation module's import boundary.
 *
 * Evaluation code may use Node builtins, its documented `yaml` parser, its own files and
 * the published contracts. It must not reach into runtime composition, the UI, provider
 * adapters, another module's internals or `test/`; a boundary that is only asserted in
 * prose is not enforced.
 */

const ROOT = resolve('src/evaluation')
const CONTRACTS = resolve('src/contracts')
const NODE_BUILTINS = new Set(['fs', 'path', 'url', 'child_process', 'os', 'crypto'])

/** Static import/export specifiers in a file. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
}

/** Every specifier that leaves the evaluation module without permission. */
export function boundaryViolations(file: string, text: string): string[] {
  return importSpecifiers(text).flatMap((spec) => {
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec) || spec === 'yaml') return []
    if (!spec.startsWith('.')) return [`${file}: bare import "${spec}" is not declared for evaluation`]
    const target = resolve(dirname(file), spec)
    if (target.startsWith(`${ROOT}/`) || target.startsWith(`${CONTRACTS}/`)) return []
    return [`${file}: import "${spec}" leaves src/evaluation`]
  })
}

describe('evaluation import boundary', () => {
  it('keeps every evaluation module inside its allowed imports', () => {
    const files = readdirSync(ROOT)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => resolve(ROOT, name))

    const violations = files.flatMap((file) => boundaryViolations(file, readFileSync(file, 'utf8')))
    expect(violations).toEqual([])
  })

  it('flags a runtime, storage or test import', () => {
    const file = resolve(ROOT, 'synthetic.ts')
    expect(boundaryViolations(file, "import { x } from '../runtime/coordinator'")).not.toEqual([])
    expect(boundaryViolations(file, "import { y } from '../storage/event-store'")).not.toEqual([])
    expect(boundaryViolations(file, "import { z } from '../../test/support/fixture-data'")).not.toEqual([])
  })

  it('allows the published contracts and local siblings', () => {
    const file = resolve(ROOT, 'synthetic.ts')
    expect(boundaryViolations(file, "import type { X } from '../contracts/requirements'")).toEqual([])
    expect(boundaryViolations(file, "import { summarise } from './metrics'")).toEqual([])
  })
})
