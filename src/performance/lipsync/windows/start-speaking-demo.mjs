/**
 * User-facing Windows launcher for the basic speaking-mouth demo.
 *
 * This is the simple open/close mouth mode, not the advanced phoneme feature.
 * The launcher composes the existing runtime production entry with the
 * existing-only M1 speaking deployment, a loopback Vite front end, a dedicated
 * Chrome/Edge app window, and the existing Python mouth companion. It owns every
 * process and local service it starts and never starts VTube Studio itself.
 *
 * It deliberately depends only on Node's standard library plus the project's
 * existing `ws`, `vite` and `tsx` packages. Vite and `ws` are imported only after
 * help and configuration validation, so `--help` works without installed
 * project packages and without a Windows platform check.
 *
 * The token value is read into memory only. The browser never receives it, no
 * URL or log contains it, and the Vite server denies the exact selected token
 * file in addition to Vite's standard deny rules.
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

const PLUGIN_NAME = 'Isla Runtime'
const PLUGIN_DEVELOPER = 'CS5351 Isla'

const VTS_API_NAME = 'VTubeStudioPublicAPI'
const VTS_API_VERSION = '1.0'
const DEFAULT_VTS_URL = 'ws://127.0.0.1:8001'

const MOUTH_FORM_INPUT = 'IslaMouthForm'
const MOUTH_X_INPUT = 'IslaMouthX'
const HOTKEY_ACTIONS = ['animation-1', 'animation-2', 'animation-3']

const DEFAULT_MODEL_MANIFEST = 'isla-speaking-model.json'
const DEFAULT_WEB_PORT = 14773
const DEFAULT_RUNTIME_PORT = 14774
const DEFAULT_CACHE_DIR = join(REPO_ROOT, '.cache', 'models', 'kokoro-cache')
const DEFAULT_PYTHON = join(REPO_ROOT, '.cache', 'm1-speaking-windows', 'Scripts', 'python.exe')

const LOCAL_TEXT_MODEL = 'local-speaking-echo'
const LOCAL_TEXT_API_KEY = 'local-speaking-demo'
const MAX_TEXT_BODY_BYTES = 1024 * 1024

const TEMP_PREFIX = 'isla-speaking-demo-'

const VTS_OPEN_TIMEOUT_MS = 4_000
const VTS_REQUEST_TIMEOUT_MS = 5_000
const VTS_MODEL_LOAD_TIMEOUT_MS = 12_000
const VTS_RESTORE_TIMEOUT_MS = 8_000
const MODEL_TRANSITION_TIMEOUT_MS = 8_000
const MODEL_TRANSITION_POLL_MS = 120
const CONTROLLED_TARGET_OBSERVE_MS = 1_000

const RUNTIME_HEALTH_TIMEOUT_MS = 120_000
const RUNTIME_STOP_TIMEOUT_MS = 10_000
const COMPANION_READY_TIMEOUT_MS = 45_000
const COMPANION_STOP_TIMEOUT_MS = 6_000
const BROWSER_STOP_TIMEOUT_MS = 3_000
const VITE_STOP_TIMEOUT_MS = 4_000
const SPAWN_TIMEOUT_MS = 10_000

// Vite 8's standard deny list. The inline server config below must repeat it
// because an explicit `fs.deny` replaces the defaults rather than appending.
const VITE_DEFAULT_DENY = [
  '.env',
  '.env.*',
  '*.{crt,pem,key,p12,pfx,cer,der}',
  '.npmrc',
  '.yarnrc.yml',
  '**/.git/**',
]

const HELP = `
Isla speaking-mouth demo (Windows, basic open/close mode)

Usage:
  node src/performance/lipsync/windows/start-speaking-demo.mjs [options]

Example:
  node src/performance/lipsync/windows/start-speaking-demo.mjs --model-manifest ./isla-speaking-model.json --token-file C:/path/to/isla-runtime-cs5351.token --python ./.cache/m1-speaking-windows/Scripts/python.exe

Prerequisites:
  * Windows 10/11, Node 22 or newer, and project dependencies installed
    (pnpm install).
  * VTube Studio is already running with its API enabled, and the existing
    "Isla Runtime" / "CS5351 Isla" token is approved. This launcher never starts
    VTube Studio and never requests a new token.
  * The configured model is installed in VTube Studio. Its model id and its
    three advertised hotkey ids must match the manifest.
  * Python 3 with websocket-client, pycaw, comtypes and psutil (the speaking
    companion's documented Windows audio dependencies).
  * Google Chrome or Microsoft Edge, or an explicit --browser path.

Model manifest:
  A JSON object with this shape (replace every placeholder):
    {
      "modelId": "<VTube Studio model id>",
      "input": "<opening input name, 0..1>",
      "hotkeyMap": {
        "animation-1": "<hotkey id>",
        "animation-2": "<hotkey id>",
        "animation-3": "<hotkey id>"
      }
    }
  The launcher also uses IslaMouthForm (-1..1) and IslaMouthX (-1..1). Custom
  inputs are created only when missing. Existing inputs are never changed.

Text mode:
  Default (local): a fresh loopback-only OpenAI-compatible service speaks the
  operator's line after "Listener said:". The first sentence is line one and all
  remaining sentences are joined into line two. No remote text request is made.
  --live-text: use the existing ISLA_LIVE_TEXT_BASE_URL, ISLA_LIVE_TEXT_MODEL and
  ISLA_LIVE_TEXT_API_KEY values. Missing variable names are reported, never values.

Shutdown:
  Close the demo browser window or press Ctrl+C here. The launcher signals the
  mouth companion to neutralize, neutralizes on the correct model if needed,
  restores the VTube Studio model it changed, requests cooperative runtime
  shutdown, closes its local services, stops only the browser process tree it
  started, and removes its own temporary directory after a clean shutdown. On a
  failure it keeps that directory as diagnostic output and reports the path.
  Keep VTube Studio running until shutdown finishes so the previous model can be
  restored.

Options:
  -h, --help                 Show this help and exit.
  --model-manifest <path>    Model manifest (env ISLA_SPEAKING_MODEL_MANIFEST;
                             default ./isla-speaking-model.json from the working
                             directory).
  --token-file <path>        Existing VTS token (env ISLA_VTS_TOKEN_PATH;
                             default %LOCALAPPDATA%\\isla-vts\\isla-runtime-cs5351.token
                             when that file exists).
  --python <path>            Python executable (env ISLA_SPEAKING_PYTHON;
                             default ./.cache/m1-speaking-windows/Scripts/python.exe
                             or python on PATH).
  --browser <path>           Chrome/Edge executable (env ISLA_SPEAKING_BROWSER;
                             default standard Chrome then Edge install paths).
  --cache <dir>              Kokoro model cache (env ISLA_KOKORO_MODEL_DIR;
                             default ./.cache/models/kokoro-cache).
  --vts-url <ws://...>       Loopback VTube Studio WebSocket
                             (default ws://127.0.0.1:8001).
  --web-port <port>          Loopback Vite port (env ISLA_SPEAKING_WEB_PORT;
                             default 14773).
  --runtime-port <port>      Loopback runtime port (env ISLA_SPEAKING_RUNTIME_PORT;
                             default 14774).
  --live-text                Opt in to the existing live text provider.
`

class DemoError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'DemoError'
    this.usage = options.usage === true
  }
}

class StopRequested extends Error {
  constructor() {
    super('stop requested')
    this.name = 'StopRequested'
  }
}

class VtsApiError extends DemoError {
  constructor(messageType, errorID) {
    super(`VTube Studio rejected ${messageType} (API error ${String(errorID)}).`)
    this.name = 'VtsApiError'
    this.messageType = messageType
    this.errorID = errorID
  }
}

function usageError(message) {
  return new DemoError(message, { usage: true })
}

function runtimeError(message) {
  return new DemoError(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function info(message) {
  process.stdout.write(`speaking-demo: ${message}\n`)
}

function warn(message) {
  process.stderr.write(`speaking-demo: ${message}\n`)
}

function printHelp() {
  process.stdout.write(HELP)
}

function envValue(name) {
  const raw = process.env[name]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

function resolveUserPath(value) {
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function findOnPath(names) {
  const rawPath = process.env.PATH
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined
  for (const rawEntry of rawPath.split(';')) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1')
    if (entry.length === 0) continue
    for (const name of names) {
      const candidate = join(entry, name)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function executableNames(value) {
  if (/\.[A-Za-z0-9]+$/.test(value)) return [value]
  return [`${value}.exe`, value]
}

function hasPathSeparator(value) {
  return value.includes('/') || value.includes('\\')
}

function resolveExecutable(value, defaultPaths, pathNames, label, guidance) {
  if (typeof value === 'string' && value.trim().length > 0) {
    const explicit = value.trim()
    const found = hasPathSeparator(explicit)
      ? resolveUserPath(explicit)
      : findOnPath(executableNames(explicit))
    if (found === undefined || !isFile(found)) {
      throw usageError(
        `${label} executable was not found: ${explicit}. ${guidance}`,
      )
    }
    return found
  }

  for (const candidate of defaultPaths) {
    if (isFile(candidate)) return candidate
  }

  const found = findOnPath(pathNames)
  if (found !== undefined) return found
  throw usageError(`${label} executable was not found. ${guidance}`)
}

function standardBrowserCandidates() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter((root) => typeof root === 'string' && root.length > 0)
  const candidates = []
  for (const root of roots) {
    candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  for (const root of roots) {
    candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  return [...new Set(candidates)]
}

function parseArgs(argv) {
  const options = { liveText: false }
  const valueOptions = new Map([
    ['--model-manifest', 'modelManifest'],
    ['--token-file', 'tokenFile'],
    ['--python', 'python'],
    ['--browser', 'browser'],
    ['--cache', 'cache'],
    ['--vts-url', 'vtsUrl'],
    ['--web-port', 'webPort'],
    ['--runtime-port', 'runtimePort'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--live-text') {
      options.liveText = true
      continue
    }

    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const key = valueOptions.get(name)
    if (key === undefined) {
      throw usageError(`unknown option "${name}".`)
    }

    let value = equals === -1 ? undefined : arg.slice(equals + 1)
    if (value === undefined) {
      index += 1
      if (index >= argv.length) {
        throw usageError(`${name} needs a value.`)
      }
      value = argv[index]
    }
    if (value.length === 0) {
      throw usageError(`${name} needs a non-empty value.`)
    }
    options[key] = value
  }

  return options
}

function requireRepoFile(relativePath) {
  const path = join(REPO_ROOT, relativePath)
  if (!isFile(path)) {
    throw usageError(
      `This launcher must run from an Isla checkout; expected file is missing: ${path}.`,
    )
  }
  return path
}

function requireManifestString(value, field, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw usageError(`Model manifest field ${field} must be a non-empty string: ${path}.`)
  }
  return value.trim()
}

function validateManifest(value, path) {
  if (!isRecord(value)) {
    throw usageError(`Model manifest must be a JSON object: ${path}.`)
  }

  const modelId = requireManifestString(value.modelId, 'modelId', path)
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(modelId)) {
    throw usageError(
      'Model manifest modelId must contain only letters, digits, dots, underscores, colons or hyphens (maximum 128 characters).',
    )
  }

  const input = requireManifestString(value.input, 'input', path)
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(input)) {
    throw usageError(
      'Model manifest input must be a VTube Studio input name: start with a letter, then letters, digits or underscores.',
    )
  }
  if (input === MOUTH_FORM_INPUT || input === MOUTH_X_INPUT) {
    throw usageError(
      `Model manifest input must differ from ${MOUTH_FORM_INPUT} and ${MOUTH_X_INPUT}.`,
    )
  }

  const rawMap = value.hotkeyMap
  if (!isRecord(rawMap)) {
    throw usageError(
      `Model manifest hotkeyMap must be an object with ${HOTKEY_ACTIONS.join(', ')}: ${path}.`,
    )
  }

  const keys = Object.keys(rawMap)
  const missing = HOTKEY_ACTIONS.filter((action) => !Object.hasOwn(rawMap, action))
  const unexpected = keys.filter((key) => !HOTKEY_ACTIONS.includes(key))
  if (missing.length > 0 || unexpected.length > 0) {
    const details = []
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`)
    if (unexpected.length > 0) details.push(`unexpected ${unexpected.join(', ')}`)
    throw usageError(
      `Model manifest hotkeyMap must contain exactly ${HOTKEY_ACTIONS.join(', ')} (${details.join('; ')}).`,
    )
  }

  const hotkeyMap = {}
  for (const action of HOTKEY_ACTIONS) {
    const raw = rawMap[action]
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw usageError(`Model manifest hotkeyMap.${action} must be a non-empty hotkey id.`)
    }
    const hotkeyId = raw.trim()
    if (hotkeyId.length > 256 || /\s/.test(hotkeyId)) {
      throw usageError(`Model manifest hotkeyMap.${action} is not a valid hotkey id.`)
    }
    hotkeyMap[action] = hotkeyId
  }

  return { modelId, input, hotkeyMap }
}

function readManifest(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw usageError(
      `Model manifest could not be read: ${path}. Pass --model-manifest or set ISLA_SPEAKING_MODEL_MANIFEST.`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw usageError(`Model manifest is not valid JSON: ${path}.`)
  }
  return validateManifest(parsed, path)
}

function readToken(path) {
  let stats
  try {
    stats = statSync(path)
  } catch {
    throw usageError(
      `The VTS token file does not exist or cannot be read: ${path}. This demo never creates tokens.`,
    )
  }
  if (!stats.isFile()) {
    throw usageError(`The VTS token path is not a file: ${path}.`)
  }
  if (stats.size > 16_384) {
    throw usageError('The VTS token file is too large to be one authentication token.')
  }

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw usageError(`The VTS token file could not be read: ${path}.`)
  }
  const token = text.trim()
  if (token.length === 0 || token.length > 4_096 || /\s/.test(token)) {
    throw usageError(
      `The VTS token file must contain one existing Isla Runtime token: ${path}.`,
    )
  }
  return token
}

function parsePort(value, label) {
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    throw usageError(`${label} must be a decimal port number.`)
  }
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usageError(`${label} must be between 1 and 65535.`)
  }
  return port
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function validateVtsUrl(raw) {
  const value = raw.trim()
  let url
  try {
    url = new URL(value)
  } catch {
    throw usageError('--vts-url must be a loopback ws:// URL with an explicit port.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (
    url.protocol !== 'ws:' ||
    !isLoopbackHostname(hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.port.length === 0
  ) {
    throw usageError('--vts-url must be a loopback ws:// URL without credentials, query or path.')
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usageError('--vts-url must include a valid port between 1 and 65535.')
  }
  return value
}

function readLiveTextConfig() {
  const names = [
    'ISLA_LIVE_TEXT_BASE_URL',
    'ISLA_LIVE_TEXT_MODEL',
    'ISLA_LIVE_TEXT_API_KEY',
  ]
  const values = names.map((name) => envValue(name))
  const missing = names.filter((_name, index) => values[index] === undefined)
  if (missing.length > 0) {
    throw usageError(
      `--live-text requires these environment variables; missing: ${missing.join(', ')}.`,
    )
  }

  const [baseUrl, model, apiKey] = values
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw usageError('ISLA_LIVE_TEXT_BASE_URL must be a valid HTTP(S) URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw usageError('ISLA_LIVE_TEXT_BASE_URL must use http or https.')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw usageError(
      'ISLA_LIVE_TEXT_BASE_URL must use https, or http only on a loopback host.',
    )
  }
  return { baseUrl, model, apiKey }
}

function resolveConfig(argv) {
  const options = parseArgs(argv)
  const repoFiles = {
    productionCli: requireRepoFile('src/runtime/production-cli.ts'),
    deployment: requireRepoFile('test/live/m1-speaking-deployment.ts'),
    companion: requireRepoFile('src/performance/lipsync/speaking_mouth.py'),
    viteConfig: requireRepoFile('vite.config.ts'),
  }

  const manifestPath = resolveUserPath(
    options.modelManifest ??
      envValue('ISLA_SPEAKING_MODEL_MANIFEST') ??
      join(process.cwd(), DEFAULT_MODEL_MANIFEST),
  )
  const manifest = readManifest(manifestPath)

  const liveText = options.liveText ? readLiveTextConfig() : null

  const explicitToken = options.tokenFile ?? envValue('ISLA_VTS_TOKEN_PATH')
  let tokenPath
  if (explicitToken !== undefined) {
    tokenPath = resolveUserPath(explicitToken)
  } else {
    const localAppData = envValue('LOCALAPPDATA')
    const candidate =
      localAppData === undefined
        ? undefined
        : join(localAppData, 'isla-vts', 'isla-runtime-cs5351.token')
    if (candidate === undefined || !isFile(candidate)) {
      throw usageError(
        'No VTS token file was specified and the default LOCALAPPDATA path does not exist. Pass --token-file or set ISLA_VTS_TOKEN_PATH.',
      )
    }
    tokenPath = candidate
  }
  const token = readToken(tokenPath)

  const pythonPath = resolveExecutable(
    options.python ?? envValue('ISLA_SPEAKING_PYTHON'),
    [DEFAULT_PYTHON],
    ['python.exe', 'python3.exe'],
    'Python',
    'Pass --python <python.exe> or set ISLA_SPEAKING_PYTHON. Install the companion dependencies in that environment.',
  )

  const browserPath = resolveExecutable(
    options.browser ?? envValue('ISLA_SPEAKING_BROWSER'),
    standardBrowserCandidates(),
    ['chrome.exe', 'msedge.exe'],
    'Chrome or Edge',
    'Pass --browser <chrome.exe-or-msedge.exe> or set ISLA_SPEAKING_BROWSER.',
  )

  const cacheDir = resolveUserPath(
    options.cache ?? envValue('ISLA_KOKORO_MODEL_DIR') ?? DEFAULT_CACHE_DIR,
  )
  if (!isDirectory(cacheDir)) {
    throw usageError(
      `The Kokoro model cache directory does not exist: ${cacheDir}. Pass --cache or set ISLA_KOKORO_MODEL_DIR after preparing the cache.`,
    )
  }

  const webPort = parsePort(
    options.webPort ?? envValue('ISLA_SPEAKING_WEB_PORT') ?? DEFAULT_WEB_PORT,
    '--web-port / ISLA_SPEAKING_WEB_PORT',
  )
  const runtimePort = parsePort(
    options.runtimePort ?? envValue('ISLA_SPEAKING_RUNTIME_PORT') ?? DEFAULT_RUNTIME_PORT,
    '--runtime-port / ISLA_SPEAKING_RUNTIME_PORT',
  )
  if (webPort === runtimePort) {
    throw usageError('The web port and runtime port must be different.')
  }

  const vtsUrl = validateVtsUrl(options.vtsUrl ?? DEFAULT_VTS_URL)

  return {
    repoFiles,
    manifest,
    manifestPath,
    token,
    tokenPath,
    pythonPath,
    browserPath,
    cacheDir,
    webPort,
    runtimePort,
    vtsUrl,
    liveText,
  }
}

function webOrigin(port) {
  return `http://127.0.0.1:${port}`
}

function createShutdownController() {
  const controller = new AbortController()
  let requested = false
  let reason = ''
  let resolveWait
  const wait = new Promise((resolveWaitPromise) => {
    resolveWait = resolveWaitPromise
  })

  return {
    signal: controller.signal,
    get requested() {
      return requested
    },
    get reason() {
      return reason
    },
    request(nextReason) {
      if (requested) return
      requested = true
      reason = nextReason
      controller.abort()
      resolveWait()
    },
    wait: () => wait,
  }
}

function throwIfStopped(signal) {
  if (signal.aborted) throw new StopRequested()
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new StopRequested())
  return new Promise((resolveValue, rejectValue) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      rejectValue(new StopRequested())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolveValue(value)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        rejectValue(error)
      },
    )
  })
}

async function delay(signal, milliseconds) {
  try {
    await sleep(milliseconds, undefined, { signal })
  } catch (error) {
    if (signal.aborted) throw new StopRequested()
    throw error
  }
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(() => {
      rejectValue(new DemoError(message))
    }, milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolveValue(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectValue(error)
      },
    )
  })
}

async function assertPortAvailable(port, label, hint) {
  await new Promise((resolveValue, rejectValue) => {
    const server = createNetServer()
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        rejectValue(
          runtimeError(
            `The ${label} port ${port} is already in use. Stop the other process or choose another port with ${hint}. This launcher does not stop or reuse other services.`,
          ),
        )
        return
      }
      rejectValue(
        runtimeError(
          `The ${label} port ${port} could not be checked (${error?.code ?? 'unknown error'}). Choose another port with ${hint}.`,
        ),
      )
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolveValue())
    })
  })
}

async function assertPortsAvailable(config) {
  await assertPortAvailable(
    config.webPort,
    'web',
    '--web-port or ISLA_SPEAKING_WEB_PORT',
  )
  await assertPortAvailable(
    config.runtimePort,
    'runtime',
    '--runtime-port or ISLA_SPEAKING_RUNTIME_PORT',
  )
}

function createRunDir() {
  try {
    return mkdtempSync(join(tmpdir(), TEMP_PREFIX))
  } catch (error) {
    throw runtimeError(`A private temporary directory could not be created: ${safeError(error)}.`)
  }
}

function createRunPaths(runDir) {
  return {
    runDir,
    dbPath: join(runDir, 'isla-speaking.db'),
    profileDir: join(runDir, 'browser-profile'),
    stopFile: join(runDir, 'mouth.stop'),
    mouthStateLog: join(runDir, 'mouth.jsonl'),
    mouthLog: join(runDir, 'mouth.log'),
    runtimeLog: join(runDir, 'runtime.log'),
    viteCache: join(runDir, 'vite-cache'),
  }
}

function waitForExit(child, milliseconds) {
  if (child === null || child === undefined) return Promise.resolve(true)
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  if (child.pid === undefined) return Promise.resolve(true)

  return new Promise((resolveValue) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      child.off('exit', onExit)
      resolveValue(value)
    }
    const onExit = () => finish(true)
    timer = setTimeout(() => finish(false), milliseconds)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) finish(true)
  })
}

async function awaitSpawn(child, label, signal) {
  if (child.pid !== undefined) return
  await abortable(
    new Promise((resolveValue, rejectValue) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('spawn', onSpawn)
        child.off('error', onError)
        child.off('exit', onExit)
        if (error) rejectValue(error)
        else resolveValue()
      }
      const onSpawn = () => finish(null)
      const onError = (error) => {
        finish(
          runtimeError(
            `${label} could not be started${error?.code ? ` (${error.code})` : ''}.`,
          ),
        )
      }
      const onExit = (code, signalName) => {
        finish(
          runtimeError(
            `${label} exited before it started (${code ?? signalName ?? 'unknown'}).`,
          ),
        )
      }
      const timer = setTimeout(() => {
        finish(runtimeError(`${label} did not start within ${SPAWN_TIMEOUT_MS / 1000} seconds.`))
      }, SPAWN_TIMEOUT_MS)
      child.once('spawn', onSpawn)
      child.once('error', onError)
      child.once('exit', onExit)
    }),
    signal,
  )
}

function guardChildErrors(child, label, shutdown) {
  child.on('error', (error) => {
    if (shutdown.requested) return
    warn(`${label} error: ${safeError(error)}`)
  })
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      timeout: 5_000,
    })
    return result.status === 0 || result.status === 128
  } catch {
    return false
  }
}

function attachChildOutput(child, options) {
  const ring = []
  let logStream = null
  let closed = false

  try {
    logStream = createWriteStream(options.logPath, { flags: 'wx' })
    logStream.on('error', () => {
      logStream = null
    })
  } catch {
    logStream = null
  }

  const readStream = (stream) => {
    const reader = createInterface({ input: stream, crlfDelay: Infinity })
    reader.on('line', (line) => {
      if (ring.length >= 40) ring.shift()
      ring.push(line)
      if (logStream !== null) {
        try {
          logStream.write(`${line}\n`)
        } catch {
          // Losing the private diagnostic log must not stop the demo.
        }
      }
      if (options.onLine !== undefined) {
        try {
          options.onLine(line)
        } catch {
          // A display callback cannot fault the child.
        }
      }
    })
    return reader
  }

  const stdoutReader = child.stdout ? readStream(child.stdout) : null
  const stderrReader = child.stderr ? readStream(child.stderr) : null

  const close = () => {
    if (closed) return
    closed = true
    try {
      stdoutReader?.close()
    } catch {
      // The stream may already be closed by the child.
    }
    try {
      stderrReader?.close()
    } catch {
      // The stream may already be closed by the child.
    }
    try {
      logStream?.end()
    } catch {
      // The private log is best effort.
    }
    logStream = null
  }

  child.once('close', close)

  return {
    lastLines: () => ring.slice(),
    close,
  }
}

function lastChildMessage(output) {
  const lines = output?.lastLines() ?? []
  if (lines.length === 0) return ''
  const text = lines[lines.length - 1].trim().slice(0, 300)
  return text.length > 0 ? `Last message: ${text}` : ''
}

function runtimeLineHandler(line) {
  try {
    const event = JSON.parse(line)
    if (isRecord(event) && event.level === 'error') {
      const suffix = typeof event.error === 'string' ? `: ${event.error}` : ''
      warn(`runtime: ${String(event.event ?? 'error')}${suffix}`.slice(0, 700))
    }
  } catch {
    // Runtime stdout can include loader warnings; the private log keeps them.
  }
}

function mouthLineHandler(line) {
  const text = line.trim()
  if (text.length > 0) warn(`mouth: ${text.slice(0, 500)}`)
}

class VtsSession {
  constructor(socket) {
    this.socket = socket
    this.pending = new Map()
    this.nextRequestId = 0
    this.opened = false
    this.closed = false
  }

  static open(url, WebSocketCtor, signal) {
    return new Promise((resolveValue, rejectValue) => {
      let socket
      try {
        socket = new WebSocketCtor(url, {
          handshakeTimeout: VTS_OPEN_TIMEOUT_MS,
          perMessageDeflate: false,
          maxPayload: 4 * 1024 * 1024,
        })
      } catch {
        rejectValue(
          runtimeError(
            `Could not create the VTube Studio WebSocket connection to ${url}.`,
          ),
        )
        return
      }

      const session = new VtsSession(socket)
      let settled = false
      let timer = null

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        socket.off('open', onOpen)
        socket.off('unexpected-response', onUnexpectedResponse)
      }

      const finish = (error, statusCode) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== null) {
          session.closed = true
          try {
            socket.terminate()
          } catch {
            // The connection failure is the reportable error.
          }
          rejectValue(vtsOpenError(url, error, statusCode))
          return
        }
        session.opened = true
        resolveValue(session)
      }

      const onOpen = () => finish(null)
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        session.closed = true
        try {
          socket.terminate()
        } catch {
          // The requested stop is the outcome.
        }
        rejectValue(new StopRequested())
      }
      const onUnexpectedResponse = (_request, response) => {
        try {
          response.resume()
        } catch {
          // The handshake failure is the reportable error.
        }
        finish(new Error('unexpected-response'), response?.statusCode)
      }

      socket.on('open', onOpen)
      socket.on('unexpected-response', onUnexpectedResponse)
      socket.on('message', (raw) => {
        if (session.opened) session.onMessage(raw)
      })
      socket.on('error', (error) => {
        if (!settled) {
          finish(error)
        } else {
          session.failAll('VTube Studio connection error.')
        }
      })
      socket.on('close', () => {
        if (!settled) {
          finish(new Error('closed'))
        } else {
          session.failAll('VTube Studio closed the connection.')
        }
      })

      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(new Error('timeout')), VTS_OPEN_TIMEOUT_MS)
    })
  }

  failAll(message) {
    this.closed = true
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(runtimeError(message))
    }
  }

  onMessage(raw) {
    if (this.closed) return

    let text
    try {
      if (typeof raw === 'string') text = raw
      else if (Buffer.isBuffer(raw)) text = raw.toString('utf8')
      else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8')
      else if (ArrayBuffer.isView(raw)) {
        text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
      } else text = String(raw)
    } catch {
      return
    }

    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(envelope)) return
    if (envelope.apiName !== VTS_API_NAME || envelope.apiVersion !== VTS_API_VERSION) {
      return
    }
    if (typeof envelope.requestID !== 'string') return

    const pending = this.pending.get(envelope.requestID)
    if (pending === undefined) return
    this.pending.delete(envelope.requestID)
    clearTimeout(pending.timer)

    if (envelope.messageType === 'APIError') {
      const data = envelope.data
      const errorID =
        isRecord(data) && typeof data.errorID === 'number' ? data.errorID : 'unknown'
      pending.reject(new VtsApiError(pending.messageType, errorID))
      return
    }
    if (envelope.messageType !== pending.expectedType) {
      pending.reject(
        runtimeError(
          `VTube Studio returned an unexpected response to ${pending.messageType}.`,
        ),
      )
      return
    }
    pending.resolve(envelope.data)
  }

  request(messageType, data, expectedType, timeoutMs) {
    if (this.closed) {
      return Promise.reject(runtimeError('The VTube Studio connection is closed.'))
    }
    if (this.socket.readyState !== 1) {
      return Promise.reject(runtimeError('The VTube Studio connection is not open.'))
    }

    this.nextRequestId += 1
    const requestId = `isla-speaking-${this.nextRequestId}`
    let serialized
    try {
      serialized = JSON.stringify({
        apiName: VTS_API_NAME,
        apiVersion: VTS_API_VERSION,
        requestID: requestId,
        messageType,
        data,
      })
    } catch {
      return Promise.reject(runtimeError('The VTube Studio request could not be encoded.'))
    }

    return new Promise((resolveValue, rejectValue) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return
        rejectValue(
          runtimeError(
            `VTube Studio did not answer ${messageType} within ${Math.round(timeoutMs / 1000)} seconds.`,
          ),
        )
      }, timeoutMs)

      this.pending.set(requestId, {
        expectedType,
        messageType,
        resolve: resolveValue,
        reject: rejectValue,
        timer,
      })

      try {
        this.socket.send(serialized)
      } catch {
        clearTimeout(timer)
        this.pending.delete(requestId)
        rejectValue(runtimeError(`The ${messageType} request could not be sent to VTube Studio.`))
      }
    })
  }

  close() {
    if (this.closed) {
      try {
        this.socket.terminate()
      } catch {
        // Already closed.
      }
      return
    }
    this.failAll('The VTube Studio connection was closed.')
    try {
      this.socket.removeAllListeners('message')
    } catch {
      // Listener removal is best effort.
    }
    try {
      this.socket.close()
    } catch {
      // The local process is stopping anyway.
    }
    try {
      this.socket.terminate()
    } catch {
      // The local process is stopping anyway.
    }
  }

  async authenticate(token) {
    let data
    try {
      data = await this.request(
        'AuthenticationRequest',
        {
          pluginName: PLUGIN_NAME,
          pluginDeveloper: PLUGIN_DEVELOPER,
          authenticationToken: token,
        },
        'AuthenticationResponse',
        VTS_REQUEST_TIMEOUT_MS,
      )
    } catch (error) {
      if (error instanceof VtsApiError) {
        throw runtimeError(
          `VTube Studio rejected the existing "Isla Runtime" / "CS5351 Isla" token (API error ${String(error.errorID)}). Confirm the token file is the one already paired with that plugin; this demo never requests a new token.`,
        )
      }
      throw error
    }
    if (!isRecord(data) || data.authenticated !== true) {
      throw runtimeError(
        'VTube Studio did not authenticate the existing "Isla Runtime" / "CS5351 Isla" token. Confirm the token file is the one already paired with that plugin; this demo never requests a new token.',
      )
    }
  }

  async currentModel() {
    const data = await this.request(
      'CurrentModelRequest',
      {},
      'CurrentModelResponse',
      VTS_REQUEST_TIMEOUT_MS,
    )
    if (
      !isRecord(data) ||
      typeof data.modelLoaded !== 'boolean' ||
      typeof data.modelID !== 'string'
    ) {
      throw runtimeError('VTube Studio returned an invalid current-model response.')
    }
    if (data.modelLoaded && data.modelID.length === 0) {
      throw runtimeError('VTube Studio reported a loaded model without a model id.')
    }
    return {
      loaded: data.modelLoaded,
      modelID: data.modelLoaded ? data.modelID : '',
    }
  }

  async listInputs(modelId) {
    const data = await this.request(
      'InputParameterListRequest',
      {},
      'InputParameterListResponse',
      VTS_REQUEST_TIMEOUT_MS,
    )
    if (!isRecord(data) || data.modelLoaded !== true) {
      throw runtimeError(
        'VTube Studio reports that no model is loaded, so the mouth inputs cannot be checked.',
      )
    }
    if (data.modelID !== modelId) {
      throw runtimeError(
        'The active VTube Studio model changed while preparing the demo. Reload the configured model and run the demo again.',
      )
    }

    const names = new Set()
    for (const field of ['defaultParameters', 'customParameters']) {
      const entries = data[field]
      if (entries === undefined) continue
      if (!Array.isArray(entries)) {
        throw runtimeError('VTube Studio returned an invalid input-parameter list.')
      }
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.name === 'string') names.add(entry.name)
      }
    }
    return names
  }

  async createParameter(parameter) {
    const data = await this.request(
      'ParameterCreationRequest',
      {
        parameterName: parameter.name,
        explanation: parameter.explanation,
        min: parameter.min,
        max: parameter.max,
        defaultValue: 0,
      },
      'ParameterCreationResponse',
      VTS_REQUEST_TIMEOUT_MS,
    )
    if (!isRecord(data) || data.parameterName !== parameter.name) {
      throw runtimeError(
        `VTube Studio did not confirm the mouth input "${parameter.name}".`,
      )
    }
  }

  async injectNeutral(openingInput) {
    const data = await this.request(
      'InjectParameterDataRequest',
      {
        mode: 'set',
        parameterValues: [
          { id: openingInput, value: 0 },
          { id: MOUTH_FORM_INPUT, value: 0 },
          { id: MOUTH_X_INPUT, value: 0 },
        ],
      },
      'InjectParameterDataResponse',
      VTS_REQUEST_TIMEOUT_MS,
    )
    if (!isRecord(data)) {
      throw runtimeError('VTube Studio returned an invalid parameter-injection response.')
    }
  }

  async hotkeyIds(modelId) {
    const data = await this.request(
      'HotkeysInCurrentModelRequest',
      {},
      'HotkeysInCurrentModelResponse',
      VTS_REQUEST_TIMEOUT_MS,
    )
    if (!isRecord(data) || data.modelLoaded !== true) {
      throw runtimeError('VTube Studio reports that no model is loaded, so hotkeys cannot be checked.')
    }
    if (data.modelID !== modelId) {
      throw runtimeError(
        'The active VTube Studio model changed while checking hotkeys. Reload the configured model and run the demo again.',
      )
    }
    if (!Array.isArray(data.availableHotkeys)) {
      throw runtimeError('VTube Studio returned an invalid hotkey list.')
    }
    const ids = new Set()
    for (const entry of data.availableHotkeys) {
      if (isRecord(entry) && typeof entry.hotkeyID === 'string' && entry.hotkeyID.length > 0) {
        ids.add(entry.hotkeyID)
      }
    }
    return ids
  }

  async loadModel(modelID, timeoutMs = VTS_MODEL_LOAD_TIMEOUT_MS) {
    const data = await this.request(
      'ModelLoadRequest',
      { modelID },
      'ModelLoadResponse',
      timeoutMs,
    )
    if (!isRecord(data) || typeof data.modelID !== 'string') {
      throw runtimeError('VTube Studio returned an invalid model-load response.')
    }
    if (modelID.length > 0 && data.modelID !== modelID) {
      throw runtimeError(
        `VTube Studio reported model "${data.modelID}" instead of the requested model.`,
      )
    }
    // An empty request is the official unload operation. Some VTS builds echo
    // the model that was just unloaded, so the authoritative no-model check is
    // a CurrentModelRequest made by the caller after this response.
  }
}

function vtsOpenError(url, error, statusCode) {
  if (typeof statusCode === 'number') {
    return runtimeError(
      `VTube Studio answered the WebSocket handshake at ${url} with HTTP ${statusCode}. Check that its API server is enabled and the port is correct.`,
    )
  }
  const code = error?.code
  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    error?.message === 'timeout'
  ) {
    return runtimeError(
      `Could not connect to VTube Studio at ${url}. Start VTube Studio, enable its API in Settings, and allow the local API server; this demo never starts VTube Studio for you.`,
    )
  }
  return runtimeError(
    `Could not connect to VTube Studio at ${url}. Confirm VTube Studio is running and its API is enabled.`,
  )
}

/**
 * VTS acknowledges a ModelLoadRequest before the visual switch finishes. During
 * that interval CurrentModelRequest can still report the previous model or no
 * model at all. Observe the expected state with a bounded monotonic deadline,
 * ignoring only the initially known old model id. A different loaded model is
 * an explicit operator selection and is never overridden.
 */
