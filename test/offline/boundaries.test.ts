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

const MODULE_PATTERN = /^\s*(?:import|export)\b[^'"]*?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

/** Normalize path separators so checks are portable across platforms. */
const norm = (path: string): string => path.replace(/\\/g, '/')

export function moduleSpecifiers(source: string): string[] {
  const specs: string[] = []
  let match: RegExpExecArray | null
  MODULE_PATTERN.lastIndex = 0
  while ((match = MODULE_PATTERN.exec(source)) !== null) {
    specs.push(match[1] ?? match[2] ?? match[3])
  }
  return specs
}

export function makeResolver(exists: (path: string) => boolean) {
  return (spec: string, fromFile: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(fromFile), spec)
    const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
    return candidates.find((candidate) => exists(candidate)) ?? null
  }
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

  it('classifies representative imports correctly', () => {
    expect(isNodeSpec('node:fs')).toBe(true)
    expect(isNodeSpec('path')).toBe(true)
    expect(isNodeSpec('ws')).toBe(true)
    expect(isNodeSpec('zod')).toBe(false)
    expect(isNodeSpec('../some/path')).toBe(false)
    expect(isTestPath('../test/support/runner-factories')).toBe(true)
    expect(isTestPath('../../src/contracts')).toBe(false)
  })

  it('keeps browser-facing contracts free of Node and backend modules', () => {
    const entry = join(SRC, 'contracts', 'index.ts')
    const edges = collectEdges(entry, (file) => readFileSync(file, 'utf8'), isFile)
    const offenders = edges.filter((edge) => contractsEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
  })

  it('allows a browser-safe M1 player import through the same checker (positive)', () => {
    const files: Record<string, string> = {
      '/app/main.tsx': "import player from '../src/performance/browser/player'\nimport { contract } from '../src/contracts'\n",
      '/src/performance/browser/player.ts': "import type { PlayerPort } from '../../contracts'\nexport const player: unknown = null\n",
      '/src/contracts/index.ts': "export const contract = 1\n",
    }
    const read = (file: string): string => files[file] ?? ''
    const exists = (path: string): boolean => path in files
    const edges = collectEdges('/app/main.tsx', read, exists)
    const offenders = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
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

  it('keeps all production source from importing test code', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        const resolved = makeResolver(isFile)(spec, file)
        if (isTestPath(spec) || (resolved !== null && isTestPath(resolved))) {
          offenders.push(`${file} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})