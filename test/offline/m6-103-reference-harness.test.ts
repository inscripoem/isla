import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRunSpec } from '../../src/evaluation/run-command'
import createReferenceTextHarness from '../support/evaluation-harness-reference'

const SPEC_PATH = join(process.cwd(), 'test/fixtures/evaluation/pilot-spec.json')
const CONTEXT = { cwd: process.cwd(), env: {} }

describe('reference text harness (#103 pilot)', () => {
  it('ships a run spec the runner accepts', () => {
    const parsed = readRunSpec(readFileSync(SPEC_PATH, 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.spec.meta.runId).toBe('pilot-selection-001')
    expect(parsed.spec.cases.map((evalCase) => evalCase.id)).toEqual(['selection-001'])
    expect(parsed.spec.conditions.textSource).toBe('provider')
    expect(parsed.spec.conditions.history).toEqual({
      source: 'local',
      recordSet: 'empty set (no prior turns)',
    })
    expect(parsed.spec.conditions.modelVersion).toContain('requested')
    expect(parsed.spec.conditions.modelVersion).toContain('unconfirmed')
    expect(parsed.spec.conditions.workload).toContain('message-001')
  })

  it('refuses a missing provider base URL instead of falling back', () => {
    expect(() => createReferenceTextHarness(CONTEXT)).toThrow(/ISLA_LIVE_TEXT_BASE_URL/)
  })

  it('refuses a missing model after the base URL is supplied', () => {
    expect(() =>
      createReferenceTextHarness({
        ...CONTEXT,
        env: { ISLA_LIVE_TEXT_BASE_URL: 'http://127.0.0.1:1/v1' },
      }),
    ).toThrow(/ISLA_LIVE_TEXT_MODEL/)
  })

  it('refuses a missing API key after URL and model are supplied', () => {
    expect(() =>
      createReferenceTextHarness({
        ...CONTEXT,
        env: {
          ISLA_LIVE_TEXT_BASE_URL: 'http://127.0.0.1:1/v1',
          ISLA_LIVE_TEXT_MODEL: 'test-model',
        },
      }),
    ).toThrow(/ISLA_LIVE_TEXT_API_KEY/)
  })
})