async function waitForModelState(session, options) {
  const expected = options.expected
  const ignoredLoadedIds = options.ignoredLoadedIds ?? new Set()
  const timeoutMs = options.timeoutMs ?? MODEL_TRANSITION_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? MODEL_TRANSITION_POLL_MS
  const signal = options.signal ?? null
  const deadline = performance.now() + timeoutMs
  let last = null

  while (true) {
    if (signal !== null) throwIfStopped(signal)
    const current =
      signal === null
        ? await session.currentModel()
        : await abortable(session.currentModel(), signal)
    last = current

    if (expected.loaded) {
      if (current.loaded && current.modelID === expected.modelID) {
        return { kind: 'observed', current }
      }
      if (current.loaded && !ignoredLoadedIds.has(current.modelID)) {
        return { kind: 'third', current }
      }
    } else {
      if (!current.loaded) return { kind: 'observed', current }
      if (!ignoredLoadedIds.has(current.modelID)) {
        return { kind: 'third', current }
      }
    }

    if (performance.now() >= deadline) {
      return { kind: 'timeout', current: last }
    }
    if (signal === null) await sleep(intervalMs)
    else await delay(signal, intervalMs)
  }
}

async function ensureMouthInputs(session, manifest, signal) {
  const required = [
    {
      name: manifest.input,
      min: 0,
      max: 1,
      explanation: 'Isla speaking demo mouth opening (0 closed, 1 open).',
    },
    {
      name: MOUTH_FORM_INPUT,
      min: -1,
      max: 1,
      explanation: 'Isla speaking demo mouth form (-1 rounded, 1 wide).',
    },
    {
      name: MOUTH_X_INPUT,
      min: -1,
      max: 1,
      explanation: 'Isla speaking demo mouth horizontal shift (-1 left, 1 right).',
    },
  ]

  let names = await abortable(session.listInputs(manifest.modelId), signal)
  for (const parameter of required) {
    if (names.has(parameter.name)) continue
    try {
      await abortable(session.createParameter(parameter), signal)
    } catch (error) {
      if (error instanceof StopRequested) throw error
      let after
      try {
        after = await abortable(session.listInputs(manifest.modelId), signal)
      } catch (nextError) {
        if (nextError instanceof StopRequested) throw nextError
        after = null
      }
      if (after !== null && after.has(parameter.name)) {
        names = after
        continue
      }
      throw runtimeError(
        `VTube Studio could not create the mouth input "${parameter.name}". Custom names must be unique and 4-32 alphanumeric characters; a parameter owned by another plugin cannot be replaced (${safeError(error)}).`,
      )
    }
  }

  names = await abortable(session.listInputs(manifest.modelId), signal)
  const missing = required
    .map((parameter) => parameter.name)
    .filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw runtimeError(
      `VTube Studio did not report the required mouth input(s): ${missing.join(', ')}.`,
    )
  }
}

