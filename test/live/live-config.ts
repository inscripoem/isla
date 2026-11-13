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

/** M3 general-model selection/reaction provider environment. */
export const LIVE_DECISION_MAX_TOKENS_ENV = 'ISLA_LIVE_DECISION_MAX_TOKENS'

export const LIVE_DECISION_PROVIDER_ENV = {
  /** Chat-completions base URL, without a trailing slash. */
  baseUrl: 'ISLA_LIVE_DECISION_BASE_URL',
  /** Model identifier the provider exposes. */
  model: 'ISLA_LIVE_DECISION_MODEL',
  /** Bearer credential. Never logged, never persisted. */
  apiKey: 'ISLA_LIVE_DECISION_API_KEY',
} as const

/** M3 dedicated Jev model environment for NFR-03 comparison. */
export const LIVE_JEV_MAX_TOKENS_ENV = 'ISLA_LIVE_JEV_MAX_TOKENS'

export const LIVE_JEV_PROVIDER_ENV = {
  /** Chat-completions base URL, without a trailing slash. */
  baseUrl: 'ISLA_LIVE_JEV_BASE_URL',
  /** Model identifier the provider exposes. */
  model: 'ISLA_LIVE_JEV_MODEL',
  /** Bearer credential. Never logged, never persisted. */
  apiKey: 'ISLA_LIVE_JEV_API_KEY',
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

/** Provider-shaped configuration shared by the M3 live model environments. */
export interface LiveProviderConfig {
  baseUrl: string
  model: string
  apiKey: string
  /** Optional positive completion-token limit; absent uses the adapter default. */
  maxTokens?: number
}

export interface LiveProviderConfigReport {
  available: boolean
  /** Why the configuration is unavailable, phrased with variable NAMES only. */
  reason: string | null
  config: LiveProviderConfig | null
}

interface LiveProviderEnv {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

/** Accepts https anywhere, or plain http only on loopback hosts. */
function isLoopbackSafeBaseUrl(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
}

function readModelProviderConfig(
  env: NodeJS.ProcessEnv,
  providerEnv: LiveProviderEnv,
  maxTokensEnv: string,
  label: string,
): LiveProviderConfigReport {
  const missing = Object.values(providerEnv).filter((name) => blank(env[name]))
  if (missing.length > 0) {
    return {
      available: false,
      reason: `${label} provider is not configured; missing environment variable(s): ${missing.join(', ')}`,
      config: null,
    }
  }

  const baseUrl = (env[providerEnv.baseUrl] ?? '').trim()
  const model = (env[providerEnv.model] ?? '').trim()
  const apiKey = (env[providerEnv.apiKey] ?? '').trim()

  if (!isLoopbackSafeBaseUrl(baseUrl)) {
    return {
      available: false,
      reason: `${providerEnv.baseUrl} must be an https URL or loopback http (localhost, 127.0.0.1, [::1])`,
      config: null,
    }
  }

  const rawMaxTokens = env[maxTokensEnv]
  let maxTokens: number | undefined
  if (!blank(rawMaxTokens)) {
    const value = (rawMaxTokens ?? '').trim()
    const parsed = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return {
        available: false,
        reason: `${maxTokensEnv} must be a positive integer`,
        config: null,
      }
    }
    maxTokens = parsed
  }

  return {
    available: true,
    reason: null,
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
  }
}

export function readLiveDecisionProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveProviderConfigReport {
  return readModelProviderConfig(
    env,
    LIVE_DECISION_PROVIDER_ENV,
    LIVE_DECISION_MAX_TOKENS_ENV,
    'live decision',
  )
}

export function readLiveJevProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveProviderConfigReport {
  return readModelProviderConfig(
    env,
    LIVE_JEV_PROVIDER_ENV,
    LIVE_JEV_MAX_TOKENS_ENV,
    'live jev',
  )
}
