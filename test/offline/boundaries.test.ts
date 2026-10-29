import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

export interface Edge {
  from: string
  spec: string
  resolved: string | null
}

const MODULE_PATTERN =
  /^\s*(?:import|export)\b(?![^'"]*?\btype\b)[^'"]*?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

/*
 * Real module specifiers, including the `type` imports that carry no runtime
 * edge but whose existence the checker still has to see.
 *
 * The import-graph edges above deliberately ignore `import type` / `export
 * type`, because an erased type import adds no runtime dependency and a type
 * contract on the browser side may legitimately name a backend-owned shape
 * (`./moduleSpecifiers.test.ts` covers both readings). This helper exists for
 * the path-level checks: a `src/` file must not even NOMINATE test code.
 */
const ALL_SPECIFIERS_PATTERN =
  /^\s*(?:import|export)\b[^'"]*?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

/** Normalize path separators so checks are portable across platforms. */
const norm = (path: string): string => path.replace(/\\/g, '/')

/** Runtime import specifiers: `import type` and `export type` are excluded. */
export function moduleSpecifiers(source: string): string[] {
  return matchAll(MODULE_PATTERN, source)
}

/** Every import specifier, including type-only ones. */
export function allSpecifiers(source: string): string[] {
  return matchAll(ALL_SPECIFIERS_PATTERN, source)
}

function matchAll(pattern: RegExp, source: string): string[] {
  const specs: string[] = []
  let match: RegExpExecArray | null
  pattern.lastIndex = 0
  while ((match = pattern.exec(source)) !== null) {
    specs.push(match[1] ?? match[2] ?? match[3])
  }
  return specs
}

export function makeResolver(exists: (path: string) => boolean) {
  return (spec: string, fromFile: string): string | null => {
    if (!spec.startsWith('.')) return null
    /*
     * Resolve in the POSIX namespace and hand the joined path to `exists`, so a
     * caller's in-memory file map ('/app/main.tsx') matches on every platform.
     * The real-filesystem callers below pass native paths, which Node's path
     * module already normalises before they reach this function.
     */
    const base = fromFile.startsWith('/') && isWindows ? posixResolve(dirname(fromFile), spec) : resolve(dirname(fromFile), spec)
    const candidates = [base, `${base}.ts`, `${base}.tsx`, posixResolve(base, 'index.ts'), posixResolve(base, 'index.tsx')]
    return candidates.find((candidate) => exists(candidate)) ?? null
  }
}

const isWindows = process.platform === 'win32'

/** Resolve a POSIX-style in-memory path without touching the Windows drive. */
function posixResolve(from: string, spec: string): string {
  const segments: string[] = from.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  for (const segment of spec.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export function collectEdges(
  entry: string,
  read: (file: string) => string,
  exists: (path: string) => boolean,
): Edge[] {
  const resolveSpec = makeResolver(exists)
  const edges: Edge[] = []
  const visited = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || visited.has(file)) continue
    visited.add(file)
    for (const spec of moduleSpecifiers(read(file))) {
      const resolved = resolveSpec(spec, file)
      edges.push({ from: file, spec, resolved })
      if (resolved !== null) queue.push(resolved)
    }
  }
  return edges
}

const isNodeSpec = (spec: string): boolean =>
  /^(?:node:.+|fs|path|http|https|net|os|child_process|crypto|url|stream|events|util|ws)$/.test(spec)

/** Backend subsystems plus non-browser performance code. */
const isBackendPath = (path: string): boolean =>
  /\/src\/(?:runtime|storage|dialogue|decision|evaluation|performance)\//.test(norm(path))

/** The browser-safe public M1 subtree that M2 may import. */
const isPerformanceBrowserPath = (path: string): boolean =>
  /\/src\/performance\/browser\//.test(norm(path))

const isTestPath = (path: string): boolean => /\/test\//.test(norm(path))

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full)
  }
  return files
}

/** A console-edge is broken if it reaches Node/builtins/ws or non-browser backend code. */
export function consoleEdgeBlocked(spec: string, resolved: string | null): boolean {
  if (isNodeSpec(spec)) return true
  if (resolved !== null && isBackendPath(resolved) && !isPerformanceBrowserPath(resolved)) return true
  return false
}

export function contractsEdgeBlocked(spec: string, resolved: string | null): boolean {
  if (isNodeSpec(spec)) return true
  if (resolved !== null && isBackendPath(resolved)) return true
  return false
}