async function verifyHotkeys(session, manifest, signal) {
  const ids = await abortable(session.hotkeyIds(manifest.modelId), signal)
  const missing = HOTKEY_ACTIONS.filter(
    (action) => !ids.has(manifest.hotkeyMap[action]),
  )
  if (missing.length > 0) {
    throw runtimeError(
      `The configured model does not advertise the hotkey for ${missing.join(', ')} from the manifest. Correct hotkeyMap or load the intended model.`,
    )
  }
}

async function loadModelWithRetry(
  session,
  modelID,
  signal,
  options = {},
) {
  const attempts = options.attempts ?? 2
  const timeoutMs = options.timeoutMs ?? VTS_MODEL_LOAD_TIMEOUT_MS
  const quiet = options.quiet === true
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (signal === null) await session.loadModel(modelID, timeoutMs)
      else await abortable(session.loadModel(modelID, timeoutMs), signal)
      return
    } catch (error) {
      if (error instanceof StopRequested) throw error
      lastError = error
      if (attempt < attempts) {
        if (!quiet) {
          info(
            `VTube Studio is not ready to change models yet; retrying in 2 seconds (${attempt}/${attempts}).`,
          )
        }
        if (signal === null) await sleep(2_200)
        else await delay(signal, 2_200)
      }
    }
  }

  const description =
    modelID === '' ? 'unload the demo model' : `load the configured model "${modelID}"`
  const detail = lastError === null ? '' : ` (${safeError(lastError)})`
  throw runtimeError(
    `VTube Studio could not ${description}${detail}. Close any open model or config window and confirm the model is installed in VTube Studio.`,
  )
}

