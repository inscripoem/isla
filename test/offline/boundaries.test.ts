import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** The path operations the resolver needs, so Windows semantics can be exercised on any host. */
type PathApi = Pick<typeof posix, 'resolve' | 'dirname' | 'join'>

const platformPath: PathApi = process.platform === 'win32' ? win32 : posix

export interface Edge {
  from: string
  spec: string
  resolved: string | null
}

/** Normalize path separators so checks are portable across platforms. */
const norm = (path: string): string => path.replace(/\\/g, '/')

/**
 * The module specifiers the source actually loads.
 *
 * A pattern cannot tell a specifier from a string literal: the previous expression
 * read `export const A = ['http']` as an import of `http`. The TypeScript scanner
 * knows which tokens form a declaration, so only `import … from`, `export … from`,
 * `import x = require(…)` and literal `import()`/`require()` calls are reported.
 * A locally shadowed `require` is not modelled; the repository is ESM and has no
 * such binding, so the limitation is theoretical. A syntax error can hide a
 * declaration from this read; `pnpm typecheck` is the line that rejects it.
 */
export function moduleSpecifiers(source: string, fileName = 'module.ts'): string[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKind)
  const specs: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const argument = node.arguments[0]
      if ((dynamicImport || commonJsRequire) && argument && ts.isStringLiteralLike(argument)) {
        specs.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return specs
}

export function makeResolver(exists: (path: string) => boolean, pathApi: PathApi = platformPath) {
  return (spec: string, fromFile: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = pathApi.resolve(pathApi.dirname(fromFile), spec)
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      pathApi.join(base, 'index.ts'),
      pathApi.join(base, 'index.tsx'),
    ]
    return candidates.find((candidate) => exists(candidate)) ?? null
  }
}

export function collectEdges(
  entry: string,
  read: (file: string) => string,
  exists: (path: string) => boolean,
  pathApi: PathApi = platformPath,
): Edge[] {
  const resolveSpec = makeResolver(exists, pathApi)
  const edges: Edge[] = []
  const visited = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || visited.has(file)) continue
    visited.add(file)
    for (const spec of moduleSpecifiers(read(file), file)) {
      const resolved = resolveSpec(spec, file)
      edges.push({ from: file, spec, resolved })
      if (resolved !== null) queue.push(resolved)
    }
  }
  return edges
}

/**
 * A virtual file map whose keys are resolved with the given path semantics.
 * `collectEdges` reads the entry literally and then resolves descendants, so
 * both forms must reach the same key on every platform.
 */
