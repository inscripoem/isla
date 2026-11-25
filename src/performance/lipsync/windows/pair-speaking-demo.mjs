#!/usr/bin/env node
/*
 * Explicit first-time VTube Studio pairing for the portable speaking demo (M1 G1).
 *
 * This helper composes the existing D1 connection handle and D2 pairing
 * primitive; it does not duplicate the VTS pairing state machine. It exists so
 * the demo can offer one explicit pairing step:
 *
 *   node src/performance/lipsync/windows/pair-speaking-demo.mjs \
 *     --pair-only --token-file <new-file> [--vts-url ws://127.0.0.1:8001]
 *
 * Public API for the demo main:
 *
 *   await pairSpeakingDemo({ tokenFile, url?, signal? })
 *
 * It resolves with `{ tokenFile }` (the resolved absolute path) after VTS has
 * shown the permission prompt, returned a token, answered AuthenticationRequest
 * with authenticated: true, and the token was saved. It throws one
 * SpeakingDemoPairingError with a stable `code` (for example
 * 'token-file-exists', 'permission-denied', 'aborted') and a message that never
 * contains the token. An existing destination is refused before any connection.
 * The helper closes its own connection before resolving or rejecting.
 *
 * Boundaries:
 *   * The destination must not exist. It is never read, refreshed or replaced.
 *   * Only loopback ws:// or wss:// endpoints without userinfo/path/query are
 *     accepted.
 *   * The token is saved only after authenticated: true, as printable text
 *     followed by one newline, with exclusive creation (wx, 0o600).
 *   * The token value is never printed or logged.
 *   * Nothing connects at import time; --help and argument errors are inert.
 *   * Model, browser, Kokoro and runtime options are not used in this mode.
 *
 * The TypeScript modules are loaded through the already-installed `tsx` ESM
 * API, so `node ...mjs` works without an operator-supplied --import tsx. There
 * are no machine-specific paths or new dependencies.
 */
import { lstat, mkdir, open, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_VTS_URL = 'ws://127.0.0.1:8001'
export const VTS_PLUGIN_NAME = 'Isla Runtime'
export const VTS_PLUGIN_DEVELOPER = 'CS5351 Isla'

const CONNECT_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 2_000
const HUMAN_APPROVAL_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 2_000
const MAX_TOKEN_LENGTH = 64

const EXIT_SUCCESS = 0
const EXIT_USAGE = 2
const EXIT_RUNTIME = 3
const EXIT_CANCELLED = 130

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const TS_CONNECTION_MODULE = '../../vts-connection.ts'
const TS_PAIRING_MODULE = '../../vts-pairing.ts'

const PAIRING_HELP = `Usage:
  node src/performance/lipsync/windows/pair-speaking-demo.mjs --pair-only \\
    --token-file <new-file> [--vts-url ws://127.0.0.1:8001]

Options:
  --pair-only        Explicitly request one VTube Studio pairing approval.
  --token-file PATH  New local file for the approved token. Must not exist.
  --vts-url URL      Loopback VTube Studio WebSocket URL
                     (default ${DEFAULT_VTS_URL}).
  -h, --help         Show this help and exit without connecting.

Pairing opens one loopback WebSocket, asks VTube Studio to show the
"${VTS_PLUGIN_NAME}" permission prompt, verifies authentication, then writes the
token as plain text plus one newline using exclusive creation. The helper never
reads, replaces or refreshes an existing token and never prints the token.

Ctrl+C cancels and closes the connection. Model, browser, Kokoro and runtime
options are irrelevant in pair-only mode. Exit codes: 0 paired, 2 usage,
3 pairing/runtime failure, 130 cancelled.
`

/**
 * @typedef {'invalid-options' | 'invalid-url' | 'token-file-exists'
 *   | 'token-file-unreadable' | 'token-file-unwritable' | 'helper-unavailable'
 *   | 'connection-failed' | 'connection-timeout' | 'aborted' | 'timeout'
 *   | 'permission-denied' | 'authentication-rejected'
 *   | 'credential-write-failed' | 'protocol-error' | 'transport-closed'
 *   | 'transport-error' | 'pairing-cleanup-failed'
 *   | 'pairing-failed'} PairingErrorCode
 */

/** A safe pairing failure; the message never contains the token value. */
export class SpeakingDemoPairingError extends Error {
  /**
   * @param {PairingErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'SpeakingDemoPairingError'
    this.code = code
  }
}

/** Internal refusal from the atomic token save. */
class TokenSaveRefusal extends Error {
  /** @param {'exists' | 'aborted' | 'write' | 'invalid'} reason */
  constructor(reason) {
    super('token save refused')
    this.name = 'TokenSaveRefusal'
    this.reason = reason
  }
}

/** @param {string} message */
function invalidOptions(message) {
  return new SpeakingDemoPairingError('invalid-options', message)
}

/** @param {string} message */
function helperUnavailable(message) {
  return new SpeakingDemoPairingError('helper-unavailable', message)
}

/** @param {unknown} value @returns {value is AbortSignal} */
function isSignalLike(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  )
}

/** @param {string} value */
function isValidTokenText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

/**
 * Validate one loopback VTS WebSocket URL. The raw value is never echoed back
 * because it may contain userinfo.
 * @param {unknown} value
 */
function validateVtsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must be a loopback ws:// or wss:// address.',
    )
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must be a loopback ws:// or wss:// address.',
    )
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must use ws:// or wss://.',
    )
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must not contain embedded userinfo.',
    )
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must use localhost, 127.0.0.1 or [::1].',
    )
  }
  if (parsed.port === '') {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must include an explicit port.',
    )
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must not include a path.',
    )
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new SpeakingDemoPairingError(
      'invalid-url',
      'The VTube Studio URL must not include a query or fragment.',
    )
  }
  return value
}