async function prepareVts(config, WebSocketCtor, state, signal) {
  const session = await VtsSession.open(config.vtsUrl, WebSocketCtor, signal)
  state.session = session

  await abortable(session.authenticate(config.token), signal)
  state.authenticated = true
  config.token = ''

  const previousModel = await abortable(session.currentModel(), signal)
  state.previousModel = previousModel

  if (previousModel.loaded && previousModel.modelID === config.manifest.modelId) {
    // The intended model is already active. Do not switch or reload it.
    state.targetObserved = true
  } else {
    // Set the flag before submission: a timed-out request is ambiguous and the
    // cleanup path may need to observe a transition that VTS nevertheless
    // accepted.
    state.modelMayHaveChanged = true
    await loadModelWithRetry(session, config.manifest.modelId, signal)

    const ignoredLoadedIds = previousModel.loaded
      ? new Set([previousModel.modelID])
      : new Set()
    const observed = await waitForModelState(session, {
      expected: { loaded: true, modelID: config.manifest.modelId },
      ignoredLoadedIds,
      timeoutMs: MODEL_TRANSITION_TIMEOUT_MS,
      intervalMs: MODEL_TRANSITION_POLL_MS,
      signal,
    })
    if (observed.kind === 'third') {
      throw runtimeError(
        `VTube Studio is now on model "${observed.current.modelID}", which is not the configured model. The operator's different model was left untouched.`,
      )
    }
    if (observed.kind === 'timeout') {
      throw runtimeError(
        `VTube Studio acknowledged the model load but did not report the configured model "${config.manifest.modelId}" within ${MODEL_TRANSITION_TIMEOUT_MS / 1000} seconds. The current selection was left to VTube Studio.`,
      )
    }
    state.targetObserved = true
  }

  await ensureMouthInputs(session, config.manifest, signal)
  state.inputsReady = true
  await verifyHotkeys(session, config.manifest, signal)

  info('VTube Studio is ready on the configured model.')
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/')
}

