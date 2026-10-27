/**
 * Live-provider configuration, read from the environment only.
 *
 * Credential rules (AGENTS.md): credentials are never written to the
 * repository, never defaulted, and never displayed. This module therefore
 * reports availability and a REASON that names variable names, never values.
 * Every failure path is checked by test/live/live-config.test.ts, including
 * the no-secret-echo property.
 *
 * The configuration is provider-shaped (an OpenAI-compatible chat endpoint)
 * because that is the shape M4-02's real `DialogueTextSource` will consume.
 * Reading it here, before that implementation lands, keeps the live harness
 * and its acceptance cases in place ahead of the code they will judge.
 */

export const LIVE_TEXT_PROVIDER_ENV = {
  /** Chat-completions base URL, without a trailing slash. */
  baseUrl: 'ISLA_LIVE_TEXT_BASE_URL',
  /** Model identifier the provider exposes. */
  model: 'ISLA_LIVE_TEXT_MODEL',
  /** Bearer credential. Never logged, never persisted. */
  apiKey: 'ISLA_LIVE_TEXT_API_KEY',
} as const

export interface LiveTextProviderConfig {
  baseUrl: string
  model: string
  apiKey: string
}

export interface LiveConfigReport {
  available: boolean
  /**
   * Why the configuration is unavailable, phrased with variable NAMES only.
   * Null when the configuration is available. Verified never to contain any
   * environment value (see live-config.test.ts).
   */
  reason: string | null
  config: LiveTextProviderConfig | null
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0
}

export function readLiveTextProviderConfig(env: NodeJS.ProcessEnv = process.env): LiveConfigReport {
  const missing = Object.values(LIVE_TEXT_PROVIDER_ENV).filter((name) => blank(env[name]))
  if (missing.length > 0) {
    return {
      available: false,
      reason: `live text provider is not configured; missing environment variable(s): ${missing.join(', ')}`,
      config: null,
    }
  }

  const baseUrl = (env[LIVE_TEXT_PROVIDER_ENV.baseUrl] ?? '').trim()
  const model = (env[LIVE_TEXT_PROVIDER_ENV.model] ?? '').trim()
  const apiKey = (env[LIVE_TEXT_PROVIDER_ENV.apiKey] ?? '').trim()

  if (!/^https?:\/\//i.test(baseUrl)) {
    return {
      available: false,
      reason: `${LIVE_TEXT_PROVIDER_ENV.baseUrl} must be an http(s) URL`,
      config: null,
    }
  }

  return {
    available: true,
    reason: null,
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey,
    },
  }
}