/** @param {string} value */
function expandTokenPath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(join(homedir(), value.slice(2)))
  }
  return resolve(value)
}

/**
 * Validate and normalize the public options without touching the filesystem.
 * @param {unknown} options
 */
function normalizeOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw invalidOptions('pairSpeakingDemo requires an options object.')
  }
  const record = /** @type {Record<string, unknown>} */ (options)
  const { tokenFile, url = DEFAULT_VTS_URL, signal, onInstruction } = record

  if (typeof tokenFile !== 'string' || tokenFile.length === 0) {
    throw invalidOptions('pairSpeakingDemo requires a non-empty tokenFile path.')
  }
  if (signal !== undefined && !isSignalLike(signal)) {
    throw invalidOptions('pairSpeakingDemo signal must be an AbortSignal.')
  }
  if (onInstruction !== undefined && typeof onInstruction !== 'function') {
    throw invalidOptions('pairSpeakingDemo onInstruction must be a function.')
  }

  return {
    target: expandTokenPath(tokenFile),
    vtsUrl: validateVtsUrl(url),
    signal: signal ?? null,
    onInstruction: onInstruction ?? null,
  }
}

/** @param {string} target */
async function assertDestinationFree(target) {
  try {
    await lstat(target)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return
    }
    throw new SpeakingDemoPairingError(
      'token-file-unreadable',
      `The token destination could not be inspected: ${target}`,
    )
  }
  throw new SpeakingDemoPairingError(
    'token-file-exists',
    `The token file already exists: ${target}. ` +
      'Refusing to read, replace or refresh an existing credential; remove it yourself to pair again.',
  )
}

/** @param {string} target */
async function ensureParentDirectory(target) {
  const parent = dirname(target)
  try {
    await mkdir(parent, { recursive: true })
  } catch {
    throw new SpeakingDemoPairingError(
      'token-file-unwritable',
      `The token file directory could not be created: ${parent}`,
    )
  }
}

/**
 * Save one newly granted token. Exclusive creation guarantees no other writer
 * is ever clobbered. The token text is written only after the file exists; any
 * pre-commit failure removes that file so a refused save leaves no partial
 * token. A save that finished writing is committed even if cancellation lands
 * immediately afterwards.
 * @param {string} target
 * @param {string} value
 * @param {AbortSignal} signal
 */