function escapeGlobLiteral(value) {
  const special = new Set('\\*?[]{}()!+@|^$'.split(''))
  return [...value].map((character) => (special.has(character) ? `\\${character}` : character)).join('')
}

function viteDenyForToken(tokenPath) {
  const deny = [...VITE_DEFAULT_DENY]
  const absolute = normalizeSlashes(tokenPath)
  deny.push(escapeGlobLiteral(absolute))
  try {
    const real = normalizeSlashes(realpathSync.native(tokenPath))
    if (real !== absolute) deny.push(escapeGlobLiteral(real))
  } catch {
    // The selected path itself is still denied.
  }
  return deny
}

function buildProxy(runtimePort) {
  const target = `http://127.0.0.1:${runtimePort}`
  const entry = { target, changeOrigin: false }
  return {
    '/health': { ...entry },
    '/diag': { ...entry, ws: true },
    '/app': { ...entry, ws: true },
    '/operator': { ...entry },
    '/audio': { ...entry },
  }
}

function buildRuntimeEnv(config, paths) {
  const env = sanitizedEnvironment()
  Object.assign(env, {
    ISLA_DEPLOYMENT_MODULE: 'test/live/m1-speaking-deployment.ts',
    ISLA_SPEAKING_MODEL_ID: config.manifest.modelId,
    ISLA_KOKORO_MODEL_DIR: config.cacheDir,
    ISLA_RUNTIME_HOST: '127.0.0.1',
    ISLA_RUNTIME_PORT: String(config.runtimePort),
    ISLA_STORAGE_DB_PATH: paths.dbPath,
    ISLA_LIVE_TEXT_BASE_URL: config.text.baseUrl,
    ISLA_LIVE_TEXT_MODEL: config.text.model,
    ISLA_LIVE_TEXT_API_KEY: config.text.apiKey,
    ISLA_VTS_WS_URL: config.vtsUrl,
    ISLA_VTS_PLUGIN_NAME: PLUGIN_NAME,
    ISLA_VTS_PLUGIN_DEVELOPER: PLUGIN_DEVELOPER,
    ISLA_VTS_TOKEN_PATH: config.tokenPath,
    ISLA_VTS_HOTKEY_MAP: JSON.stringify(config.manifest.hotkeyMap),
    ISLA_ALLOWED_ORIGINS: webOrigin(config.webPort),
    ISLA_ALLOWED_HOSTS: `127.0.0.1:${config.webPort},127.0.0.1:${config.runtimePort}`,
  })

  if (config.liveText === null) {
    const loopback = '127.0.0.1,localhost,::1'
    env.NO_PROXY = env.NO_PROXY === undefined ? loopback : `${env.NO_PROXY},${loopback}`
    env.no_proxy = env.no_proxy === undefined ? loopback : `${env.no_proxy},${loopback}`
  }
  return env
}