function virtualFiles(entries: Record<string, string>, pathApi: PathApi = platformPath) {
  const key = (path: string): string => norm(pathApi.resolve(path))
  const files = new Map(Object.entries(entries).map(([path, text]) => [key(path), text] as const))
  return {
    read: (path: string): string => files.get(key(path)) ?? '',
    exists: (path: string): boolean => files.has(key(path)),
  }
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
    const { read, exists } = virtualFiles(files)
    const edges = collectEdges('/app/main.tsx', read, exists)
    const offenders = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
    // The positive must prove the graph was actually traversed, not merely that
    // an unresolved specifier produced no offender.
    expect(
      edges.some(
        (edge) =>
          edge.spec === '../src/performance/browser/player' && edge.resolved !== null,
      ),
    ).toBe(true)
  })

  it('treats an exported constant array as data, not as module specifiers (positive)', () => {
    const constant =
      "export const OPERATOR_BOOTSTRAP_FAILURE_REASONS = ['http', 'invalid_response', 'timeout', 'network'] as const\n" +
      "export const FURTHER_LITERALS = ['path', '../test/support/fixture-data', 'node:fs'] as const\n"
    const files: Record<string, string> = {
      '/app/main.tsx': "import { OPERATOR_BOOTSTRAP_FAILURE_REASONS } from '../src/console/operator-bootstrap'\n",
      '/src/console/operator-bootstrap.ts': constant,
    }
    const { read, exists } = virtualFiles(files)

    expect(moduleSpecifiers(constant, 'operator-bootstrap.ts')).toEqual([])
    const edges = collectEdges('/app/main.tsx', read, exists)
    const offenders = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
    expect(edges.some((edge) => edge.resolved !== null)).toBe(true)
  })

  it('still blocks a real re-export of a Node module (negative)', () => {
    const source = "export { readFileSync } from 'node:fs'\n"
    const files: Record<string, string> = {
      '/app/main.tsx': "import { readFileSync } from '../src/console/operator-bootstrap'\n",
      '/src/console/operator-bootstrap.ts': source,
    }
    const { read, exists } = virtualFiles(files)

    expect(moduleSpecifiers(source, 'operator-bootstrap.ts')).toEqual(['node:fs'])
    const blocked = collectEdges('/app/main.tsx', read, exists).filter((edge) =>
      consoleEdgeBlocked(edge.spec, edge.resolved),
    )
    expect(blocked.some((edge) => edge.spec === 'node:fs')).toBe(true)
  })

  it('reads declarations and literal calls, and ignores look-alikes', () => {
    const cases: Array<{ name: string; source: string; fileName?: string; expected: string[] }> = [
      { name: 'static import', source: "import fs from 'node:fs'\n", expected: ['node:fs'] },
      { name: 'multiline static import', source: "import {\n  readFile,\n} from 'node:fs'\n", expected: ['node:fs'] },
      { name: 're-export', source: "export { x } from 'node:fs'\n", expected: ['node:fs'] },
      { name: 'dynamic import', source: "const m = await import('node:fs')\n", expected: ['node:fs'] },
      {
        name: 'template dynamic import',
        source: 'const m = await import(`node:fs`)\n',
        expected: ['node:fs'],
      },
      { name: 'import equals', source: "import fs = require('node:fs')\n", expected: ['node:fs'] },
      {
        name: 'import after an earlier statement',
        source: "export const a = 1; import fs from 'node:fs'\n",
        expected: ['node:fs'],
      },
      {
        name: 'import after JSX in a .tsx file',
        source: "export const el = <div>text</div>\nimport fs from 'node:fs'\n",
        fileName: 'component.tsx',
        expected: ['node:fs'],
      },
      { name: 'member call named require', source: "obj.require('fs')\n", expected: [] },
      {
        name: 'string literal containing a declaration',
        source: 'export const s = "from \'node:fs\'"\n',
        expected: [],
      },
      {
        name: 'template literal containing a declaration',
        source: "const t = `\nimport x from 'node:os'\n`\n",
        expected: [],
      },
      {
        name: 'comments',
        source: "// import fs from 'node:fs'\n/* export { x } from 'node:fs' */\n",
        expected: [],
      },
      {
        name: 'JSX text',
        source: "export const el = <div>import fs from 'node:fs'</div>\n",
        fileName: 'component.tsx',
        expected: [],
      },
    ]
    for (const testCase of cases) {
      expect(moduleSpecifiers(testCase.source, testCase.fileName ?? 'module.ts'), testCase.name).toEqual(
        testCase.expected,
      )
    }
  })

  it('rejects a browser player that transitively imports backend or Node code (negative)', () => {
    const backendGraph: Record<string, string> = {
      '/app/main.tsx': "import player from '../src/performance/browser/player'\n",
      '/src/performance/browser/player.ts': "import { server } from '../../runtime/server'\n",
      '/src/runtime/server.ts': "import WebSocket from 'ws'\nexport const server = 1\n",
    }
    const backend = virtualFiles(backendGraph)
    const blocked = collectEdges('/app/main.tsx', backend.read, backend.exists).filter((edge) =>
      consoleEdgeBlocked(edge.spec, edge.resolved),
    )
    expect(blocked.length).toBeGreaterThan(0)
    expect(
      blocked.some(
        (edge) => edge.spec === '../../runtime/server' && edge.resolved !== null,
      ),
    ).toBe(true)

    const nodeGraph: Record<string, string> = {
      '/app/main.tsx': "import player from '../src/performance/browser/player'\n",
      '/src/performance/browser/player.ts': "import fs from 'node:fs'\n",
    }
    // actual node-graph traversal with its own resolver
    const nodeFiles = virtualFiles(nodeGraph)
    const nodeEdges = collectEdges('/app/main.tsx', nodeFiles.read, nodeFiles.exists)
    const nodeOffenders = nodeEdges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(nodeOffenders.some((edge) => edge.spec === 'node:fs')).toBe(true)
  })

  it('rejects a backend import from the main entry (negative)', () => {
    const files: Record<string, string> = {
      '/app/main.tsx': "import { server } from '../src/runtime/server'\n",
      '/src/runtime/server.ts': "import WebSocket from 'ws'\nexport const server = 1\n",
    }
    const { read, exists } = virtualFiles(files)
    const blocked = collectEdges('/app/main.tsx', read, exists).filter((edge) =>
      consoleEdgeBlocked(edge.spec, edge.resolved),
    )
    expect(blocked.length).toBeGreaterThan(0)
    expect(
      blocked.some((edge) => edge.spec === '../src/runtime/server' && edge.resolved !== null),
    ).toBe(true)
  })

  it('traverses a forbidden transitive import under Windows path semantics (negative)', () => {
    const { read, exists } = virtualFiles(
      {
        'C:/app/main.tsx': "import player from '../src/performance/browser/player'\n",
        'C:/src/performance/browser/player.ts':
          "import { server } from '../../runtime/server'\nexport const player = server\n",
        'C:/src/runtime/server.ts': "import WebSocket from 'ws'\nexport const server = WebSocket\n",
      },
      win32,
    )
    const edges = collectEdges('C:/app/main.tsx', read, exists, win32)
    // Both hops resolved, so the blocked edge below is a real traversal result,
    // not a missing virtual key.
    expect(
      edges.some(
        (edge) =>
          edge.spec === '../src/performance/browser/player' && edge.resolved !== null,
      ),
    ).toBe(true)
    expect(
      edges.some((edge) => edge.spec === '../../runtime/server' && edge.resolved !== null),
    ).toBe(true)
    const blocked = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(blocked.some((edge) => edge.spec === '../../runtime/server')).toBe(true)
    expect(blocked.some((edge) => edge.spec === 'ws')).toBe(true)
  })

  it('does not mistake a Windows sibling performance module for the browser subtree (negative)', () => {
    const { read, exists } = virtualFiles(
      {
        'C:/app/main.tsx': "import other from '../src/performance/browser-other/player'\n",
        'C:/src/performance/browser-other/player.ts': 'export const other = 1\n',
      },
      win32,
    )
    const edges = collectEdges('C:/app/main.tsx', read, exists, win32)
    const blocked = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(
      blocked.some(
        (edge) =>
          edge.spec === '../src/performance/browser-other/player' && edge.resolved !== null,
      ),
    ).toBe(true)
  })

  it('flags a production module importing test code through the same checker', () => {
    const files: Record<string, string> = {
      '/src/app.ts': "import { fixture } from '../test/support/fixture-data'\nexport const x = fixture\n",
      '/test/support/fixture-data.ts': 'export const fixture = 1\n',
    }
    const { read, exists } = virtualFiles(files)
    const edges = collectEdges('/src/app.ts', read, exists)
    expect(edges.some((edge) => edge.resolved !== null && isTestPath(edge.resolved))).toBe(true)
  })

  it('keeps all production source from importing test code', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      for (const spec of moduleSpecifiers(readFileSync(file, 'utf8'), file)) {
        const resolved = makeResolver(isFile)(spec, file)
        if (isTestPath(spec) || (resolved !== null && isTestPath(resolved))) {
          offenders.push(`${file} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the I1 loop demo client free of Node, provider and runner imports', () => {
    const entry = join(ROOT, 'test', 'browser', 'loop.ts')
    const edges = collectEdges(entry, (file) => readFileSync(file, 'utf8'), isFile)
    const offenders = edges.filter((edge) => consoleEdgeBlocked(edge.spec, edge.resolved))
    expect(offenders).toEqual([])
    // The demo may share the browser-safe performer machine, but must never
    // reach Node-only test support or a fixture runner.
    expect(
      edges.some((edge) => edge.resolved !== null && /\/test\/support\//.test(norm(edge.resolved))),
    ).toBe(false)
  })
})