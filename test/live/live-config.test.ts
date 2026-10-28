import { describe, expect, it } from 'vitest'
import { LIVE_TEXT_PROVIDER_ENV, readLiveTextProviderConfig } from './live-config'

/**
 * Offline-safe tests for the live configuration loader. They run wherever the
 * live suite runs and need no credentials: every case injects a synthetic
 * environment, and the secret-echo property is pinned with an unmistakable
 * sentinel value.
 */
const SECRET = 'sk-sentinel-never-echo-anywhere'

function envWith(values: Partial<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    [LIVE_TEXT_PROVIDER_ENV.baseUrl]: 'https://gateway.example.com/v1',
    [LIVE_TEXT_PROVIDER_ENV.model]: 'test-model',
    [LIVE_TEXT_PROVIDER_ENV.apiKey]: SECRET,
    ...values,
  }
}

describe('M4 live text provider configuration', () => {
  it('is unavailable with every variable missing', () => {
    const report = readLiveTextProviderConfig({})
    expect(report.available).toBe(false)
    expect(report.config).toBeNull()
    expect(report.reason).toContain(LIVE_TEXT_PROVIDER_ENV.baseUrl)
    expect(report.reason).toContain(LIVE_TEXT_PROVIDER_ENV.model)
    expect(report.reason).toContain(LIVE_TEXT_PROVIDER_ENV.apiKey)
  })

  it('names the missing variable when only one is absent', () => {
    const report = readLiveTextProviderConfig(envWith({ [LIVE_TEXT_PROVIDER_ENV.apiKey]: undefined }))
    expect(report.available).toBe(false)
    expect(report.reason).toContain(LIVE_TEXT_PROVIDER_ENV.apiKey)
  })

  it('treats a blank value as missing', () => {
    const report = readLiveTextProviderConfig(envWith({ [LIVE_TEXT_PROVIDER_ENV.model]: '   ' }))
    expect(report.available).toBe(false)
    expect(report.reason).toContain(LIVE_TEXT_PROVIDER_ENV.model)
  })

  it('refuses a base URL that is not http(s)', () => {
    const report = readLiveTextProviderConfig(
      envWith({ [LIVE_TEXT_PROVIDER_ENV.baseUrl]: 'ftp://gateway.example.com' }),
    )
    expect(report.available).toBe(false)
    expect(report.reason).toContain(LIVE_TEXT_PROVIDER_ENV.baseUrl)
  })

  it('parses a complete configuration and trims the base URL', () => {
    const report = readLiveTextProviderConfig(
      envWith({ [LIVE_TEXT_PROVIDER_ENV.baseUrl]: 'https://gateway.example.com/v1///' }),
    )
    expect(report.available).toBe(true)
    expect(report.reason).toBeNull()
    expect(report.config).not.toBeNull()
    expect(report.config?.baseUrl).toBe('https://gateway.example.com/v1')
    expect(report.config?.model).toBe('test-model')
    expect(report.config?.apiKey).toBe(SECRET)
  })

  it('never echoes an environment value into the unavailability reason', () => {
    // Every field is a sentinel value, so any leak of a VALUE (as opposed to a
    // variable NAME) into the reason fails this case.
    const report = readLiveTextProviderConfig(
      envWith({ [LIVE_TEXT_PROVIDER_ENV.baseUrl]: 'not-a-url' }),
    )
    expect(report.available).toBe(false)
    expect(report.reason).not.toContain(SECRET)
    expect(report.reason).not.toContain('test-model')
    expect(report.reason).not.toContain('not-a-url')
  })
})
