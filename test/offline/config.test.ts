import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_PAYLOAD,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  isLoopbackHost,
  normalizeRuntimeConfig,
  resolvePort,
} from '../../src/runtime/config'

describe('isLoopbackHost', () => {
  it('accepts loopback names and the 127/8 range', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('rejects any public or wildcard address', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
  })
})

describe('resolvePort', () => {
  it('uses the fallback only when the value is absent', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT)
    expect(resolvePort(undefined, 1234)).toBe(1234)
  })

  it('parses a clean decimal integer', () => {
    expect(resolvePort('4317')).toBe(4317)
    expect(resolvePort('0')).toBe(0)
    expect(resolvePort(' 8080 ')).toBe(8080)
  })

  it('rejects trailing or malformed input instead of truncating', () => {
    expect(() => resolvePort('4317abc')).toThrow(/invalid port/)
    expect(() => resolvePort('')).toThrow(/invalid port/)
    expect(() => resolvePort('abc')).toThrow(/invalid port/)
    expect(() => resolvePort('1.5')).toThrow(/invalid port/)
  })

  it('rejects values outside the TCP port range', () => {
    expect(() => resolvePort('70000')).toThrow(/invalid port/)
    expect(() => resolvePort('-1')).toThrow(/invalid port/)
  })
})

describe('normalizeRuntimeConfig', () => {
  it('defaults to a validated loopback configuration', () => {
    expect(normalizeRuntimeConfig()).toEqual({
      host: LOOPBACK_HOST,
      port: DEFAULT_PORT,
      maxPayload: DEFAULT_MAX_PAYLOAD,
      graceMs: expect.any(Number),
    })
  })

  it('rejects non-loopback hosts', () => {
    expect(() => normalizeRuntimeConfig({ host: '0.0.0.0' })).toThrow(/loopback/)
    expect(() => normalizeRuntimeConfig({ host: '192.168.1.10' })).toThrow(/loopback/)
  })

  it('rejects out-of-range or non-integer tuning values', () => {
    expect(() => normalizeRuntimeConfig({ port: -1 })).toThrow(/port/)
    expect(() => normalizeRuntimeConfig({ port: 65536 })).toThrow(/port/)
    expect(() => normalizeRuntimeConfig({ maxPayload: 0 })).toThrow(/maxPayload/)
    expect(() => normalizeRuntimeConfig({ graceMs: 0 })).toThrow(/graceMs/)
  })
})