function startRuntime(context) {
  const { config, paths, resources, shutdown, recordFailure } = context
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/runtime/production-cli.ts'], {
    cwd: REPO_ROOT,
    env: buildRuntimeEnv(config, paths),
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  resources.runtime = child
  guardChildErrors(child, 'The local runtime', shutdown)

  const output = attachChildOutput(child, {
    logPath: paths.runtimeLog,
    onLine: runtimeLineHandler,
  })
  resources.runtimeOutput = output

  child.once('exit', (code, signalName) => {
    if (shutdown.requested) return
    if (resources.runtimeReady && code === 0) {
      shutdown.request('the local runtime stopped')
      return
    }
    recordFailure(
      runtimeError(
        `The local runtime exited ${resources.runtimeReady ? 'unexpectedly' : 'before becoming healthy'} (${code ?? signalName ?? 'unknown'}). ${lastChildMessage(output)} See ${paths.runtimeLog}.`,
      ),
    )
  })

  return output
}

async function waitForHealth(context) {
  const { config, paths, resources, shutdown } = context
  const healthUrl = `http://127.0.0.1:${config.runtimePort}/health`
  const deadline = Date.now() + RUNTIME_HEALTH_TIMEOUT_MS
  let lastStatus = null

  while (Date.now() < deadline) {
    throwIfStopped(shutdown.signal)
    const runtime = resources.runtime
    if (
      runtime !== null &&
      (runtime.exitCode !== null || runtime.signalCode !== null)
    ) {
      throw runtimeError(
        `The local runtime exited before becoming healthy. ${lastChildMessage(resources.runtimeOutput)} See ${paths.runtimeLog}.`,
      )
    }

    try {
      const response = await fetch(healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.any([
          shutdown.signal,
          AbortSignal.timeout(1_500),
        ]),
      })
      lastStatus = response.status
      if (response.ok) return
      try {
        await response.arrayBuffer()
      } catch {
        // A short error body does not change the retry decision.
      }
    } catch {
      if (shutdown.signal.aborted) throw new StopRequested()
    }

    await delay(shutdown.signal, 250)
  }

  const status = lastStatus === null ? '' : ` (last HTTP ${lastStatus})`
  throw runtimeError(
    `The local runtime did not become healthy within ${RUNTIME_HEALTH_TIMEOUT_MS / 1000} seconds${status}. ${lastChildMessage(resources.runtimeOutput)} See ${paths.runtimeLog}.`,
  )
}

async function startVite(context, createViteServer) {
  const { config, paths, resources, shutdown } = context
  let vite
  try {
    vite = await createViteServer({
      root: REPO_ROOT,
      configFile: config.repoFiles.viteConfig,
      cacheDir: paths.viteCache,
      clearScreen: false,
      logLevel: 'warn',
      server: {
        host: '127.0.0.1',
        port: config.webPort,
        strictPort: true,
        hmr: false,
        watch: null,
        open: false,
        fs: {
          strict: true,
          deny: viteDenyForToken(config.tokenPath),
        },
        proxy: buildProxy(config.runtimePort),
      },
    })
  } catch (error) {
    throw runtimeError(
      `The local Vite server could not be created: ${safeError(error)}. Check the repository Vite config and run pnpm install if dependencies are missing.`,
    )
  }

  resources.vite = vite
  throwIfStopped(shutdown.signal)

  try {
    await abortable(vite.listen(), shutdown.signal)
  } catch (error) {
    if (error instanceof StopRequested) throw error
    try {
      await withTimeout(
        Promise.resolve().then(() => vite.close()),
        VITE_STOP_TIMEOUT_MS,
        'Vite did not close after a failed start.',
      )
    } catch {
      // The listen failure is the reportable error.
    }
    const message = safeError(error)
    if (error?.code === 'EADDRINUSE' || /EADDRINUSE|already in use/i.test(message)) {
      throw runtimeError(
        `The web port ${config.webPort} is already in use. Stop the other process or pass --web-port or ISLA_SPEAKING_WEB_PORT. This launcher does not reuse other services.`,
      )
    }
    throw runtimeError(`The local Vite server could not listen: ${message}.`)
  }

  return vite
}

function sanitizedEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key)) {
      delete env[key]
    }
  }
  return env
}

