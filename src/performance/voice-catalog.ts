/**
 * The single allowlist of English Kokoro voices this project exposes.
 *
 * The pinned `kokoro-js` 1.2.1 package bundles 54 voice assets, including
 * non-English ids the Node SDK will not use. This table is pinned SDK metadata,
 * not a discovery result: the installed `.bin` set can only narrow the catalog,
 * never expand it. `kokoro-provider` uses the same table for its supported-voice
 * admission check, so the catalog and the provider cannot drift.
 *
 * `listInstalledKokoroVoices` is the Node-only helper for the reference runtime.
 * It reads only the bundled voice directory and never loads model weights,
 * tokenizers or a network resource.
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { VoiceLocale, VoiceOption } from '../contracts'

/** One pinned English voice and the display metadata the console renders. */
export interface KokoroVoiceDefinition {
  readonly id: string
  readonly name: string
  readonly locale: VoiceLocale
}

/**
 * The exact English voice table exposed by the pinned `kokoro-js` 1.2.1
 * `KokoroTTS.voices` map. Names are stable display names derived from the
 * bundled asset suffix; locales follow the `a`/`b` language prefix.
 */
export const KOKORO_VOICE_ALLOWLIST: readonly KokoroVoiceDefinition[] = Object.freeze([
  Object.freeze({ id: 'af_alloy', name: 'Alloy', locale: 'en-US' }),
  Object.freeze({ id: 'af_aoede', name: 'Aoede', locale: 'en-US' }),
  Object.freeze({ id: 'af_bella', name: 'Bella', locale: 'en-US' }),
  Object.freeze({ id: 'af_heart', name: 'Heart', locale: 'en-US' }),
  Object.freeze({ id: 'af_jessica', name: 'Jessica', locale: 'en-US' }),
  Object.freeze({ id: 'af_kore', name: 'Kore', locale: 'en-US' }),
  Object.freeze({ id: 'af_nicole', name: 'Nicole', locale: 'en-US' }),
  Object.freeze({ id: 'af_nova', name: 'Nova', locale: 'en-US' }),
  Object.freeze({ id: 'af_river', name: 'River', locale: 'en-US' }),
  Object.freeze({ id: 'af_sarah', name: 'Sarah', locale: 'en-US' }),
  Object.freeze({ id: 'af_sky', name: 'Sky', locale: 'en-US' }),
  Object.freeze({ id: 'am_adam', name: 'Adam', locale: 'en-US' }),
  Object.freeze({ id: 'am_echo', name: 'Echo', locale: 'en-US' }),
  Object.freeze({ id: 'am_eric', name: 'Eric', locale: 'en-US' }),
  Object.freeze({ id: 'am_fenrir', name: 'Fenrir', locale: 'en-US' }),
  Object.freeze({ id: 'am_liam', name: 'Liam', locale: 'en-US' }),
  Object.freeze({ id: 'am_michael', name: 'Michael', locale: 'en-US' }),
  Object.freeze({ id: 'am_onyx', name: 'Onyx', locale: 'en-US' }),
  Object.freeze({ id: 'am_puck', name: 'Puck', locale: 'en-US' }),
  Object.freeze({ id: 'am_santa', name: 'Santa', locale: 'en-US' }),
  Object.freeze({ id: 'bf_alice', name: 'Alice', locale: 'en-GB' }),
  Object.freeze({ id: 'bf_emma', name: 'Emma', locale: 'en-GB' }),
  Object.freeze({ id: 'bf_isabella', name: 'Isabella', locale: 'en-GB' }),
  Object.freeze({ id: 'bf_lily', name: 'Lily', locale: 'en-GB' }),
  Object.freeze({ id: 'bm_daniel', name: 'Daniel', locale: 'en-GB' }),
  Object.freeze({ id: 'bm_fable', name: 'Fable', locale: 'en-GB' }),
  Object.freeze({ id: 'bm_george', name: 'George', locale: 'en-GB' }),
  Object.freeze({ id: 'bm_lewis', name: 'Lewis', locale: 'en-GB' }),
])

/** Membership set for provider admission; syntax-only checks remain separate. */
export const SUPPORTED_KOKORO_VOICE_IDS: ReadonlySet<string> = new Set(
  KOKORO_VOICE_ALLOWLIST.map((voice) => voice.id),
)

/**
 * Filter the pinned allowlist by the voices actually installed, deduplicate the
 * input and return a stable id-sorted list. Unknown ids and path-like strings
 * are ignored because only allowlist entries can survive the filter.
 */
export function createKokoroVoiceCatalog(
  installedVoiceIds: readonly string[],
): readonly VoiceOption[] {
  const installed = new Set(
    installedVoiceIds.filter((voiceId): voiceId is string => typeof voiceId === 'string'),
  )
  return Object.freeze(
    KOKORO_VOICE_ALLOWLIST.filter((voice) => installed.has(voice.id))
      .map((voice) => Object.freeze({ id: voice.id, name: voice.name, locale: voice.locale }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  )
}

/** Resolve the bundled voice directory through the pinned SDK package entry. */
function resolveKokoroVoicesDirectory(): string {
  const require = createRequire(import.meta.url)
  const distEntry = require.resolve('kokoro-js')
  return join(dirname(distEntry), '..', 'voices')
}

/**
 * List the allowlisted English voices whose `.bin` assets are bundled in the
 * installed `kokoro-js` package. Node-only and filesystem-only: no model,
 * tokenizer, cache or network request is touched.
 */
export function listInstalledKokoroVoices(): readonly VoiceOption[] {
  const installed = readdirSync(resolveKokoroVoicesDirectory())
    .filter((name) => name.endsWith('.bin'))
    .map((name) => name.slice(0, -'.bin'.length))
  return createKokoroVoiceCatalog(installed)
}