async function writeTokenExclusive(target, value, signal) {
  if (!isValidTokenText(value)) throw new TokenSaveRefusal('invalid')
  if (signal.aborted) throw new TokenSaveRefusal('aborted')

  let handle
  try {
    handle = await open(target, 'wx', 0o600)
  } catch (error) {
    const exists =
      error !== null && typeof error === 'object' && error.code === 'EEXIST'
    throw new TokenSaveRefusal(exists ? 'exists' : 'write')
  }

  let failure = null
  try {
    // Cancellation that arrives before the first byte removes the empty file
    // instead of leaving a placeholder credential.
    if (signal.aborted) throw new TokenSaveRefusal('aborted')
    await handle.writeFile(`${value}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    failure = error instanceof TokenSaveRefusal ? error : new TokenSaveRefusal('write')
  }

  try {
    await handle.close()
  } catch {
    if (failure === null) failure = new TokenSaveRefusal('write')
  }

  if (failure !== null) {
    try {
      await unlink(target)
    } catch {
      // Best effort: a closing failure may keep the handle briefly locked.
    }
    throw failure
  }
}

/**
 * Load the real typed modules through the installed tsx ESM API. This happens
 * before any connection so a missing loader cannot cause a stray permission
 * prompt.
 */
async function loadPairingModules() {
  let tsx
  try {
    tsx = await import('tsx/esm/api')
  } catch {
    throw helperUnavailable(
      'The installed tsx loader could not be loaded; run this helper from the repository with dependencies installed.',
    )
  }

  let connectionModule
  let pairingModule
  try {
    connectionModule = await tsx.tsImport(TS_CONNECTION_MODULE, import.meta.url)
    pairingModule = await tsx.tsImport(TS_PAIRING_MODULE, import.meta.url)
  } catch {
    throw helperUnavailable(
      'The VTube Studio pairing modules could not be loaded; run this helper from the repository with dependencies installed.',
    )
  }

  if (
    connectionModule === null ||
    typeof connectionModule.createVtsConnectionHandle !== 'function' ||
    pairingModule === null ||
    typeof pairingModule.pairVtsConnection !== 'function'
  ) {
    throw helperUnavailable(
      'The VTube Studio pairing modules did not expose the expected exports.',
    )
  }

  return {
    createVtsConnectionHandle: connectionModule.createVtsConnectionHandle,
    pairVtsConnection: pairingModule.pairVtsConnection,
  }
}

/** @param {unknown} socket */
function destroySocket(socket) {
  if (socket === null || socket === undefined) return
  try {
    if (typeof socket.terminate === 'function') socket.terminate()
    else socket.close()
  } catch {
    // The socket is already unusable; nothing else is owned here.
  }
}

/**
 * Open exactly one loopback ws:// socket with a finite handshake bound and
 * abort support. The returned socket is still OPEN and has not sent anything.
 * @param {string} url
 * @param {number} timeoutMs
 * @param {AbortSignal} signal
 */
async function openLoopbackSocket(url, timeoutMs, signal) {
  let WebSocket
  try {
    ;({ WebSocket } = await import('ws'))
  } catch {
    throw helperUnavailable(
      'The installed ws package could not be loaded; run this helper from the repository with dependencies installed.',
    )
  }

  return await new Promise((resolveSocket, rejectSocket) => {
    let socket
    try {
      socket = new WebSocket(url)
    } catch {
      rejectSocket(
        new SpeakingDemoPairingError(
          'connection-failed',
          'The VTube Studio WebSocket could not be created.',
        ),
      )
      return
    }

    // Keep one inert listener so a late ws error can never become an unhandled
    // process exception; the connection handle adds its own listener later.
    socket.on('error', () => {})

    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {
        // Removal is best effort.
      }
    }

    /** @param {SpeakingDemoPairingError} error */
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      destroySocket(socket)
      rejectSocket(error)
    }

    const onOpen = () => {
      if (settled) return
      settled = true
      cleanup()
      resolveSocket(socket)
    }
    const onError = () => {
      fail(
        new SpeakingDemoPairingError(
          'connection-failed',
          'The VTube Studio WebSocket failed before it opened.',
        ),
      )
    }
    const onClose = () => {
      fail(
        new SpeakingDemoPairingError(
          'connection-failed',
          'The VTube Studio endpoint closed the connection before it opened.',
        ),
      )
    }
    const onAbort = () => {
      fail(
        new SpeakingDemoPairingError(
          'aborted',
          'Pairing was cancelled before VTube Studio connected; no token was saved.',
        ),
      )
    }

    try {
      timer = setTimeout(() => {
        fail(
          new SpeakingDemoPairingError(
            'connection-timeout',
            'VTube Studio did not accept the loopback connection in time; no token was saved.',
          ),
        )
      }, timeoutMs)
    } catch {
      fail(
        new SpeakingDemoPairingError(
          'connection-failed',
          'The VTube Studio connection timer could not be created.',
        ),
      )
      return
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/**
 * Merge the caller's signal with the human Ctrl+C path. When the caller owns a
 * signal, it also owns SIGINT handling; the CLI path installs one here.
 * @param {AbortSignal | null} external
 */
function createCallCancellation(external) {
  const controller = new AbortController()
  let externalAttached = false
  let sigintAttached = false

  const forward = () => {
    controller.abort()
  }
  const onSigint = () => {
    controller.abort()
  }

  if (external !== null) {
    if (external.aborted) {
      controller.abort()
    } else {
      external.addEventListener('abort', forward, { once: true })
      externalAttached = true
    }
  } else {
    try {
      process.once('SIGINT', onSigint)
      sigintAttached = true
    } catch {
      // A denied signal registration leaves the caller's cancellation path.
    }
  }

  return {
    signal: controller.signal,
    dispose() {
      if (externalAttached && external !== null) {
        try {
          external.removeEventListener('abort', forward)
        } catch {
          // Removal is best effort.
        }
      }
      if (sigintAttached) {
        try {
          process.off('SIGINT', onSigint)
        } catch {
          // Removal is best effort.
        }
      }
    },
  }
}

/** @param {() => void} callback @param {string} message */
function notify(callback, message) {
  try {
    callback(message)
  } catch {
    // Human-facing output must not change pairing behavior.
  }
}

/** @param {string} message */
function defaultInstruction(message) {
  try {
    process.stderr.write(`pair-speaking-demo: ${message}\n`)
  } catch {
    // Output is best effort.
  }
}

/** @param {string} message */
function writeStderr(message) {
  try {
    process.stderr.write(message)
  } catch {
    // Output is best effort.
  }
}

/**
 * Map a D2 failure to the public error. Only denial and rejected
 * authentication are guaranteed to be pre-save; other messages avoid claiming
 * that no file exists.
 * @param {string} code
 * @param {'none' | 'exists' | 'aborted' | 'write' | 'invalid'} saveFailure
 * @param {string} target
 */
function pairingFailure(code, saveFailure, target) {
  const messages = {
    aborted: 'Pairing was cancelled before it completed.',
    timeout:
      'VTube Studio did not answer the pairing request in time; no token was saved.',
    permission_denied:
      'VTube Studio denied the pairing request; no token was saved. ' +
      'Click "Allow" in VTube Studio and run the pairing again.',
    authentication_rejected:
      'VTube Studio rejected the new credential; no token was saved.',
    credential_read_failed:
      'No usable credential was available; the token was not saved.',
    credential_missing:
      'No usable credential was available; the token was not saved.',
    protocol_error:
      'VTube Studio returned an unexpected pairing response; no token was saved.',
    transport_closed:
      'The VTube Studio connection ended before pairing finished.',
    transport_error:
      'The VTube Studio connection failed before pairing finished.',
    pairing_cleanup_failed:
      'Pairing failed and the connection did not close cleanly.',
  }

  let message = messages[code] ?? 'Pairing failed.'
  if (code === 'credential_write_failed') {
    message =
      saveFailure === 'exists'
        ? `The token file appeared while pairing (${target}); nothing was overwritten.`
        : saveFailure === 'aborted'
          ? 'Pairing was cancelled while saving the token; no partial token was kept.'
          : `The token could not be saved to ${target}.`
  }

  const publicCodes = {
    aborted: 'aborted',
    timeout: 'timeout',
    credential_write_failed: 'credential-write-failed',
    permission_denied: 'permission-denied',
    authentication_rejected: 'authentication-rejected',
    protocol_error: 'protocol-error',
    transport_closed: 'transport-closed',
    transport_error: 'transport-error',
    pairing_cleanup_failed: 'pairing-cleanup-failed',
  }
  return new SpeakingDemoPairingError(publicCodes[code] ?? 'pairing-failed', message)
}

/**
 * Explicitly pair the portable speaking demo with loopback VTube Studio.
 * @param {{
 *   tokenFile: string,
 *   url?: string,
 *   signal?: AbortSignal,
 *   onInstruction?: (message: string) => void,
 * }} options
 * @returns {Promise<{ tokenFile: string }>}
 */
export async function pairSpeakingDemo(options) {
  const settings = normalizeOptions(options)

  // The destination is decided before any loader, directory, permission prompt
  // or connection. Existing credentials are never read or replaced.
  await assertDestinationFree(settings.target)
  const modules = await loadPairingModules()
  await ensureParentDirectory(settings.target)

  if (settings.signal !== null && settings.signal.aborted) {
    throw new SpeakingDemoPairingError(
      'aborted',
      'Pairing was cancelled before it started; no token was saved.',
    )
  }

  const cancellation = createCallCancellation(settings.signal)
  const report = settings.onInstruction ?? defaultInstruction
  /** @type {'none' | 'exists' | 'aborted' | 'write' | 'invalid'} */
  let saveFailure = 'none'
  let socket = null
  let handle = null

  try {
    socket = await openLoopbackSocket(
      settings.vtsUrl,
      CONNECT_TIMEOUT_MS,
      cancellation.signal,
    )

    try {
      handle = modules.createVtsConnectionHandle({
        socket,
        closeTimeoutMs: CLOSE_TIMEOUT_MS,
      })
    } catch {
      throw new SpeakingDemoPairingError(
        'connection-failed',
        'The VTube Studio connection handle could not be created.',
      )
    }

    notify(
      report,
      `Click "Allow" in the VTube Studio permission prompt for "${VTS_PLUGIN_NAME}"; ` +
        `waiting up to ${Math.round(HUMAN_APPROVAL_TIMEOUT_MS / 1_000)} seconds.`,
    )

    let pairing
    try {
      pairing = await modules.pairVtsConnection({
        handle,
        identity: {
          pluginName: VTS_PLUGIN_NAME,
          pluginDeveloper: VTS_PLUGIN_DEVELOPER,
        },
        credentials: {
          async load() {
            // Presence was verified before connecting; an existing file never
            // reaches this helper and is never read.
            return null
          },
          async save(value, saveSignal) {
            try {
              await writeTokenExclusive(settings.target, value, saveSignal)
            } catch (error) {
              saveFailure =
                error instanceof TokenSaveRefusal ? error.reason : 'write'
              throw error
            }
          },
        },
        signal: cancellation.signal,
        mode: 'allow-prompt',
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        humanApprovalTimeoutMs: HUMAN_APPROVAL_TIMEOUT_MS,
      })
    } catch {
      throw new SpeakingDemoPairingError(
        'pairing-failed',
        'Pairing could not be started; no token was saved.',
      )
    }

    if (pairing.kind === 'failed') {
      throw pairingFailure(pairing.code, saveFailure, settings.target)
    }

    return { tokenFile: settings.target }
  } finally {
    if (handle !== null) {
      let completion = { kind: 'closed' }
      try {
        completion = await handle.close()
      } catch {
        completion = { kind: 'failed', code: 'close_failed' }
      }
      if (completion.kind !== 'closed') destroySocket(socket)
    } else if (socket !== null) {
      destroySocket(socket)
    }
    cancellation.dispose()
  }
}

/**
 * Parse only the pair-only CLI surface. No VTS, browser or model flags exist
 * here by design.
 * @param {string[]} argv
 */
function parseCliArgs(argv) {
  let pairOnly = false
  let tokenFile = null
  let vtsUrl = DEFAULT_VTS_URL

  /** @param {number} index @param {string} flag @param {string | null} inline */
  const takeValue = (index, flag, inline) => {
    if (inline !== null) {
      if (inline.length === 0) throw new Error(`${flag} requires a value.`)
      return { value: inline, next: index }
    }
    const candidate = argv[index + 1]
    if (candidate === undefined || candidate.length === 0) {
      throw new Error(`${flag} requires a value.`)
    }
    return { value: candidate, next: index + 1 }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const inline = equals === -1 ? null : arg.slice(equals + 1)

    if (name === '--pair-only') {
      if (inline !== null) throw new Error('--pair-only does not take a value.')
      pairOnly = true
      continue
    }
    if (name === '--token-file') {
      const taken = takeValue(index, '--token-file', inline)
      tokenFile = taken.value
      index = taken.next
      continue
    }
    if (name === '--vts-url') {
      const taken = takeValue(index, '--vts-url', inline)
      vtsUrl = taken.value
      index = taken.next
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  return { pairOnly, tokenFile, vtsUrl }
}

/**
 * Run the standalone CLI and return its exit code. `--help` and any argument
 * error return before a loader is imported or a socket exists.
 * @param {string[]} argv
 * @param {{ stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }} [io]
 */
export async function runPairingCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const args = Array.isArray(argv) ? argv.map(String) : []

  /** @param {{ write(text: string): unknown }} stream @param {string} text */
  const write = (stream, text) => {
    try {
      stream.write(text)
    } catch {
      // Output is best effort.
    }
  }

  // Help is inert even when other arguments are malformed.
  if (args.includes('--help') || args.includes('-h')) {
    write(stdout, PAIRING_HELP)
    return EXIT_SUCCESS
  }

  let parsed
  try {
    parsed = parseCliArgs(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid arguments.'
    write(stderr, `pair-speaking-demo: ${message}\n`)
    return EXIT_USAGE
  }

  if (!parsed.pairOnly) {
    write(
      stderr,
      'pair-speaking-demo: pairing is explicit; pass --pair-only to connect to VTube Studio (see --help).\n',
    )
    return EXIT_USAGE
  }
  if (parsed.tokenFile === null) {
    write(
      stderr,
      'pair-speaking-demo: --token-file <new-file> is required (see --help).\n',
    )
    return EXIT_USAGE
  }

  try {
    const result = await pairSpeakingDemo({
      tokenFile: parsed.tokenFile,
      url: parsed.vtsUrl,
      onInstruction: (message) => {
        write(stderr, `pair-speaking-demo: ${message}\n`)
      },
    })
    write(
      stdout,
      `Pairing complete: VTube Studio authenticated ${VTS_PLUGIN_NAME}; ` +
        `the token was saved to ${result.tokenFile}.\n`,
    )
    return EXIT_SUCCESS
  } catch (error) {
    if (error instanceof SpeakingDemoPairingError) {
      write(stderr, `pair-speaking-demo: ${error.message}\n`)
      if (error.code === 'aborted') return EXIT_CANCELLED
      if (error.code === 'invalid-url' || error.code === 'invalid-options') {
        return EXIT_USAGE
      }
      return EXIT_RUNTIME
    }
    write(stderr, 'pair-speaking-demo: pairing failed unexpectedly.\n')
    return EXIT_RUNTIME
  }
}

/** @returns {boolean} */
function isDirectInvocation() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  let entryUrl
  try {
    entryUrl = pathToFileURL(resolve(entry)).href
  } catch {
    return false
  }
  return process.platform === 'win32'
    ? entryUrl.toLowerCase() === import.meta.url.toLowerCase()
    : entryUrl === import.meta.url
}

if (isDirectInvocation()) {
  runPairingCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      writeStderr('pair-speaking-demo: pairing failed unexpectedly.\n')
      process.exitCode = EXIT_RUNTIME
    },
  )
}