async function startBrowser(context) {
  const { config, paths, resources, shutdown, recordFailure } = context
  const args = [
    `--user-data-dir=${paths.profileDir}`,
    `--app=${webOrigin(config.webPort)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ]

  const child = spawn(config.browserPath, args, {
    cwd: REPO_ROOT,
    env: sanitizedEnvironment(),
    windowsHide: false,
    shell: false,
    stdio: 'ignore',
  })
  resources.browser = child
  guardChildErrors(child, 'The demo browser', shutdown)

  child.once('exit', (code, signalName) => {
    if (shutdown.requested) return
    if (code === 0 || signalName !== null) {
      shutdown.request('the demo browser window was closed')
      return
    }
    recordFailure(
      runtimeError(
        `The demo browser exited unexpectedly (${code ?? signalName ?? 'unknown'}).`,
      ),
    )
  })

  await awaitSpawn(child, 'The demo browser', shutdown.signal)

  await delay(shutdown.signal, 600)
  if (child.exitCode !== null) {
    throw runtimeError(
      `The demo browser exited immediately (code ${child.exitCode}). Check the browser executable and the temporary profile path.`,
    )
  }
  return child
}

function companionReady(logPath) {
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return false
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const event = JSON.parse(line)
      if (isRecord(event) && event.event === 'ready') return true
    } catch {
      // A partial append is retried on the next poll.
    }
  }
  return false
}

async function waitForDatabase(paths, signal) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    throwIfStopped(signal)
    if (isFile(paths.dbPath)) return
    await delay(signal, 100)
  }
  throw runtimeError(
    `The local runtime did not create its event database: ${paths.dbPath}. See ${paths.runtimeLog}.`,
  )
}

async function waitForCompanionReady(child, output, paths, signal) {
  const deadline = Date.now() + COMPANION_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    throwIfStopped(signal)
    if (child.exitCode !== null || child.signalCode !== null) {
      throw runtimeError(
        `The mouth companion exited before it was ready (${child.exitCode ?? child.signalCode ?? 'unknown'}). ${lastChildMessage(output)} See ${paths.mouthLog}.`,
      )
    }
    if (companionReady(paths.mouthStateLog)) return
    await delay(signal, 100)
  }
  throw runtimeError(
    `The mouth companion did not become ready within ${COMPANION_READY_TIMEOUT_MS / 1000} seconds. ${lastChildMessage(output)} See ${paths.mouthLog}.`,
  )
}

async function startCompanion(context, browserPid) {
  const { config, paths, resources, shutdown, recordFailure } = context
  await waitForDatabase(paths, shutdown.signal)

  const args = [
    '-B',
    '-X',
    'utf8',
    config.repoFiles.companion,
    '--db',
    paths.dbPath,
    '--browser-pid',
    String(browserPid),
    '--token-file',
    config.tokenPath,
    '--model-id',
    config.manifest.modelId,
    '--input',
    config.manifest.input,
    '--url',
    config.vtsUrl,
    '--stop-file',
    paths.stopFile,
    '--log',
    paths.mouthStateLog,
  ]

  const child = spawn(config.pythonPath, args, {
    cwd: REPO_ROOT,
    env: sanitizedEnvironment(),
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  resources.companion = child
  guardChildErrors(child, 'The mouth companion', shutdown)

  const output = attachChildOutput(child, {
    logPath: paths.mouthLog,
    onLine: mouthLineHandler,
  })
  resources.companionOutput = output

  child.once('exit', (code, signalName) => {
    if (shutdown.requested) return
    if (resources.companionReady && code === 0) {
      shutdown.request('the mouth companion stopped')
      return
    }
    recordFailure(
      runtimeError(
        `The mouth companion exited ${resources.companionReady ? 'before the demo ended' : 'before it was ready'} (${code ?? signalName ?? 'unknown'}). ${lastChildMessage(output)} See ${paths.mouthLog}.`,
      ),
    )
  })

  await awaitSpawn(child, 'The mouth companion', shutdown.signal)
  await waitForCompanionReady(child, output, paths, shutdown.signal)
  resources.companionReady = true
  return child
}

function createLocalTextHandler() {
  return (request, response) => {
    void handleLocalTextRequest(request, response)
  }
}

function promptText(body) {
  if (!isRecord(body) || !Array.isArray(body.messages)) return ''
  const parts = []
  for (const message of body.messages) {
    if (!isRecord(message)) continue
    const content = message.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('\n')
}

function extractListenerLine(text) {
  const pattern = /(?:^|\r?\n)[ \t]*Listener said:[ \t]*([^\r\n]+)/g
  let match = null
  let last = null
  while ((match = pattern.exec(text)) !== null) {
    last = match[1]
  }
  return last === null ? null : last.trim()
}

function splitSentences(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  try {
    if (typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
      const segments = [...segmenter.segment(trimmed)]
        .map((segment) => segment.segment.trim())
        .filter((segment) => segment.length > 0)
      if (segments.length > 0) return segments
    }
  } catch {
    // Fall back to punctuation splitting when the runtime lacks English ICU data.
  }
  return (trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [trimmed])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

function finishJson(response, status, payload) {
  if (response.writableEnded) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function handleLocalTextRequest(request, response) {
  try {
    if (request.method !== 'POST') {
      finishJson(response, 404, { error: { message: 'Not found' } })
      return
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== '/v1/chat/completions') {
      finishJson(response, 404, { error: { message: 'Not found' } })
      return
    }

    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_TEXT_BODY_BYTES) {
        finishJson(response, 413, { error: { message: 'Request body too large' } })
        request.destroy()
        return
      }
      chunks.push(chunk)
    }

    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      finishJson(response, 400, { error: { message: 'Request body is not valid JSON' } })
      return
    }

    const line = extractListenerLine(promptText(body))
    if (line === null || line.length === 0) {
      finishJson(response, 422, {
        error: { message: 'The prompt does not contain a non-empty "Listener said:" line' },
      })
      return
    }

    const sentences = splitSentences(line)
    if (sentences.length === 0) {
      finishJson(response, 422, { error: { message: 'The listener line is empty' } })
      return
    }
    const content = [sentences[0], sentences.slice(1).join(' ')]
      .filter((part) => part.length > 0)
      .join('\n')
    const requestedModel =
      isRecord(body) && typeof body.model === 'string' && body.model.trim().length > 0
        ? body.model.trim()
        : LOCAL_TEXT_MODEL
    const now = Date.now()

    finishJson(response, 200, {
      id: `chatcmpl-local-${now}`,
      object: 'chat.completion',
      created: Math.floor(now / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    })
  } catch {
    finishJson(response, 400, {
      error: { message: 'The local text request could not be read' },
    })
  }
}

async function startLocalTextService() {
  const server = createHttpServer(createLocalTextHandler())
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    }
  })
  server.on('error', (error) => {
    warn(`Local text service error: ${safeError(error)}`)
  })

  await new Promise((resolveValue, rejectValue) => {
    const onError = (error) => {
      server.off('listening', onListening)
      try {
        server.close()
      } catch {
        // The failed listen leaves no usable server.
      }
      rejectValue(
        runtimeError(`The local text service could not start: ${safeError(error)}.`),
      )
    }
    const onListening = () => {
      server.off('error', onError)
      resolveValue()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw runtimeError('The local text service did not report a loopback port.')
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  }
}

function printInstructions(config) {
  info(`Demo ready at ${webOrigin(config.webPort)}`)
  process.stdout.write('In the demo browser window, click these controls in order:\n')
  process.stdout.write('  1. Attach performer\n')
  process.stdout.write('  2. Bootstrap operator\n')
  process.stdout.write('  3. Resume\n')
  process.stdout.write('  4. Type an English line and click Submit input\n')
  process.stdout.write('  5. Click Stop to close the mouth\n')
  process.stdout.write('\n')
  process.stdout.write('Submit more lines to keep speaking. Close the demo browser window or press Ctrl+C here to stop.\n')
  process.stdout.write('Keep VTube Studio running until this launcher has restored the previous model.\n')
}

async function stopCompanion(context) {
  const { resources, paths } = context
  const child = resources.companion
  if (child === null) return
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return

  try {
    writeFileSync(paths.stopFile, 'stop\n', 'utf8')
  } catch (error) {
    warn(`Could not write the mouth companion stop file: ${safeError(error)}`)
  }

  const exited = await waitForExit(child, COMPANION_STOP_TIMEOUT_MS)
  if (exited) return

  warn('The mouth companion did not stop in time; terminating only its process tree.')
  if (!killTree(child.pid)) {
    try {
      child.kill()
    } catch {
      // The process may already be gone.
    }
  }
  await waitForExit(child, 2_000)
}

async function settleAcceptedTransition(context) {
  const { config, resources } = context
  const state = resources.vts
  if (state === null || state.session === null || !state.authenticated) return
  if (!state.modelMayHaveChanged || state.targetObserved) return

  const ignoredLoadedIds =
    state.previousModel !== null && state.previousModel.loaded
      ? new Set([state.previousModel.modelID])
      : new Set()
  const observed = await waitForModelState(state.session, {
    expected: { loaded: true, modelID: config.manifest.modelId },
    ignoredLoadedIds,
    timeoutMs: MODEL_TRANSITION_TIMEOUT_MS,
    intervalMs: MODEL_TRANSITION_POLL_MS,
  })

  if (observed.kind === 'observed') {
    state.targetObserved = true
    info('The accepted VTube Studio model change completed before shutdown.')
  } else if (observed.kind === 'third') {
    info(
      `VTube Studio is on model "${observed.current.modelID}", which the operator selected; leaving it unchanged.`,
    )
  } else {
    warn(
      `The accepted VTube Studio model change was not observed within ${MODEL_TRANSITION_TIMEOUT_MS / 1000} seconds; shutdown will only restore an actually observed demo model.`,
    )
  }
}

async function neutralizeVts(context) {
  const { config, resources } = context
  const state = resources.vts
  if (state === null || state.session === null || !state.authenticated) return
  if (!state.inputsReady) return

  try {
    const observed = await waitForModelState(state.session, {
      expected: { loaded: true, modelID: config.manifest.modelId },
      ignoredLoadedIds:
        state.previousModel !== null && state.previousModel.loaded
          ? new Set([state.previousModel.modelID])
          : new Set(),
      timeoutMs: CONTROLLED_TARGET_OBSERVE_MS,
      intervalMs: MODEL_TRANSITION_POLL_MS,
    })
    if (observed.kind !== 'observed') {
      info('The demo model is no longer the active selection; mouth neutralization is skipped.')
      return
    }
    await state.session.injectNeutral(config.manifest.input)
    info('Mouth inputs set to neutral.')
  } catch (error) {
    resources.cleanupProblems.push('could not neutralize the mouth')
    warn(`Could not neutralize the mouth: ${safeError(error)}`)
  }
}

async function stopRuntime(context) {
  const { resources } = context
  const child = resources.runtime
  if (child === null) return
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return

  let sent = false
  if (child.connected) {
    try {
      child.send({ type: 'isla.runtime.shutdown' })
      sent = true
    } catch {
      sent = false
    }
  }

  if (sent) {
    const exited = await waitForExit(child, RUNTIME_STOP_TIMEOUT_MS)
    if (exited) return
    warn('The local runtime did not shut down cooperatively; terminating only its process tree.')
  } else {
    warn('The local runtime IPC channel is not available; terminating only its process tree.')
  }

  if (!killTree(child.pid)) {
    try {
      child.kill()
    } catch {
      // The process may already be gone.
    }
  }
  await waitForExit(child, 3_000)
}

async function restoreVts(context) {
  const { config, resources } = context
  const state = resources.vts
  if (state === null || state.session === null) return

  try {
    if (!state.authenticated || !state.modelMayHaveChanged) return
    if (state.previousModel === null) {
      resources.cleanupProblems.push('the previous VTube Studio model was not recorded')
      warn('Could not restore the previous VTube Studio model because it was not recorded.')
      return
    }
    if (
      state.previousModel.loaded &&
      state.previousModel.modelID === config.manifest.modelId
    ) {
      info('The configured model was already active before the demo; no model restore is needed.')
      return
    }

    // Only take action while the observed model is still our own target. A
    // short tolerant observation ignores a transient empty read from a just
    // completed fade, but an old or unrelated third model is left untouched.
    const controlling = await waitForModelState(state.session, {
      expected: { loaded: true, modelID: config.manifest.modelId },
      ignoredLoadedIds: state.previousModel.loaded
        ? new Set([state.previousModel.modelID])
        : new Set(),
      timeoutMs: CONTROLLED_TARGET_OBSERVE_MS,
      intervalMs: MODEL_TRANSITION_POLL_MS,
    })
    if (controlling.kind !== 'observed') {
      info('VTube Studio is no longer on the demo model; leaving the current selection unchanged.')
      return
    }

    const restoreTarget = state.previousModel.loaded
      ? state.previousModel.modelID
      : ''
    await loadModelWithRetry(state.session, restoreTarget, null, {
      attempts: 2,
      timeoutMs: VTS_RESTORE_TIMEOUT_MS,
      quiet: true,
    })

    const expected =
      restoreTarget.length > 0
        ? { loaded: true, modelID: restoreTarget }
        : { loaded: false }
    const observed = await waitForModelState(state.session, {
      expected,
      ignoredLoadedIds: new Set([config.manifest.modelId]),
      timeoutMs: MODEL_TRANSITION_TIMEOUT_MS,
      intervalMs: MODEL_TRANSITION_POLL_MS,
    })
    if (observed.kind === 'third') {
      info(
        `VTube Studio is on model "${observed.current.modelID}", which the operator selected; leaving it unchanged.`,
      )
      return
    }
    if (observed.kind === 'timeout') {
      const wanted =
        restoreTarget.length > 0
          ? `model "${restoreTarget}"`
          : 'no loaded model'
      throw runtimeError(
        `VTube Studio acknowledged the restore but did not report ${wanted} within ${MODEL_TRANSITION_TIMEOUT_MS / 1000} seconds.`,
      )
    }
    if (restoreTarget.length > 0) {
      info(`Restored the previous VTube Studio model (${restoreTarget}).`)
    } else {
      info('Unloaded the demo model (no model was loaded before the demo).')
    }
  } catch (error) {
    resources.cleanupProblems.push('could not restore the previous VTube Studio model')
    warn(`Could not restore the previous VTube Studio model: ${safeError(error)}`)
  } finally {
    if (state.session !== null) {
      try {
        state.session.close()
      } catch {
        // The local process is stopping anyway.
      }
    }
    state.session = null
  }
}

async function stopVite(context) {
  const { resources } = context
  const vite = resources.vite
  if (vite === null) return
  try {
    vite.httpServer?.closeAllConnections?.()
  } catch {
    // The server may already be closed.
  }
  try {
    await withTimeout(
      Promise.resolve().then(() => vite.close()),
      VITE_STOP_TIMEOUT_MS,
      'Vite did not close in time.',
    )
  } catch (error) {
    warn(`The local Vite server did not close cleanly: ${safeError(error)}`)
  }
  resources.vite = null
}

async function stopLocalText(context) {
  const { resources } = context
  const service = resources.localText
  if (service === null) return
  try {
    service.server.closeAllConnections?.()
  } catch {
    // The server may already be closed.
  }
  try {
    await withTimeout(
      new Promise((resolveValue) => {
        service.server.close(() => resolveValue())
      }),
      2_000,
      'The local text service did not close in time.',
    )
  } catch (error) {
    warn(`The local text service did not close cleanly: ${safeError(error)}`)
  }
  resources.localText = null
}

async function stopBrowser(context) {
  const { resources } = context
  const child = resources.browser
  if (child === null) return
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return

  if (!killTree(child.pid)) {
    try {
      child.kill()
    } catch {
      // The browser may already be gone.
    }
  }
  if (!(await waitForExit(child, BROWSER_STOP_TIMEOUT_MS))) {
    warn('The demo browser did not stop in time; only its owned process tree was targeted.')
  }
}

function removeRunDir(runDir) {
  if (runDir === null) return
  if (!basename(runDir).startsWith(TEMP_PREFIX)) {
    warn(`Refusing to remove an unexpected temporary path: ${runDir}`)
    return
  }
  try {
    rmSync(runDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    })
  } catch (error) {
    warn(`Temporary files remain at ${runDir}: ${safeError(error)}`)
  }
}

async function cleanup(context) {
  const { resources, paths } = context
  if (resources.cleaned) return
  resources.cleaned = true

  info('Stopping the speaking demo...')

  const steps = [
    () => stopCompanion(context),
    () => settleAcceptedTransition(context),
    () => neutralizeVts(context),
    () => stopRuntime(context),
    () => restoreVts(context),
    () => stopVite(context),
    () => stopLocalText(context),
    () => stopBrowser(context),
  ]

  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      resources.cleanupProblems.push(safeError(error))
      warn(`Cleanup step failed: ${safeError(error)}`)
    }
  }

  // Final fallback for an owned child that survived its cooperative bound. It
  // never targets an unowned process or an image name.
  for (const child of [resources.companion, resources.runtime, resources.browser]) {
    if (
      child !== null &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined
    ) {
      killTree(child.pid)
    }
  }

  try {
    resources.runtimeOutput?.close()
  } catch {
    // The output is already closed.
  }
  try {
    resources.companionOutput?.close()
  } catch {
    // The output is already closed.
  }

  if (paths !== null) {
    const keep =
      resources.keepRunDir === true || resources.cleanupProblems.length > 0
    if (keep) {
      info(`Diagnostic files remain at ${paths.runDir}`)
    } else {
      await sleep(300)
      removeRunDir(paths.runDir)
    }
  }

  info('Speaking demo stopped.')
}

async function runDemo(config) {
  const shutdown = createShutdownController()
  const resources = {
    runtime: null,
    runtimeOutput: null,
    runtimeReady: false,
    companion: null,
    companionOutput: null,
    companionReady: false,
    browser: null,
    vite: null,
    localText: null,
    vts: null,
    cleanupProblems: [],
    cleaned: false,
    keepRunDir: false,
  }
  const context = {
    config,
    paths: null,
    resources,
    shutdown,
    recordFailure: null,
  }

  let failure = null
  const recordFailure = (error) => {
    if (failure === null) {
      failure =
        error instanceof DemoError
          ? error
          : runtimeError(`Unexpected failure: ${safeError(error)}`)
    }
    resources.keepRunDir = true
    shutdown.request('failure')
  }
  context.recordFailure = recordFailure

  const forceStop = () => {
    try {
      if (context.paths !== null) {
        writeFileSync(context.paths.stopFile, 'stop\n', 'utf8')
      }
    } catch {
      // The emergency exit proceeds anyway.
    }
    for (const child of [resources.companion, resources.runtime, resources.browser]) {
      if (
        child !== null &&
        child.exitCode === null &&
        child.signalCode === null &&
        child.pid !== undefined
      ) {
        killTree(child.pid)
      }
    }
    process.exit(130)
  }

  const onSignal = (signalName) => {
    if (shutdown.requested) {
      forceStop()
      return
    }
    shutdown.request(`received ${signalName}`)
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  const onSighup = () => onSignal('SIGHUP')

  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('SIGHUP', onSighup)

  try {
    await assertPortsAvailable(config)
    throwIfStopped(shutdown.signal)

    const WebSocketCtor = await loadWebSocket()
    const createViteServer = await loadVite()
    throwIfStopped(shutdown.signal)

    const runDir = createRunDir()
    context.paths = createRunPaths(runDir)
    mkdirSync(context.paths.profileDir, { recursive: true })

    if (config.liveText !== null) {
      config.text = config.liveText
      info('Using the configured live text provider from the explicit --live-text opt-in.')
    } else {
      const localText = await startLocalTextService()
      resources.localText = localText
      config.text = {
        baseUrl: localText.baseUrl,
        model: LOCAL_TEXT_MODEL,
        apiKey: LOCAL_TEXT_API_KEY,
      }
      info('Using a fresh loopback-only text service; no remote text request is made.')
    }
    throwIfStopped(shutdown.signal)

    resources.vts = {
      session: null,
      authenticated: false,
      previousModel: null,
      modelMayHaveChanged: false,
      targetObserved: false,
      inputsReady: false,
    }
    await prepareVts(config, WebSocketCtor, resources.vts, shutdown.signal)
    throwIfStopped(shutdown.signal)

    startRuntime(context)
    await awaitSpawn(resources.runtime, 'The local runtime', shutdown.signal)
    await waitForHealth(context)
    resources.runtimeReady = true
    throwIfStopped(shutdown.signal)

    await startVite(context, createViteServer)
    throwIfStopped(shutdown.signal)

    const browser = await startBrowser(context)
    throwIfStopped(shutdown.signal)

    await startCompanion(context, browser.pid)
    throwIfStopped(shutdown.signal)

    printInstructions(config)
    await shutdown.wait()
  } catch (error) {
    if (error instanceof StopRequested) {
      if (!shutdown.requested) shutdown.request('stop')
    } else {
      recordFailure(error)
    }
  } finally {
    try {
      await cleanup(context)
    } catch (error) {
      warn(`Cleanup failed: ${safeError(error)}`)
      resources.cleanupProblems.push(safeError(error))
    }
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
  }

  if (failure !== null) {
    warn(failure.message)
    return 1
  }
  if (resources.cleanupProblems.length > 0) {
    warn(
      `The demo stopped with cleanup warnings: ${resources.cleanupProblems.join('; ')}.`,
    )
    return 1
  }
  return 0
}

async function loadWebSocket() {
  let module
  try {
    module = await import('ws')
  } catch {
    throw usageError('The "ws" package is not installed. Run pnpm install in the checkout and retry.')
  }
  const WebSocketCtor =
    module.WebSocket ?? module.default?.WebSocket ?? module.default
  if (typeof WebSocketCtor !== 'function') {
    throw usageError('The installed "ws" package does not expose WebSocket. Reinstall project dependencies.')
  }
  return WebSocketCtor
}

async function loadVite() {
  let module
  try {
    module = await import('vite')
  } catch {
    throw usageError('The "vite" package is not installed. Run pnpm install in the checkout and retry.')
  }
  if (typeof module.createServer !== 'function') {
    throw usageError('The installed "vite" package does not expose createServer. Reinstall project dependencies.')
  }
  return module.createServer
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp()
    return 0
  }

  try {
    if (process.platform !== 'win32') {
      throw usageError('This speaking demo launcher is Windows-only.')
    }
    const major = Number(process.versions.node.split('.')[0])
    if (!Number.isInteger(major) || major < 22) {
      throw usageError(
        `Node 22 or newer is required (found ${process.versions.node}).`,
      )
    }

    const config = resolveConfig(argv)
    return await runDemo(config)
  } catch (error) {
    if (error instanceof StopRequested) return 0
    const message =
      error instanceof DemoError
        ? error.message
        : `Unexpected failure: ${safeError(error)}`
    warn(message)
    if (error instanceof DemoError && error.usage) {
      warn('Run with --help for usage and prerequisites.')
    }
    return error instanceof DemoError && error.usage ? 2 : 1
  }
}

try {
  const exitCode = await main()
  process.exitCode = exitCode
  setTimeout(() => process.exit(exitCode), 300)
} catch (error) {
  warn(`Unexpected failure: ${safeError(error)}`)
  process.exitCode = 1
  setTimeout(() => process.exit(1), 300)
}
