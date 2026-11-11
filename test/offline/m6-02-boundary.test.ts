import { readdirSync, readFileSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'
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

/** The path operations the containment check needs, so Windows semantics are testable on any host. */
type PathApi = Pick<typeof posix, 'resolve' | 'dirname' | 'relative' | 'isAbsolute' | 'sep'>

const platformPath: PathApi = process.platform === 'win32' ? win32 : posix

/**
 * True only when `target` is strictly inside `parent`. `path.relative` is used
 * instead of string prefixes so a sibling such as `evaluation-other` is not
 * mistaken for a child of `evaluation`, and a different drive is rejected.
 */
export function isWithin(
  parent: string,
  target: string,
  pathApi: PathApi = platformPath,
): boolean {
  const rel = pathApi.relative(parent, target)
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(rel)
  )
}

export interface BoundaryOptions {
  readonly pathApi?: PathApi
  readonly root?: string
  readonly contracts?: string
}

/** Static import/export specifiers in a file. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
}

/** Every specifier that leaves the evaluation module without permission. */
export function boundaryViolations(
  file: string,
  text: string,
  options: BoundaryOptions = {},
): string[] {
  const pathApi = options.pathApi ?? platformPath
  const root = options.root ?? ROOT
  const contracts = options.contracts ?? CONTRACTS
  return importSpecifiers(text).flatMap((spec) => {
    if (spec.startsWith('node:') || NODE_BUILTINS.has(spec) || spec === 'yaml') return []
    if (!spec.startsWith('.')) return [`${file}: bare import "${spec}" is not declared for evaluation`]
    const target = pathApi.resolve(pathApi.dirname(file), spec)
    if (isWithin(root, target, pathApi) || isWithin(contracts, target, pathApi)) return []
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

  it('rejects a sibling module whose name shares the evaluation prefix (negative)', () => {
    const file = resolve(ROOT, 'synthetic.ts')
    expect(boundaryViolations(file, "import { x } from '../evaluation-other/metrics'")).not.toEqual([])
  })

  it('uses Windows containment semantics for case, sibling prefixes and other drives', () => {
    expect(isWithin('C:/repo/src/evaluation', 'C:/repo/src/evaluation/metrics.ts', win32)).toBe(true)
    expect(isWithin('C:/Repo/src/evaluation', 'c:/repo/src/evaluation/metrics.ts', win32)).toBe(true)
    expect(
      isWithin('C:/repo/src/evaluation', 'C:/repo/src/evaluation-other/metrics.ts', win32),
    ).toBe(false)
    expect(isWithin('C:/repo/src/evaluation', 'D:/shared/metrics.ts', win32)).toBe(false)
  })

  it('applies the Windows containment rule to a virtual evaluation module', () => {
    const root = 'C:/repo/src/evaluation'
    const contracts = 'C:/repo/src/contracts'
    const file = `${root}/synthetic.ts`
    const options: BoundaryOptions = { pathApi: win32, root, contracts }
    expect(boundaryViolations(file, "import { summarise } from './metrics'", options)).toEqual([])
    expect(
      boundaryViolations(file, "import type { X } from '../contracts/requirements'", options),
    ).toEqual([])
    expect(
      boundaryViolations(file, "import { x } from '../runtime/coordinator'", options),
    ).not.toEqual([])
    expect(
      boundaryViolations(file, "import { x } from '../evaluation-other/x'", options),
    ).not.toEqual([])
  })
})
