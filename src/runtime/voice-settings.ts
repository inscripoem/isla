/**
 * One persisted console voice preference and the in-memory settings service.
 *
 * The selected voice is a single small JSON value. A selection becomes active
 * only after its write succeeds, so a refused or failed save leaves the last
 * applied voice unchanged. Updates are serialized within one service instance;
 * the JSON file itself is replaced atomically (temporary file + rename) next to
 * the explicitly supplied path.
 *
 * This module stores no audio and no WAV bytes.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { VoiceOption } from '../contracts'

/** The default voice for the reference deployment. */
export const DEFAULT_VOICE_ID = 'af_heart'

/** Stable profile version reported for every selected voice. */
export const VOICE_PROFILE_VERSION = '1'

/** Version of the persisted preference document. */
export const VOICE_SETTINGS_VERSION = 1

export type VoiceSettingsFailureCode =
  | 'unknown_voice'
  | 'persistence_failed'
  | 'no_selected_voice'

/** Typed refusal raised by settings construction or selection. */
export class VoiceSettingsError extends Error {
  readonly code: VoiceSettingsFailureCode

  constructor(
    code: VoiceSettingsFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'VoiceSettingsError'
    this.code = code
  }
}

/** The voice list and currently applied selection rendered by the console. */
export interface VoiceSettingsState {
  readonly selectedVoiceId: string | null
  readonly voices: readonly VoiceOption[]
}

/** The value a turn captures before it starts. */
export interface VoiceProfile {
  readonly voiceProfileId: string
  readonly voiceProfileVersion: string
}

/** Minimal persistence seam: one small string document, no audio. */
export interface VoiceSettingsPersistence {
  read(): Promise<string | null>
  write(contents: string): Promise<void>
}

/** The persisted preference document; legacy strings are accepted on read. */
export interface VoicePreferenceDocument {
  readonly version: typeof VOICE_SETTINGS_VERSION
  readonly selectedVoiceId: string
}

export interface VoiceSettings {
  state(): VoiceSettingsState
  select(voiceId: string): Promise<VoiceSettingsState>
  currentVoiceProfile(): VoiceProfile
}

export interface VoiceSettingsOptions {
  readonly voices: readonly VoiceOption[]
  readonly persistence: VoiceSettingsPersistence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function copyVoices(voices: readonly VoiceOption[]): readonly VoiceOption[] {
  if (!Array.isArray(voices)) {
    throw new Error('voice-settings: voices must be an array')
  }
  const seen = new Set<string>()
  const copied: VoiceOption[] = []
  for (const voice of voices) {
    if (!isRecord(voice)) {
      throw new Error('voice-settings: every voice must be an object')
    }
    const { id, name, locale } = voice
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('voice-settings: every voice needs a nonempty id')
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`voice-settings: voice ${id} needs a display name`)
    }
    if (locale !== 'en-US' && locale !== 'en-GB') {
      throw new Error(`voice-settings: voice ${id} has an unsupported locale`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    copied.push(Object.freeze({ id, name, locale }))
  }
  return Object.freeze(copied)
}

/**
 * Read a saved preference. A missing file, malformed JSON or an unknown shape is
 * treated as no preference; the caller then applies the default cleanly.
 */
function parseSavedVoiceId(contents: string | null): string | null {
  if (contents === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return null
  }
  if (typeof parsed === 'string') {
    return parsed.length > 0 ? parsed : null
  }
  if (!isRecord(parsed)) return null
  for (const key of ['selectedVoiceId', 'voiceId', 'voice'] as const) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function serializePreference(voiceId: string): string {
  const document: VoicePreferenceDocument = {
    version: VOICE_SETTINGS_VERSION,
    selectedVoiceId: voiceId,
  }
  return `${JSON.stringify(document)}\n`
}

/**
 * Create the settings service, loading one saved preference before returning.
 * The saved voice wins only when it is still present in the supplied catalog.
 */
export async function createVoiceSettings(
  options: VoiceSettingsOptions,
): Promise<VoiceSettings> {
  if (!isRecord(options)) {
    throw new Error('voice-settings: options are required')
  }
  const voices = copyVoices(options.voices)
  const persistence = options.persistence
  if (
    !isRecord(persistence) ||
    typeof persistence.read !== 'function' ||
    typeof persistence.write !== 'function'
  ) {
    throw new Error('voice-settings: persistence must provide read and write')
  }

  const available = new Map(voices.map((voice) => [voice.id, voice]))
  let saved: string | null
  try {
    saved = parseSavedVoiceId(await persistence.read())
  } catch (error) {
    throw new VoiceSettingsError(
      'persistence_failed',
      'voice-settings: the saved voice preference could not be read',
      { cause: error },
    )
  }

  let selectedVoiceId =
    saved !== null && available.has(saved)
      ? saved
      : available.has(DEFAULT_VOICE_ID)
        ? DEFAULT_VOICE_ID
        : (voices[0]?.id ?? null)

  let state: VoiceSettingsState = Object.freeze({ selectedVoiceId, voices })
  let queue: Promise<void> = Promise.resolve()

  function currentState(): VoiceSettingsState {
    return state
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task)
    // Keep the serialization chain settled even when one update fails, so a
    // later selection can still run and observe the last applied value.
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function select(voiceId: string): Promise<VoiceSettingsState> {
    if (typeof voiceId !== 'string' || !available.has(voiceId)) {
      return Promise.reject(
        new VoiceSettingsError(
          'unknown_voice',
          `voice-settings: voice ${String(voiceId)} is not installed`,
        ),
      )
    }
    return enqueue(async () => {
      if (selectedVoiceId === voiceId) return currentState()
      try {
        await persistence.write(serializePreference(voiceId))
      } catch (error) {
        throw new VoiceSettingsError(
          'persistence_failed',
          `voice-settings: could not save voice ${voiceId}`,
          { cause: error },
        )
      }
      selectedVoiceId = voiceId
      state = Object.freeze({ selectedVoiceId, voices })
      return currentState()
    })
  }

  function currentVoiceProfile(): VoiceProfile {
    if (selectedVoiceId === null) {
      throw new VoiceSettingsError(
        'no_selected_voice',
        'voice-settings: no voice is selected',
      )
    }
    return Object.freeze({
      voiceProfileId: selectedVoiceId,
      voiceProfileVersion: VOICE_PROFILE_VERSION,
    })
  }

  return Object.freeze({ state: currentState, select, currentVoiceProfile })
}

/**
 * Persistence over one explicitly supplied JSON file. Writes create the parent
 * directory, write a uniquely named sibling temporary file and rename it over the
 * target, so a reader never sees a partially written preference.
 */
export function createJsonFileVoiceSettingsPersistence(
  filePath: string,
): VoiceSettingsPersistence {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('voice-settings: a file path is required')
  }
  const directory = dirname(filePath)
  const temporaryPrefix = `.${basename(filePath)}.${process.pid}.`

  return Object.freeze({
    async read() {
      try {
        return await readFile(filePath, 'utf8')
      } catch (error) {
        if (isMissingFile(error)) return null
        throw error
      }
    },
    async write(contents: string) {
      await mkdir(directory, { recursive: true })
      const temporaryPath = join(directory, `${temporaryPrefix}${randomUUID()}.tmp`)
      try {
        await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
        await rename(temporaryPath, filePath)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {})
        throw error
      }
    },
  })
}
