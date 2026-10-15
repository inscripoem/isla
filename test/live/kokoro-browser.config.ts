import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/**
 * Isolated Node-only Vite configuration for the M1 kokoro generated-WAV browser
 * smoke harness.
 *
 * This is a test fixture, not product HTTP wiring: it serves exactly one
 * loopback harness page and two fixed read-only fixture routes backed by the
 * known generated WAV. It never offers generic file serving and never exposes
 * the repository as static content.
 */

const liveDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const srcDir = join(repoRoot, 'src')
const browserDir = join(srcDir, 'performance', 'browser')
const contractsDir = join(srcDir, 'contracts', 'app')
const nodeModulesDir = join(repoRoot, 'node_modules')
const liveNodeModulesDir = join(liveDir, 'node_modules')
const liveViteDepsDir = join(liveNodeModulesDir, '.vite', 'deps')
const repoToolingViteDepsDir = join(nodeModulesDir, '.vite', 'deps')
const kokoroHtmlPath = join(liveDir, 'kokoro-browser.html')
const fixtureWavPath = join(repoRoot, '.cache', 'audio', 'kokoro-smoke.wav')

/**
 * Resolve the installed Vite package's public browser client `env.mjs` through
 * Node's official module resolver, derive its exact containing package path and
 * return the normalized absolute `dist/client/env.mjs` file. No version, hash or
 * `.pnpm` path is hardcoded; if resolution fails the result is null and the
 * asset is not served.
 */
function resolveVitePublicClientEnv(): string | null {
  try {
    const resolved = import.meta.resolve('vite')
    const entryPath = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved
    const marker = join('node_modules', 'vite')
    const markerIndex = entryPath.lastIndexOf(marker)
    if (markerIndex === -1) return null
    const packageRoot = entryPath.slice(0, markerIndex + marker.length)
    return normalize(join(packageRoot, 'dist', 'client', 'env.mjs'))
  } catch {
    return null
  }
}

const vitePublicClientEnvPath = resolveVitePublicClientEnv()

const FIXTURE_PREFIX = '/__kokoro_fixture/'
const FIXTURE_AUDIO_ROUTE = '/__kokoro_fixture/audio.wav'
const FIXTURE_METADATA_ROUTE = '/__kokoro_fixture/metadata'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Refuse a non-loopback `--host` override. A bare `--host` listens on all
 * interfaces and is therefore rejected as well.
 */
function assertLoopbackHost(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    let value: string | null = null
    if (arg === '--host') {
      const next = argv[index + 1]
      value = next === undefined || next.startsWith('-') ? '' : next
    } else if (arg.startsWith('--host=')) {
      value = arg.slice('--host='.length)
    }
    if (value === null) continue
    if (!LOOPBACK_HOSTS.has(value)) {
      const shown = value.length === 0 ? '(all interfaces)' : value
      throw new Error(
        `kokoro-browser fixture: refusing non-loopback host ${shown}; only ${[...LOOPBACK_HOSTS].join(', ')} are permitted`,
      )
    }
  }
}

assertLoopbackHost(process.argv)

interface WavMetadata {
  readonly sha256: string
  readonly byteLength: number
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
  readonly floatFormat: string
  readonly frameCount: number
  readonly durationMs: number
}

type FixtureResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly metadata: WavMetadata }
  | { readonly ok: false }

interface Format {
  readonly sampleRate: number
  readonly channels: number
  readonly bits: number
  readonly blockAlign: number
}

/**
 * Parse and validate the exact current RIFF/WAVE bytes. It accepts only
 * WAVE_FORMAT_IEEE_FLOAT (tag 3), mono, 32-bit samples and requires the fmt and
 * data chunks to be internally consistent and bounded by the file length. No
 * size, hash or duration is assumed from any prior snapshot.
 */
function parseWav(bytes: Buffer): FixtureResult {
  if (bytes.length < 12) return { ok: false }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return { ok: false }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return { ok: false }
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return { ok: false }

  let offset = 12
  let format: Format | null = null
  let dataSize: number | null = null

  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    if (dataStart + chunkSize > bytes.length) return { ok: false }

    if (chunkId === 'fmt ') {
      if (format !== null || chunkSize < 16) return { ok: false }
      const audioFormat = bytes.readUInt16LE(dataStart)
      const channels = bytes.readUInt16LE(dataStart + 2)
      const sampleRate = bytes.readUInt32LE(dataStart + 4)
      const byteRate = bytes.readUInt32LE(dataStart + 8)
      const blockAlign = bytes.readUInt16LE(dataStart + 12)
      const bits = bytes.readUInt16LE(dataStart + 14)
      if (audioFormat !== 3) return { ok: false }
      if (channels !== 1) return { ok: false }
      if (bits !== 32) return { ok: false }
      if (!Number.isInteger(sampleRate) || sampleRate <= 0) return { ok: false }
      if (blockAlign !== channels * (bits / 8)) return { ok: false }
      if (byteRate !== sampleRate * blockAlign) return { ok: false }
      format = { sampleRate, channels, bits, blockAlign }
    } else if (chunkId === 'data') {
      if (format === null || dataSize !== null) return { ok: false }
      if (chunkSize === 0 || chunkSize % format.blockAlign !== 0) return { ok: false }
      dataSize = chunkSize
    }

    offset = dataStart + chunkSize + (chunkSize % 2)
  }

  if (format === null || dataSize === null) return { ok: false }
  if (offset !== bytes.length) return { ok: false }

  const frameCount = dataSize / format.blockAlign
  const durationMs = (frameCount / format.sampleRate) * 1000
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  return {
    ok: true,
    bytes,
    metadata: {
      sha256,
      byteLength: bytes.length,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bits,
      floatFormat: 'IEEE-754 float32 (WAVE_FORMAT_IEEE_FLOAT)',
      frameCount,
      durationMs,
    },
  }
}