describe('import graph boundary checker', () => {
  const isFile = (path: string): boolean => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }

  it('keeps the console graph (from the main entry) free of Node/ws and backend code', () => {
    const entry = join(SRC, 'main.tsx')
    const edges = collectEdges(entry, (file) => readFileSync(file, 'utf8'), isFile)
    const offenders = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
  })

  it('keeps browser-facing contracts free of Node and backend modules', () => {
    const entry = join(SRC, 'contracts', 'index.ts')
    const edges = collectEdges(entry, (file) => readFileSync(file, 'utf8'), isFile)
    const offenders = edges.filter((edge) => contractsEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
  })

  it('separates type-only imports from runtime edges', () => {
    /*
     * Both readings matter and must not be conflated. A type-only import is
     * erased, so it adds no runtime edge - that is what lets the browser-facing
     * contracts declare a backend-owned payload shape. It is still a real
     * dependency for path checks, so `allSpecifiers` reports it.
     */
    const source = [
      "import type { Payload } from '../dialogue/contract'",
      "import { value } from '../dialogue/runtime'",
      "export type { Other } from '../dialogue/other'",
    ].join('\n')
    expect(moduleSpecifiers(source)).toEqual(['../dialogue/runtime'])
    expect(allSpecifiers(source)).toEqual([
      '../dialogue/contract',
      '../dialogue/runtime',
      '../dialogue/other',
    ])
  })

  it('rejects a browser player that transitively imports backend or Node code (negative)', () => {
    const backendGraph: Record<string, string> = {
      '/app/main.tsx': "import player from '../src/performance/browser/player'\n",
      '/src/performance/browser/player.ts': "import { server } from '../../runtime/server'\n",
      '/src/runtime/server.ts': "import WebSocket from 'ws'\nexport const server = 1\n",
    }
    const read = (file: string): string => backendGraph[file] ?? ''
    const exists = (path: string): boolean => path in backendGraph
    const blocked = collectEdges('/app/main.tsx', read, exists).filter((edge) =>
      consoleEdgeBlocked(edge.spec, edge.resolved),
    )
    expect(blocked.length).toBeGreaterThan(0)

    const nodeGraph: Record<string, string> = {
      '/app/main.tsx': "import player from '../src/performance/browser/player'\n",
      '/src/performance/browser/player.ts': "import fs from 'node:fs'\n",
    }
    // actual node-graph traversal with its own resolver
    const nodeRead = (file: string): string => nodeGraph[file] ?? ''
    const nodeExists = (path: string): boolean => path in nodeGraph
    const nodeEdges = collectEdges('/app/main.tsx', nodeRead, nodeExists)
    const nodeOffenders = nodeEdges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(nodeOffenders.some((edge) => edge.spec === 'node:fs')).toBe(true)
  })

  it('rejects a backend import from the main entry (negative)', () => {
    const files: Record<string, string> = {
      '/app/main.tsx': "import { server } from '../src/runtime/server'\n",
      '/src/runtime/server.ts': "import WebSocket from 'ws'\nexport const server = 1\n",
    }
    const read = (file: string): string => files[file] ?? ''
    const exists = (path: string): boolean => path in files
    const blocked = collectEdges('/app/main.tsx', read, exists).filter((edge) =>
      consoleEdgeBlocked(edge.spec, edge.resolved),
    )
    expect(blocked.length).toBeGreaterThan(0)
  })

  it('flags a production module importing test code through the same checker', () => {
    const files: Record<string, string> = {
      '/src/app.ts': "import { fixture } from '../test/support/fixture-data'\nexport const x = fixture\n",
      '/test/support/fixture-data.ts': 'export const fixture = 1\n',
    }
    const read = (file: string): string => files[file] ?? ''
    const exists = (path: string): boolean => path in files
    const edges = collectEdges('/src/app.ts', read, exists)
    expect(edges.some((edge) => edge.resolved !== null && isTestPath(edge.resolved))).toBe(true)
  })

  it('flags a type-only import of test code, which the runtime graph would miss', () => {
    /*
     * Counterpart to the previous case: the runtime edge set ignores
     * `import type`, so the path-level rule must be applied to every specifier
     * or a type-only reach into test code would go unreported.
     */
    const source = "import type { Fixture } from '../test/support/fixture-data'\n"
    expect(moduleSpecifiers(source)).toEqual([])
    expect(allSpecifiers(source)).toEqual(['../test/support/fixture-data'])
  })

  it('keeps all production source free of runtime and type-only test imports', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      for (const spec of allSpecifiers(readFileSync(file, 'utf8'))) {
        const resolved = makeResolver(isFile)(spec, file)
        if (resolved !== null && isTestPath(resolved)) {
          offenders.push(`${file} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
