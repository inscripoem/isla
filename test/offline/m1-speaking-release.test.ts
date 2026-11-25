import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createProductionDeployment } from '../live/m1-speaking-deployment'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pureTest = join(repoRoot, 'test', 'offline', 'test_m1_speaking_mouth.py')
const modelEnv = 'ISLA_SPEAKING_MODEL_ID'

interface Python3 {
  readonly command: string
  readonly args: readonly string[]
}

/** First interpreter from python3 / python / py -3 that really is Python 3. */
function findPython3(): Python3 | null {
  const candidates: readonly Python3[] = [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
    { command: 'py', args: ['-3'] },
  ]
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.args, '-c', 'import sys; print(sys.version_info[0])'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: false },
    )
    if (probe.error === undefined && probe.status === 0 && probe.stdout.trim() === '3') {
      return candidate
    }
  }
  return null
}

const python3 = findPython3()

/** Dummy reference environment that `parseReferenceLiveConfig` accepts. */
function referenceEnv(modelId?: string): Record<string, string | undefined> {
  return {
    ISLA_LIVE_TEXT_BASE_URL: 'http://127.0.0.1:9/v1',
    ISLA_LIVE_TEXT_MODEL: 'dummy-text-model',
    ISLA_LIVE_TEXT_API_KEY: 'dummy-api-key',
    ISLA_VTS_WS_URL: 'ws://127.0.0.1:9',
    ISLA_VTS_PLUGIN_NAME: 'Isla Runtime',
    ISLA_VTS_PLUGIN_DEVELOPER: 'CS5351 Isla',
    ISLA_VTS_TOKEN_PATH: join(repoRoot, 'missing-vts-token'),
    ISLA_VTS_HOTKEY_MAP: '{"toggle-mute":"Ctrl+Alt+M"}',
    ISLA_KOKORO_MODEL_DIR: join(repoRoot, 'missing-kokoro-model'),
    ISLA_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    [modelEnv]: modelId,
  }
}

describe('M1 speaking release', () => {
  it.skipIf(python3 === null)(
    'executes the pure speaking-mouth unittest with an available Python 3',
    () => {
      const interpreter = python3 as Python3
      const run = spawnSync(interpreter.command, [...interpreter.args, pureTest], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })
      const output = `${run.stdout}\n${run.stderr}`

      expect(run.error).toBeUndefined()
      expect(run.status, output).toBe(0)

      const ran = /Ran (\d+) tests? in [\d.]+s/.exec(run.stderr)
      expect(ran, output).not.toBeNull()
      expect(Number(ran?.[1])).toBeGreaterThan(0)
      expect(run.stderr).toContain('OK')
    },
  )

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ] as const)(
    'refuses before connecting when ISLA_SPEAKING_MODEL_ID is %s',
    async (_state, modelId) => {
      await expect(
        createProductionDeployment({
          clock: { nowMs: () => 0 },
          databasePath: join(tmpdir(), 'isla-speaking-release.sqlite'),
          env: referenceEnv(modelId),
        }),
      ).rejects.toThrow(
        `speaking-deployment: ${modelEnv} must name the VTube Studio model to animate`,
      )
    },
  )
})