/** Read and parse the fixed generated WAV at request time. */
function loadFixture(): FixtureResult {
  try {
    return parseWav(readFileSync(fixtureWavPath))
  } catch {
    return { ok: false }
  }
}

function isWithin(target: string, directory: string): boolean {
  const rel = relative(directory, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Only Vite's own client/environment endpoints are served from `/@vite`. */
function isAllowedViteEndpoint(pathname: string): boolean {
  return pathname === '/@vite/client' || pathname === '/@vite/env'
}

/** Only actual optimized dependency JS assets are served from node_modules. */
function isViteOptimizedDependency(pathname: string): boolean {
  return pathname.startsWith('/node_modules/.vite/deps/') && pathname.endsWith('.js')
}

/**
 * Fail-closed allowlist for non-fixture requests. It permits the harness HTML
 * and client, Vite's client/env endpoints, real optimized dependency assets, the
 * exact resolved Vite public client `env.mjs` file and `/@fs` paths that resolve
 * inside the browser-safe M1 subtree, the browser-safe contracts subtree or the
 * Vite dependency cache. Nothing else is served.
 */
function isAllowedHarnessPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/kokoro-browser.html' || pathname === '/kokoro-browser.ts') {
    return true
  }
  if (isAllowedViteEndpoint(pathname)) return true
  if (isViteOptimizedDependency(pathname)) return true
  if (pathname.startsWith('/@fs/')) {
    const target = normalize(pathname.slice('/@fs/'.length))
    if (vitePublicClientEnvPath !== null && target === vitePublicClientEnvPath) return true
    return (
      isWithin(target, browserDir) ||
      isWithin(target, contractsDir) ||
      isWithin(target, liveViteDepsDir) ||
      isWithin(target, repoToolingViteDepsDir)
    )
  }
  return false
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

function kokoroFixturePlugin(): Plugin {
  return {
    name: 'isla-kokoro-browser-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '/'
        const queryIndex = rawUrl.indexOf('?')
        const hasQuery = queryIndex !== -1
        const rawPathname = hasQuery ? rawUrl.slice(0, queryIndex) : rawUrl

        // Fixture routes require the raw pathname to be exactly one of the two
        // literals; percent-encoded or otherwise rewritten variants are refused
        // before the fixture is ever read.
        if (rawPathname === FIXTURE_AUDIO_ROUTE || rawPathname === FIXTURE_METADATA_ROUTE) {
          if (req.method !== 'GET') {
            sendText(res, 405, 'method not allowed')
            return
          }
          if (hasQuery) {
            sendText(res, 404, 'not found')
            return
          }
          const fixture = loadFixture()
          if (!fixture.ok) {
            sendJson(res, 503, { error: 'fixture_unavailable' })
            return
          }
          if (rawPathname === FIXTURE_METADATA_ROUTE) {
            sendJson(res, 200, fixture.metadata)
            return
          }
          res.statusCode = 200
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('Content-Type', 'audio/wav')
          res.setHeader('Content-Length', String(fixture.bytes.length))
          res.end(fixture.bytes)
          return
        }

        if (rawPathname.startsWith(FIXTURE_PREFIX)) {
          sendText(res, 404, 'not found')
          return
        }

        let decoded: string
        try {
          decoded = decodeURIComponent(rawPathname)
        } catch {
          sendText(res, 400, 'bad request')
          return
        }

        if (isAllowedHarnessPath(decoded)) {
          next()
          return
        }

        sendText(res, 404, 'not found')
      })
    },
  }
}

export default defineConfig({
  root: liveDir,
  appType: 'mpa',
  plugins: [kokoroFixturePlugin()],
  server: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
    fs: {
      strict: true,
      allow: [liveDir, browserDir, contractsDir, nodeModulesDir],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: { 'kokoro-browser': kokoroHtmlPath },
    },
  },
})
